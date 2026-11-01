// @vitest-environment jsdom
/** Tests for Local CLI provider card and configuration integration. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { LocalCliCard } from '../src/client/LocalCliCard.tsx'
import { ModelsSection } from '../src/client/ModelsSection.tsx'
import type { ModelsSectionProps } from '../src/client/ModelsSection.tsx'
import { ProviderEditor } from '../src/client/ProviderEditor.tsx'
import { ModelsSettingsStore } from '../src/client/store.ts'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createModelsOperations } from '../src/client/operations.ts'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(cleanup)

const t = (key: keyof typeof en): string => en[key]

function ok<T>(value: T) {
  return { ok: true as const, value }
}

function mockOperations(mutateFn = vi.fn().mockResolvedValue(ok({ revision: 1, user: {} }))) {
  const ctx = new Context()
  const remote = {
    settings: {
      mutate: mutateFn,
      read: vi.fn(),
      describe: vi.fn(),
    },
    credentials: {
      resolve: vi.fn(),
      set: vi.fn().mockResolvedValue(ok(undefined)),
      unset: vi.fn().mockResolvedValue(ok(undefined)),
      describe: vi.fn().mockResolvedValue(ok([])),
    },
    llm: {
      listModels: vi.fn().mockResolvedValue(ok([])),
      discoverModels: vi.fn(),
    },
    session: {
      initializeDefaultModel: vi.fn(),
    },
  }
  ctx.provide('remote', remote)
  ctx.provide('remote.settings', remote.settings)
  ctx.provide('remote.credentials', remote.credentials)
  ctx.provide('remote.llm', remote.llm)
  ctx.provide('remote.session', remote.session)
  return { operations: createModelsOperations(ctx), mutate: mutateFn }
}

describe('LocalCliCard', () => {
  it('pre-fills defaults for Agy preset and writes profile on create', async () => {
    const { operations, mutate } = mockOperations()
    const onClose = vi.fn()

    render(
      <LocalCliCard
        taken={[]}
        revision={1}
        operations={operations}
        t={t}
        readOnly={false}
        onClose={onClose}
      />,
    )

    // Preset dropdown defaults to Agy CLI
    expect(screen.getByLabelText<HTMLSelectElement>(en.cliPreset).value).toBe('agy')
    expect(screen.getByLabelText<HTMLInputElement>(en.cliRoute).value).toBe('agy')
    expect(screen.getByLabelText<HTMLInputElement>(en.cliDisplayName).value).toBe('Agy CLI')
    expect(screen.getByLabelText<HTMLInputElement>(en.cliCommand).value).toBe('agy')
    expect(screen.getByLabelText<HTMLInputElement>(en.cliArgs).value).toBe('--print -')

    fireEvent.click(screen.getByText(en.create))

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledWith(true)
    })

    expect(mutate).toHaveBeenCalledWith(
      'llm-external-cli',
      [
        {
          op: 'set',
          path: ['providers', 'agy'],
          value: {
            cliType: 'agy',
            command: 'agy',
            args: ['--print', '-'],
            displayName: 'Agy CLI',
          },
        },
      ],
      1,
    )
  })

  it('switches presets and pre-fills Claude and Codex configurations', () => {
    const { operations } = mockOperations()
    const onClose = vi.fn()

    render(
      <LocalCliCard
        taken={[]}
        revision={1}
        operations={operations}
        t={t}
        readOnly={false}
        onClose={onClose}
      />,
    )

    // Switch to Claude Code
    fireEvent.change(screen.getByLabelText(en.cliPreset), { target: { value: 'claude' } })
    expect(screen.getByLabelText<HTMLInputElement>(en.cliRoute).value).toBe('claude')
    expect(screen.getByLabelText<HTMLInputElement>(en.cliDisplayName).value).toBe('Claude Code CLI')
    expect(screen.getByLabelText<HTMLInputElement>(en.cliCommand).value).toBe('claude')
    expect(screen.getByLabelText<HTMLInputElement>(en.cliArgs).value).toBe('--print')

    // Switch to Codex
    fireEvent.change(screen.getByLabelText(en.cliPreset), { target: { value: 'codex' } })
    expect(screen.getByLabelText<HTMLInputElement>(en.cliRoute).value).toBe('codex')
    expect(screen.getByLabelText<HTMLInputElement>(en.cliDisplayName).value).toBe('Codex CLI')
    expect(screen.getByLabelText<HTMLInputElement>(en.cliCommand).value).toBe('codex')
    expect(screen.getByLabelText<HTMLInputElement>(en.cliArgs).value).toBe('exec')

    // Switch to Custom CLI
    fireEvent.change(screen.getByLabelText(en.cliPreset), { target: { value: 'custom' } })
    expect(screen.getByLabelText<HTMLInputElement>(en.cliRoute).value).toBe('')
    expect(screen.getByLabelText<HTMLInputElement>(en.cliRoute).disabled).toBe(false)
    expect(screen.getByLabelText<HTMLInputElement>(en.cliCommand).value).toBe('')
  })

  it('validates custom route format and unique route constraint', () => {
    const { operations } = mockOperations()
    const onClose = vi.fn()

    render(
      <LocalCliCard
        taken={['existing-cli']}
        revision={1}
        operations={operations}
        t={t}
        readOnly={false}
        onClose={onClose}
      />,
    )

    fireEvent.change(screen.getByLabelText(en.cliPreset), { target: { value: 'custom' } })

    // Invalid format with uppercase
    fireEvent.change(screen.getByLabelText(en.cliRoute), { target: { value: 'My-CLI' } })
    expect(screen.getByText(en.cliRouteInvalid)).toBeTruthy()

    // Taken route
    fireEvent.change(screen.getByLabelText(en.cliRoute), { target: { value: 'existing-cli' } })
    expect(screen.getByText(en.cliRouteTaken)).toBeTruthy()
  })
})

describe('ProviderEditor for CLI provider', () => {
  it('renders command and args fields and updates profile without key input', async () => {
    const { operations, mutate } = mockOperations(
      vi.fn().mockResolvedValue(ok({ revision: 2, view: { user: { command: 'agy-v2' }, revision: 2 } })),
    )
    const onClose = vi.fn()

    const namespace: SettingsNamespaceView = {
      ns: 'llm-external-cli',
      schema: JSON.parse(JSON.stringify(Schema.object({
        providers: Schema.dict(Schema.object({
          command: Schema.string(),
          args: Schema.array(Schema.string()),
          displayName: Schema.string(),
        })),
      }).toJSON())) as JsonValue,
      value: {
        providers: {
          agy: {
            cliType: 'agy',
            command: 'agy',
            args: ['--print', '-'],
            displayName: 'Agy CLI',
          },
        },
      },
      user: {
        providers: {
          agy: {
            cliType: 'agy',
            command: 'agy',
            args: ['--print', '-'],
            displayName: 'Agy CLI',
          },
        },
      },
      base: {},
      autoGenerate: false,
      applies: 'live',
      secrets: [],
      revision: 1,
    }

    render(
      <ProviderEditor
        provider="agy"
        displayName="Agy CLI"
        namespace={namespace}
        schema={settingsSchema}
        settingsPath={['providers', 'agy']}
        operations={operations}
        t={t}
        readOnly={false}
        onClose={onClose}
      />,
    )

    // Key input should NOT be present for CLI provider
    expect(screen.queryByLabelText(en.keyInput)).toBeNull()

    // Command and arguments inputs should be rendered
    const cmdInput = screen.getByLabelText(en.cliCommand) as HTMLInputElement
    expect(cmdInput.value).toBe('agy')
    const argsInput = screen.getByLabelText(en.cliArgs) as HTMLInputElement
    expect(argsInput.value).toBe('--print -')

    // Edit command
    fireEvent.change(cmdInput, { target: { value: 'agy-v2' } })
    fireEvent.click(screen.getByText(en.apply))

    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith(
        'llm-external-cli',
        [
          {
            op: 'set',
            path: ['providers', 'agy', 'command'],
            value: 'agy-v2',
          },
        ],
        1,
      )
    })
  })
})

describe('ModelsSection with CLI mode', () => {
  it('renders Local CLI tab and opens LocalCliCard when clicked', async () => {
    const ctx = new Context()
    const cliNamespace: SettingsNamespaceView = {
      ns: 'llm-external-cli',
      schema: JSON.parse(JSON.stringify(Schema.object({
        providers: Schema.dict(Schema.object({
          command: Schema.string(),
          args: Schema.array(Schema.string()),
          displayName: Schema.string(),
        })),
      }).toJSON())) as JsonValue,
      value: { providers: {} },
      user: { providers: {} },
      base: {},
      autoGenerate: false,
      applies: 'live',
      secrets: [],
      revision: 1,
    }

    const piAiNamespace: SettingsNamespaceView = {
      ns: 'llm-pi-ai',
      schema: JSON.parse(JSON.stringify(Schema.object({
        providers: Schema.dict(Schema.object({
          api: Schema.union(['openai-completions', 'anthropic-messages']),
          baseURL: Schema.string(),
          models: Schema.array(Schema.object({ id: Schema.string() })),
        })),
      }).toJSON())) as JsonValue,
      value: { providers: {} },
      user: { providers: {} },
      base: {},
      autoGenerate: false,
      applies: 'live',
      secrets: [],
      revision: 1,
    }

    const remote = {
      settings: {
        describe: vi.fn().mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [cliNamespace, piAiNamespace] })),
        mutate: vi.fn().mockResolvedValue(ok(cliNamespace)),
        update: vi.fn(),
        read: vi.fn(),
      },
      credentials: {
        describe: vi.fn().mockResolvedValue(ok({})),
        set: vi.fn(),
        unset: vi.fn(),
        resolve: vi.fn(),
      },
      llm: {
        listProviders: vi.fn().mockResolvedValue(ok([])),
        listConfigurableProviders: vi.fn().mockResolvedValue(ok([
          { provider: 'openai', displayName: 'OpenAI', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'] },
        ])),
        discoverModels: vi.fn().mockResolvedValue(ok([])),
        listModels: vi.fn().mockResolvedValue(ok([])),
      },
      session: {
        initializeDefaultModel: vi.fn(),
      },
    }

    ctx.provide('remote', remote)
    ctx.provide('remote.settings', remote.settings)
    ctx.provide('remote.credentials', remote.credentials)
    ctx.provide('remote.llm', remote.llm)
    ctx.provide('remote.session', remote.session)

    const mirror = new SettingsDescribeMirror(ctx)
    const controller = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await controller.load()

    const injected: ModelsSectionProps = {
      controller,
      useSnapshot: bindSnapshotSelector(controller.store),
      operations: createModelsOperations(ctx),
      schema: settingsSchema,
      t,
      renderSlot: vi.fn(),
    }

    render(<ModelsSection {...injected} />)

    // Click "Add model provider"
    fireEvent.click(screen.getByRole('button', { name: en.add }))

    // SegmentedControl should have all 3 tabs:
    expect(screen.getByRole('tab', { name: en.addCatalog })).toBeTruthy()
    expect(screen.getByRole('tab', { name: en.addCustom })).toBeTruthy()
    const cliTab = screen.getByRole('tab', { name: en.addCli })
    expect(cliTab).toBeTruthy()

    // Switch to Local CLI tab
    fireEvent.click(cliTab)
    expect(cliTab.getAttribute('aria-selected')).toBe('true')

    // LocalCliCard fields should be visible
    expect(screen.getByLabelText(en.cliPreset)).toBeTruthy()
    expect(screen.getByLabelText(en.cliCommand)).toBeTruthy()
  })
})
