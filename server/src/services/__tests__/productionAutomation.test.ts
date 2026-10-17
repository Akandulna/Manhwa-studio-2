import { describe, expect, it, vi } from 'vitest'
import { buildProcessSeries, emptyStages, type ProcessChapter, type ProcessStage } from '../seriesProcessModel.js'
import { nextProductionStep, parseProductionConfig, productionChapters, productionShares, type ProductionConfig, type ProductionJob } from '../productionAutomationModel.js'
import { ProductionRunner, type ProductionRunnerDependencies } from '../productionRunner.js'

const config: ProductionConfig = { device: 'phone-a', profileId: 'profile-2', clipper: { ai: 'aistudio', flow: 'steps', tabs: 3, chatGpt: { mode: null, model: null, effort: null } } }
const chapter = (n = 1): ProcessChapter => ({ id: `c${n}`, number: n, name: `Chapter ${n}`, stages: emptyStages() })
const finish = (c: ProcessChapter, keys: ProcessStage[]) => { for (const k of keys) c.stages[k] = { state: 'done' } }
const prepared = () => { const c = chapter(); finish(c, ['download', 'cleanup', 'stitch']); return c }
const model = (chapters: ProcessChapter[], manual: number[] = []) => buildProcessSeries({ id: 's1', title: 'Demo', rootFolder: 'Demo' }, chapters, manual)

describe('production resume and review boundary', () => {
  it('requires preparation, then checks both languages before advancing each step', () => {
    const c = chapter()
    expect(nextProductionStep(model([]))).toBe('preparation')
    expect(nextProductionStep(model([c]))).toBe('preparation')
    finish(c, ['download', 'cleanup', 'stitch'])
    expect(nextProductionStep(model([c]))).toBe('scripts')
    finish(c, ['script_en'])
    expect(nextProductionStep(model([c]))).toBe('scripts')
    finish(c, ['script_hi'])
    expect(nextProductionStep(model([c]))).toBe('voiceover')
    finish(c, ['voice_en'])
    expect(nextProductionStep(model([c]))).toBe('voiceover')
    finish(c, ['voice_hi'])
    expect(nextProductionStep(model([c]))).toBe('clipping')
    finish(c, ['align_en', 'align_hi'])
    expect(nextProductionStep(model([c]))).toBe('clipping')
    finish(c, ['crop_json'])
    expect(nextProductionStep(model([c]))).toBe('review')
    finish(c, ['review', 'crop', 'timeline_en', 'timeline_hi'])
    expect(nextProductionStep(model([c]))).toBe('review')
  })
  it('resumes old imports without re-preparing saved scripts and ignores completed parts', () => {
    const old = chapter(); finish(old, ['script_en', 'script_hi'])
    expect(nextProductionStep(model([old]))).toBe('voiceover')
    expect(productionChapters(model([old, chapter(21)], [1])).map(c => c.number)).toEqual([21])
    expect(nextProductionStep(model([old], [1]))).toBe('complete')
  })
  it('rejects missing device/profile and invalid clipping options', () => {
    expect(parseProductionConfig(config)).toEqual(config)
    const gemini = { ...config, clipper: { ...config.clipper, ai: 'gemini' } }
    expect(parseProductionConfig(gemini)).toEqual(gemini)
    for (const bad of [null, {}, { ...config, device: '' }, { ...config, profileId: '' }, { ...config, clipper: { ...config.clipper, tabs: 5 } }, { ...config, clipper: { ...config.clipper, ai: 'unknown' } }, { ...config, clipper: { ...config.clipper, chatGpt: { mode: 'invalid' } } }]) expect(() => parseProductionConfig(bad)).toThrow()
  })
})

function harness(c = prepared(), override: Partial<ProductionRunnerDependencies> = {}) {
  const events: ProductionJob[] = [], saved: ProductionJob[] = [], performed: string[] = []
  const deps: ProductionRunnerDependencies = {
    load: async () => [], save: async job => { saved.push(structuredClone(job)) },
    series: async () => model([c]), validate: async () => {}, emit: j => events.push(structuredClone(j)), stop: vi.fn(async () => {}),
    perform: async (step, _job, _signal, report) => {
      performed.push(step)
      if (step === 'scripts') { await report('sent scripts', { kind: 'narration', sentAt: new Date().toISOString() }); finish(c, ['script_en', 'script_hi']) }
      if (step === 'voiceover') finish(c, ['voice_en', 'voice_hi'])
      if (step === 'clipping') finish(c, ['crop_json'])
    }, ...override
  }
  return { runner: new ProductionRunner(deps), events, saved, performed, deps }
}

describe('parallel production devices', () => {
  const parallel = { ...config, parallelDevices: [{ device: 'phone-b', profileId: 'b-profile' }] }
  it('validates every profile and rejects duplicate devices', () => {
    expect(parseProductionConfig(parallel)).toEqual(parallel)
    for (const parallelDevices of [[{ device: 'phone-a', profileId: 'x' }], [{ device: 'phone-b', profileId: '' }], [null], 'all']) {
      expect(() => parseProductionConfig({ ...config, parallelDevices })).toThrow()
    }
  })
  it('keeps scripts sequential and assigns disjoint unfinished chapters to parallel stages', () => {
    expect(productionShares(parallel, 'narration', [1, 2, 3]).map(s => [s.target.device, s.chapters])).toEqual([['phone-a', [1, 2, 3]]])
    expect(productionShares(parallel, 'voiceover', [1, 2, 3]).map(s => [s.target.device, s.chapters])).toEqual([['phone-a', [1, 3]], ['phone-b', [2]]])
    expect(productionShares(parallel, 'clipper', [1]).map(s => s.target.device)).toEqual(['phone-a'])
    expect(productionShares(parallel, 'clipper', [])).toEqual([])
  })
  it('reserves additional devices against another series, including starts still validating', async () => {
    let release!: () => void
    const h = harness(prepared(), {
      validate: () => new Promise<void>(r => { release = r }),
      perform: async (_step, _job, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
    })
    const starting = h.runner.start('s1', parallel)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await expect(h.runner.start('s2', { ...config, device: 'phone-b' })).rejects.toThrow('already starting')
    release(); await starting
    await expect(h.runner.start('s2', { ...config, device: 'phone-b' })).rejects.toThrow('already running')
    await h.runner.cancel('s1')
  })
})

describe('server production runner', () => {
  it('chains in order, persists command state, and ends at manual review without Editor 2.0', async () => {
    const h = harness()
    await h.runner.start('s1', config)
    await vi.waitFor(() => expect(h.events.at(-1)?.status).toBe('review'))
    expect(h.performed).toEqual(['scripts', 'voiceover', 'clipping', 'review'])
    expect(h.saved.some(j => j.command?.kind === 'narration')).toBe(true)
    expect(h.events.at(-1)?.message).toContain('Review')
  })
  it('starts from the first unfinished step, using real chapters in a partial part', async () => {
    const c = prepared(); finish(c, ['script_en', 'script_hi', 'voice_en', 'voice_hi', 'align_en', 'align_hi'])
    const h = harness(c)
    await h.runner.start('s1', config)
    await vi.waitFor(() => expect(h.events.at(-1)?.status).toBe('review'))
    expect(h.performed).toEqual(['clipping', 'review'])
  })
  it('halts after a failed stage and does not advance from incomplete results', async () => {
    const h = harness(prepared(), { perform: async () => {} })
    await h.runner.start('s1', config)
    await vi.waitFor(() => expect(h.events.at(-1)?.status).toBe('failed'))
    expect(h.events.at(-1)?.step).toBe('scripts')
    expect(h.events.at(-1)?.message).toContain('did not finish')
  })
  it('blocks concurrent starts on the same device or series', async () => {
    const h = harness(prepared(), { perform: async (_step, _j, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })) })
    await h.runner.start('s1', config)
    await expect(h.runner.start('s1', { ...config, device: 'phone-b' })).rejects.toThrow('already running')
    await expect(h.runner.start('s2', config)).rejects.toThrow('already running')
    await h.runner.cancel('s1')
    expect((await h.runner.get('s1')).job?.status).toBe('cancelled')
    expect(h.deps.stop).toHaveBeenCalledOnce()
  })
  it('cancellation cannot advance into another stage when an in-flight operation finishes', async () => {
    let release!: () => void
    const c = prepared()
    const perform = vi.fn(async () => { await new Promise<void>(r => { release = r }); finish(c, ['script_en', 'script_hi']) })
    const h = harness(c, { perform })
    await h.runner.start('s1', config)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await h.runner.cancel('s1')
    release()
    await new Promise(r => setTimeout(r, 0))
    expect(perform).toHaveBeenCalledOnce()
    expect((await h.runner.get('s1')).job?.status).toBe('cancelled')
  })
  it('restores active jobs as interrupted after restart without replaying commands', async () => {
    const old: ProductionJob = { id: 'old', seriesId: 's1', config, status: 'running', step: 'scripts', message: 'sent', createdAt: '', updatedAt: '', command: { kind: 'narration', sentAt: '' } }
    const perform = vi.fn()
    const h = harness(prepared(), { load: async () => [old], perform })
    expect((await h.runner.get('s1')).job?.status).toBe('interrupted')
    expect(perform).not.toHaveBeenCalled()
    expect(h.saved.at(-1)?.status).toBe('interrupted')
  })
  it('does not reserve a device or save a job when validation fails', async () => {
    const h = harness(prepared(), { validate: async () => { throw new Error('profile missing') } })
    await expect(h.runner.start('s1', config)).rejects.toThrow('profile missing')
    expect(h.saved).toHaveLength(0)
    expect((await h.runner.get('s1')).job).toBeNull()
  })
})
