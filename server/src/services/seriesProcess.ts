import { deliverSnapshot, snapshotDigest } from './snapshotDelivery.js'
import { r2Snapshot, snapshotJournal } from './snapshotDestinations.js'
import { relayFetch, relayRetryDelay } from './relayTraffic.js'
import {managedCropBindingCount} from './managedCropProjection.js'
import {onManagedCropProjectionChange} from './managedCropEvents.js'
import fs from 'fs/promises'
import { recordSeriesFileActivity, recordPhoneActivity } from './seriesActivity.js'
import { recordLocalManagerChapter, recordLegacyManagerReceipt, managerChapterIdentity, managerCanDeclareRevision } from './managerReporting.js'
import { watch, type FSWatcher } from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import type { Server } from 'socket.io'
import { prisma } from '../index.js'
import { getImageFiles } from './chapterManifest.js'
import { readChapterCropState, isChapterCropping } from './clipper3/chapterCrop.js'
import { readEffectiveReview } from './clipper3/chapterReview.js'
import { listExistingExports } from './editor2Export.js'
import { alignmentFileName, scriptFileName } from './narrationLanguage.js'
import { relayReceipts } from './phoneRelay.js'
import { createClient, getR2Config } from './r2Service.js'
import { libraryDeviceId } from './librarySync.js'
import { chapterStoryLinksCurrent } from './seriesRestartFiles.js'
import { restartRevision, sameRestart, preservedRestartStages } from './seriesRestartModel.js'
import { seriesRestartPending } from './seriesRestartGuard.js'
import { libraryControl } from './libraryControls.js'
import { readPageReplacement, type PageReplacement } from './chapterPageReplacement.js'
import { buildProcessSeries, emptyStages, mergeStage, PROCESS_STAGES, stage, processPublishDelay,
  type ChapterStages, type ProcessSnapshot } from './seriesProcessModel.js'

type RemoteChapter = { stages?: Partial<ChapterStages>; pageRevision?: string; restartRevision?: string }
interface DeviceProcess { schema: 'device-process/1'; deviceId: string; updatedAt: string; series: { folder: string; chapters: Record<string, RemoteChapter> }[] }
const phoneProgress = new Map<string, DeviceProcess>()
let io: Server | null = null
let watcher: FSWatcher | null = null
let snapshot: ProcessSnapshot | null = null
let refresh: Promise<ProcessSnapshot> | null = null
let timer: NodeJS.Timeout | null = null
let dirty = true
const generations = new Map<string, number>()
const cache = new Map<string, { hash: string; generation: number; stages: ChapterStages }>()
let publishTimer: NodeJS.Timeout | null = null
let publishing = false
let publishedHash = ''
/** When the last publication began: the relay receives process snapshots at most every PROCESS_PUBLISH_INTERVAL_MS. */
let publishStartedAt = 0

const root = () => path.resolve(process.env.DOWNLOAD_ROOT || './downloads')
const content = async (file: string) => (await fs.stat(file).catch(() => null))?.size ?? 0

/** Phone snapshots carry saved chapter facts, independently of the run that made them. */
export function receiveDeviceProcess(value: unknown): void {
  const body = value as DeviceProcess
  if (!body || body.schema !== 'device-process/1' || typeof body.deviceId !== 'string' || !Array.isArray(body.series) || !Number.isFinite(Date.parse(body.updatedAt))) return
  const prior = phoneProgress.get(body.deviceId)
  if (prior && Date.parse(prior.updatedAt) >= Date.parse(body.updatedAt)) return
  phoneProgress.set(body.deviceId, body)
  recordLegacyManagerReceipt('process', body.deviceId, body, Date.now())
  recordPhoneActivity('process', body.deviceId, body)
  notifySeriesProcessChanged()
}

export function notifySeriesProcessChanged(invalidateFiles = false): void {
  dirty = true
  if (invalidateFiles) cache.clear()
  if (!io || timer) return
  timer = setTimeout(() => {
    timer = null
    void getSeriesProcess().catch(error => console.error('[series-process] refresh failed:', error))
  }, 350)
  timer.unref()
}

async function localStages(chapter: any, title: string, timelines: any[]): Promise<ChapterStages> {
  const managed=await managedCropBindingCount(chapter.folderPath)>0
  const hash = JSON.stringify([chapter, timelines])
  const generation = generations.get(chapter.folderPath) ?? 0
  const previous = cache.get(chapter.id)
  if (!managed && previous?.hash === hash && previous.generation === generation) return structuredClone(previous.stages)
  const result = emptyStages()
  if (chapter.completedAt && !managed) {
    for (const key of PROCESS_STAGES) result[key] = { state: 'done' }
  } else {
    const dir = path.join(root(), chapter.folderPath)
    const files = await getImageFiles(dir).catch(() => [])
    result.download = { state: chapter.status === 'done' && files.length > 0 ? 'done' : ['queued', 'downloading'].includes(chapter.status) ? 'active' : files.length ? 'partial' : 'pending', done: files.length, total: Math.max(files.length, chapter.pageCount ?? 0) }
    if (chapter.status === 'failed') result.download.state = 'failed'
    const prepared = await content(path.join(dir, '.library-prepared.json')) > 0 || await content(path.join(dir, '.stitch-originals/stitch.json')) > 0
    if (prepared) result.cleanup = result.stitch = { state: 'done' }
    for (const language of ['en', 'hi'] as const) {
      const script = chapter.scripts.find((s: any) => s.language === language)
      const scriptExists = await content(script?.scriptPath ? path.isAbsolute(script.scriptPath) ? script.scriptPath : path.resolve(script.scriptPath) : path.join(dir, scriptFileName(language))) > 0
      result[`script_${language}`] = { state: scriptExists && ['done', 'edited'].includes(script?.status) ? 'done' : script?.status === 'generating' ? 'active' : script?.status === 'failed' ? 'failed' : scriptExists ? 'review' : 'pending' }
      const sections = chapter.audioSections.filter((s: any) => s.language === language)
      const voiced = await Promise.all(sections.map(async (s: any) => s.audioFile?.status === 'done' && await content(path.resolve(s.audioFile.filePath)) > 0))
      result[`split_${language}`] = sections.length && sections.every((s: any) => !!s.text.trim()) ? { state: 'done', done: sections.length, total: sections.length } : { state: 'pending' }
      result[`voice_${language}`] = stage(voiced.filter(Boolean).length, sections.length, sections.some((s: any) => s.status === 'generating'))
      const aligned = sections.filter((s: any) => !!s.timelineScript?.trim()).length
      result[`align_${language}`] = await content(path.join(dir, alignmentFileName(language))) > 0 ? { state: 'done' } : stage(aligned, sections.length)
      const timeline = timelines.find(t => t.language === language)
      result[`timeline_${language}`] = { state: timeline?.json.trim() ? 'done' : 'pending' }
      result[`processed_${language}`] = { state: timeline?.json.trim() && timeline.processedJson === timeline.json ? 'done' : 'pending' }
    }
    if (files.length) {
      // Skip the expensive crop validator for a chapter that has no crop artifacts yet.
      const hasCrops = await managedCropBindingCount(chapter.folderPath)>0 || await fs.stat(path.join(dir, 'crop_points3')).then(() => true, () => false)
      if (hasCrops) {
        const crops = await readChapterCropState({ folderPath: chapter.folderPath, series: { title } }).catch(() => null)
        if (crops) {
          result.crop_json = stage(crops.targets.length, crops.totalImages)
          try {
            const {requireCurrentSplitMetadata}=await import('./clipper3/metadataSplit.js')
            const split=await requireCurrentSplitMetadata({...chapter,series:{title}})
            if(split || await chapterStoryLinksCurrent(root(),chapter.folderPath)) result.metadata = {state:'done',done:crops.totalImages,total:crops.totalImages}
          } catch { result.metadata = {state:'pending',total:crops.totalImages} }
          result.crop = { state: crops.outputs.complete && crops.fullyAttached ? 'done' : isChapterCropping(chapter.id) ? 'active' : crops.chopped ? 'partial' : 'pending' }
        }
      }
      if ((await readEffectiveReview(chapter.folderPath)).reviewed) result.review = { state: 'done' }
    }
  }
  cache.set(chapter.id, { hash, generation, stages: structuredClone(result) })
  return result
}

function mergeRemote(stages: ChapterStages, folder: string, name: string, replacement: PageReplacement | null, revision: string | null): void {
  for (const receipt of phoneProgress.values()) {
    const chapter = receipt.series.find(s => s.folder === folder)?.chapters?.[name]
    const remote = chapter?.stages
    if (!remote) continue
    for (const key of PROCESS_STAGES) {
      if (!preservedRestartStages.has(key) && !sameRestart(revision, chapter?.restartRevision)) continue
      if (replacement && ['crop_json', 'review'].includes(key) && chapter?.pageRevision !== replacement.revision) continue
      // Rendering, processing and alignment are desktop facts, never guessed from a phone's script or package.
      if (key.startsWith('export_') || key.startsWith('processed_') || key.startsWith('align_') || key === 'crop' || key === 'metadata') continue
      const value = remote[key]
      if (value && ['pending', 'active', 'partial', 'review', 'failed', 'done'].includes(value.state)) stages[key] = mergeStage(stages[key], value)
    }
  }
  // Older phone builds already report scripts, speech counts and crop pages. Keep their progress visible too.
  for (const receipt of relayReceipts<any>('scripts') ?? []) {
    const series = receipt.body.series?.[folder]
    if (series?.restartPending || !sameRestart(revision, series?.restartRevision)) continue
    for (const language of ['en', 'hi'] as const) {
      const c = (language === 'en' ? series : series?.hi)?.chapters?.[name]
      if (!c) continue
      stages[`script_${language}`] = mergeStage(stages[`script_${language}`], { state: c.status === 'done' ? 'done' : c.status === 'review' || c.status === 'needs_summary' || c.status === 'stale' ? 'review' : 'pending' })
      const voice = c.voiceover
      if (voice?.total > 0 && voice.status !== 'script_changed') {
        stages[`split_${language}`] = mergeStage(stages[`split_${language}`], { state: 'done', done: voice.total, total: voice.total })
        stages[`voice_${language}`] = mergeStage(stages[`voice_${language}`], stage(Number(voice.done) || 0, Number(voice.total)))
      }
    }
  }
  const donePages = new Set<string>()
  let total = 0
  for (const receipt of relayReceipts<any>('crops') ?? []) {
    const entry = receipt.body.series?.[folder]
    if (entry?.restartPending || !sameRestart(revision, entry?.restartRevision)) continue
    const c = entry?.chapters?.[name]
    if (replacement && c?.pageRevision !== replacement.revision) continue
    total = Math.max(total, Number(c?.total) || 0)
    for (const [page, state] of Object.entries(c?.pages ?? {})) if (state === 'done') donePages.add(page)
  }
  if (total) stages.crop_json = mergeStage(stages.crop_json, stage(donePages.size, total))
  for (const receipt of relayReceipts<any>('sync') ?? []) {
    const c = receipt.body.series?.[folder]?.chapters?.[name]
    if (c?.state === 'downloaded') stages.download = mergeStage(stages.download, { state: 'done' })
  }
}

async function scan(): Promise<ProcessSnapshot> {
  const rows = await prisma.series.findMany({ include: { chapters: { orderBy: { number: 'asc' }, include: { scripts: true, audioSections: { include: { audioFile: true } } } } }, orderBy: { title: 'asc' } })
  const timelines = await prisma.editor2Timeline.findMany()
  const managerObservedAt = new Date().toISOString()
  const managerChapters: Parameters<typeof recordLocalManagerChapter>[0][] = []
  const series = []
  for (const row of rows) {
    const control = await libraryControl(path.basename(row.rootFolder))
    if (control.deleted) continue
    const revision = restartRevision(control)
    const restarting = revision ? await seriesRestartPending(control.folder) : false
    const declaresRevision = await managerCanDeclareRevision(row.id,row.sourceSite).catch(() => false)
    const [en, hi] = await Promise.all([listExistingExports(row.rootFolder, 'en',new Map(row.chapters.map(c=>[c.number,c.folderPath]))), listExistingExports(row.rootFolder, 'hi',new Map(row.chapters.map(c=>[c.number,c.folderPath])))])
    const chapters = []
    for (const c of row.chapters) {
      const stages = await localStages(c, row.title, timelines.filter(t => t.chapterId === c.id))
      const replacement = await readPageReplacement(c.folderPath)
      if (revision && !await chapterStoryLinksCurrent(root(), c.folderPath)) stages.metadata = { state: 'pending', total: c.pageCount ?? 0 }
      if (restarting) for (const key of PROCESS_STAGES) if (!preservedRestartStages.has(key)) stages[key] = { state: 'pending' }
      const local = structuredClone(stages)
      local.export_en = { state: !c.completedAt && en.has(c.number) ? 'done' : 'pending' }
      local.export_hi = { state: !c.completedAt && hi.has(c.number) ? 'done' : 'pending' }
      const identity = await managerChapterIdentity(c.id).catch(() => null)
      managerChapters.push({ declaresRevision, observedAt: managerObservedAt, sharedSeriesId: identity?.seriesId, sharedChapterId: identity?.chapterId, seriesId: row.id, chapterId: c.id, title: row.title, folder: path.basename(row.rootFolder), name: path.basename(c.folderPath), stages: local, pageRevision: replacement?.revision ?? null, archived: !!c.completedAt })
      mergeRemote(stages, path.basename(row.rootFolder), path.basename(c.folderPath), replacement, revision)
      const managed=await managedCropBindingCount(c.folderPath)>0
      if(managed) {stages.crop_json=local.crop_json;stages.crop=local.crop;stages.review=local.review}
      stages.export_en = { state: (!managed && c.completedAt) || en.has(c.number) ? 'done' : 'pending' }
      stages.export_hi = { state: (!managed && c.completedAt) || hi.has(c.number) ? 'done' : 'pending' }
      if (restarting) for (const key of PROCESS_STAGES) if (!preservedRestartStages.has(key)) { stages[key] = { state: 'pending' }; local[key] = { state: 'pending' } }
      chapters.push({ ...(revision ? { restartRevision: revision } : {}), id: c.id, name: path.basename(c.folderPath), number: c.number, stages, ...(replacement ? { pageRevision: replacement.revision } : {}) })
    }
    series.push(buildProcessSeries({ ...row, rootFolder: path.basename(row.rootFolder) }, chapters,
      Object.entries(control.parts ?? {}).filter(([, d]) => d.done && d.at > (control.restart?.at ?? 0)).map(([n]) => Number(n))))
  }
  // Flush one scan together so reporter batching does not persist the full projection per chapter.
  for (const chapter of managerChapters) recordLocalManagerChapter(chapter)
  return { schema: 'series-process/1', deviceId: await libraryDeviceId(), updatedAt: new Date().toISOString(), series }
}

export async function getSeriesProcess(): Promise<ProcessSnapshot> {
  if (refresh) return refresh
  if (snapshot && !dirty) return snapshot
  dirty = false
  refresh = scan().then(next => {
    const changed = JSON.stringify(next.series) !== JSON.stringify(snapshot?.series)
    snapshot = next
    if (changed) { io?.emit('series-process:updated', next); schedulePublish() }
    return next
  }).catch(error => { dirty = true; throw error }).finally(() => {
    refresh = null
    if (dirty) notifySeriesProcessChanged()
  })
  return refresh
}

function schedulePublish(): void {
  if (publishTimer || publishing || !io) return
  publishTimer = setTimeout(() => {
    publishTimer = null
    publishing = true
    publishStartedAt = Date.now()
    void (async () => {
      if (!snapshot) return
      const outgoing = snapshot
      const hash = createHash('sha256').update(JSON.stringify(outgoing.series)).digest('hex')
      // Destination acknowledgments survive restart; the local hash is only a scheduling hint.
      const config = getR2Config()
      const targets=[]
      if(config)targets.push(r2Snapshot('r2:'+snapshotDigest(config),()=>createClient(config),config.bucket,`${config.prefix}progress/${outgoing.deviceId}.json`))
      const url = process.env.RELAY_URL?.trim().replace(/\/+$/, '')
      if(url&&process.env.RELAY_TOKEN)targets.push({id:'relay:'+snapshotDigest({url,token:process.env.RELAY_TOKEN}),send:async(body:string)=>{
        const response=await relayFetch(`${url}/receipt/process?device=${outgoing.deviceId}`,{method:'POST',headers:{Authorization:`Bearer ${process.env.RELAY_TOKEN}`,'Content-Type':'application/json'},body,signal:AbortSignal.timeout(30_000)})
        await response.body?.cancel()
        if(!response.ok)throw new Error(`Process relay returned ${response.status}`)
      }})
      await deliverSnapshot(snapshotJournal(prisma),'snapshotDelivery/process',hash,outgoing,targets)
      publishedHash = hash
    })().catch(async error => {
      console.error('[series-process] publication will retry:', error)
      publishTimer = setTimeout(() => { publishTimer = null; schedulePublish() }, await relayRetryDelay().catch(()=>300_000))
      publishTimer.unref()
    }).finally(() => {
      publishing = false
      if (snapshot && createHash('sha256').update(JSON.stringify(snapshot.series)).digest('hex') !== publishedHash) schedulePublish()
    })
  }, processPublishDelay(publishStartedAt, Date.now()))
  publishTimer.unref()
}

export function startSeriesProcess(socket: Server): void {
  io = socket
  void fs.mkdir(root(), { recursive: true }).then(() => {
    watcher?.close()
    watcher = watch(root(), { recursive: true }, (_event, file) => {
      if (file) {
        recordSeriesFileActivity(String(file))
        const parts = String(file).split(path.sep)
        if (parts.length >= 2) {
          const folder = parts.slice(0, 2).join(path.sep)
          generations.set(folder, (generations.get(folder) ?? 0) + 1)
        }
      }
      notifySeriesProcessChanged()
    })
    watcher.on('error', error => console.error('[series-process] file watcher:', error))
    watcher.unref()
  }).catch(error => console.error('[series-process] file watcher setup:', error))
  notifySeriesProcessChanged()
}

// Immutable publication can live outside DOWNLOAD_ROOT, beyond the filesystem watcher.
onManagedCropProjectionChange(()=>notifySeriesProcessChanged(true))
