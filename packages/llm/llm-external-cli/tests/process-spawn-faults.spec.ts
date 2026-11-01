import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'

// Faults a real child process cannot produce on demand: non-Error throws and
// a stdin pipe that breaks while the prompt is written.
const spawn = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn }))

const { streamExternalCli } = await import('../src/process.ts')

const run = async (): Promise<StreamChunk[]> => {
  const chunks: StreamChunk[] = []
  for await (const chunk of streamExternalCli({ command: 'fake' }, {
    provider: 'external-cli', model: 'test',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
  })) chunks.push(chunk)
  return chunks
}

afterEach(() => spawn.mockReset())

describe('spawn faults', () => {
  it('reports a non-Error thrown while spawning', async () => {
    spawn.mockImplementation(() => { throw 'spawn refused' })
    expect((await run()).at(-1)).toEqual({ type: 'finish', reason: { kind: 'error', failure: {
      code: 'CLI_SPAWN_FAILED', message: 'Failed to spawn CLI command "fake": spawn refused',
    } } })
  })

  it('survives a broken stdin and reports a non-Error process failure', async () => {
    const proc = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: Object.assign(new EventEmitter(), {
        write: () => { throw new Error('EPIPE') },
        end: () => {},
      }),
      kill: () => { throw new Error('already gone') },
    })
    spawn.mockReturnValue(proc)
    const chunks = run()
    await new Promise(resolve => setImmediate(resolve))
    proc.stdin.emit('error', new Error('EPIPE'))
    proc.emit('error', 'process vanished')
    expect((await chunks).at(-1)).toEqual({ type: 'finish', reason: { kind: 'error', failure: {
      code: 'CLI_ERROR', message: 'process vanished',
    } } })
  })
})
