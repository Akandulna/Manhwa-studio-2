import fs from 'fs/promises'
import path from 'path'
import sharp from 'sharp'
import {randomUUID} from 'crypto'
import { GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { sha256, normalizeScript, storyLinksCurrent } from './studioCropAuthorityModel.js'
import { fileSha256 } from './fileHashCache.js'
import { getChapterManifest } from '../chapterManifest.js'
import { readChapterReview } from './chapterReview.js'
import { getSourceFolderPath, getOutputDir, readImagePoints, readImageMetadata, writeImageMetadata, getMetadataFilePathFor,
  extractCrops, expectedExportedFilenames, chapterCropOutputs, cropRotation, rotatedSize, type Clipper3CropEntry } from './perImageStore.js'
import { withUnmanagedCropChapter, managedCropBindingCount } from '../managedCropProjection.js'
import { readPageRedo } from './pageRedo.js'

export const METADATA_JOB_SCHEMA = 'sleeper-cell-metadata-job/1'
export const METADATA_RENDERER = 'studio-minmax-round/1'
/** Same cut, then a quarter turn for crops carrying `rotate`. Older phones refuse it instead of describing a sideways crop. */
export const METADATA_RENDERER_ROTATE = 'studio-minmax-round-rotate/1'
const JOB_DIR = '.metadata-jobs'
const CUT_RECEIPT = '.metadata-cut-receipt.json'
/**
 * Pages whose Metadata Studio made again ("Recreate" in AI Engines → Metadata): page → stamp. The stamp goes
 * into the page's job payload, so its revision changes: phones (which keep results per job revision) stop
 * counting their old result and take Studio's new one from R2. Phones ignore payload keys they don't know.
 */
const REGENERATIONS = '.metadata-regenerations.json'
async function readRegenerations(dir: string): Promise<Record<string, string>> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(dir, REGENERATIONS), 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}
export const METADATA_RESULT_SCHEMA = 'sleeper-cell-metadata-result/1'
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'series'
export const safeName = (s: unknown): s is string => typeof s === 'string' && !!s.trim() && !s.startsWith('.') && !/[\\/\0]/.test(s)
export function pixelBounds(c: Clipper3CropEntry, width: number, height: number) {
  if (c.crop.points.length !== 4 || c.crop.points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new Error('Invalid crop corners')
  const xs = c.crop.points.map(p => p.x), ys = c.crop.points.map(p => p.y)
  const px = (n: number, size: number) => Math.round(Math.max(0, Math.min(1, n)) * size)
  const b = { x0: px(Math.min(...xs), width), y0: px(Math.min(...ys), height), x1: px(Math.max(...xs), width), y1: px(Math.max(...ys), height) }
  if (b.x1 <= b.x0 || b.y1 <= b.y0) throw new Error('Degenerate crop')
  return b
}
async function atomic(file: string, body: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(body, null, 2)); await fs.rename(tmp, file)
}
type Chapter = {id: string; folderPath: string; number: number; seriesId: string; series: {title: string}}
async function geometrySnapshot(chapter: Chapter) {
  if (await managedCropBindingCount(chapter.folderPath)) throw new Error('Metadata split is not supported for managed/mixed chapters yet; retain managed review/cut authority')
  const review = await readChapterReview(chapter.folderPath)
  if (!review.reviewed || !review.reviewedAt) throw new Error('Manual review is required before Metadata')
  const dir = getSourceFolderPath(chapter.folderPath), manifest = await getChapterManifest(chapter.folderPath)
  const pages = []
  for (const image of manifest.images) {
    if ((await readPageRedo(chapter.folderPath, image.filename))?.status === 'pending') throw new Error('A page is waiting for regenerated pointers')
    const stored = await readImagePoints(chapter.folderPath, image.filename)
    if (!stored?.file) throw new Error(`Pointers missing: ${image.filename}`)
    const crops = extractCrops(stored.file)
    if (crops.length !== stored.file.crops.length) throw new Error(`Invalid pointers: ${image.filename}`)
    // Cached by size/mtime and hashed once per page (Editor readiness runs this on every open).
    const source = await fileSha256(path.join(dir, image.filename))
    if (stored.file.workflow==='clipper-geometry/1' && stored.file.sourceSha256!==source.sha256) throw new Error('Pointers belong to a changed source image')
    const pointersText = JSON.stringify({...stored.file, format:'four-point-crop', coordinateSystem:'normalized', image, crops})
    const names = expectedExportedFilenames(slug(chapter.series.title), image.filename, crops)
    const inventory = []
    for (let i = 0; i < crops.length; i++) {
      const filename = names[i]
      if (!safeName(filename)) throw new Error('Invalid final crop filename')
      const bounds = pixelBounds(crops[i], image.width, image.height)
      const rotate = cropRotation(crops[i])
      // Only turned crops carry the key, so snapshots (and receipts) of upright pages stay byte-identical.
      inventory.push(rotate ? {id: crops[i].id, exportedFilename: filename, bounds, rotate} : {id: crops[i].id, exportedFilename: filename, bounds})
    }
    pages.push({page:image.filename, sourceSha256:source.sha256, sourceBytes:source.bytes, width:image.width, height:image.height,
      pointersText, crops:inventory})
  }
  if (!pages.length) throw new Error('No source pages')
  return {reviewedAt:review.reviewedAt, pages}
}
/** Called only after a complete successful cut; binds current approval, source, geometry and output bytes. */
export const captureMetadataGeometry = geometrySnapshot
export async function recordMetadataCut(chapter: Chapter, baseline?: Awaited<ReturnType<typeof geometrySnapshot>>) {
  const snapshot = await geometrySnapshot(chapter)
  if (baseline && JSON.stringify(snapshot)!==JSON.stringify(baseline)) throw new Error('Geometry/source/review changed during cropping')
  const expected = snapshot.pages.flatMap(p => p.crops.map(c => c.exportedFilename))
  const state = await chapterCropOutputs(chapter.folderPath, expected, true, {slug:slug(chapter.series.title),filenames:snapshot.pages.map(p=>p.page)})
  if (!state.complete) throw new Error('Current chapter cut is incomplete')
  const files = []
  for (const p of snapshot.pages) for (const c of p.crops) {
    const file = path.join(getOutputDir(chapter.folderPath), c.exportedFilename), bytes = await fs.readFile(file)
    const image = await sharp(bytes).metadata()
    const size = rotatedSize(c.bounds.x1-c.bounds.x0, c.bounds.y1-c.bounds.y0, cropRotation(c))
    if (image.width !== size.width || image.height !== size.height) throw new Error('Cut dimensions differ from approved pointers')
    files.push({filename:c.exportedFilename,sha256:sha256(bytes),bytes:bytes.length})
  }
  const proof = {snapshot, files}
  const receipt = {...proof, revision:sha256(JSON.stringify(proof))}
  await atomic(path.join(getSourceFolderPath(chapter.folderPath), CUT_RECEIPT), receipt)
  return receipt
}
export async function currentMetadataJobs(chapter: Chapter, generation: {restartRevision:string|null;pageRevision:string|null}, regenerationOverrides: Record<string, string> = {}) {
  const snapshot = await geometrySnapshot(chapter)
  const dir = getSourceFolderPath(chapter.folderPath)
  const regenerations = {...await readRegenerations(dir), ...regenerationOverrides}
  const receipt = JSON.parse(await fs.readFile(path.join(dir, CUT_RECEIPT), 'utf8'))
  if (JSON.stringify(receipt.snapshot) !== JSON.stringify(snapshot) || receipt.revision !== sha256(JSON.stringify({snapshot:receipt.snapshot,files:receipt.files}))) throw new Error('Approved pointers/source/review changed since the cut')
  for (const file of receipt.files) {
    if (!safeName(file.filename) || (await fileSha256(path.join(getOutputDir(chapter.folderPath), file.filename))).sha256 !== file.sha256) throw new Error('Cut output bytes changed')
  }
  const script = normalizeScript(await fs.readFile(path.join(dir, 'script.md'), 'utf8'))
  if (!script) throw new Error('English script required for Metadata')
  const series = path.basename(path.dirname(dir)), chapterName = path.basename(dir)
  const chapterRevision = sha256(JSON.stringify([receipt.revision, generation]))
  // Phones keep a rejected page's redo marker for good; naming the (finished) redo these pointers answer
  // tells them the page is no longer rejected. Pending redos never reach here (geometrySnapshot throws).
  const redos = new Map<string, string>()
  for (const p of snapshot.pages) {
    const redo = await readPageRedo(chapter.folderPath, p.page)
    if (redo?.status === 'imported') redos.set(p.page, redo.revision)
  }
  const jobs = snapshot.pages.map(p => {
    const payloadText = JSON.stringify({series,chapter:chapterName,chapterNumber:String(chapter.number),...p,...generation,
      scriptSha256:sha256(script),chapterRevision,cutRevision:receipt.revision,renderer:p.crops.some(c => cropRotation(c) !== 0) ? METADATA_RENDERER_ROTATE : METADATA_RENDERER,expectedPages:snapshot.pages.map(p=>p.page),
      ...(redos.has(p.page) ? {studioRedoRevision:redos.get(p.page)} : {}),
      // Only recreated pages carry the key, so every other page's job stays byte-identical.
      ...(typeof regenerations[p.page] === 'string' ? {studioRegeneration:regenerations[p.page]} : {})})
    return {schema:METADATA_JOB_SCHEMA,revision:sha256(payloadText),payloadText}
  })
  return {jobs, script, series, chapter:chapterName}
}
export async function metadataGenerations(chapter: Chapter) {
  const {requireSeriesRestartReady} = await import('../seriesRestartGuard.js')
  const {readPageReplacement} = await import('../chapterPageReplacement.js')
  const dir = getSourceFolderPath(chapter.folderPath)
  const replacement = await readPageReplacement(chapter.folderPath)
  return {restartRevision:await requireSeriesRestartReady(path.basename(path.dirname(dir))),pageRevision:replacement?.revision??null}
}
/** Durable job files survive cloud outages; a later Sync/Metadata refresh republishes them. */
export async function publishMetadataJobs(chapter: Chapter, options: {notify?: boolean} = {}) {
  return withUnmanagedCropChapter(chapter.folderPath, async () => {
    const current = await currentMetadataJobs(chapter, await metadataGenerations(chapter))
    const {createClient,getR2Config,phoneFolders} = await import('../r2Service.js')
    const config = getR2Config(); if (!config) return {queued:0,waiting:'Configure R2 to deliver approved pointers'}
    const client = createClient(config)
    try {
      const roots = [...new Set([config.prefix,'',...await phoneFolders(client,config)])]
      const get = (Key: string) => client.send(new GetObjectCommand({Bucket:config.bucket,Key})).catch((e:any)=>{if(e.name==='NoSuchKey'||e.$metadata?.httpStatusCode===404)return null;throw e})
      let results = 0
      for (const job of current.jobs) {
        const p = JSON.parse(job.payloadText), relative = `${current.series}/${current.chapter}/${path.parse(p.page).name}.page.json`
        await atomic(path.join(getSourceFolderPath(chapter.folderPath),JOB_DIR,`${path.parse(p.page).name}.json`),job)
        // A page Studio made again: its result goes to R2 before its new job, so a phone that takes the
        // job finds the result in the same sync (MetadataStore.pull, then pullResults) instead of starting
        // the page itself. Written under our prefix, and over any older result a phone left elsewhere.
        let result: string | null = null
        if (typeof p.studioRegeneration === 'string') {
          const text = await readImageMetadata(chapter.folderPath, p.page)
          if (text) try { validateMetadataResult(text, job, current.script); result = JSON.stringify({schema:METADATA_RESULT_SCHEMA,series:current.series,chapter:current.chapter,page:p.page,revision:job.revision,metadataText:text}) } catch { /* not remade yet */ }
        }
        for (const prefix of roots) {
          if (result) {
            const resultKey = `${prefix}metadata/${relative}`
            const old = await get(resultKey)
            const body = old?.Body ? await old.Body.transformToString().catch(() => '') : null
            if ((body !== null || prefix === config.prefix) && body !== result) {
              await client.send(new PutObjectCommand({Bucket:config.bucket,Key:resultKey,Body:result,ContentType:'application/json'}))
              results++
            }
          }
          const key = `${prefix}shared/metadata-jobs/${relative}`
          const old = await get(key)
          if (!old?.Body || JSON.parse(await old.Body.transformToString()).revision !== job.revision)
            await client.send(new PutObjectCommand({Bucket:config.bucket,Key:key,Body:JSON.stringify(job),ContentType:'application/json'}))
        }
      }
      // A Metadata start already pulls these jobs; avoid a second full-library sync before dispatch.
      if (options.notify !== false) {
        const {sendPhoneRequest} = await import('../phoneRelay.js'); await sendPhoneRequest('sync',{series:current.series})
      }
      return {queued:current.jobs.length,results}
    } finally {client.destroy()}
  })
}
export function validateMetadataResult(text: string, job: {revision:string;payloadText:string}, script: string) {
  const p=JSON.parse(job.payloadText), value=JSON.parse(text)
  if(value.metadataJob?.schema!=='sleeper-cell-metadata/1'||value.metadataJob.revision!==job.revision||value.metadataJob.cutRevision!==p.cutRevision)throw new Error('Stale Metadata job result')
  if(!storyLinksCurrent(text,script,p.sourceSha256)||value.storyLinking.inputRevision!==job.revision)throw new Error('Invalid or stale English-script associations')
  if(!Array.isArray(value.crops)||value.crops.length!==p.crops.length)throw new Error('Incomplete crop metadata')
  for(let i=0;i<p.crops.length;i++) {
    const c=value.crops[i], expected=p.crops[i]
    if(c.id!==expected.id||c.exportedFilename!==expected.exportedFilename||typeof c.description!=='string'||!c.description.trim()||c.description.length>1200)throw new Error('Metadata differs from approved crop inventory')
  }
  return value
}
export async function importMetadataResult(chapter: Chapter, page: string, text: string) {
  return withUnmanagedCropChapter(chapter.folderPath,async()=>{
    const current=await currentMetadataJobs(chapter,await metadataGenerations(chapter))
    const job=current.jobs.find(j=>JSON.parse(j.payloadText).page===page)
    if(!job)throw new Error('Unknown Metadata page')
    validateMetadataResult(text,job,current.script)
    if(await readImageMetadata(chapter.folderPath,page)===text)return false
    await writeImageMetadata(chapter.folderPath,page,text)
    const {queueEditorPublish}=await import('../editorAutoPublish.js');queueEditorPublish(chapter.id)
    return true
  })
}
/**
 * Saves Metadata Studio made again for a page that already had some. [text] is valid for the page's current
 * job; the page gets a new regeneration stamp (so a new job revision) and the result is re-stamped with it.
 * The replaced file is kept in `.metadata-resets/<ms>/`. R2 and phones are updated by publishMetadataJobs.
 */
export async function saveRecreatedMetadata(chapter: Chapter, page: string, text: string) {
  return withUnmanagedCropChapter(chapter.folderPath, async () => {
    const dir = getSourceFolderPath(chapter.folderPath)
    const generation = await metadataGenerations(chapter)
    const before = await currentMetadataJobs(chapter, generation)
    const oldJob = before.jobs.find(j => JSON.parse(j.payloadText).page === page)
    if (!oldJob) throw new Error('Unknown Metadata page')
    validateMetadataResult(text, oldJob, before.script)
    const stamp = randomUUID()
    const after = await currentMetadataJobs(chapter, generation, {[page]: stamp})
    const job = after.jobs.find(j => JSON.parse(j.payloadText).page === page)!
    const value = JSON.parse(text)
    value.metadataJob.revision = job.revision
    value.storyLinking.inputRevision = job.revision
    const restamped = JSON.stringify(value, null, 2)
    validateMetadataResult(restamped, job, after.script)
    const previous = await readImageMetadata(chapter.folderPath, page)
    if (previous !== null) {
      const backup = path.join(dir, '.metadata-resets', String(Date.now()))
      await fs.mkdir(backup, { recursive: true })
      await fs.writeFile(path.join(backup, path.basename(getMetadataFilePathFor(chapter.folderPath, page))), previous)
    }
    await atomic(path.join(dir, REGENERATIONS), {...await readRegenerations(dir), [page]: stamp})
    await writeImageMetadata(chapter.folderPath, page, restamped)
    const {queueEditorPublish}=await import('../editorAutoPublish.js');queueEditorPublish(chapter.id)
    return {revision: job.revision, text: restamped}
  })
}
/** Explicit ordinary synchronization reads JSON results only, never crop-image archives. */
export async function fetchMetadataResults(chapter: Chapter) {
  const {createClient,getR2Config,phoneFolders}=await import('../r2Service.js');const config=getR2Config()
  if(!config)return {imported:0,errors:[] as string[]}
  const client=createClient(config);let imported=0;const errors:string[]=[]
  const dir=getSourceFolderPath(chapter.folderPath),relative=`${path.basename(path.dirname(dir))}/${path.basename(dir)}/`
  try {
    const roots=[...new Set([config.prefix,'',...await phoneFolders(client,config)])]
    for(const prefix of roots) {
      let token:string|undefined
      do {
        const list=await client.send(new ListObjectsV2Command({Bucket:config.bucket,Prefix:`${prefix}metadata/${relative}`,ContinuationToken:token}))
        for(const item of list.Contents??[]) {
          if(!item.Key?.endsWith('.page.json'))continue
          try {
            const object=await client.send(new GetObjectCommand({Bucket:config.bucket,Key:item.Key}));const result=JSON.parse(await object.Body!.transformToString())
            if(result.schema!=='sleeper-cell-metadata-result/1'||!safeName(result.page)||result.series!==path.basename(path.dirname(dir))||result.chapter!==path.basename(dir))throw new Error('Invalid Metadata result identity')
            if(await importMetadataResult(chapter,result.page,result.metadataText))imported++
          }catch(e){errors.push(e instanceof Error?e.message:String(e))}
        }
        token=list.NextContinuationToken
      }while(token)
    }
    return {imported,errors}
  }finally{client.destroy()}
}

/** Editor readiness must bind descriptions/links to the current approved cut, in either language. */
export async function requireCurrentSplitMetadata(chapter: Chapter) {
  const manifest = await getChapterManifest(chapter.folderPath)
  let split = false
  for (const image of manifest.images) {
    const points = await readImagePoints(chapter.folderPath,image.filename)
    const metadata = await readImageMetadata(chapter.folderPath,image.filename)
    if(points?.file?.workflow==='clipper-geometry/1' || (metadata && JSON.parse(metadata).metadataJob)) split = true
  }
  if(!split)return false
  const current = await currentMetadataJobs(chapter,await metadataGenerations(chapter))
  for(const job of current.jobs) {
    const p=JSON.parse(job.payloadText),text=await readImageMetadata(chapter.folderPath,p.page)
    if(!text)throw new Error(`Metadata missing: ${p.page}`)
    validateMetadataResult(text,job,current.script)
  }
  return true
}
