import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, LlmRuntime, createUserMessage, ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { ExternalCliAdapter, DEFAULT_CONTEXT_WINDOW } from '../src/adapter.ts'
import { formatPrompt, parseAgyStream, parseThinkTags, resolveCommandAndArgs } from '../src/process.ts'
import * as LlmExternalCli from '../src/index.ts'
import { cliChildEnv } from '../src/env.ts'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('formatPrompt', () => {
  it('formats single user text message for completion mode without role wrapper', () => {
    const options: GenerateOptions = {
      provider: 'external-cli',
      model: 'claude',
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: 'Complete this sentence: In a galaxy far' }],
          source: { kind: 'user' },
        }),
      ],
    }
    const prompt = formatPrompt(options)
    expect(prompt).toBe('Complete this sentence: In a galaxy far')
  })

  it('formats multi-turn chat messages with role headers', () => {
    const options: GenerateOptions = {
      provider: 'external-cli',
      model: 'claude',
      system: 'You are a helpful coding assistant.',
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: 'Hello' }],
          source: { kind: 'user' },
        }),
      ],
    }
    const prompt = formatPrompt(options)
    expect(prompt).toContain('[System]\nYou are a helpful coding assistant.')
    expect(prompt).toContain('[User]\nHello')
    expect(prompt).toContain('[Assistant]\n')
  })
})

describe('parseThinkTags', () => {
  it('returns content directly when no think tags are present', () => {
    const parsed = parseThinkTags('Just a direct response.')
    expect(parsed.reasoning).toBeUndefined()
    expect(parsed.content).toBe('Just a direct response.')
  })

  it('extracts reasoning and content when think tags are present', () => {
    const parsed = parseThinkTags('<think>\nI am pondering the solution...\n</think>\nHere is the answer.')
    expect(parsed.reasoning).toBe('I am pondering the solution...')
    expect(parsed.content).toBe('Here is the answer.')
  })
})

describe('resolveCommandAndArgs', () => {
  it('uses explicit config command and args', () => {
    const resolved = resolveCommandAndArgs(
      { command: 'custom-cli', args: ['--custom-flag', 'val'] },
      { provider: 'external-cli', model: 'any-model', messages: [] },
    )
    expect(resolved.command).toBe('custom-cli')
    expect(resolved.args).toEqual(['--custom-flag', 'val'])
  })

  it('defaults to known CLI defaults when args are omitted', () => {
    const claude = resolveCommandAndArgs({}, { provider: 'external-cli', model: 'claude', messages: [] })
    expect(claude.command).toBe('claude')
    expect(claude.args).toEqual(['--print'])

    const codex = resolveCommandAndArgs({}, { provider: 'external-cli', model: 'codex', messages: [] })
    expect(codex.command).toBe('codex')
    expect(codex.args).toEqual(['exec', '--skip-git-repo-check'])

    const agy = resolveCommandAndArgs({}, { provider: 'external-cli', model: 'agy', messages: [] })
    expect(agy.command).toBe('agy')
    expect(agy.args).toEqual(['--input-format', 'stream-json', '--output-format', 'stream-json', '--print='])

    const copilot = resolveCommandAndArgs({}, { provider: 'external-cli', model: 'copilot', messages: [] })
    expect(copilot.command).toBe('copilot')
    expect(copilot.args).toEqual(['--silent'])
  })
})

describe('ExternalCliAdapter', () => {
  it('provides metadata and model information', async () => {
    const adapter = new ExternalCliAdapter({ command: 'claude' })
    expect(adapter.providerInfo('external-cli')).toEqual({ id: 'external-cli', name: 'External CLI' })

    const models = await adapter.listModels('external-cli')
    expect(models.map(m => m.id)).toContain('claude')
    expect(models.map(m => m.id)).toContain('agy')
    expect(models.map(m => m.id)).toContain('codex')
    expect(models.map(m => m.id)).toContain('copilot')

    const resolved = await adapter.resolveModel('external-cli', 'claude')
    expect(resolved.id).toBe('claude')
    expect(resolved.context?.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW)
  })

  it('offers a configured executable that is not a known CLI preset', async () => {
    const adapter = new ExternalCliAdapter({ command: 'my-cli' })
    expect((await adapter.listModels('external-cli')).map(model => model.id)).toEqual(['my-cli', 'agy', 'codex', 'claude', 'copilot'])
  })

  it('reports no models for a route it does not serve', async () => {
    const adapter = new ExternalCliAdapter({ providers: { codex: { command: 'codex-wrapper' } } })
    expect(await adapter.listModels('unknown-route')).toEqual([])
  })

  it('streams responses from a spawned child process', async () => {
    const adapter = new ExternalCliAdapter({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("Hello from external CLI")'],
    })

    const chunks = []
    for await (const chunk of adapter.stream({
      provider: 'external-cli',
      model: 'test',
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: 'Test prompt' }],
          source: { kind: 'user' },
        }),
      ],
    })) {
      chunks.push(chunk)
    }

    const assembler = new BlockAssembler()
    for (const chunk of chunks) {
      assembler.push(chunk)
    }

    expect(assembler.finish).toEqual({ kind: 'stop' })
    expect(assembler.blocks()).toEqual([{ type: 'text', text: 'Hello from external CLI' }])
  })

  it.each([
    'Permission denied in headless mode',
    'Individual quota reached. Resets in 70h14m29s.',
    '',
  ])('reports empty successful output with diagnostic %j', async (diagnostic) => {
    const adapter = new ExternalCliAdapter({
      command: process.execPath,
      args: ['-e', `process.stderr.write(${JSON.stringify(diagnostic)})`],
    })
    const chunks = []
    for await (const chunk of adapter.stream({ provider: 'external-cli', model: 'test', messages: [] })) {
      chunks.push(chunk)
    }
    expect(chunks).toEqual([{
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          code: 'CLI_EMPTY_OUTPUT',
          message: `CLI command "${process.execPath}" returned no response.${diagnostic ? ` ${diagnostic}` : ' Check the CLI authentication and noninteractive permissions.'}`,
        },
      },
    }])
  })

  it('separates reasoning when CLI outputs think tags', async () => {
    const adapter = new ExternalCliAdapter({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("<think>Thinking step</think>Final answer")'],
    })

    const chunks = []
    for await (const chunk of adapter.stream({
      provider: 'external-cli',
      model: 'test',
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: 'Test prompt' }],
          source: { kind: 'user' },
        }),
      ],
    })) {
      chunks.push(chunk)
    }

    const assembler = new BlockAssembler()
    for (const chunk of chunks) {
      assembler.push(chunk)
    }

    expect(assembler.finish).toEqual({ kind: 'stop' })
    expect(assembler.blocks()).toEqual([
      { type: 'reasoning', text: 'Thinking step' },
      { type: 'text', text: 'Final answer' },
    ])
  })

  it('passes prompt through stdin to the child process', async () => {
    const adapter = new ExternalCliAdapter({
      command: process.execPath,
      args: ['-e', 'let data = ""; process.stdin.on("data", c => data += c); process.stdin.on("end", () => process.stdout.write("ECHO: " + data.trim()))'],
    })

    const chunks = []
    for await (const chunk of adapter.stream({
      provider: 'external-cli',
      model: 'test',
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: 'Piped through stdin' }],
          source: { kind: 'user' },
        }),
      ],
    })) {
      chunks.push(chunk)
    }

    const assembler = new BlockAssembler()
    for (const chunk of chunks) {
      assembler.push(chunk)
    }

    expect(assembler.blocks()).toEqual([{ type: 'text', text: 'ECHO: Piped through stdin' }])
  })

  it('preserves a failed CLI diagnostic written to stdout', async () => {
    const adapter = new ExternalCliAdapter({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("Individual quota reached. Resets in 70h14m29s."); process.exitCode = 1'],
    })
    const chunks = []
    for await (const chunk of adapter.stream({ provider: 'external-cli', model: 'test', messages: [] })) {
      chunks.push(chunk)
    }
    expect(chunks).toEqual([{
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          code: 'CLI_EXECUTION_ERROR',
          message: `CLI command "${process.execPath}" failed (code 1): Individual quota reached. Resets in 70h14m29s.`,
        },
      },
    }])
  })

  it('handles child process failure with error finish chunk', async () => {
    const adapter = new ExternalCliAdapter({
      command: process.execPath,
      args: ['-e', 'process.stderr.write("CLI crashed"); process.exit(1)'],
    })

    const chunks = []
    for await (const chunk of adapter.stream({
      provider: 'external-cli',
      model: 'test',
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: 'Test failure' }],
          source: { kind: 'user' },
        }),
      ],
    })) {
      chunks.push(chunk)
    }

    const finish = chunks.find(c => c.type === 'finish')
    expect(finish).toBeDefined()
    expect(finish?.type === 'finish' && finish.reason.kind).toBe('error')
  })

  it('handles abort signal cleanly', async () => {
    const controller = new AbortController()
    const adapter = new ExternalCliAdapter({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => process.stdout.write("Done"), 5000)'],
    })

    setTimeout(() => { controller.abort() }, 100)

    const chunks = []
    for await (const chunk of adapter.stream({
      provider: 'external-cli',
      model: 'test',
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: 'Aborted run' }],
          source: { kind: 'user' },
        }),
      ],
      signal: controller.signal,
    })) {
      chunks.push(chunk)
    }

    const finish = chunks.find(c => c.type === 'finish')
    expect(finish).toBeDefined()
    expect(finish?.type === 'finish' && finish.reason.kind).toBe('aborted')
  })
})

describe('Cordis plugin registration', () => {
  it('remains dormant when mounted without command or providers', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmExternalCli, {})

    expect(ctx.llm.listProviders()).toEqual([])
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
  })

  it('registers external-cli in LlmRuntime when top-level command is configured', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmExternalCli, { command: 'agy' })

    const providers = ctx.llm.listProviders().map(p => p.id)
    expect(providers).toContain('cli')
    expect(providers).toContain('external-cli')

    const configurable = ctx.llm.listConfigurableProviders().map(p => p.provider)
    expect(configurable).toEqual(['external-cli'])
  })

  it('updates registrations dynamically on loader/volatile-update', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    let currentProviders: Record<string, LlmExternalCli.ExternalCliProviderProfile> = {}
    const DynamicPlugin = (innerCtx: Context, cfg: LlmExternalCli.Config): void => {
      LlmExternalCli.apply(innerCtx, cfg)
    }
    DynamicPlugin.inject = ['llm']

    await ctx.plugin(
      DynamicPlugin,
      {
        providers: {
          get: () => currentProviders,
        },
      },
    )

    expect(ctx.llm.listProviders()).toEqual([])

    currentProviders = {
      agy: {
        command: 'agy',
        displayName: 'Agy CLI',
      },
    }
    ctx.emit('loader/volatile-update', [['providers']])

    expect(ctx.llm.listProviders().map(p => p.id)).toContain('cli')
    expect(ctx.llm.listProviders().map(p => p.id)).toContain('agy')
    expect(ctx.llm.listConfigurableProviders().map(p => p.provider)).toEqual(['agy'])
  })

  it('runs keyless without requiring DEEPSEEK_API_KEY or credentials service', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmExternalCli, {
      command: process.execPath,
      args: ['-e', 'process.stdout.write("Keyless response")'],
    })

    const stream = ctx.llm.stream({
      provider: 'external-cli',
      model: 'agy',
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: 'Hello without API key' }],
          source: { kind: 'user' },
        }),
      ],
    })

    const assembler = new BlockAssembler()
    for await (const chunk of stream) {
      assembler.push(chunk)
    }

    expect(assembler.finish).toEqual({ kind: 'stop' })
    expect(assembler.blocks()).toEqual([{ type: 'text', text: 'Keyless response' }])
  })

  it('supports chat mode with multi-turn messages and tool results', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmExternalCli, {
      command: process.execPath,
      args: ['-e', 'let d=""; process.stdin.on("data", c => d += c); process.stdin.on("end", () => process.stdout.write("Processed chat with length " + d.length))'],
    })

    const stream = ctx.llm.stream({
      provider: 'external-cli',
      model: 'codex',
      system: 'You are Codex.',
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: 'First user message' }],
          source: { kind: 'user' },
        }),
      ],
    })

    const assembler = new BlockAssembler()
    for await (const chunk of stream) {
      assembler.push(chunk)
    }

    expect(assembler.finish).toEqual({ kind: 'stop' })
    expect(assembler.blocks()[0]?.type).toBe('text')
  })

  it('registers configured profiles in directory and resolves per-provider settings', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmExternalCli, {
      providers: {
        agy: {
          command: process.execPath,
          args: ['-e', 'process.stdout.write("Hello from Agy CLI")'],
          displayName: 'Agy Assistant',
        },
      },
    })

    const configurable = ctx.llm.listConfigurableProviders()
    const agyEntry = configurable.find(entry => entry.provider === 'agy')
    expect(agyEntry).toBeDefined()
    expect(agyEntry?.displayName).toBe('Agy Assistant')
    expect(agyEntry?.settingsNs).toBe('llm-external-cli')
    expect(agyEntry?.settingsPath).toEqual(['providers', 'agy'])

    const providers = ctx.llm.listProviders()
    const info = providers.find(p => p.id === 'agy')
    expect(info?.name).toBe('Agy Assistant')
    const cliInfo = providers.find(p => p.id === 'cli')
    expect(cliInfo?.name).toBe('CLI')

    // Models under CLI provider group
    const cliModels = await ctx.llm.listModels('cli')
    expect(cliModels).toEqual([
      { provider: 'cli', id: 'agy', name: 'Agy Assistant' },
    ])

    const stream = ctx.llm.stream({
      provider: 'cli',
      model: 'agy',
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: 'Hi' }],
          source: { kind: 'user' },
        }),
      ],
    })

    const assembler = new BlockAssembler()
    for await (const chunk of stream) {
      assembler.push(chunk)
    }
    expect(assembler.finish).toEqual({ kind: 'stop' })
    expect(assembler.blocks()).toEqual([{ type: 'text', text: 'Hello from Agy CLI' }])
  })
})


describe('CLI model selection', () => {
  it.each([
    ['codex', ['exec', '--skip-git-repo-check', '--model', 'chosen', '-c', 'model_reasoning_effort=high']],
    ['claude', ['--print', '--model', 'chosen', '--effort', 'high']],
    ['agy', ['--input-format', 'stream-json', '--output-format', 'stream-json', '--print=', '--model', 'chosen', '--effort', 'high']],
    ['copilot', ['--silent', '--model', 'chosen', '--reasoning-effort', 'high']],
  ] as const)('passes the selected model and effort to %s', (command, expected) => {
    const result = resolveCommandAndArgs({ providers: { route: {
      command, models: [{ id: 'chosen', reasoningEfforts: { high: 'high' } }],
    } } }, { provider: 'route', model: 'chosen', reasoningEffort: ReasoningEffortId('high'), messages: [] })
    expect(result.args).toEqual(expected)
  })

  it('offers actual models under their configured provider', async () => {
    const adapter = new ExternalCliAdapter({ providers: { codex: {
      command: 'codex-wrapper', models: [{ id: 'chosen', name: 'Chosen model', reasoningEfforts: { high: 'high' } }],
    } } })
    expect(await adapter.listModels('codex')).toContainEqual({ provider: 'codex', id: 'chosen', name: 'Chosen model' })
    expect(await adapter.resolveModel('codex', 'chosen')).toMatchObject({
      reasoning: { efforts: [{ id: 'high', name: 'high' }] },
    })
  })

  it('rejects a disappeared model instead of silently running the CLI default', () => {
    expect(() => resolveCommandAndArgs({ providers: { codex: { command: 'codex', models: [] } } }, {
      provider: 'codex', model: 'gone', messages: [],
    })).toThrow('unavailable')
  })

  it('rejects argument overrides that would disagree with the chat selection', () => {
    expect(() => resolveCommandAndArgs({ providers: { codex: {
      command: 'codex', args: ['exec', '--model=other'], models: [{ id: 'chosen' }],
    } } }, { provider: 'codex', model: 'chosen', messages: [] })).toThrow('Remove model and effort overrides')
  })

  it('substitutes custom model and effort arguments without splitting values', () => {
    expect(resolveCommandAndArgs({ providers: { custom: {
      command: 'my-cli', args: [], cliType: 'custom', modelArgs: ['model={model}'], effortArgs: ['effort={effort}'],
      models: [{ id: 'chosen', reasoningEfforts: { high: 'deep thinking' } }],
    } } }, { provider: 'custom', model: 'chosen', reasoningEffort: ReasoningEffortId('high'), messages: [] }).args)
      .toEqual(['model=chosen', 'effort=deep thinking'])
  })
})


it('runs the configured provider with the selected model and effort in a real child process', async () => {
  const adapter = new ExternalCliAdapter({ providers: { custom: {
    command: process.execPath, cliType: 'custom',
    args: ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify(process.argv.slice(1))))', '--'],
    modelArgs: ['{model}'], effortArgs: ['{effort}'],
    models: [{ id: 'selected-model', reasoningEfforts: { high: 'deep' } }],
  } } })
  const assembler = new BlockAssembler()
  for await (const chunk of adapter.stream({ provider: 'custom', model: 'selected-model',
    reasoningEffort: ReasoningEffortId('high'), messages: [] })) assembler.push(chunk)
  expect(assembler.blocks()).toEqual([{ type: 'text', text: '["selected-model","deep"]' }])
})


it.each([
  [{ command: 'custom-cli', cliType: 'custom' as const, models: [{ id: 'chosen' }] }, undefined, 'modelArgs'],
  [{ command: 'custom-cli', cliType: 'custom' as const, modelArgs: ['{model}'], models: [{ id: 'chosen', reasoningEfforts: { high: 'high' } }] }, 'high', 'effortArgs'],
  [{ command: 'codex', models: [{ id: 'chosen' }] }, 'high', 'does not support'],
])('rejects incomplete model or effort configuration', (profile, effort, diagnostic) => {
  expect(() => resolveCommandAndArgs({ providers: { route: profile } }, {
    provider: 'route', model: 'chosen', messages: [], ...effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) },
  })).toThrow(diagnostic)
})

it('leaves the CLI model and effort defaults untouched for the default entry', () => {
  expect(resolveCommandAndArgs({ providers: { codex: { command: 'codex', args: ['exec'] } } }, {
    provider: 'codex', model: 'codex', messages: [],
  })).toEqual({ command: 'codex', args: ['exec', '--skip-git-repo-check'] })
})

it.each([
  ['agy', ['--print', '-'], ['--input-format', 'stream-json', '--output-format', 'stream-json', '--print=', '--effort', 'high']],
  ['claude', ['--print'], ['--print', '--effort', 'high']],
  ['codex', ['exec'], ['exec', '--skip-git-repo-check', '-c', 'model_reasoning_effort=high']],
  ['copilot', [], ['--silent', '--reasoning-effort', 'high']],
] as const)('sends the chosen level to the %s default entry', (route, args, expected) => {
  expect(resolveCommandAndArgs({ providers: { [route]: { command: route, args: [...args] } } }, {
    provider: route, model: route, reasoningEffort: ReasoningEffortId('high'), messages: [],
  }).args).toEqual([...expected])
})

it('sends the chosen level for an alias entry that names a configured route', () => {
  expect(resolveCommandAndArgs({ providers: { agy: { command: 'agy' } } }, {
    provider: 'cli', model: 'agy', reasoningEffort: ReasoningEffortId('medium'), messages: [],
  }).args).toEqual(['--input-format', 'stream-json', '--output-format', 'stream-json', '--print=', '--effort', 'medium'])
})

it('uses configured effort arguments for the default entry', () => {
  expect(resolveCommandAndArgs({ providers: { agy: { command: 'agy', effortArgs: ['--reasoning-effort', '{effort}'] } } }, {
    provider: 'agy', model: 'agy', reasoningEffort: ReasoningEffortId('low'), messages: [],
  }).args).toEqual(['--input-format', 'stream-json', '--output-format', 'stream-json', '--print=', '--reasoning-effort', 'low'])
})

it('refuses a level the CLI default does not accept', () => {
  expect(() => resolveCommandAndArgs({ providers: { copilot: { command: 'copilot' } } }, {
    provider: 'copilot', model: 'copilot', reasoningEffort: ReasoningEffortId('ultra'), messages: [],
  })).toThrow('CLI default model does not support')
})

it('refuses a level for a custom CLI that declares no vocabulary', () => {
  expect(() => resolveCommandAndArgs({ providers: { route: { command: 'sh', cliType: 'custom' } } }, {
    provider: 'route', model: 'route', reasoningEffort: ReasoningEffortId('high'), messages: [],
  })).toThrow('CLI default model does not support')
})

it('refuses a level when the CLI arguments already override the effort', () => {
  expect(() => resolveCommandAndArgs({ providers: { agy: { command: 'agy', args: ['--print', '-', '--effort', 'low'] } } }, {
    provider: 'agy', model: 'agy', reasoningEffort: ReasoningEffortId('high'), messages: [],
  })).toThrow('Remove model and effort overrides')
})

it('supports an explicit Off entry without sending an effort option', () => {
  expect(resolveCommandAndArgs({ providers: { codex: { command: 'codex', models: [{ id: 'chosen', reasoningEfforts: { off: null } }] } } }, {
    provider: 'codex', model: 'chosen', reasoningEffort: ReasoningEffortId('off'), messages: [],
  }).args).toEqual(['exec', '--skip-git-repo-check', '--model', 'chosen'])
})


it.each([
  { models: [{ id: '' }] }, { models: [{ id: 'route' }] }, { models: [{ id: 'duplicate' }, { id: 'duplicate' }] },
])('refuses ambiguous configured model identifiers before publishing the catalog', ({ models }) => {
  expect(() => new ExternalCliAdapter({ providers: { route: { command: 'codex', models } } })).toThrow('unique')
})

it.each([{ '': 'high' }, { high: '' }])('refuses empty reasoning declarations before publishing the catalog', (reasoningEfforts) => {
  expect(() => new ExternalCliAdapter({ providers: { route: { command: 'codex', models: [{ id: 'chosen', reasoningEfforts }] } } })).toThrow('non-empty')
})


it('withdraws CLI routes, settings entries and discovery when the plugin unloads', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const fork = ctx.plugin(LlmExternalCli, { providers: { codex: { command: 'codex-wrapper', models: [{ id: 'chosen' }] } } })
  await fork
  const llm = ctx.llm
  expect(await llm.discoverModels('llm-external-cli', { provider: 'codex' })).toEqual([{ id: 'chosen' }])
  await fork.dispose()
  expect(llm.listProviders()).toEqual([])
  expect(llm.listConfigurableProviders()).toEqual([])
  await expect(llm.discoverModels('llm-external-cli', { provider: 'codex' })).rejects.toThrow('no model discovery')

})


it('uses the explicit CLI protocol for default arguments when the executable is a wrapper', () => {
  expect(resolveCommandAndArgs({ providers: { custom: {
    command: 'my-wrapper', cliType: 'codex', models: [{ id: 'chosen' }],
  } } }, { provider: 'custom', model: 'chosen', messages: [] }).args).toEqual(['exec', '--skip-git-repo-check', '--model', 'chosen'])
})

describe('cliChildEnv', () => {
  it('drops a parent Claude Code session identity', () => {
    const env = cliChildEnv({ PATH: 'p', CLAUDECODE: '1', CLAUDE_CODE_OAUTH_TOKEN: 't', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_PID: '1', AI_AGENT: 'x', ANTHROPIC_API_KEY: 'k' })
    expect(env).toEqual({ PATH: 'p', ANTHROPIC_API_KEY: 'k' })
  })

  it('keeps a token the user exported outside a Claude Code session', () => {
    const env = { PATH: 'p', CLAUDE_CODE_OAUTH_TOKEN: 't' }
    expect(cliChildEnv(env)).toBe(env)
  })
})

describe('parseAgyStream', () => {
  it('reads the reply from the final result event', () => {
    const out = '{"event":"init"}\n{"event":"result","result":{"status":"SUCCESS","response":"51\\n"}}\n'
    expect(parseAgyStream(out)).toEqual({ response: '51\n' })
  })

  it('reports the error of a failed run', () => {
    expect(parseAgyStream('{"event":"result","result":{"status":"ERROR","error":"denied"}}')).toEqual({ error: 'denied' })
  })
})

describe('Session working directory', () => {
  const runIn = async (adapter: ExternalCliAdapter, sessionId?: string): Promise<string> => {
    let text = ''
    for await (const chunk of adapter.stream({
      provider: 'external-cli', model: 'test',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'pwd' }], source: { kind: 'user' } })],
      ...sessionId === undefined ? {} : { sessionId },
    } as unknown as GenerateOptions)) {
      if (chunk.type === 'text-delta') text += chunk.text
    }
    return text
  }
  const printCwd = { command: process.execPath, args: ['-e', 'process.stdout.write(process.cwd())'] }

  it('runs the CLI in the Session working directory', async () => {
    const project = mkdtempSync(join(tmpdir(), 'dsh-cli-cwd-'))
    const adapter = new ExternalCliAdapter(printCwd)
    adapter.resolveSession = sessionId => sessionId === 'session-1' ? { cwd: project } : {}
    expect(realpathSync(await runIn(adapter, 'session-1'))).toBe(realpathSync(project))
  })

  it('runs the CLI in the app directory without a Session directory', async () => {
    const adapter = new ExternalCliAdapter(printCwd)
    expect(await runIn(adapter)).toBe(process.cwd())
    expect(await runIn(adapter, 'session-without-host')).toBe(process.cwd())
  })
})

describe('headless defaults', () => {
  it.each([
    ['codex', ['exec', '--skip-git-repo-check'], ['exec', '--skip-git-repo-check']],
    ['codex', ['review'], ['review']],
    ['copilot', ['-s'], ['-s']],
    ['copilot', ['--silent'], ['--silent']],
    ['agy', ['--print=hello'], ['--print=hello']],
    ['agy', ['-p', '-', '--mode', 'auto'], ['--input-format', 'stream-json', '--output-format', 'stream-json', '--print=', '--mode', 'auto']],
  ] as const)('keeps what a %s route already sets', (command, args, expected) => {
    expect(resolveCommandAndArgs({ providers: { [command]: { command, args: [...args] } } }, {
      provider: command, model: command, messages: [],
    }).args).toEqual([...expected])
  })
})

describe('parseAgyStream edge cases', () => {
  it.each([
    ['plain text\n{not json\n{"event":"init"}\n{"event":"result"}', { error: 'plain text\n{not json\n{"event":"init"}\n{"event":"result"}' }],
    ['', { error: 'Agy returned no result event' }],
    ['{"event":"result","result":{"status":"SUCCESS"}}', { response: '' }],
    ['{"event":"result","result":{"status":"CANCELLED"}}', { error: 'Agy finished with status CANCELLED' }],
    ['{"event":"result","result":{}}', { error: 'Agy finished with status unknown' }],
  ])('parses %j', (stdout, expected) => {
    expect(parseAgyStream(stdout)).toEqual(expected)
  })
})

describe('Agy stream-json turns', () => {
  // A stand-in for agy: it reads the stream-json user message from stdin and
  // answers with a result event, as `agy --input-format stream-json` does.
  const fakeAgy = (status: string): string => 'let s=\'\';process.stdin.on(\'data\',d=>s+=d).on(\'end\',()=>{const m=JSON.parse(s);'
    + `const nl=String.fromCharCode(10);process.stdout.write(JSON.stringify({event:'init'})+nl+JSON.stringify({event:'result',result:{status:'${status}',response:'got:'+m.message.content,error:'denied'}})+nl)})`
  const run = async (status: string): Promise<StreamChunk[]> => {
    const adapter = new ExternalCliAdapter({ providers: { agy: {
      command: process.execPath, cliType: 'agy', args: ['-e', fakeAgy(status), '--', '--input-format', 'stream-json'],
    } } })
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({ provider: 'agy', model: 'agy', messages: [
      createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }),
    ] })) chunks.push(chunk)
    return chunks
  }

  it('sends the prompt as a stream-json message and answers with the result', async () => {
    const chunks = await run('SUCCESS')
    expect(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')).toBe('got:hello')
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('reports the error of a failed Agy turn', async () => {
    const chunks = await run('ERROR')
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'error', failure: {
      code: 'CLI_EXECUTION_ERROR', message: `CLI command "${process.execPath}" failed: denied`,
    } } })
  })
})

describe('plugin Session directory lookup', () => {
  const printCwd = { command: process.execPath, cliType: 'custom' as const, args: ['-e', 'process.stdout.write(process.cwd())'] }
  const turn = async (ctx: Context, sessionId: string): Promise<string> => {
    let text = ''
    for await (const chunk of ctx.llm.stream({ provider: 'route', model: 'route', sessionId, messages: [
      createUserMessage({ content: [{ type: 'text', text: 'pwd' }], source: { kind: 'user' } }),
    ] } as unknown as GenerateOptions)) if (chunk.type === 'text-delta') text += chunk.text
    return text
  }

  it('runs the CLI in the directory the working-directory service records for the Session', async () => {
    const project = mkdtempSync(join(tmpdir(), 'dsh-cli-plugin-cwd-'))
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.provide('sessions', { get: (id: string) => id === 'known' ? { id } : undefined } as never)
    ctx.provide('workingDirectory', { get: () => project } as never)
    await ctx.plugin(LlmExternalCli, { providers: { route: printCwd } })
    expect(realpathSync(await turn(ctx, 'known'))).toBe(realpathSync(project))
    expect(await turn(ctx, 'unknown')).toBe(process.cwd())
  })

  it('runs the CLI in the app directory on a host without Sessions', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmExternalCli, { providers: { route: printCwd } })
    expect(await turn(ctx, 'any')).toBe(process.cwd())
  })
})

describe('Session file access', () => {
  const resolve = (command: string, sandbox: 'read-only' | 'workspace-write' | 'danger-full-access', args?: string[]) =>
    resolveCommandAndArgs({ providers: { [command]: { command, ...args === undefined ? {} : { args } } } },
      { provider: command, model: command, messages: [] }, sandbox).args

  it.each([
    ['claude', 'read-only', ['--print', '--permission-mode', 'plan']],
    ['claude', 'workspace-write', ['--print', '--permission-mode', 'acceptEdits']],
    ['claude', 'danger-full-access', ['--print', '--permission-mode', 'bypassPermissions']],
    ['agy', 'read-only', ['--input-format', 'stream-json', '--output-format', 'stream-json', '--print=', '--mode', 'plan']],
    ['agy', 'workspace-write', ['--input-format', 'stream-json', '--output-format', 'stream-json', '--print=', '--sandbox', '--dangerously-skip-permissions']],
    ['agy', 'danger-full-access', ['--input-format', 'stream-json', '--output-format', 'stream-json', '--print=', '--dangerously-skip-permissions']],
    ['codex', 'read-only', ['exec', '--skip-git-repo-check', '--sandbox', 'read-only']],
    ['codex', 'workspace-write', ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write']],
    ['codex', 'danger-full-access', ['exec', '--skip-git-repo-check', '--sandbox', 'danger-full-access']],
    ['copilot', 'read-only', ['--silent', '--allow-all-tools', '--deny-tool', 'shell', '--deny-tool', 'write']],
    ['copilot', 'workspace-write', ['--silent', '--allow-all-tools']],
    ['copilot', 'danger-full-access', ['--silent', '--allow-all']],
  ] as const)('grants %s the %s access of the Session', (command, sandbox, expected) => {
    expect(resolve(command, sandbox)).toEqual([...expected])
  })

  it('keeps the permissions a route sets itself', () => {
    expect(resolve('claude', 'danger-full-access', ['--print', '--permission-mode=plan'])).toEqual(['--print', '--permission-mode=plan'])
    expect(resolve('codex', 'danger-full-access', ['exec', '-s', 'read-only'])).toEqual(['exec', '-s', 'read-only', '--skip-git-repo-check'])
  })

  it('adds nothing for a custom CLI', () => {
    expect(resolveCommandAndArgs({ providers: { tool: { command: 'tool', cliType: 'custom' } } }, { provider: 'tool', model: 'tool', messages: [] }, 'workspace-write').args).toEqual([])
  })
})
