/**
 * Environment for spawned CLI processes.
 *
 * @module @deepseek-ai/dsh-llm-external-cli/env
 */

/** Variables a Claude Code session sets for its own child processes. */
const CLAUDE_SESSION_VARIABLE = /^(CLAUDECODE|CLAUDE_CODE_[A-Z0-9_]+|CLAUDE_PID|CLAUDE_EFFORT|AI_AGENT)$/

/**
 * The environment a CLI child starts with. An app launched from inside a
 * Claude Code session inherits that session's identity, messaging socket and
 * short-lived OAuth token; a child `claude` then authenticates with the
 * parent's token ("OAuth token revoked") instead of the user's own login.
 * Those variables are dropped only when the parent session marker is present,
 * so a token the user exported deliberately still applies.
 * @param env - Environment of the app process.
 * @returns Environment for the CLI child.
 */
export function cliChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env['CLAUDECODE'] === undefined) return env
  return Object.fromEntries(Object.entries(env).filter(([name]) => !CLAUDE_SESSION_VARIABLE.test(name)))
}
