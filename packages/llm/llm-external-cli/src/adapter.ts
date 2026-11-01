/**
 * External CLI provider adapter for the DeepSeek Harness LLM seam.
 *
 * @module @deepseek-ai/dsh-llm-external-cli/adapter
 */

import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { ExternalCliModel, ExternalCliOptions, ExternalCliProviderProfile } from './config.ts'
import { streamExternalCli } from './process.ts'
import { cliEffortLevels, discoverCliModels, mergeModels } from './catalog.ts'

/** Default context window token limit for external CLI models. */
export const DEFAULT_CONTEXT_WINDOW = 128000

/** Known preset names mapped to friendly titles. */
const PRESET_NAMES: Record<string, string> = {
  agy: 'Agy CLI',
  claude: 'Claude Code CLI',
  codex: 'Codex CLI',
  copilot: 'GitHub Copilot CLI',
}

/** Refuse ambiguous configured catalogs before publishing model choices. */
function validateCatalogs(config: ExternalCliOptions): void {
  for (const [provider, profile] of Object.entries(config.providers ?? {})) {
    const seen = new Set<string>([provider])
    for (const model of profile.models ?? []) {
      if (model.id.trim().length === 0 || seen.has(model.id)) {
        throw new LlmError(`CLI model identifiers must be non-empty and unique, and cannot equal the provider identifier: ${provider}`, 'CLI_INVALID_MODELS')
      }
      seen.add(model.id)
      for (const [effort, value] of Object.entries(model.reasoningEfforts ?? {})) {
        if (effort.trim().length === 0 || (value !== null && value.trim().length === 0)) {
          throw new LlmError(`CLI reasoning levels and values must be non-empty: ${provider}/${model.id}`, 'CLI_INVALID_EFFORTS')
        }
      }
    }
  }
}

/**
 * Adapter that dispatches LLM requests to a local CLI command via stdin/stdout.
 */
export class ExternalCliAdapter extends LlmAdapter {
  private config: ExternalCliOptions
  /** Catalog the last discovery read for each route, refreshed by the model menu. */
  private readonly catalogs = new Map<string, readonly ExternalCliModel[]>()
  /**
   * The working directory of a Session, so the CLI's own tools act on the
   * user's project as they do when the CLI runs in a terminal there. Unset or
   * undefined runs the CLI in the app's directory.
   */
  resolveCwd?: (sessionId: string) => string | undefined

  /**
   * Create a new ExternalCliAdapter instance.
   * @param config - Provider configuration options.
   */
  constructor(config: ExternalCliOptions = {}) {
    super()
    validateCatalogs(config)
    this.config = config
  }

  /**
   * Update effective adapter configuration on live settings changes.
   * @param config - New external CLI options.
   */
  updateConfig(config: ExternalCliOptions): void {
    validateCatalogs(config)
    this.config = config
    // A profile may now name another executable, so catalogs read from the replaced one no longer describe it.
    this.catalogs.clear()
  }

  /**
   * Return display metadata for the provider route.
   * @param provider - Route identifier.
   * @returns Provider display info.
   */
  override providerInfo(provider: string): LlmProviderInfo {
    if (provider.toLowerCase() === 'cli') {
      return { id: provider, name: 'CLI' }
    }
    if (provider.toLowerCase() === 'external-cli') {
      return { id: provider, name: 'External CLI' }
    }
    const profile = this.config.providers?.[provider]
    const name = profile?.displayName
      ?? PRESET_NAMES[provider.toLowerCase()]
      ?? `${provider.charAt(0).toUpperCase() + provider.slice(1)} CLI`
    return { id: provider, name }
  }

  /**
   * List discoverable models for the external CLI provider.
   * Groups all configured CLI provider profiles under the CLI provider group.
   * @param provider - Route identifier.
   * @returns List of model descriptors.
   */
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const profile = this.config.providers?.[provider]
    if (profile !== undefined) {
      let discovered: readonly ExternalCliModel[]
      try {
        discovered = await this.refreshCatalog(provider, profile)
      } catch (error) {
        // The settings discovery operation reports the failure; saved models remain usable in chat.
        if ((profile.models?.length ?? 0) === 0) throw error
        discovered = []
      }
      const merged = mergeModels(discovered, profile.models ?? [])
      // Models first: the CLI default entry defers model and effort to the CLI,
      // so it carries no reasoning levels and belongs after the choices that do.
      return Promise.resolve([
        ...merged.map(model => ({ provider, id: model.id, name: model.name ?? model.id })),
        { provider, id: provider, name: `${profile.displayName ?? provider} (CLI default)` },
      ])
    }
    if (provider.toLowerCase() === 'cli' || provider.toLowerCase() === 'external-cli') {
      const configuredIds = Object.keys(this.config.providers ?? {})
      if (configuredIds.length > 0) {
        const models: LlmModelInfo[] = []
        for (const id of configuredIds) {
          const profile = this.config.providers?.[id]
          const displayName = profile?.displayName
            ?? PRESET_NAMES[id.toLowerCase()]
            ?? `${id.charAt(0).toUpperCase() + id.slice(1)} CLI`
          models.push({
            provider,
            id,
            name: displayName,
          })
        }
        return Promise.resolve(models)
      }

      // When no user profiles are configured in settings yet, list known CLI tools
      const known = ['agy', 'codex', 'claude', 'copilot']
      const models: LlmModelInfo[] = known.map(id => ({
        provider,
        id,
        name: PRESET_NAMES[id] ?? `${id.charAt(0).toUpperCase() + id.slice(1)} CLI`,
      }))
      if (this.config.command !== undefined && !known.includes(this.config.command.toLowerCase())) {
        models.unshift({
          provider,
          id: this.config.command,
          name: `${this.config.command} (CLI)`,
        })
      }
      return Promise.resolve(models)
    }

    return Promise.resolve([])
  }

  /**
   * Resolve exact model metadata from the configured entries and the catalog
   * last discovered for the route, without starting the CLI.
   * @param provider - Route identifier.
   * @param model - Model identifier.
   * @param _signal - Optional abort signal.
   * @returns Resolved model metadata with default context window.
   */
  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const route = this.config.providers?.[provider]
    const profile = route ?? this.config.providers?.[model]
    const selected = this.catalog(provider, profile).find(entry => entry.id === model)
    const name = selected?.name ?? (selected === undefined ? profile?.displayName : model)
      ?? PRESET_NAMES[model.toLowerCase()]
      ?? PRESET_NAMES[provider.toLowerCase()]
      ?? model
    // The CLI default entry runs without a model option, so its levels are the
    // ones the CLI applies to its own configured model.
    const runsCliDefault = profile !== undefined
      && (model === provider || this.config.providers?.[model] !== undefined)
    const levels = selected?.reasoningEfforts === undefined
      ? runsCliDefault
        ? cliEffortLevels({ ...profile, command: profile.command ?? (route === undefined ? model : provider) })
        : []
      : Object.keys(selected.reasoningEfforts)
    return Promise.resolve({
      provider,
      id: model,
      name,
      context: { contextWindow: DEFAULT_CONTEXT_WINDOW },
      ...levels.length === 0 ? {} : {
        reasoning: { efforts: levels.map(id => ({ id: ReasoningEffortId(id), name: id })) },
      },
    })
  }

  /**
   * Stream model chunks by invoking the configured CLI tool via stdin/stdout.
   * @param options - Full generate options.
   * @returns Async iterable yielding canonical StreamChunks.
   */
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const config = this.config
    const cwd = options.sessionId === undefined ? undefined : this.resolveCwd?.(options.sessionId)
    const profile = config.providers?.[options.provider]
    if (profile === undefined) {
      yield* streamExternalCli(config, options, cwd)
      return
    }
    // A model the chat lists without saving it is served from a fresh catalog;
    // a configured one streams with the catalog this adapter already holds.
    if (options.model !== options.provider && !(profile.models ?? []).some(model => model.id === options.model)) {
      await this.refreshCatalog(options.provider, profile, options.signal)
    }
    yield* streamExternalCli({ ...config, providers: { ...config.providers,
      [options.provider]: { ...profile, models: this.catalog(options.provider, profile) },
    } }, options, cwd)
  }

  /**
   * Models a route offers: its configured entries over the catalog last
   * discovered for it. Reads only; discovery refreshes through {@link refreshCatalog}.
   * @param provider - Route identifier.
   * @param profile - Profile configured for the route, when it has one.
   * @returns One entry per model identifier, discovered models first.
   */
  private catalog(provider: string, profile: ExternalCliProviderProfile | undefined): ExternalCliModel[] {
    const discovered = this.config.providers?.[provider] === undefined ? [] : this.catalogs.get(provider) ?? []
    return mergeModels(discovered, profile?.models ?? [])
  }

  /**
   * Discover one route's catalog and keep it for later resolutions. A failed
   * discovery leaves the last good catalog in place.
   * @param provider - Route identifier.
   * @param profile - Executable and discovery limits.
   * @param signal - Optional caller cancellation.
   * @returns The discovered models, in CLI order.
   */
  private async refreshCatalog(
    provider: string,
    profile: ExternalCliProviderProfile,
    signal?: AbortSignal,
  ): Promise<readonly ExternalCliModel[]> {
    const discovered = await discoverCliModels(profile, signal)
    this.catalogs.set(provider, discovered)
    return discovered
  }
}
