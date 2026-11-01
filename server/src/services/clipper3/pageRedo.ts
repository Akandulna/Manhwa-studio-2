import fs from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'
import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { getSourceFolderPath, getPointsFilePathFor, getMetadataFilePathFor, getOutputDir, stemOf } from './perImageStore.js'
import { sha256 } from './studioCropAuthorityModel.js'
import { withUnmanagedCropChapter } from '../managedCropProjection.js'
import { writeChapterReview, notReviewed, CHAPTER_REVIEW_FILE } from './chapterReview.js'

export interface PageRedo {
  schema: 'studio-page-redo/1'
  revision: string
  series: string
  chapter: string
  chapterNumber: string
  page: string
  sourceSha256: string
  sourceBytes: number
  restartRevision: string | null
  pageRevision: string | null
  deviceId: string | null
  requestedAt: string
  status: 'pending' | 'imported'
  deliveryError?: string
  deliveredAt?: string
}
const directory = '.studio-page-redo'
function fileFor(folder: string, filename: string) {
  if (path.basename(filename) !== filename || filename.startsWith('.') || filename.includes('\\')) throw new Error('Invalid page filename')
  return path.join(getSourceFolderPath(folder), directory, `${filename}.json`)
}
export async function readPageRedo(folder: string, filename: string): Promise<PageRedo | null> {
  try {
    const value = JSON.parse(await fs.readFile(fileFor(folder, filename), 'utf8'))
    if (value.schema !== 'studio-page-redo/1' || value.page !== filename || !value.revision) throw new Error('Unreadable page redo request')
    return value
  } catch (error: any) { if (error.code === 'ENOENT') return null; throw error }
}
async function save(folder: string, value: PageRedo) {
  const target = fileFor(folder, value.page)
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temp = `${target}.${randomUUID()}.tmp`
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n')
  await fs.rename(temp, target)
}
/** Old incoming JSON is never eligible again, including after a restart or an interrupted import. */
export function matchesRedo(value: PageRedo, pointers: string, metadata: string): boolean {
  try { const p=JSON.parse(pointers); return p.studioRedoRevision === value.revision && (p.workflow==='clipper-geometry/1' ? true : JSON.parse(metadata).studioRedoRevision === value.revision) }
  catch { return false }
}
export async function finishPageRedo(folder: string, value: PageRedo) { await save(folder, { ...value, status: 'imported' }) }

/** Back up only this page; repeat delivery keeps the same request and never clears subsequent progress. */
export async function rejectPage(input: { folderPath: string; filename: string; chapterNumber: number; seriesSlug: string;
  restartRevision: string | null; pageRevision: string | null; deviceId: string | null },
  publish: (request: PageRedo) => Promise<void>): Promise<PageRedo> {
  return withUnmanagedCropChapter(input.folderPath, async () => {
    const dir = getSourceFolderPath(input.folderPath)
    let request = await readPageRedo(input.folderPath, input.filename)
    const source = await fs.readFile(path.join(dir, input.filename))
    if (request?.status !== 'pending' || request.sourceSha256 !== sha256(source) || request.restartRevision !== input.restartRevision || request.pageRevision !== input.pageRevision) {
      request = { schema: 'studio-page-redo/1', revision: randomUUID(), series: path.basename(path.dirname(dir)),
        chapter: path.basename(dir), chapterNumber: String(input.chapterNumber), page: input.filename,
        sourceSha256: sha256(source), sourceBytes: source.length, restartRevision: input.restartRevision,
        pageRevision: input.pageRevision, deviceId: input.deviceId, requestedAt: new Date().toISOString(), status: 'pending' }
      const backup = path.join(dir, directory, 'backups', request.revision)
      const candidates = [getPointsFilePathFor(input.folderPath, input.filename), getMetadataFilePathFor(input.folderPath, input.filename), path.join(dir, CHAPTER_REVIEW_FILE)]
      const output = getOutputDir(input.folderPath), prefix = `${input.seriesSlug}_${stemOf(input.filename)}_`
      for (const name of await fs.readdir(output).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return []; throw e })) {
        if (name.startsWith(prefix)) candidates.push(path.join(output, name))
      }
      await fs.mkdir(backup, { recursive: true })
      for (const source of candidates) {
        const target = path.join(backup, path.relative(dir, source)); await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.copyFile(source, target).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e })
      }
      // Persist the rejection before detaching: a crash can never make old drop-off JSON eligible.
      await save(input.folderPath, request)
      await writeChapterReview(input.folderPath, notReviewed())
      for (const source of candidates.filter(p => p !== path.join(dir, CHAPTER_REVIEW_FILE))) await fs.rm(source, { force: true })
    }
    try { await publish(request); request = { ...request, deliveredAt: new Date().toISOString(), deliveryError: undefined } }
    catch (error) { request = { ...request, deliveryError: error instanceof Error ? error.message : String(error) } }
    await save(input.folderPath, request)
    return request
  })
}

/** Explicit rejection is the only producer of redo commands. Sync never calls this. */
export async function publishPageRedo(request: PageRedo): Promise<void> {
  const { createClient, getR2Config, phoneFolders } = await import('../r2Service.js')
  const config = getR2Config(); if (!config) throw new Error('Configure cloud storage before requesting a redo')
  const client = createClient(config)
  try {
    const roots = [...new Set([config.prefix, '', ...await phoneFolders(client, config)])]
    // Rejection revokes chapter completion while retaining every unaffected page's actual files.
    for (const prefix of roots) {
      for (const suffix of ['.cropped.json', '.reviewed.json']) await client.send(new DeleteObjectCommand({
        Bucket: config.bucket, Key: `${prefix}crops/${request.series}/${request.chapter}${suffix}` }))
    }
    for (const prefix of roots) await client.send(new PutObjectCommand({ Bucket: config.bucket,
      Key: `${prefix}shared/studio-page-redo/${request.series}/${request.chapter}/${stemOf(request.page)}.json`,
      Body: JSON.stringify(request), ContentType: 'application/json' }))
    const { sendPhoneRequest } = await import('../phoneRelay.js')
    await sendPhoneRequest('sync', { series: request.series })
  } finally { client.destroy() }
}

export async function hasPendingPageRedo(folder: string): Promise<boolean> {
  const dir = path.join(getSourceFolderPath(folder), directory)
  for (const name of await fs.readdir(dir).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return []; throw e })) {
    if (name.endsWith('.json') && (await readPageRedo(folder, name.slice(0, -5)))?.status === 'pending') return true
  }
  return false
}
