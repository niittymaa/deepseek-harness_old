/**
 * Answering "which models can this provider serve?" for the configuration
 * surface's "fetch available models" action.
 *
 * A route the installed pi-ai catalog ships is answered **from that catalog**,
 * with no network call at all: pi-ai's registry is the authoritative list for
 * its own providers, and it carries the capacities a listing endpoint would
 * not disclose. Only a route the catalog does not describe — a gateway, a
 * self-hosted server — is interrogated over the wire.
 *
 * Neither path is a catalog refresh. Nothing here is stored: the request
 * carries a draft the user is still editing, and the reply is candidate
 * metadata the surface offers for adoption. `cordis.patch.yml` remains the only
 * thing that decides what a route serves.
 *
 * OpenAI-compatible and Anthropic Messages protocols are interrogated through
 * their native model-listing endpoints. The parser accepts the standard
 * `data` array and the enriched `models` map some compatible gateways expose.
 * Every other protocol reports that it cannot be interrogated so the surface
 * falls back to hand-entry rather than guessing its response fields.
 *
 * @module dsh-llm-pi-ai/discovery
 */

import { INVALID_CREDENTIAL_CODE, LlmError, normalizeApiKey } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel, LlmModelDiscoveryOperation } from '@deepseek-ai/dsh-llm'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { catalogModels, THINKING_LEVELS } from './catalog.ts'
import type { PiAiModality, PiAiReasoningEfforts } from './catalog.ts'

/**
 * Protocols whose model listing this module can read. OpenAI protocols use
 * bearer auth at `GET {baseURL}/models`; Anthropic Messages uses `x-api-key`
 * and `anthropic-version` at its native `GET /v1/models`. Azure is absent
 * despite its OpenAI lineage — it authenticates with an `api-key` header and
 * requires an `api-version` query — and Codex authenticates through OAuth;
 * guessing at either would report an authentication failure as a provider
 * with no models. pi-ai's remaining protocols are absent for the same reason.
 */
export const DISCOVERY_PROTOCOLS: ReadonlySet<string> = new Set([
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
])

/** The protocols whose model listing this module can read. */
const LISTABLE_PROTOCOLS = DISCOVERY_PROTOCOLS

/** Stable API version required by Anthropic's model-listing endpoint. */
const ANTHROPIC_VERSION = '2023-06-01'

/** Largest model-list page accepted by Anthropic's public endpoint; discovery reads one page and does not follow `has_more`. */
const ANTHROPIC_MODEL_LIMIT = 1000

/**
 * Endpoint replies larger than this are refused. The endpoint is whatever URL
 * the user typed, so the ceiling holds on the bytes actually read rather than
 * on the length the server claims — the same two-stage shape `dsh-web-fetch`
 * uses for its own caller-supplied URLs, except that a truncated model listing
 * is not parseable, so overflow rejects instead of truncating.
 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** Capacity fields nested by enriched model-directory replies. */
interface ListingLimit {
  context?: unknown
  output?: unknown
}

/** Per-route capacities OpenRouter nests under each entry. */
interface ListingTopProvider {
  max_completion_tokens?: unknown
}

/** One entry of a supported `GET /models` reply. */
interface ListingEntry {
  id?: unknown
  /** Common gateway extensions; absent from the official listings. */
  name?: unknown
  display_name?: unknown
  displayName?: unknown
  contextWindow?: unknown
  context_window?: unknown
  context_length?: unknown
  max_input_tokens?: unknown
  maxOutputTokens?: unknown
  max_tokens?: unknown
  max_output_tokens?: unknown
  maxTokens?: unknown
  limit?: ListingLimit | null
  top_provider?: ListingTopProvider | null
  /** Accepted input types, which gateways spell either way. */
  input_modalities?: unknown
  inputModalities?: unknown
  /** Capability bag some gateways nest effort tiers and vision inside. */
  capabilities?: unknown
  /** Selectable reasoning levels a gateway discloses. */
  effort_tiers?: unknown
}

/**
 * One model a provider's listing describes, with the facts a route needs to
 * serve it. Unlike the configuration surface's narrower
 * {@link LlmDiscoveredModel}, this carries what model dispatch reads.
 */
export interface PiAiListedModel {
  /** Model id the endpoint accepts. */
  id: string
  /** Display name; the id when the endpoint discloses none. */
  name: string
  /** Maximum combined request and response context, when disclosed. */
  contextWindow?: number
  /** Maximum output tokens, when disclosed. */
  maxTokens?: number
  /** Accepted input types, when disclosed. */
  input?: PiAiModality[]
  /** Selectable reasoning levels and their wire spellings, when disclosed. */
  reasoningEfforts?: PiAiReasoningEfforts
}

/** A positive integer field of a listing entry, or `undefined` when absent or unusable. */
function capacity(...candidates: readonly unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate
  }
  return undefined
}

/** A non-empty string field of a listing entry, or `undefined`. */
function label(...candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/**
 * The input modalities one entry discloses, or `undefined` when it says
 * nothing. A declared list wins over the capability bag; the bag's `vision`
 * flag is the other spelling gateways use, and text is the floor every
 * supported protocol carries.
 * @param entry - one listing entry.
 * @returns the declared modalities, or none.
 */
function listedInput(entry: ListingEntry): PiAiModality[] | undefined {
  const declared = entry.input_modalities ?? entry.inputModalities
  if (Array.isArray(declared)) {
    const modalities = declared.filter((value): value is PiAiModality => value === 'text' || value === 'image')
    if (modalities.length > 0) return [...new Set(modalities)]
  }
  const capabilities = entry.capabilities
  if (capabilities !== null && typeof capabilities === 'object' && Reflect.get(capabilities, 'vision') === true) {
    return ['text', 'image']
  }
  return undefined
}

/**
 * The reasoning levels one entry discloses, translated to pi-ai's level
 * vocabulary. Every level the endpoint does not name is pinned to `null`
 * (unsupported) because pi-ai otherwise assumes the base levels stand, which
 * would offer a tier the provider may reject; `off` stays absent so it keeps
 * meaning "send nothing". A list offering only `none` states no selectable
 * reasoning.
 * @param entry - one listing entry.
 * @returns the disclosed levels, or none.
 */
function listedEfforts(entry: ListingEntry): PiAiReasoningEfforts | undefined {
  const capabilities = entry.capabilities
  const nested: unknown = capabilities !== null && typeof capabilities === 'object'
    ? Reflect.get(capabilities, 'effort_tiers')
    : undefined
  const declared: unknown = entry.effort_tiers ?? nested
  if (!Array.isArray(declared)) return undefined
  const offered = new Map<string, string>()
  for (const tier of declared) {
    if (typeof tier !== 'string' || tier.length === 0) continue
    const level = tier === 'none' || tier === 'off' ? 'off' : tier
    if (!(THINKING_LEVELS as readonly string[]).includes(level)) continue
    offered.set(level, tier)
  }
  if (![...offered.keys()].some(level => level !== 'off')) return undefined
  const efforts: PiAiReasoningEfforts = {}
  for (const level of THINKING_LEVELS) {
    // `off` is pi-ai's absence of the parameter, not a wire spelling.
    if (level === 'off') continue
    efforts[level] = offered.get(level) ?? null
  }
  return efforts
}

/**
 * Join the endpoint base with the protocol's listing path. The base is
 * treated as a prefix rather than a URL to resolve against, so a deployment
 * path such as `https://gateway.example/openai/v1` keeps its segments instead
 * of losing them to `URL` resolution. OpenAI protocols list at
 * `{baseURL}/models`. Anthropic lists at `{root}/v1/models`, where the root is
 * the base without trailing slashes and without one trailing `/v1` segment:
 * gateway documentation publishes both spellings of the same root. Only this
 * listing URL normalizes that segment; model requests receive the configured
 * `baseURL` unchanged.
 */
function listingUrl(baseURL: string, api: string): string {
  const base = baseURL.replace(/\/+$/, '')
  if (api !== 'anthropic-messages') return `${base}/models`
  const root = base.endsWith('/v1') ? base.slice(0, -3) : base
  return `${root}/v1/models?limit=${String(ANTHROPIC_MODEL_LIMIT)}`
}

/**
 * Read a reply body, refusing one that outgrows the ceiling. A declared length
 * is checked first so an honest server is turned away without transferring
 * anything; the accumulated total is what actually enforces the bound, because
 * a server that under-declares (or streams) tells us nothing up front.
 */
async function readBounded(response: Response, url: string): Promise<string> {
  const oversized = (): LlmError =>
    new LlmError(`${url} answered with more than ${MAX_RESPONSE_BYTES} bytes`, 'DISCOVERY_FAILED')
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw oversized()
  }
  /* v8 ignore next -- fetch always exposes a body stream on a 2xx Response; the null guard is defensive. */
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw oversized()
      chunks.push(value)
    }
  } finally {
    /* v8 ignore next 4 -- cancel() after a completed or abandoned read settles without rejecting; unobserved best-effort cleanup. */
    await reader.cancel().catch(() => {
      // Cancel after a drained read, or after this function walked away from
      // an oversized one, is cleanup; the reply is already decided either way.
    })
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

/**
 * Read one supported model-listing reply into the facts a route serves from.
 * The standard `data` array takes precedence when both supported formats are
 * present. An enriched `models` map uses each property key as the
 * endpoint-facing id; its nested `id` is only a fallback for an empty key
 * because gateways may put a canonical model identity there instead of the
 * alias they accept on requests. Only object-valued map entries are models;
 * primitive properties are ignored because they may be directory metadata
 * rather than model records.
 *
 * Entries without a usable id are skipped rather than failing the whole
 * interrogation: a single malformed row should not deny the user the rest of
 * a working endpoint's catalog. Missing names fall back to the adopted id so
 * every caller receives a complete human-readable row.
 * @param body - the parsed listing reply.
 * @returns the described models in endpoint order.
 * @throws LlmError when the reply is neither supported listing shape.
 */
export function readModelListing(body: unknown): PiAiListedModel[] {
  const listing = body as { data?: unknown; models?: unknown } | null
  const data = listing?.data
  let listed: { readonly key?: string; readonly raw: unknown }[]
  if (Array.isArray(data)) {
    const rows = data as readonly unknown[]
    listed = rows.map(raw => ({ raw }))
  } else {
    const models = listing?.models
    if (models === null || typeof models !== 'object' || Array.isArray(models)) {
      throw new LlmError(
        'the endpoint\'s model listing has neither a "data" array nor a "models" object; '
        + 'enter this provider\'s models by hand',
        'DISCOVERY_FAILED',
      )
    }
    listed = Object.entries(models as Record<string, unknown>)
      .filter(([, raw]) => raw !== null && typeof raw === 'object' && !Array.isArray(raw))
      .map(([key, raw]) => ({ key, raw }))
  }
  const models: PiAiListedModel[] = []
  for (const { key, raw } of listed) {
    const entry = raw as ListingEntry | null
    const id = label(key, entry?.id)
    // A row naming no id describes nothing dispatch could address; every other
    // row is served even when it discloses nothing but its id.
    if (id === undefined) continue
    const described: ListingEntry = entry ?? {}
    const name = label(described.name, described.display_name, described.displayName) ?? id
    const contextWindow = capacity(
      described.contextWindow,
      described.context_window,
      described.context_length,
      described.max_input_tokens,
      described.limit?.context,
    )
    const maxTokens = capacity(
      described.maxOutputTokens,
      described.max_output_tokens,
      described.maxTokens,
      described.max_tokens,
      described.limit?.output,
      described.top_provider?.max_completion_tokens,
    )
    const input = listedInput(described)
    const reasoningEfforts = listedEfforts(described)
    models.push({
      id,
      name,
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
      ...input === undefined ? {} : { input },
      ...reasoningEfforts === undefined ? {} : { reasoningEfforts },
    })
  }
  return models
}

/**
 * Accept one probe key, or refuse it before the header is built. Without this
 * the `fetch` below would throw a ByteString `TypeError` that this function's
 * catch reports as `could not reach <url>` — blaming the network for a local,
 * deterministic fault.
 * @param raw - the key typed into the form or read from storage.
 * @returns the trimmed, usable key.
 */
function usableProbeKey(raw: string): string {
  const checked = normalizeApiKey(raw)
  if (checked.ok) return checked.value
  throw new LlmError(
    checked.reason === 'empty'
      ? 'this provider\'s API key is blank; enter it on the Models page, or clear it to probe unauthenticated'
      : 'this provider\'s API key contains characters no HTTP header can carry; paste the raw key only',
    INVALID_CREDENTIAL_CODE,
  )
}

/** Host-owned profile inputs that a configuration draft deliberately omits. */
export interface StoredModelDiscoveryProfile {
  /** Deployment headers configured on the named route. */
  readonly headers: Readonly<Record<string, string>> | undefined
  /** Resolve the named route's credential only when the draft carries none. */
  readonly resolveApiKey: () => Promise<string | undefined>
}

/** Inputs for one endpoint listing read at request time. */
export interface EndpointListingRequest {
  /** Endpoint base the listing path is appended to. */
  baseURL: string
  /** Wire protocol, deciding the listing path and header shape; defaults to OpenAI Chat Completions. */
  api?: string
  /** Credential for this read alone; `undefined` reads unauthenticated. */
  apiKey?: string
  /** Deployment-owned headers sent with the request. */
  headers?: Readonly<Record<string, string>>
  /** Caller cancellation. */
  signal?: AbortSignal
}

/**
 * Read one endpoint's advertised models. This is the same interrogation the
 * configuration surface offers, minus its draft semantics: a served route reads
 * its own listing with the credential and headers it already has.
 * @param request - endpoint, protocol, credential, headers, and cancellation.
 * @returns the advertised models in endpoint order.
 * @throws LlmError when the protocol has no readable listing, the endpoint
 *   refuses or fails the request, or the reply is not a model listing.
 */
export async function fetchModelListing(request: EndpointListingRequest): Promise<PiAiListedModel[]> {
  const api = request.api ?? 'openai-completions'
  if (!LISTABLE_PROTOCOLS.has(api)) {
    throw new LlmError(
      `pi-ai protocol "${api}" has no model listing this build can read; enter this provider's models by hand`,
      'DISCOVERY_UNSUPPORTED',
    )
  }
  const url = listingUrl(request.baseURL, api)
  const apiKey = request.apiKey === undefined ? undefined : usableProbeKey(request.apiKey)
  let response: Response
  try {
    const headers = new Headers(request.headers === undefined ? undefined : Object.entries(request.headers))
    headers.set('accept', 'application/json')
    if (api === 'anthropic-messages') {
      headers.set('anthropic-version', ANTHROPIC_VERSION)
      if (apiKey !== undefined) headers.set('x-api-key', apiKey)
    } else if (apiKey !== undefined) {
      headers.set('authorization', `Bearer ${apiKey}`)
    }
    for (const [name, value] of Object.entries(attributionHeaders())) headers.set(name, value)
    response = await fetch(url, {
      method: 'GET',
      headers,
      ...request.signal === undefined ? {} : { signal: request.signal },
    })
  } catch (error: unknown) {
    if (request.signal?.aborted) {
      throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    throw new LlmError(`could not reach ${url}`, 'DISCOVERY_FAILED', { cause: error })
  }
  if (!response.ok) {
    throw new LlmError(
      `${url} answered ${response.status}${response.status === 401 || response.status === 403 ? '; check the API key' : ''}`,
      'DISCOVERY_FAILED',
    )
  }
  let text: string
  try {
    text = await readBounded(response, url)
  } catch (error: unknown) {
    // Cancellation during the body read rejects with the abort reason, which
    // may be any value; the caller gets the same coded failure it would have
    // for a cancellation before the request went out.
    if (request.signal?.aborted) {
      throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    throw error
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch (error: unknown) {
    throw new LlmError(`${url} did not answer with JSON`, 'DISCOVERY_FAILED', { cause: error })
  }
  return readModelListing(body)
}

/**
 * Interrogate one draft provider endpoint for the models it advertises.
 * @param request - the endpoint, protocol, and one-shot credential to use.
 * @param storedProfile - Host-owned headers and lazy credential resolution for
 *   the named route. It is read only on the path that reaches the network; the
 *   credential is resolved only when the draft carries none.
 * @returns the advertised models in endpoint order.
 * @throws LlmError when the protocol has no readable listing, the endpoint
 *   refuses or fails the request, or the reply is not a model listing.
 */
export async function discoverModels(
  request: LlmModelDiscoveryOperation,
  storedProfile?: () => StoredModelDiscoveryProfile | undefined,
): Promise<readonly LlmDiscoveredModel[]> {
  // A catalog route already has its answer, and a better one: the installed
  // entries carry context windows and output caps no listing endpoint reports.
  if (request.provider !== undefined) {
    const installed = catalogModels(request.provider)
    if (installed.size > 0) {
      return [...installed.values()].map(model => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        inputModalities: [...model.input],
      }))
    }
  }
  if (request.baseURL === undefined || request.baseURL.length === 0) {
    throw new LlmError(
      `pi-ai ships no catalog for provider "${request.provider ?? ''}", so its models can only come from its`
      + " endpoint; set a baseURL, or enter this provider's models by hand",
      'DISCOVERY_FAILED',
    )
  }
  // A key typed into the form wins: it may replace the stored key that is
  // failing. The stored profile is asked past the catalog check, and its
  // credential resolver remains lazy so a typed key cannot fail over a stored
  // credential it supersedes. A route may still authenticate through a
  // deployment-owned Authorization header when neither key exists. A draft that
  // has not chosen a protocol yet is asked as OpenAI Chat Completions: it is
  // the shape a gateway is overwhelmingly likely to speak, and the alternative
  // — refusing until the field is filled — would withhold the action from the
  // case it exists for.
  const stored = storedProfile?.()
  const supplied = request.apiKey ?? await stored?.resolveApiKey()
  const listed = await fetchModelListing({
    baseURL: request.baseURL,
    ...request.api === undefined ? {} : { api: request.api },
    ...supplied === undefined ? {} : { apiKey: supplied },
    ...stored?.headers === undefined ? {} : { headers: stored.headers },
    ...request.signal === undefined ? {} : { signal: request.signal },
  })
  // The configuration surface adopts ids and capacities only; what dispatch
  // reads stays inside the adapter that serves the route.
  return listed.map(model => ({
    id: model.id,
    name: model.name,
    ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
    ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
    ...model.input === undefined ? {} : { inputModalities: [...model.input] },
  }))
}
