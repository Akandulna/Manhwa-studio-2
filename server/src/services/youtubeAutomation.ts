import { DESCRIPTION_IDENTITY_POLICY } from './youtubeDescriptions.js'
import fs from 'node:fs/promises'
import sharp from 'sharp'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { YouTubeError, YouTubeStore } from './youtubeStore.js'
import { youtubeProvider, type YouTubeAutomationKind, type YouTubePhone, type YouTubeJob, type YouTubePhoneJobStatus } from './youtubeAutomationTypes.js'
export type { YouTubeAutomationKind, YouTubePhone, YouTubeJob, YouTubePhoneJobStatus } from './youtubeAutomationTypes.js'
export interface YouTubeTransport {
 phones(): Promise<YouTubePhone[]>
 put(key: string, body: object): Promise<void>
 get(key: string): Promise<unknown | null>
 start(device: string, jobId: string): Promise<void>
 putImage?(key: string, bytes: Buffer): Promise<void>
 getImage?(key: string, maxBytes: number): Promise<Buffer>
 /** In-memory receipt state only; must not read R2 (free tier: no polling). */
 jobStatus?(device: string, jobId: string): Promise<YouTubePhoneJobStatus>
 /** Stops whatever run the phone has going; only sent when that run is this job. */
 stop?(device: string): Promise<void>
}
const providerName = (kind: YouTubeAutomationKind) => youtubeProvider(kind) === 'aistudio' ? 'AI Studio (Gemini 4 Hydrogen · High)' : 'ChatGPT'
/** A job the phone may still be working on: it holds the phone and its prompt. */
const active = (j: YouTubeJob) => (j.status === 'dispatching' || j.status === 'waiting') && Date.parse(j.expiresAt) > Date.now()
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
export class YouTubeAutomation {
 private queue: Promise<unknown> = Promise.resolve()
 private timers = new Map<string, ReturnType<typeof setTimeout>>()
 constructor(private store: YouTubeStore, private transport: YouTubeTransport, private root = path.resolve('.config/youtube-automation'), private background = false) {
  if (background) { const timer=setTimeout(()=>{ void this.all().then(jobs=>jobs.forEach(job=>this.watch(job))).catch(()=>{}) },0);timer.unref() }
 }
 private watch(job: YouTubeJob) {
  if (!this.background || this.timers.has(job.id) || job.status==='done' || job.status==='cancelled' || job.status==='needs_attention' && job.response || Date.parse(job.expiresAt)<Date.now()) return
  const timer=setTimeout(()=>{ this.timers.delete(job.id);void this.check(job.seriesId,job.id).then(next=>this.watch(next)).catch(()=>this.watch(job)) },15000)
  timer.unref();this.timers.set(job.id,timer)
 }
 private serial<T>(task: () => Promise<T>): Promise<T> { const result = this.queue.then(task); this.queue = result.catch(() => {}); return result }
 private async all(): Promise<YouTubeJob[]> { await fs.mkdir(this.root, { recursive: true }); const files = (await fs.readdir(this.root)).filter(f => /^[a-f0-9-]{36}\.json$/.test(f)); return Promise.all(files.map(async f => JSON.parse(await fs.readFile(path.join(this.root, f), 'utf8')))) }
 private async save(job: YouTubeJob) { const file = path.join(this.root, `${job.id}.json`); const temp = `${file}.tmp`; await fs.writeFile(temp, JSON.stringify(job)); await fs.rename(temp, file); return job }
 async phones() { return (await this.transport.phones()).map(({ prefix: _, ...phone }) => phone) }
 async latest(seriesId: string, kind: YouTubeAutomationKind, requestId: string, slot?: number) { return (await this.all()).filter(j => j.seriesId === seriesId && j.kind === kind && j.requestId === requestId && (!kind.startsWith('thumbnail_') || j.slot===slot)).sort((a,b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null }
 start(seriesId: string, kind: unknown, input: { requestId?: unknown; device?: unknown; expectedRevision?: unknown; slot?: unknown }) { return this.serial(() => this.startNow(seriesId, kind, input)) }
 private async startNow(seriesId: string, kind: unknown, input: { requestId?: unknown; device?: unknown; expectedRevision?: unknown; slot?: unknown }): Promise<YouTubeJob> {
  if (kind !== 'titles' && kind !== 'descriptions' && kind !== 'thumbnail_prepare' && kind !== 'thumbnail_generate') throw new YouTubeError('Choose titles, descriptions or a thumbnail variation.')
  if (typeof input.device !== 'string' || !input.device || typeof input.requestId !== 'string') throw new YouTubeError('Choose a phone and prepared prompt.')
  const w = await this.store.openWorkspace(seriesId)
  if (input.expectedRevision !== w.titles.revision) throw new YouTubeError('Workspace changed. Refresh before starting automation.', 409)
  const request = (kind === 'titles' ? w.titles.requests : kind === 'descriptions' ? w.descriptions.requests : w.thumbnails.requests).find(r => r.id === input.requestId)
  if (!request || ('importedAt' in request && request.importedAt)) throw new YouTubeError('Choose a prepared prompt that has not been imported.', 409)
  if (kind === 'descriptions' && ('title' in request && request.title !== w.selectedTitle || !('outputVersion' in request) || request.outputVersion !== 2)) throw new YouTubeError('Prepare a new paired description prompt for the selected title.', 409)
  const slot=kind.startsWith('thumbnail_') ? input.slot : undefined
  if (kind === 'descriptions' && (!('identityPolicy' in request) || request.identityPolicy !== DESCRIPTION_IDENTITY_POLICY)) throw new YouTubeError('Prepare a new description prompt that excludes the real manhwa name.', 409)
  if(kind.startsWith('thumbnail_') && (typeof slot!=='number'||!Number.isInteger(slot)||slot<0||slot>2||!('prompts' in request)||request.title!==w.selectedTitle))throw new YouTubeError('Choose a current thumbnail variation.',409)
  const all = await this.all(); const prior = all.filter(j => j.seriesId === seriesId && j.requestId === input.requestId && j.kind === kind && (!kind.startsWith('thumbnail_')||j.slot===slot)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0]
  // Repeated clicks never submit the prompt twice; only Retry (which cancels the job first) sends it again.
  if (prior && prior.status!=='cancelled') return prior
  if(kind==='thumbnail_generate' && w.thumbnails.versions.some(v=>v.requestId===request.id&&v.slot===slot))throw new YouTubeError('This variation already has an image. Prepare another request for more versions.',409)
  if (all.some(j => j.device === input.device && active(j))) throw new YouTubeError('This phone already has a YouTube request waiting for a result. Cancel it first.', 409)
  const phone = (await this.transport.phones()).find(p => p.id === input.device)
  if (!phone?.ready) throw new YouTubeError(phone?.reason || 'Choose a connected phone with YouTube automation support.', 409)
  if(youtubeProvider(kind)==='aistudio' && !phone.aiStudioText)throw new YouTubeError('Update Sleeper Cell beta: titles and descriptions now run in AI Studio.',409)
  if(kind==='thumbnail_generate' && (!phone.thumbnailGeneration||!this.transport.getImage))throw new YouTubeError('Update Sleeper Cell beta for thumbnail generation.',409)
  if(kind.startsWith('thumbnail_') && (!phone.thumbnailPreparation||!this.transport.putImage))throw new YouTubeError('Update Sleeper Cell beta for thumbnail reference preparation.',409)
  const job: YouTubeJob = { schema:'youtube-automation/1', id:randomUUID(), seriesId, requestId:request.id, kind, device:phone.id, prefix:phone.prefix, provider:youtubeProvider(kind), expectedRevision:w.titles.revision, createdAt:new Date().toISOString(), expiresAt:new Date(Date.now()+30*60_000).toISOString(), status:'dispatching', message:'Sending to Sleeper Cell…', ...(kind.startsWith('thumbnail_')?{slot:slot as number}: {}) }
  await this.save(job)
  try {
   const attachments: NonNullable<YouTubeJob['attachments']>=[]
   if(kind.startsWith('thumbnail_') && 'references' in request){
    if(request.references.length<1||request.references.length>10)throw new Error('Select 1–10 crop references.')
    const files=request.references.map((ref,i)=>({id:ref.id,filename:`reference-${i+1}.png`}))
    if(request.parentId)files.push({id:request.parentId,filename:'base-thumbnail.png'})
    let total=0
    for(const file of files){const bytes=await this.store.thumbnailMedia(seriesId,file.id);total+=bytes.length;if(bytes.length>20*1024*1024||total>100*1024*1024)throw new Error('Reference pack exceeds the 100 MB transfer limit.');const key=`${job.prefix}youtube/attachments/${job.id}/${file.filename}`;await this.transport.putImage!(key,bytes);attachments.push({key,filename:file.filename,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})}
    job.attachments=attachments
   }
   await this.transport.put(`${job.prefix}youtube/jobs/${job.id}.json`, { schema:job.schema, id:job.id, seriesId, requestId:request.id, kind, provider:job.provider, device:phone.id, expiresAt:job.expiresAt, prompt:'prompts' in request?request.prompts[slot as number]:request.prompt, ...(kind.startsWith('thumbnail_')?{attachments,slot}: {}) })
   await this.transport.start(phone.id, job.id)
   job.status='waiting'; job.message=kind==='thumbnail_generate'?'Waiting for ChatGPT to generate the thumbnail. You can close this popup and return later.':kind.startsWith('thumbnail_')?'Preparing the prompt and reference images in ChatGPT. Sleeper Cell will stop before Send.':`Waiting for ${providerName(kind)} on Sleeper Cell. You can close this popup and return later.`
  } catch(error) { job.status='needs_attention'; job.message=`Delivery could not be confirmed. Check the phone before trying another prompt. ${error instanceof Error ? error.message : ''}` }
  const saved=await this.save(job);this.watch(saved);return saved
 }
 /**
  * Stops waiting for a job. The phone is told to stop only when its receipt shows it running this very job, since
  * run_stop ends whatever run it has going. A result that still arrives for a cancelled job is ignored.
  */
 private async cancelNow(seriesId: string, id: string): Promise<YouTubeJob> {
  if(!uuid.test(id))throw new YouTubeError('Invalid automation request.')
  const job=(await this.all()).find(j=>j.id===id&&j.seriesId===seriesId)
  if(!job)throw new YouTubeError('Automation request not found.',404)
  if(job.status==='done')throw new YouTubeError('This request already finished.',409)
  if(job.status==='cancelled')return job
  let stopped=false
  try{ if((await this.transport.jobStatus?.(job.device,job.id))?.running&&this.transport.stop){await this.transport.stop(job.device);stopped=true} }catch{ /* Cancelling here never depends on the phone answering. */ }
  clearTimeout(this.timers.get(job.id));this.timers.delete(job.id)
  job.status='cancelled';job.cancelledAt=new Date().toISOString();delete job.phoneStep
  job.message=stopped?'Cancelled. The phone was told to stop this request.':'Cancelled. Studio stopped waiting; the phone was not working on this request.'
  return this.save(job)
 }
 cancel(seriesId: string, id: string) { return this.serial(() => this.cancelNow(seriesId, id)) }
 /** Cancels [id] if it is still pending and sends the same prepared prompt again as a new job (a new job id). */
 retry(seriesId: string, id: string, input: { device?: unknown; expectedRevision?: unknown }) { return this.serial(async () => {
  if(!uuid.test(id))throw new YouTubeError('Invalid automation request.')
  const job=(await this.all()).find(j=>j.id===id&&j.seriesId===seriesId)
  if(!job)throw new YouTubeError('Automation request not found.',404)
  if(job.status==='done')throw new YouTubeError('This request already finished.',409)
  if(job.status!=='cancelled')await this.cancelNow(seriesId,id)
  return this.startNow(seriesId,job.kind,{requestId:job.requestId,device:input.device??job.device,expectedRevision:input.expectedRevision,slot:job.slot})
 }) }
 retryImageTransfer(seriesId: string, id: string) { return this.serial(async()=>{
  if(!uuid.test(id))throw new YouTubeError('Invalid automation request.')
  const job=(await this.all()).find(j=>j.id===id&&j.seriesId===seriesId)
  if(!job||job.kind!=='thumbnail_generate'||!job.image)throw new YouTubeError('No completed image is available for transfer retry.',409)
  if(job.status==='done')return job
  const phone=(await this.transport.phones()).find(p=>p.id===job.device)
  if(!phone?.ready)throw new YouTubeError(phone?.reason||'The phone is offline.',409)
  await this.transport.start(job.device,job.id)
  job.status='waiting';job.message='Retrying transfer of the saved image. The prompt will not be generated again.';delete job.lastCheckAt
  const saved=await this.save(job);this.watch(saved);return saved
 }) }
 check(seriesId: string, id: string) { return this.serial(async () => {
  if (!uuid.test(id)) throw new YouTubeError('Invalid automation request.')
  const job = (await this.all()).find(j => j.id === id && j.seriesId === seriesId)
  if (!job) throw new YouTubeError('Automation request not found.',404)
  if (job.status === 'done' || job.status === 'cancelled' || job.status==='needs_attention' && job.response || Date.now() - (job.lastCheckAt ?? 0) < 15_000) return job
  job.lastCheckAt = Date.now()
  try {
   const raw = job.response || job.image ? { ...job, status:"ok" } : await this.transport.get(`${job.prefix}youtube/results/${job.id}.json`)
   if (raw === null) {
    if (Date.parse(job.expiresAt) < Date.now()) { job.status='needs_attention';delete job.phoneStep;job.message='No result arrived within 30 minutes. Check the phone, then use Retry to send the prompt again.' }
    else if (job.status==='waiting') {
     // Live phone state from the relay (in memory): its current step, or why it did not start this job.
     const phone=await this.transport.jobStatus?.(job.device,job.id).catch(()=>undefined)
     if(phone?.step)job.phoneStep=phone.step; else delete job.phoneStep
     if(!phone?.running&&phone?.start?.state==='refused'){job.status='needs_attention';job.phoneFailed=true;job.message=`The phone did not start this request: ${phone.start.reason||'refused'}. Use Retry when the phone is free.`}
     else if(!phone?.running&&phone?.start?.state==='delayed')job.phoneStep=`Start delayed: ${phone.start.reason||'the phone will try again'}`
    }
    return this.save(job)
   }
   const result = raw as Record<string,unknown>
   if (!result || result.schema!==job.schema || result.id!==job.id || result.device!==job.device || result.seriesId!==seriesId || result.requestId!==job.requestId || result.kind!==job.kind) throw new Error('The returned result does not match this phone and prompt.')
   if (result.status !== 'ok') { job.phoneFailed=true;throw new Error(typeof result.error==='string' ? result.error.slice(0,1000) : 'The phone could not complete this request.') }
   if(job.kind==='thumbnail_generate'){
    if(result.slot!==job.slot)throw new Error('Returned thumbnail variation does not match.')
    const image=result.image as YouTubeJob['image']
    if(!image||image.key!==`${job.prefix}youtube/images/${job.id}/image`||!Number.isInteger(image.bytes)||image.bytes<1||image.bytes>20*1024*1024||!Number.isInteger(image.width)||!Number.isInteger(image.height)||image.width<512||image.height<288||image.width*image.height>32000000||!['image/png','image/jpeg','image/webp'].includes(image.mime)||typeof image.sha256!=='string'||!/^[a-f0-9]{64}$/.test(image.sha256))throw new Error('Invalid generated-image identity or size.')
    job.image=image;await this.save(job)
    const bytes=await this.transport.getImage!(image.key,image.bytes)
    if(bytes.length!==image.bytes||createHash('sha256').update(bytes).digest('hex')!==image.sha256)throw new Error('Generated image failed integrity verification.')
    const meta=await sharp(bytes,{limitInputPixels:32000000}).metadata()
    if(meta.width!==image.width||meta.height!==image.height||`image/${meta.format==='jpg'?'jpeg':meta.format}`!==image.mime||(meta.pages??1)!==1)throw new Error('Generated image metadata does not match the phone result.')
    await this.store.importThumbnail(seriesId,{requestId:job.requestId,slot:job.slot,expectedRevision:job.expectedRevision,automationJobId:job.id},bytes)
    job.status='done';job.message=`Variation ${(job.slot??0)+1} saved. Review it and choose Use this thumbnail.`;return this.save(job)
   }
   if(job.kind==='thumbnail_prepare'){
    if(result.prepared!==true||result.slot!==job.slot||result.attachmentCount!==job.attachments?.length)throw new Error('Phone did not confirm every expected attachment.')
    const current=await this.store.openWorkspace(seriesId);const request=current.thumbnails.requests.find(r=>r.id===job.requestId)
    if(!request||request.title!==current.selectedTitle)throw new Error('Selected title changed. The prepared draft uses the previous title; review it on the phone.')
    job.status='done';job.message=`Variation ${(job.slot??0)+1} prepared with ${job.attachments!.length} images in ChatGPT. Stopped before Send; image generation is the next stage.`;return this.save(job)
   }
   if (typeof result.response!=='string'  || !result.response.trim() || result.response.length>100000) throw new Error(`The returned ${providerName(job.kind)} response is empty or too large.`)
   job.response=result.response; await this.save(job) // Keep recoverable response before import.
   if (job.kind==='titles') await this.store.importTitles(seriesId,job.requestId,result.response,job.expectedRevision)
   else await this.store.importDescription(seriesId,{requestId:job.requestId,response:result.response,expectedRevision:job.expectedRevision})
   job.status='done';job.message=job.kind==='titles'?'Five title ideas added. Choose the title you want.':'English and Hinglish descriptions saved.'
  } catch(error) { job.status='needs_attention';delete job.phoneStep;job.message=error instanceof Error?error.message:'Could not fetch the phone result.' }
  return this.save(job)
 }) }
}
