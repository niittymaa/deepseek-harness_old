import { describe, expect, it } from 'vitest'
import { createUserMessage, type ContentBlock, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { formatContentBlocks, formatPrompt, resolveCommandAndArgs, streamExternalCli } from '../src/process.ts'

const user = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

const collect = async (config: Parameters<typeof streamExternalCli>[0], options: Partial<GenerateOptions> = {}): Promise<StreamChunk[]> => {
  const chunks: StreamChunk[] = []
  for await (const chunk of streamExternalCli(config, { provider: 'external-cli', model: 'test', messages: [user('hi')], ...options })) chunks.push(chunk)
  return chunks
}

const node = (script: string) => ({ command: process.execPath, args: ['-e', script] })

describe('formatContentBlocks', () => {
  it('labels every block kind the CLI cannot receive natively', () => {
    const blocks = [
      { type: 'text', text: 'plain' },
      { type: 'reasoning', text: 'thought' },
      { type: 'tool-call', name: 'read', arguments: '{"path":"a"}' },
      { type: 'image', attachment: { name: 'shot.png' } },
      { type: 'file', attachment: { name: 'notes.txt' } },
      { type: 'future-kind' },
    ] as unknown as ContentBlock[]
    expect(formatContentBlocks(blocks)).toBe('plain\n<think>\nthought\n</think>\n[Tool Call: read({"path":"a"})]\n[Image: shot.png]\n[File: notes.txt]')
  })
})

describe('formatPrompt', () => {
  it('labels a single user message that carries more than text', () => {
    const message = createUserMessage({ content: [{ type: 'text', text: 'see' }, { type: 'image', attachment: { name: 'a.png' } }] as never, source: { kind: 'user' } })
    expect(formatPrompt({ provider: 'p', model: 'm', messages: [message] })).toBe('[User]\nsee\n[Image: a.png]\n\n[Assistant]\n')
  })

  it('asks for no reply when the conversation ends with the assistant', () => {
    const assistant = { role: 'assistant', content: [{ type: 'text', text: 'done' }] } as never
    expect(formatPrompt({ provider: 'p', model: 'm', messages: [user('hi'), assistant] })).toBe('[User]\nhi\n\n[Assistant]\ndone')
  })
})

describe('command resolution without a configured command', () => {
  it.each([
    [{ provider: 'Claude', model: 'other' }, 'claude'],
    [{ provider: 'external-cli', model: '  ' }, 'claude'],
    [{ provider: 'external-cli', model: 'my-tool' }, 'my-tool'],
  ])('resolves %j to %s', (selection, command) => {
    expect(resolveCommandAndArgs({}, { ...selection, messages: [] }).command).toBe(command)
  })
})

describe('streamExternalCli process outcomes', () => {
  it('reports the exit code when a failing CLI prints nothing', async () => {
    const chunks = await collect(node('process.exit(3)'))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'error', failure: {
      code: 'CLI_EXECUTION_ERROR', message: `CLI command "${process.execPath}" failed (code 3): Process exited with code 3`,
    } } })
  })

  it('answers with reasoning alone when the CLI only thinks', async () => {
    const chunks = await collect(node('process.stdout.write("<think>only thought</think>")'))
    expect(chunks.filter(chunk => chunk.type === 'reasoning-delta')).toEqual([{ type: 'reasoning-delta', index: 0, text: 'only thought' }])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('stops a CLI that outlasts its timeout', async () => {
    const chunks = await collect({ ...node('setTimeout(() => {}, 60000)'), timeoutMs: 50 })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'error', failure: {
      code: 'CLI_TIMEOUT', message: `CLI command "${process.execPath}" timed out after 50ms`,
    } } })
  })

  it('reports a CLI that cannot be started', async () => {
    const chunks = await collect({ command: 'dsh-no-such-cli-for-tests' })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'CLI_ERROR' } } })
  })

  it('reports an executable name the platform refuses before spawning', async () => {
    const chunks = await collect({ command: 'bad\0name' })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'CLI_SPAWN_FAILED' } } })
  })

  it('reports an abort that arrived before the CLI started', async () => {
    const controller = new AbortController()
    controller.abort()
    const chunks = await collect({ command: 'dsh-no-such-cli-for-tests' }, { signal: controller.signal })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'CLI execution aborted by signal' } } })
  })

  it('stops a running CLI when the turn is aborted', async () => {
    const controller = new AbortController()
    const stream = streamExternalCli(node('setTimeout(() => {}, 60000)'), { provider: 'external-cli', model: 'test', messages: [user('hi')], signal: controller.signal })
    setTimeout(() => { controller.abort() }, 50)
    const chunks: StreamChunk[] = []
    for await (const chunk of stream) chunks.push(chunk)
    expect(chunks.at(-1)?.type).toBe('finish')
  })
})
