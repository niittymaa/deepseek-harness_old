#!/usr/bin/env node
/**
 * Ensure a local OmniRoute gateway is reachable before a desktop app boot.
 *
 * The DSH `omniroute` model provider talks to `http://127.0.0.1:20128/v1`, so
 * the gateway has to be up before the app sends its first request. This helper
 * is a no-op when the gateway already answers, starts it as a background daemon
 * otherwise, and never fails the app boot: an absent or broken OmniRoute only
 * prints a warning, because the app still works with its other providers.
 *
 * Environment:
 *   OMNIROUTE_SKIP_START=1  skip the check entirely
 *   OMNIROUTE_HEALTH_URL    override the readiness probe
 *   OMNIROUTE_BIN           override the executable to launch
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const HEALTH_URL = process.env.OMNIROUTE_HEALTH_URL ?? 'http://127.0.0.1:20128/api/health'
const READY_TIMEOUT_MS = 90_000
const PROBE_TIMEOUT_MS = 2_000

/** @returns {Promise<boolean>} whether the gateway answered its health probe */
async function healthy() {
  try {
    const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Resolve the OmniRoute executable without assuming a shell PATH.
 * @returns {string | undefined} the command to spawn, when one exists
 */
function resolveBinary() {
  if (process.env.OMNIROUTE_BIN !== undefined && process.env.OMNIROUTE_BIN.length > 0) {
    return process.env.OMNIROUTE_BIN
  }
  const executable = process.platform === 'win32' ? 'omniroute.cmd' : 'omniroute'
  const candidates = [
    process.env.LOCALAPPDATA === undefined
      ? undefined
      : join(process.env.LOCALAPPDATA, 'pnpm', 'bin', executable),
    process.env.APPDATA === undefined ? undefined : join(process.env.APPDATA, 'npm', executable),
  ].filter(candidate => candidate !== undefined && existsSync(candidate))
  // PATH stays the first choice: a shim installed elsewhere is still `omniroute`.
  if (process.env.PATH?.split(process.platform === 'win32' ? ';' : ':').some(directory => (
    directory.length > 0 && existsSync(join(directory, executable))
  ))) return executable
  return candidates[0]
}

/** Start the gateway daemon and wait for its health endpoint. */
async function start() {
  const command = resolveBinary()
  if (command === undefined) {
    warn('the omniroute executable is not installed; run: pnpm add -g omniroute@latest')
    return
  }
  info(`starting ${command}`)
  const child = spawn(command, ['serve', '--no-open', '--daemon'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  await new Promise(resolve => child.once('exit', resolve))
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await healthy()) return
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
  warn(`the gateway did not answer ${HEALTH_URL} within ${READY_TIMEOUT_MS / 1_000}s`)
}

/** @param {string} message */
function info(message) {
  console.log(`[omniroute] ${message}`)
}

/** @param {string} message */
function warn(message) {
  console.warn(`[omniroute] ${message} — the app starts without it`)
}

if (process.env.OMNIROUTE_SKIP_START === '1') {
  info('start skipped (OMNIROUTE_SKIP_START=1)')
} else if (await healthy()) {
  info(`already running at ${HEALTH_URL}`)
} else {
  await start()
  if (await healthy()) info(`ready at ${HEALTH_URL}`)
}
