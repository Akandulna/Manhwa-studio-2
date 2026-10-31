import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  db: { audioSection: { findUnique: vi.fn(), update: vi.fn() } }
}))
vi.mock('child_process', () => ({ spawn: mocks.spawn }))
vi.mock('../../index.js', () => ({ prisma: mocks.db }))
vi.mock('../alignment/beatFormatter.js', () => ({ buildTimelineScript: () => '00:00 - 00:01: text' }))
vi.mock('../alignment/alignmentDocument.js', () => ({ writeAlignmentDocument: vi.fn().mockResolvedValue(true) }))
vi.mock('../seriesProcess.js', () => ({ notifySeriesProcessChanged: vi.fn() }))
import { alignSection, alignmentProgress, pendingAlignments } from '../alignment/alignmentService.js'

function sidecar() {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() }),
    kill: vi.fn()
  })
}
function complete(proc: ReturnType<typeof sidecar>) {
  proc.stdout.emit('data', JSON.stringify({ words: [{ word: 'text', start: 0, end: 1 }], durationSec: 1 }))
  proc.emit('close', 0)
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  mocks.db.audioSection.findUnique.mockImplementation(async ({ where }) => ({
    id: where.id, chapterId: where.id, language: 'en', index: 0,
    text: 'text', audioFile: { filePath: '/audio.wav' }
  }))
  mocks.db.audioSection.update.mockResolvedValue({})
})
afterEach(() => { vi.useRealTimers() })

describe('alignment serialization', () => {
  it('runs different chapters one after another and shares duplicate section requests', async () => {
    const first = sidecar(), second = sidecar()
    mocks.spawn.mockReturnValueOnce(first).mockReturnValueOnce(second)
    const a = alignSection('a')
    expect(alignSection('a')).toBe(a)
    const b = alignSection('b')
    await flush()
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    expect(pendingAlignments('a', 'en')).toBe(1)
    expect(pendingAlignments('b', 'en')).toBe(1)
    complete(first)
    await a
    await flush()
    expect(mocks.spawn).toHaveBeenCalledTimes(2)
    complete(second)
    await b
    expect(pendingAlignments('a', 'en')).toBe(0)
    expect(pendingAlignments('b', 'en')).toBe(0)
  })

  it('waits for a timed-out sidecar to exit, escalating to SIGKILL before advancing', async () => {
    const first = sidecar(), second = sidecar()
    mocks.spawn.mockReturnValueOnce(first).mockReturnValueOnce(second)
    const a = alignSection('timeout').catch(error => error)
    const b = alignSection('next')
    await flush()
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(first.kill).toHaveBeenCalledWith()
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(first.kill).toHaveBeenCalledWith('SIGKILL')
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    first.emit('close', null)
    expect((await a).message).toBe('Alignment timed out')
    await flush()
    expect(mocks.spawn).toHaveBeenCalledTimes(2)
    complete(second)
    await b
  })

  it('continues after a failed process and permits retrying that section', async () => {
    const first = sidecar(), second = sidecar()
    mocks.spawn.mockReturnValueOnce(first).mockReturnValueOnce(second)
    const failed = alignSection('retry').catch(error => error)
    await flush()
    first.emit('error', new Error('spawn failed'))
    first.emit('close', -2)
    expect((await failed).message).toContain('spawn failed')
    const retried = alignSection('retry')
    await flush()
    expect(mocks.spawn).toHaveBeenCalledTimes(2)
    complete(second)
    await retried
  })

  it('gives a long voiceover time beyond the short-job timeout', async () => {
    mocks.db.audioSection.findUnique.mockResolvedValue({
      id: 'long', chapterId: 'long', language: 'hi', index: 0,
      text: 'text', audioFile: { filePath: '/long.wav', durationMs: 12 * 60 * 1000 }
    })
    const proc = sidecar()
    mocks.spawn.mockReturnValueOnce(proc)
    const job = alignSection('long')
    await flush()
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(proc.kill).not.toHaveBeenCalled()
    expect(pendingAlignments('long', 'hi')).toBe(1)
    complete(proc)
    await job
    expect(pendingAlignments('long', 'hi')).toBe(0)
  })

  it('streams fragmented progress, keeps a refresh snapshot, and completes only after saving', async () => {
    const proc = sidecar()
    const emit = vi.fn()
    mocks.spawn.mockReturnValueOnce(proc)
    const job = alignSection('progress', { emit } as any)
    await flush()
    expect(alignmentProgress('progress', 'en')).toMatchObject({ percent: 0, phase: 'loading' })
    proc.stderr.emit('data', 'Library diagnostic\nALIGNMENT_PROG')
    proc.stderr.emit('data', 'RESS {"percent":43,"phase":"audio"}\nALIGNMENT_PROGRESS invalid\n')
    expect(alignmentProgress('progress', 'en')).toMatchObject({ percent: 43, phase: 'audio', sectionNumber: 1 })
    proc.stderr.emit('data', 'ALIGNMENT_PROGRESS {"percent":20,"phase":"audio"}\n')
    expect(alignmentProgress('progress', 'en')?.percent).toBe(43)
    proc.stderr.emit('data', 'ALIGNMENT_PROGRESS {"percent":100,"phase":"saving"}\n')
    expect(alignmentProgress('progress', 'en')?.percent).toBe(99)
    expect(emit.mock.calls.some(([, event]) => event.stage === 'done')).toBe(false)
    complete(proc)
    await job
    expect(emit).toHaveBeenCalledWith('alignment:progress', expect.objectContaining({ stage: 'done', percent: 100 }))
    expect(alignmentProgress('progress', 'en')).toBeNull()
  })

  it('clears a failed section progress snapshot', async () => {
    const proc = sidecar()
    mocks.spawn.mockReturnValueOnce(proc)
    const job = alignSection('progress-failure').catch(error => error)
    await flush()
    proc.stderr.emit('data', 'ALIGNMENT_PROGRESS {"percent":60,"phase":"audio"}\n')
    proc.emit('close', 1)
    expect(await job).toBeInstanceOf(Error)
    expect(alignmentProgress('progress-failure', 'en')).toBeNull()
  })
})
