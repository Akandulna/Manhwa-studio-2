import { randomUUID } from 'crypto'
import { nextProductionStep, productionDevices, type ProductionConfig, type ProductionJob, type ProductionStep } from './productionAutomationModel.js'
import type { ProcessSeries } from './seriesProcessModel.js'

export interface ProductionRunnerDependencies {
  load: () => Promise<ProductionJob[]>
  save: (job: ProductionJob) => Promise<void>
  series: (id: string) => Promise<ProcessSeries>
  validate: (seriesId: string, config: ProductionConfig) => Promise<void>
  perform: (step: ProductionStep, job: ProductionJob, signal: AbortSignal, report: (message: string, command?: ProductionJob['command']) => Promise<void>) => Promise<void>
  stop: (job: ProductionJob) => Promise<void>
  emit: (job: ProductionJob) => void
}

/** Server-owned sequence: closing the Library cannot abandon a run or bypass its review gate. */
export class ProductionRunner {
  private jobs = new Map<string, ProductionJob>()
  private active = new Map<string, AbortController>()
  private starting = new Set<string>()
  private ready: Promise<void> | null = null
  constructor(private deps: ProductionRunnerDependencies) {}

  init(): Promise<void> {
    return this.ready ??= (async () => {
      for (const saved of await this.deps.load()) {
        if (saved.status === 'running') {
          saved.status = 'interrupted'
          saved.message = 'Server restarted. Check the phone, then resume from saved progress.'
          saved.updatedAt = new Date().toISOString()
          await this.deps.save(saved)
        }
        this.jobs.set(saved.seriesId, saved)
      }
    })()
  }

  async get(seriesId: string): Promise<{ job: ProductionJob | null; nextStep: ProductionStep }> {
    await this.init()
    return { job: this.jobs.get(seriesId) ?? null, nextStep: nextProductionStep(await this.deps.series(seriesId)) }
  }

  async list(): Promise<ProductionJob[]> { await this.init(); return [...this.jobs.values()] }

  async start(seriesId: string, config: ProductionConfig): Promise<ProductionJob> {
    await this.init()
    const devices = productionDevices(config).map(d => `device:${d.device}`)
    const seriesKey = `series:${seriesId}`
    const overlaps = (job: ProductionJob | undefined) => !!job && productionDevices(job.config).some(d => devices.includes(`device:${d.device}`))
    if ([seriesKey, ...devices].some(key => this.starting.has(key))) throw new Error('Automation is already starting for this series or device')
    for (const key of [seriesKey, ...devices]) this.starting.add(key)
    try {
      if (this.active.has(seriesId) || [...this.active.keys()].some(id => overlaps(this.jobs.get(id)))) throw new Error('Automation is already running or finishing its current operation for this series or device')
      if ([...this.jobs.values()].some(j => j.status === 'running' && (j.seriesId === seriesId || overlaps(j)))) throw new Error('Automation is already running for this series or device')
      const series = await this.deps.series(seriesId)
      const step = nextProductionStep(series)
      if (step === 'complete') throw new Error('All parts in this series are complete')
      await this.deps.validate(seriesId, config)
      const now = new Date().toISOString()
      const job: ProductionJob = { id: randomUUID(), seriesId, config, step, status: 'running', message: 'Starting from saved production progress…', createdAt: now, updatedAt: now }
      await this.deps.save(job)
      this.jobs.set(seriesId, job)
      const controller = new AbortController()
      this.active.set(seriesId, controller)
      this.deps.emit(job)
      void this.run(job, controller).catch(error => console.error('[production] could not save run outcome:', error))
      return job
    } finally {
      for (const key of [seriesKey, ...devices]) this.starting.delete(key)
    }
  }

  private async run(job: ProductionJob, controller: AbortController): Promise<void> {
    const signal = controller.signal
    const report = async (message: string, command?: ProductionJob['command']) => {
      signal.throwIfAborted()
      job.message = message
      if (command) job.command = command
      job.updatedAt = new Date().toISOString()
      await this.deps.save(job)
      signal.throwIfAborted()
      this.deps.emit(job)
    }
    try {
      while (!signal.aborted) {
        job.step = nextProductionStep(await this.deps.series(job.seriesId))
        signal.throwIfAborted()
        if (job.step === 'review' || job.step === 'complete') {
          // Also fetch/attach existing phone results on a run resumed at the review boundary.
          if (job.step === 'review') await this.deps.perform('review', job, signal, report)
          signal.throwIfAborted()
          job.status = 'review'
          await report('Automation finished through Image Clipping. Review the results before starting Editor 2.0.')
          break
        }
        const step = job.step
        await report(`Running ${step}…`)
        await this.deps.perform(step, job, signal, report)
        signal.throwIfAborted()
        const next = nextProductionStep(await this.deps.series(job.seriesId))
        if (next === step) throw new Error(`${step} did not finish. Check its production counters and resume after fixing it.`)
        job.command = undefined
      }
    } catch (error) {
      if (!signal.aborted) {
        job.status = 'failed'
        await report(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (this.active.get(job.seriesId) === controller) this.active.delete(job.seriesId)
    }
  }

  async cancel(seriesId: string): Promise<ProductionJob> {
    await this.init()
    const job = this.jobs.get(seriesId)
    if (!job || job.status !== 'running') throw new Error('There is no running automation for this series')
    this.active.get(seriesId)?.abort()
    job.status = 'cancelled'
    job.message = 'Automation stopped. Any local operation already in progress will finish; no next step will start.'
    job.updatedAt = new Date().toISOString()
    await this.deps.save(job)
    this.deps.emit(job)
    await this.deps.stop(job)
    return job
  }
}
