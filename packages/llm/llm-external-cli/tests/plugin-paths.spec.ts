import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { ExternalCliAdapter } from '../src/adapter.ts'
import * as LlmExternalCli from '../src/index.ts'

// The Loader hands live settings as an object whose `get` reads the current
// value. Mounting `apply` without the schema passes that object through as is.
const live = (read: () => Record<string, unknown>): Record<string, unknown> => ({ get: read })
const unvalidated = { name: LlmExternalCli.name, inject: LlmExternalCli.inject, apply: LlmExternalCli.apply }

// The Loader's event, declared by a package this one does not depend on.
const volatileUpdate = (ctx: Context): void => {
  (ctx.emit as (this: Context, name: string, ...args: unknown[]) => void).call(ctx, 'loader/volatile-update', [])
}

const mount = async (config: Record<string, unknown>, setup?: (ctx: Context) => void): Promise<Context> => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  setup?.(ctx)
  await ctx.plugin(unvalidated, config)
  return ctx
}

describe('plugin configuration', () => {
  it('publishes a top-level command under its own provider name', async () => {
    const ctx = await mount({ command: 'my-cli', args: ['run'], timeoutMs: 1000, shell: false, provider: 'mine', providers: { mine: { command: 'my-cli' }, other: { command: 'other-cli' } } })
    expect(ctx.llm.listConfigurableProviders().map(entry => [entry.provider, entry.displayName])).toEqual([
      ['mine', 'Mine CLI'], ['other', 'Other CLI'],
    ])
  })

  it('names a top-level command without a provider the External CLI', async () => {
    const ctx = await mount({ command: 'my-cli' })
    expect(ctx.llm.listConfigurableProviders().map(entry => entry.displayName)).toEqual(['External CLI'])
  })

  it('registers nothing until a route is configured, then follows live settings', async () => {
    let providers: Record<string, unknown> = {}
    const ctx = await mount({ providers: live(() => providers) })
    expect(ctx.llm.listProviders()).toEqual([])
    providers = { codex: { command: 'codex', displayName: 'Work Codex' } }
    volatileUpdate(ctx)
    expect(ctx.llm.listConfigurableProviders().map(entry => entry.displayName)).toEqual(['Work Codex'])
    providers = { claude: { command: 'claude' } }
    volatileUpdate(ctx)
    expect(ctx.llm.listConfigurableProviders().map(entry => entry.provider)).toEqual(['claude'])
  })

  it('logs a live settings change it cannot apply and keeps the previous routes', async () => {
    let providers: Record<string, unknown> = { codex: { command: 'codex' } }
    const ctx = await mount({ providers: live(() => providers) })
    const logged = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    providers = { codex: { command: 'codex', models: [{ id: 'same' }, { id: 'same' }] } }
    volatileUpdate(ctx)
    expect(logged).toHaveBeenCalledWith('llm-external-cli: failed to update volatile registrations', expect.any(Error))
    expect(ctx.llm.listConfigurableProviders().map(entry => entry.provider)).toEqual(['codex'])
  })

  it('discovers nothing for an unknown route and only configured models for a custom CLI', async () => {
    const ctx = await mount({ providers: { custom: { command: 'custom-cli', cliType: 'custom' } } })
    expect(await ctx.llm.discoverModels('llm-external-cli', { provider: 'missing' })).toEqual([])
    expect(await ctx.llm.discoverModels('llm-external-cli', { baseURL: 'http://localhost' })).toEqual([])
    expect(await ctx.llm.discoverModels('llm-external-cli', { provider: 'custom' })).toEqual([])
  })

  it('declares its settings when the settings service is present', async () => {
    const configure = vi.fn(() => () => {})
    await mount({ providers: { codex: { command: 'codex' } } }, ctx => ctx.provide('settings', { configure } as never))
    expect(configure).toHaveBeenCalledWith({ auto: false }, expect.anything())
  })
})

describe('adapter model listing', () => {
  it('names configured routes by preset, display name, or route id', async () => {
    const adapter = new ExternalCliAdapter({ providers: { claude: { command: 'claude' }, tool: { command: 'tool' }, named: { command: 'x', displayName: 'Named' } } })
    expect((await adapter.listModels('cli')).map(model => model.name)).toEqual(['Claude Code CLI', 'Tool CLI', 'Named'])
  })

  it('does not repeat a known CLI given as the top-level command', async () => {
    const adapter = new ExternalCliAdapter({ command: 'Claude' })
    expect((await adapter.listModels('external-cli')).map(model => model.id)).toEqual(['agy', 'codex', 'claude', 'copilot'])
  })
})
