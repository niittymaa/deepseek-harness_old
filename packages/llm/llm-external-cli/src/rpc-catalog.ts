/** Read native CLI model catalogs without starting a model turn.
 * @module @deepseek-ai/dsh-llm-external-cli/rpc-catalog
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { cliChildEnv } from './env.ts'
import { DEFAULT_DISCOVERY_BYTES, DEFAULT_DISCOVERY_TIMEOUT_MS } from './config.ts'
import type { ExternalCliModel, ExternalCliProviderProfile } from './config.ts'

/** CLI protocols that publish their catalog over a metadata channel of their own. */
export type RpcProtocol = 'claude' | 'codex' | 'copilot'

/** Client identity the metadata channels accept as display metadata. */
const CLIENT = { name: 'dsh', version: '0.2.1' }

/** Request identifier of the single Claude Code control request. */
const CONTROL_REQUEST_ID = 'dsh-catalog'

/** Header of one `Content-Length` framed message. */
const CONTENT_LENGTH = /^Content-Length: (\d+)$/im

/** Longest teardown wait for a channel that does not confirm its exit. */
const CLOSE_GRACE_MS = 2000

/** Arguments that start each protocol's catalog mode. */
const ARGS: Record<RpcProtocol, readonly string[]> = {
  claude: ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'],
  codex: ['app-server'],
  copilot: ['--headless', '--no-auto-update', '--stdio'],
}

/** Whether a protocol frames messages as JSON lines or as `Content-Length` bodies. */
const FRAMED: Record<RpcProtocol, boolean> = { claude: false, codex: false, copilot: true }

/** One message the catalog channel accepts. */
type Send = (message: object) => void

/** Read one inbound message, returning the whole catalog only once it is complete. */
type Read = (message: Record<string, unknown>) => ExternalCliModel[] | undefined

/** One catalog operation settled exactly once. */
interface Deferred {
  /** Rejects with the first failure, or resolves with the models. */
  readonly promise: Promise<ExternalCliModel[]>
  /** Resolve the operation with a catalog, in arrival order. */
  readonly resolve: (models: readonly ExternalCliModel[]) => void
  /** Reject the operation with its first failure. */
  readonly reject: (error: LlmError) => void
}

/**
 * Create the single-settlement handle a catalog operation reports through.
 * @returns the operation promise and its two settlement paths.
 */
function deferred(): Deferred {
  let done = false
  let resolve!: (models: ExternalCliModel[]) => void
  let reject!: (error: LlmError) => void
  const promise = new Promise<ExternalCliModel[]>((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  return {
    promise,
    resolve: (models) => {
      if (done) return
      done = true
      resolve([...models])
    },
    reject: (error) => {
      if (done) return
      done = true
      reject(error)
    },
  }
}

/** Describe one catalog violation in the terms a settings surface can report. */
function invalid(detail: string): LlmError {
  return new LlmError(`The CLI catalog is invalid: ${detail}. Check its version or update the CLI.`, 'CLI_INVALID_CATALOG')
}

/** Refuse a catalog value that is not the object its protocol describes. */
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid('a message or catalog entry is not an object')
  return value as Record<string, unknown>
}

/** Read the model array of one page, including the protocol's identifiers, names and reasoning levels. */
function models(protocol: RpcProtocol, value: unknown): ExternalCliModel[] {
  if (!Array.isArray(value)) throw invalid('no model array was returned')
  return value.map((entry: unknown) => {
    const model = record(entry)
    const id = protocol === 'claude' ? model['value'] : protocol === 'codex' ? model['model'] : model['id']
    if (typeof id !== 'string' || id.trim().length === 0) throw invalid('a model entry has no identifier')
    const name = protocol === 'copilot' ? model['name'] : model['displayName']
    if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0)) throw invalid(`model "${id}" has no usable name`)
    const reasoningEfforts: Record<string, string> = {}
    if (protocol !== 'copilot') {
      const levels = protocol === 'claude' ? model['supportedEffortLevels'] : model['supportedReasoningEfforts']
      if (levels !== undefined) {
        if (!Array.isArray(levels)) throw invalid(`model "${id}" lists unreadable reasoning levels`)
        const listed: readonly unknown[] = levels
        for (const level of listed) {
          const effort = protocol === 'codex' ? record(level)['reasoningEffort'] : level
          if (typeof effort !== 'string' || effort.trim().length === 0) throw invalid(`model "${id}" lists an empty reasoning level`)
          reasoningEfforts[effort] = effort
        }
      }
    }
    return {
      id,
      ...typeof name === 'string' ? { name } : {},
      ...Object.keys(reasoningEfforts).length === 0 ? {} : { reasoningEfforts },
    }
  })
}

/** The list request of one protocol, tagged with the identifier its reply echoes. */
function listRequest(protocol: RpcProtocol, id: number, cursor?: string): object {
  return protocol === 'codex'
    ? { id, method: 'model/list', params: { includeHidden: false, ...cursor === undefined ? {} : { cursor } } }
    : { jsonrpc: '2.0', id, method: 'models.list', params: {} }
}

/** The message that opens one protocol's catalog channel. */
function openRequest(protocol: RpcProtocol): object {
  switch (protocol) {
    case 'claude':
      return { type: 'control_request', request_id: CONTROL_REQUEST_ID, request: { subtype: 'initialize' } }
    case 'codex':
      return { id: 0, method: 'initialize', params: { clientInfo: CLIENT } }
    case 'copilot':
      return { jsonrpc: '2.0', id: 0, method: 'connect', params: { clientInfo: { editorName: CLIENT.name, editorVersion: CLIENT.version, extensionName: CLIENT.name, extensionVersion: CLIENT.version } } }
  }
}

/**
 * Build the reader for one protocol, holding the request sequence it needs.
 * Claude Code answers its initialization control request, Codex and Copilot
 * answer numbered requests.
 * @param protocol - the channel's message dialect.
 * @param send - writes one message to the channel.
 * @returns a reader that yields models only when the catalog is complete.
 */
function readerFor(protocol: RpcProtocol, send: Send): Read {
  if (protocol === 'claude') {
    return (message) => {
      if (message['type'] !== 'control_response') return undefined
      const response = record(message['response'])
      if (response['request_id'] !== CONTROL_REQUEST_ID) return undefined
      if (response['subtype'] === 'error') throw new LlmError('Claude Code refused catalog initialization. Check its version and authentication.', 'CLI_DISCOVERY_FAILED')
      return models(protocol, record(response['response'])['models'])
    }
  }
  const collected: ExternalCliModel[] = []
  const cursors = new Set<string>()
  let requestId = 1
  return (message) => {
    const id = message['id']
    if (id === undefined) return undefined
    if (message['error'] !== undefined) throw new LlmError(`${protocol} rejected catalog discovery. Check its version and authentication.`, 'CLI_DISCOVERY_FAILED')
    if (id === 0) {
      if (protocol === 'codex') send({ method: 'initialized', params: {} })
      send(listRequest(protocol, requestId))
      return undefined
    }
    if (id !== requestId) return undefined
    const result = record(message['result'])
    collected.push(...models(protocol, result[protocol === 'codex' ? 'data' : 'models']))
    const cursor = result['nextCursor']
    // A page may repeat a model an earlier page listed; the catalog names each model once, at its first position.
    if (protocol !== 'codex' || cursor === null || cursor === undefined) {
      const unique = new Map<string, ExternalCliModel>()
      for (const model of collected) if (!unique.has(model.id)) unique.set(model.id, model)
      return [...unique.values()]
    }
    if (typeof cursor !== 'string' || cursors.has(cursor)) throw invalid('pagination repeats or misdeclares its cursor')
    cursors.add(cursor)
    requestId += 1
    send(listRequest(protocol, requestId, cursor))
    return undefined
  }
}

/**
 * Fetch a CLI's model catalog through its native metadata channel. The
 * channel starts no model turn and is stopped as soon as the catalog arrives.
 * @param profile - Executable and bounded discovery settings.
 * @param protocol - Native CLI protocol to use.
 * @param signal - Optional caller cancellation.
 * @returns Selectable models with the reasoning levels the CLI advertises.
 */
export async function discoverRpcModels(
  profile: ExternalCliProviderProfile,
  protocol: RpcProtocol,
  signal?: AbortSignal,
): Promise<ExternalCliModel[]> {
  if (signal?.aborted === true) throw new LlmError('CLI model discovery was cancelled.', 'ABORTED')
  const child = spawn(profile.command ?? protocol, [...ARGS[protocol]], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: profile.shell ?? false, env: cliChildEnv(process.env) })
  const closed = once(child, 'close')
  // The operation promise owns failure; this listener only keeps teardown quiet.
  void closed.catch(() => {})
  const limit = profile.discoveryMaxBytes ?? DEFAULT_DISCOVERY_BYTES
  const { promise, resolve, reject } = deferred()
  const fail = (message: string, code = 'CLI_DISCOVERY_FAILED'): void => { reject(new LlmError(message, code)) }
  const send: Send = (message) => {
    const json = JSON.stringify(message)
    child.stdin.write(FRAMED[protocol] ? `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}` : `${json}\n`)
  }
  const read = readerFor(protocol, send)
  const onAbort = (): void => { fail('CLI model discovery was cancelled.', 'ABORTED') }
  const onError = (): void => { fail('Could not start the CLI catalog service. Check the configured executable.') }
  const onClose = (): void => { fail('The CLI catalog service exited before returning models. Check its version and authentication.') }
  const timer = setTimeout(() => { fail('CLI model discovery timed out. Retry or configure models in settings.', 'CLI_TIMEOUT') }, profile.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS)
  let buffered = Buffer.alloc(0)
  let received = 0
  const account = (chunk: Buffer): boolean => {
    received += chunk.length
    if (received <= limit) return true
    fail('CLI catalog output exceeded the configured limit.', 'CLI_CATALOG_TOO_LARGE')
    return false
  }
  const onStderr = (chunk: Buffer): void => { account(chunk) }
  /** Take the next complete message off the channel, if one is buffered. */
  const frame = (): string | undefined => {
    if (FRAMED[protocol]) {
      const end = buffered.indexOf('\r\n\r\n')
      if (end < 0) return undefined
      const length = Number(CONTENT_LENGTH.exec(buffered.subarray(0, end).toString('utf8'))?.[1])
      if (!Number.isSafeInteger(length) || length < 1 || length > limit) throw invalid('a message declares no usable Content-Length')
      if (buffered.length < end + 4 + length) return undefined
      const body = buffered.subarray(end + 4, end + 4 + length).toString('utf8')
      buffered = buffered.subarray(end + 4 + length)
      return body
    }
    const end = buffered.indexOf(10)
    if (end < 0) return undefined
    const line = buffered.subarray(0, end).toString('utf8')
    buffered = buffered.subarray(end + 1)
    return line.trim().length === 0 ? '' : line
  }
  const receive = (): void => {
    for (;;) {
      const message = frame()
      if (message === undefined) return
      if (message.length === 0) continue
      const found = read(record(JSON.parse(message)))
      if (found !== undefined) {
        resolve(found)
        return
      }
    }
  }
  const onData = (chunk: Buffer): void => {
    if (!account(chunk)) return
    buffered = Buffer.concat([buffered, chunk])
    try {
      receive()
    } catch (error) {
      // A malformed message is the protocol's failure, not a harness fault.
      if (error instanceof LlmError) fail(error.message, error.failure.code)
      else fail('The CLI returned invalid catalog JSON.', 'CLI_INVALID_CATALOG')
    }
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  child.on('error', onError)
  child.on('close', onClose)
  child.stdin.on('error', onError)
  child.stdout.on('data', onData)
  child.stderr.on('data', onStderr)
  send(openRequest(protocol))
  try {
    return await promise
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    child.stdout.off('data', onData)
    child.stderr.off('data', onStderr)
    child.stdin.off('error', onError)
    child.off('error', onError)
    child.off('close', onClose)
    child.kill()
    // A CLI that ignores the kill must not hold the caller open; discovery has already settled.
    await Promise.race([
      closed.then(() => undefined, () => undefined),
      new Promise<void>((grant) => { setTimeout(grant, CLOSE_GRACE_MS).unref() }),
    ])
  }
}
