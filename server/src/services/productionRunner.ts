import type {ProductionResumeApproval} from './managedProductionResume.js'
import {ProductionOwnershipConflict,type ProductionVersion} from './productionJobStore.js'
import { randomUUID } from 'crypto'
import { nextProductionStep, productionDevices, type ProductionConfig, type ProductionJob, type ProductionStep } from './productionAutomationModel.js'
import type { ProcessSeries } from './seriesProcessModel.js'

export interface ProductionRunnerDependencies {
  activate: () => Promise<void>
  load: () => Promise<ProductionJob[]>
  save: (job: ProductionJob, expected:ProductionVersion|null) => Promise<void>
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
  private versions=new Map<string,ProductionVersion>()
  private pending=new Map<string,Promise<void>>()
  constructor(private deps: ProductionRunnerDependencies) {}

  private async refresh(activate=false):Promise<void> {
    if(activate)try {await this.deps.activate()}catch(error){if(!(error instanceof ProductionOwnershipConflict))throw error}
    for(const saved of await this.deps.load()) {
      const version={id:saved.id,revision:saved.revision??0},known=this.versions.get(saved.seriesId)
      if(known&&known.revision>version.revision)continue
      this.jobs.set(saved.seriesId,saved);this.versions.set(saved.seriesId,version)
    }
  }
  init():Promise<void> {return this.ready??=this.refresh(true)}

  /** Serialize report/cancel writes and capture immutable state before awaiting storage. */
  private async persist(job:ProductionJob,signal?:AbortSignal,replacing=false,required?:ProductionVersion):Promise<ProductionJob> {
    const snapshot=structuredClone(job),seriesId=job.seriesId
    const work=(this.pending.get(seriesId)??Promise.resolve()).catch(()=>{}).then(async()=>{
      signal?.throwIfAborted()
      const expected=this.versions.get(seriesId)??null
      if(required&&(expected?.id!==required.id||expected.revision!==required.revision))throw new ProductionOwnershipConflict('Saved run revision changed before durable resume')
      if(!replacing&&expected?.id!==snapshot.id)throw new ProductionOwnershipConflict('This production job was replaced')
      snapshot.revision=(expected?.revision??0)+1
      await this.deps.save(snapshot,expected)
      this.versions.set(seriesId,{id:snapshot.id,revision:snapshot.revision})
      this.jobs.set(seriesId,snapshot)
      job.revision=snapshot.revision
    })
    this.pending.set(seriesId,work)
    try {await work;return snapshot}finally{if(this.pending.get(seriesId)===work)this.pending.delete(seriesId)}
  }

  async get(seriesId: string): Promise<{ job: ProductionJob | null; nextStep: ProductionStep }> {
    await this.init()
    await this.refresh(true)
    return { job: this.jobs.get(seriesId) ?? null, nextStep: nextProductionStep(await this.deps.series(seriesId),this.jobs.get(seriesId)?.config) }
  }

  async list(): Promise<ProductionJob[]> { await this.init(); await this.refresh(true); return [...this.jobs.values()] }

  async start(seriesId: string, config: ProductionConfig, resume?:ProductionResumeApproval): Promise<ProductionJob> {
    await this.init()
    await this.deps.activate()
    await this.refresh()
    const devices = productionDevices(config).map(d => `device:${d.device}`)
    const seriesKey = `series:${seriesId}`
    const overlaps = (job: ProductionJob | undefined) => !!job && productionDevices(job.config).some(d => devices.includes(`device:${d.device}`))
    if ([seriesKey, ...devices].some(key => this.starting.has(key))) throw new Error('Automation is already starting for this series or device')
    for (const key of [seriesKey, ...devices]) this.starting.add(key)
    try {
      if (this.active.has(seriesId) || [...this.active.keys()].some(id => overlaps(this.jobs.get(id)))) throw new Error('Automation is already running or finishing its current operation for this series or device')
      if ([...this.jobs.values()].some(j => j.status === 'running' && (j.seriesId === seriesId || overlaps(j)))) throw new Error('Automation is already running for this series or device')
      const original=this.jobs.get(seriesId)
      if(resume) {
        if(!original?.config.managedCrop||!['failed','interrupted'].includes(original.status)||original.id!==resume.jobId||(original.revision??0)!==resume.revision||JSON.stringify(config)!==JSON.stringify(original.config))throw new ProductionOwnershipConflict('Saved run changed before resume. Inspect its exact current revision')
      }else if(original?.config.managedCrop&&['failed','interrupted','cancelled'].includes(original.status))throw new ProductionOwnershipConflict('Inspect the saved managed run and use explicit Resume. Cancelled runs cannot resume')
      const series = await this.deps.series(seriesId)
      const step = nextProductionStep(series,config)
      if (step === 'complete') throw new Error('All parts in this series are complete')
      await this.deps.validate(seriesId, config)
      const now = new Date().toISOString()
      const job: ProductionJob = { id: randomUUID(), seriesId, config, step, status: 'running', message: 'Starting from saved production progress…', createdAt: now, updatedAt: now }
      // Resume only the persisted original claim intents; a new receipt must never adopt retained work.
      const previous=this.jobs.get(seriesId)
      if(config.managedCrop&&previous?.config.managedCrop&&previous.config.device===config.device&&previous.config.profileId===config.profileId)job.command=previous.command?structuredClone(previous.command):undefined
      if(resume) {
        job.adoptedFrom=previous?.adoptedFrom?structuredClone(previous.adoptedFrom):undefined
        job.handoffHistory=previous?.handoffHistory?structuredClone(previous.handoffHistory):undefined
        if(previous?.pendingHandoff)throw new ProductionOwnershipConflict('Finish the pending handoff before resume')
        const current=this.jobs.get(seriesId)
        if(current?.id!==resume.jobId||(current.revision??0)!==resume.revision)throw new ProductionOwnershipConflict('Saved run changed during resume validation')
        job.resumedFrom=structuredClone(resume)
      }
      await this.persist(job,undefined,true,resume?{id:resume.jobId,revision:resume.revision}:undefined)
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
      const saved=await this.persist(job,signal)
      signal.throwIfAborted()
      this.deps.emit(saved)
    }
    try {
      while (!signal.aborted) {
        job.step = nextProductionStep(await this.deps.series(job.seriesId),job.config)
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
        const next = nextProductionStep(await this.deps.series(job.seriesId),job.config)
        if (next === step) throw new Error(`${step} did not finish. Check its production counters and resume after fixing it.`)
        job.command = undefined
      }
    } catch (error) {
      if(error instanceof ProductionOwnershipConflict){controller.abort();await this.refresh();return}
      if (!signal.aborted) {
        job.status = 'failed'
        await report(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (this.active.get(job.seriesId) === controller) this.active.delete(job.seriesId)
    }
  }

  async pauseManaged(seriesId:string,expected:{jobId:string;revision:number}):Promise<ProductionJob> {
    await this.init();await this.deps.activate();await this.refresh()
    const initial=this.jobs.get(seriesId)
    if(!initial?.config.managedCrop||initial.id!==expected.jobId||(initial.revision??0)!==expected.revision||!['running','failed','interrupted'].includes(initial.status)||initial.pendingHandoff)throw new ProductionOwnershipConflict('Refresh an active or retained managed run before requesting handoff pause')
    this.active.get(seriesId)?.abort()
    await this.pending.get(seriesId)?.catch(()=>{})
    await this.refresh()
    const current=this.jobs.get(seriesId)
    if(current?.id!==initial.id||!['running','failed','interrupted'].includes(current.status))throw new ProductionOwnershipConflict('Saved run changed before handoff pause')
    const paused=structuredClone(current)
    if(paused.status==='running')paused.status='interrupted'
    paused.message='Scheduling paused for handoff. Wait for the phone to confirm an unsent stop before transfer.'
    paused.updatedAt=new Date().toISOString()
    this.deps.emit(await this.persist(paused))
    return paused
  }

  async cancel(seriesId: string): Promise<ProductionJob> {
    await this.init()
    const initial=this.jobs.get(seriesId)
    if(!initial||!(initial.status==='running'||initial.config.managedCrop&&['failed','interrupted'].includes(initial.status)))throw new Error('There is no running automation for this series')
    this.active.get(seriesId)?.abort()
    // An in-flight report may have just saved a claim. Wait before collecting Stop's exact receipts.
    await this.pending.get(seriesId)?.catch(()=>{})
    await this.deps.activate()
    await this.refresh()
    const current=this.jobs.get(seriesId)
    if(current?.id!==initial.id||!(current.status==='running'||current.config.managedCrop&&['failed','interrupted'].includes(current.status)))throw new ProductionOwnershipConflict('The saved production job changed before Stop; reconcile its current owner')
    const job=structuredClone(current)
    job.status='cancelled'
    job.message='Automation stopped. Any local operation already in progress will finish; no next step will start.'
    job.updatedAt=new Date().toISOString()
    this.deps.emit(await this.persist(job))
    try {await this.deps.stop(job)}catch(error) {
      job.message='Automation stopped scheduling. Phone stop needs reconciliation: '+(error instanceof Error?error.message:String(error))
      job.updatedAt=new Date().toISOString()
      this.deps.emit(await this.persist(job))
      throw error
    }
    return job
  }
}
