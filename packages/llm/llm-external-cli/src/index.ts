/**
 * External CLI provider plugin for DeepSeek Harness.
 * Routes model calls to local LLM CLIs (Agy, Codex, Claude Code, Copilot) via stdin/stdout.
 *
 * @module @deepseek-ai/dsh-llm-external-cli
 */

import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { Context } from '@deepseek-ai/cordis'
import type { AdapterRegistrationHandle, DirectoryRegistrationHandle, LlmConfigurableProvider } from '@deepseek-ai/dsh-llm'
import { ExternalCliAdapter } from './adapter.ts'
import { discoverCliModels, mergeModels } from './catalog.ts'
import type { CliSandboxMode, Config, ExternalCliOptions, ExternalCliProviderProfile } from './config.ts'

export { ExternalCliAdapter, DEFAULT_CONTEXT_WINDOW } from './adapter.ts'
export { Config, type ExternalCliOptions, type ExternalCliProviderProfile, type ExternalCliModel } from './config.ts'
export { formatPrompt, parseThinkTags, resolveCommandAndArgs, streamExternalCli } from './process.ts'

/** Configuration accepted from the Loader or direct plugin mounting. */
type PluginConfig = Config | ExternalCliOptions

/** Cordis plugin name. */
export const name = 'llm-external-cli'

/** Required service dependencies. */
export const inject = ['llm']

/**
 * Mount the external CLI provider plugin.
 * Registers the ExternalCliAdapter on preset routes and any user-configured routes.
 * @param ctx - Cordis context with LLM service.
 * @param config - Provider configuration options.
 */
export function apply(ctx: Context, config: PluginConfig = {}): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })

  const getEffectiveConfig = (): ExternalCliOptions & { providers: Record<string, ExternalCliProviderProfile> } => {
    const rawProviders = config.providers !== undefined
      ? typeof (config.providers as { get?: () => unknown }).get === 'function'
        ? (config.providers as { get: () => unknown }).get()
        : config.providers
      : undefined
    const effective: ExternalCliOptions & { providers: Record<string, ExternalCliProviderProfile> } = {
      providers: (rawProviders as Record<string, ExternalCliProviderProfile> | undefined) ?? {},
    }
    if (config.command !== undefined) effective.command = config.command
    if (config.args !== undefined) effective.args = config.args
    if (config.timeoutMs !== undefined) effective.timeoutMs = config.timeoutMs
    if (config.shell !== undefined) effective.shell = config.shell
    if (config.provider !== undefined) effective.provider = config.provider
    return effective
  }

  let effectiveConfig = getEffectiveConfig()
  const primaryProvider = effectiveConfig.provider ?? 'external-cli'
  const adapter = new ExternalCliAdapter(effectiveConfig)
  // Optional services, looked up per turn: a host without Sessions, a
  // working directory or permission presets runs the CLI in the app's
  // directory with the CLI's own permission settings.
  adapter.resolveSession = (sessionId) => {
    const session = (ctx.get('sessions') as { get(id: string): unknown } | undefined)?.get(sessionId)
    if (session === undefined) return {}
    const directory = ctx.get('workingDirectory') as { get(session: unknown): string } | undefined
    const presets = ctx.get('permissionPresets') as { current(session: unknown): string; resolve(name: string): { sandbox: CliSandboxMode } } | undefined
    const shell = ctx.get('shell') as { sandboxMode: CliSandboxMode } | undefined
    let sandbox: CliSandboxMode | undefined
    if (presets !== undefined) {
      // A custom knob combination names no preset; the shell's mode then applies.
      try { sandbox = presets.resolve(presets.current(session)).sandbox } catch { sandbox = shell?.sandboxMode }
    }
    return {
      ...directory === undefined ? {} : { cwd: directory.get(session) },
      ...sandbox === undefined ? {} : { sandbox },
    }
  }

  let adapterRegistration: AdapterRegistrationHandle | undefined
  let directoryRegistration: DirectoryRegistrationHandle | undefined

  const ensureRegistrations = (): void => {
    effectiveConfig = getEffectiveConfig()
    adapter.updateConfig(effectiveConfig)

    const configuredIds = Object.keys(effectiveConfig.providers)
    const hasTopLevelCommand = effectiveConfig.command !== undefined
    const hasAnyConfig = hasTopLevelCommand || configuredIds.length > 0
    const allRoutes = hasAnyConfig
      ? Array.from(new Set([
        'cli',
        ...hasTopLevelCommand ? [primaryProvider] : [],
        ...configuredIds,
      ]))
      : []

    if (adapterRegistration === undefined) {
      if (allRoutes.length > 0) {
        adapterRegistration = ctx.llm.registerAdapter(allRoutes, adapter)
      }
    } else {
      adapterRegistration.replace(allRoutes)
    }

    const directoryEntries: LlmConfigurableProvider[] = []
    if (hasTopLevelCommand) {
      directoryEntries.push({
        provider: primaryProvider,
        displayName: primaryProvider === 'external-cli' ? 'External CLI' : `${primaryProvider.charAt(0).toUpperCase() + primaryProvider.slice(1)} CLI`,
        settingsNs: name,
        settingsPath: ['providers', primaryProvider],
        declared: true,
      })
    }
    for (const id of configuredIds) {
      if (hasTopLevelCommand && id === primaryProvider) continue
      const profile = effectiveConfig.providers[id]
      directoryEntries.push({
        provider: id,
        displayName: profile?.displayName ?? `${id.charAt(0).toUpperCase() + id.slice(1)} CLI`,
        settingsNs: name,
        settingsPath: ['providers', id],
        declared: true,
      })
    }

    if (directoryRegistration === undefined) {
      if (directoryEntries.length > 0) {
        directoryRegistration = ctx.llm.registerConfigurableProviders(directoryEntries)
      }
    } else {
      directoryRegistration.replace(directoryEntries)
    }
  }

  ensureRegistrations()
  ctx.llm.registerModelDiscovery(name, async (request, signal) => {
    const profile = getEffectiveConfig().providers[request.provider ?? '']
    if (profile === undefined) return []
    const discovered = await discoverCliModels(profile, signal)
    return mergeModels(discovered, profile.models ?? [])
  })

  ctx.on('loader/volatile-update', () => {
    try {
      ensureRegistrations()
    } catch (error) {
      ctx.logger.error('llm-external-cli: failed to update volatile registrations', error)
    }
  })
}
