/**
 * A serving route that learns its model catalog from its own endpoint: every
 * advertised model must appear in the catalog the Harness selects from, carry
 * the metadata the selector shows, and dispatch a request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

afterEach(async () => {
  await closeMockServers()
})

beforeEach(() => {
  vi.stubEnv('PI_TEST_KEY', 'test-key')
})

/** Direct adapter over the real profile resolver, with a fixed key per call. */
function adapterOf(
  providers: Record<string, LlmPiAi.PiAiProviderProfile>,
): PiAiAdapter {
  return new PiAiAdapter({
    profiles: () => resolveProfiles(providers),
    resolveApiKey: () => Promise.resolve('test-key'),
    auth: memoryAuth(),
  })
}

/** A gateway route that reads its models from the endpoint it serves. */
function gateway(baseURL: string, overrides: Partial<LlmPiAi.PiAiProviderProfile> = {}): Record<string, LlmPiAi.PiAiProviderProfile> {
  return {
    gateway: {
      apiKeyEnv: 'PI_TEST_KEY',
      api: 'openai-completions',
      baseURL,
      discoverModels: true,
      ...overrides,
    },
  }
}

const LISTING = {
  data: [
    {
      id: 'gw-large',
      name: 'Gateway Large',
      context_length: 65_536,
      max_output_tokens: 4096,
      input_modalities: ['text', 'image'],
      capabilities: { effort_tiers: ['none', 'low', 'high'] },
    },
    { id: 'gw-small' },
  ],
}

describe('endpoint-discovered models', () => {
  it('serves every model the endpoint advertises, with the metadata it discloses', async () => {
    const server = await mockServer([{ body: JSON.stringify(LISTING) }])
    const adapter = adapterOf(gateway(server.url))

    const models = await adapter.listModels('gateway')

    expect(models).toEqual([
      { provider: 'gateway', id: 'gw-large', name: 'Gateway Large', inputModalities: ['text', 'image'] },
      { provider: 'gateway', id: 'gw-small', name: 'gw-small', inputModalities: ['text'] },
    ])
    await expect(adapter.resolveModel('gateway', 'gw-large')).resolves.toMatchObject({
      context: { contextWindow: 65_536 },
      inputModalities: ['text', 'image'],
      reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }] },
    })
    expect(server.paths).toEqual(['/models'])
  })

  it('learns a model the last read did not see, for a selection restored from a Session', async () => {
    const server = await mockServer([
      { body: JSON.stringify({ data: [{ id: 'first' }] }) },
      { body: JSON.stringify({ data: [{ id: 'first' }, { id: 'second' }] }) },
    ])
    const adapter = adapterOf(gateway(server.url))

    expect((await adapter.listModels('gateway')).map(model => model.id)).toEqual(['first'])
    // The cache holds the first read; a model beyond it re-reads the endpoint.
    await expect(adapter.resolveModel('gateway', 'second')).resolves.toMatchObject({ id: 'second' })
    expect(server.paths).toEqual(['/models', '/models'])
  })

  it('dispatches a request to a model the endpoint supplied', async () => {
    const server = await mockServer([
      { body: JSON.stringify(LISTING) },
      { events: textEvents },
    ])
    const adapter = adapterOf(gateway(server.url))

    await adapter.listModels('gateway')
    const prepared = await adapter.prepareCall('gateway', 'gw-small')
    const chunks: unknown[] = []
    for await (const chunk of prepared.stream({
      provider: 'gateway',
      model: 'gw-small',
      messages: [],
    })) chunks.push(chunk)

    expect(chunks.length).toBeGreaterThan(0)
    expect(server.paths).toEqual(['/models', '/chat/completions'])
    expect(server.requests[1]).toMatchObject({ model: 'gw-small' })
  })

  it('keeps a configured entry over the listing row of the same id', async () => {
    const server = await mockServer([{ body: JSON.stringify(LISTING) }])
    const adapter = adapterOf(gateway(server.url, {
      models: [{ id: 'gw-large', name: 'Corrected Large', contextWindow: 131_072, maxTokens: 8192 }],
    }))

    const models = await adapter.listModels('gateway')

    expect(models.map(model => model.id)).toEqual(['gw-large', 'gw-small'])
    await expect(adapter.resolveModel('gateway', 'gw-large')).resolves.toMatchObject({
      name: 'Corrected Large',
      context: { contextWindow: 131_072 },
    })
  })

  it('keeps configured models serving when the listing read fails', async () => {
    const server = await mockServer([{ status: 500, body: '{"error":"boom"}' }])
    const adapter = adapterOf(gateway(server.url, { models: [{ id: 'configured' }] }))

    expect((await adapter.listModels('gateway')).map(model => model.id)).toEqual(['configured'])
  })

  it('reports a failed listing read when the route has nothing else to serve', async () => {
    const server = await mockServer([{ status: 500, body: '{"error":"boom"}' }])
    const adapter = adapterOf(gateway(server.url))

    await expect(adapter.listModels('gateway')).rejects.toThrow(/answered 500/)
  })

  it('reads one listing per interval, not one per selector open', async () => {
    const server = await mockServer([{ body: JSON.stringify(LISTING) }])
    const adapter = adapterOf(gateway(server.url))

    await adapter.listModels('gateway')
    await adapter.listModels('gateway')
    await adapter.listModels('gateway')

    expect(server.paths).toEqual(['/models'])
  })
})

describe('discovery configuration', () => {
  it('accepts a route whose models all come from its endpoint', () => {
    const profiles = resolveProfiles({
      gateway: { api: 'openai-completions', baseURL: 'https://gateway.test/v1', discoverModels: true },
    })
    expect(profiles.get('gateway')?.discoverModels).toBe(true)
    expect(profiles.get('gateway')?.piProvider?.getModels()).toEqual([])
  })

  it('names what a discovery route is missing', () => {
    expect(() => resolveProfiles({
      gateway: { baseURL: 'https://gateway.test/v1', discoverModels: true },
    })).toThrow(/discoverModels.*needs an "api"/)
    expect(() => resolveProfiles({
      gateway: { api: 'openai-completions', discoverModels: true },
    })).toThrow(/discoverModels.*needs a baseURL/)
    expect(() => resolveProfiles({
      gateway: { api: 'bedrock-converse-stream', baseURL: 'https://gateway.test', discoverModels: true },
    })).toThrow(/needs an "api" whose model listing/)
  })
})
