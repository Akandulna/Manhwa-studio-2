import {withUnmanagedCropChapter,assertUnmanagedCropChapter} from './managedCropProjection.js'
/**
 * Fetch crop JSON made on the Sleeper-Cell phone into `Processed/`.
 *
 * As soon as every page of a chapter is done, the phone uploads
 * `<phone prefix>crops/<Series>/<Chapter>.zip` (see ChapterUpload.kt), replacing
 * any earlier upload of that chapter. The zip holds one `<Series>/` folder laid
 * out like the phone's Crops/Output:
 *
 *     <Series>/<Chapter>/chapter.json                               what's in the zip
 *     <Series>/<Chapter>/page_###/crop-pointers-ch###-p###.json     one folder per page
 *                                 crop-metadata-ch###-p###.json
 *
 * which is the Sync json drop-off layout already, so fetching is: list the
 * series' folder in R2, download each chapter zip that is new or changed since
 * the last fetch, and unpack it into `<Series>/Processed/<Chapter>/`. Exact current story-link returns
 * are attached immediately without changing reviewed visual inputs. Other candidates wait for Sync json, which
 * then attaches it like any hand-made drop-off. The zip is read in memory and
 * never written to disk, so there is nothing to clean up after.
 *
 * R2 cost per fetch: one or two LISTs (Class A), plus one GET (Class B) per
 * chapter whose zip changed. A marker file in each chapter's Processed folder
 * remembers the ETag it was unpacked from, so a re-run downloads nothing new.
 * Nothing here runs on a timer; only the Sync json button calls it.
 *
 * Review: the Master phone re-uploads the SAME key after a whole-chapter
 * review, with corrected JSON and a `review` object in chapter.json. Each
 * fetch writes the chapter's review record (chapterReview.ts) from that
 * object — reviewed, or not reviewed when a clipping phone's fresh zip
 * replaced a reviewed one — and notes it in the marker, which is what tells
 * Sync json to replace already-attached pages once (processedSync.ts).
 *
 * Cropped: a chapter cut here (crops3/ has output) is finished, and counts as
 * reviewed. The phones are told with a marker beside the chapter's zip,
 *
 *     <same folder as the zips>/<Chapter>.cropped.json
 *
 * so the Master shows it as Cropped (no review) and clipping phones hold
 * their uploads over it. It is written after every cut, backfilled by Sync
 * json for chapters cut before the marker existed, and by the Library's
 * "Publish cropped chapters" for every series. Only an explicit page replacement removes those markers.
 *
 * Reviewed: the desktop's own Mark reviewed (Preview) is told the same way,
 *
 *     <same folder as the zips>/<Chapter>.reviewed.json
 *
 * so the Master shows the chapter as reviewed in Studio and doesn't offer it
 * for review again. Mark reviewed writes it and Unmark removes it; Sync json
 * puts R2 back in step with the desktop's records when either call failed.
 * Phone reviews need no marker: they travel in the zip's chapter.json.
 */

import { recordManagerTransfer } from './managerReporting.js'
import { withSeriesMutation } from './seriesActivity.js'
import { requireSeriesRestartReady } from './seriesRestartGuard.js'
import fs from 'fs/promises'
import path from 'path'
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import { prisma } from '../index.js'
import { readZip, type ZipEntry } from '../utils/zipReader.js'
import { createClient, getR2Config, phoneFolders, type R2Config } from './r2Service.js'
import { getChapterManifest } from './chapterManifest.js'
import { getOutputDir, listOutputs, stemOf } from './clipper3/perImageStore.js'
import { seriesSlug } from './clipper3/chapterCrop.js'
import { FETCH_MARKER, getProcessedDir, syncChapterProcessed, type FetchMarker } from './clipper3/processedSync.js'
import { notReviewed, parseManifestReview, readChapterReview, readEffectiveReview, writeChapterReview } from './clipper3/chapterReview.js'
import { matchesPageRevision, pageReplacementActive, readPageReplacement } from './chapterPageReplacement.js'

/** Folder the phone uploads chapter zips to, inside its R2 prefix. Keep in step with FOLDER in ChapterUpload.kt. */
export const CROPS_FOLDER = 'crops/'

/** In each Processed/<Chapter>/: which R2 zip it was unpacked from. Defined beside Sync json, which reads it too. */
export { FETCH_MARKER }

/** Beside `<Chapter>.zip`: the desktop has cut this chapter. Keep in step with the phones. */
export const CROPPED_SUFFIX = '.cropped.json'
export const CROPPED_SCHEMA = 'manhwa-studio-cropped/1'

/** Beside `<Chapter>.zip`: the desktop marked this chapter reviewed. Keep in step with ReviewSync.REVIEWED_SUFFIX. */
export const REVIEWED_SUFFIX = '.reviewed.json'
export const REVIEWED_SCHEMA = 'manhwa-studio-reviewed/1'

/** The chapter manifest the phone puts in each zip; kept alongside the pages. */
const MANIFEST_FILE = 'chapter.json'

/** Crop zips are JSON only; anything bigger is not one of ours. */
const MAX_ZIP_BYTES = 32 * 1024 * 1024

const CROP_FILE = /^crop-(pointers|metadata)-[^/\\]*\.json$/i

export interface FetchedChapter {
  chapterId: string
  chapterNumber: number
  /** Chapter folder name, as on the desktop and in R2. */
  folder: string
  /** Page folders unpacked. */
  pages: number
  /** The zip's chapter.json carries a Master phone review; cropping is now allowed. */
  reviewed: boolean
}

export interface PhoneCropsFetch {
  /** False when R2 is not set up; nothing was looked at. */
  configured: boolean
  /** Chapter zips in R2 for this series (every one is a finished chapter). */
  found: number
  /** Chapters unpacked by this run: new, or the phone re-uploaded them. */
  fetched: FetchedChapter[]
  /** Chapters already unpacked from the same zip earlier. */
  upToDate: number
  /** Zips in R2 with no desktop chapter folder of that name. */
  unmatched: string[]
  failed: { folder: string; reason: string }[]
  /** Cropped markers this run put in R2 for chapters cut before they existed. */
  cropped: CroppedPublish
  /** Reviewed markers this run put in R2 or took out of it, to match the desktop's reviews. */
  reviewedMarkers: ReviewedPublish
  metadata?: {imported:number;errors:string[]}
}

/** What putting the reviewed markers in step did. */
export interface ReviewedPublish {
  /** Chapter folders whose `.reviewed.json` was written. */
  published: string[]
  /** Chapter folders whose `.reviewed.json` was removed (no longer reviewed on the desktop). */
  removed: string[]
  failed: { folder: string; reason: string }[]
}

/** What a cropped-marker backfill wrote. */
export interface CroppedPublish {
  /** Chapter folders whose `.cropped.json` was written. */
  published: string[]
  failed: { folder: string; reason: string }[]
}

// ============ Unpacking ============

/** A single path segment that can't climb out of the folder it is joined to. */
function isSafeSegment(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && !/[/\\\0]/.test(name)
}

/**
 * Writes a chapter zip's entries into `processedDir` (`<Series>/Processed/<Chapter>/`)
 * and returns how many page folders it wrote.
 *
 * Entries are `<Series>/<Chapter>/…`; both leading folders are dropped rather
 * than checked, so a series or chapter renamed on one side still lands in the
 * folder the zip was matched to. Only `chapter.json` and
 * `page_###/crop-{pointers,metadata}-*.json` are written; anything else in the
 * zip is ignored. A page folder's old crop files are removed first: Sync json
 * finds them by prefix, and a stale file with an older name would sit beside
 * the new one.
 */
export async function unpackChapterZip(entries: ZipEntry[], processedDir: string): Promise<number> {
  const pages = new Map<string, { name: string; data: Buffer }[]>()
  let manifest: Buffer | null = null

  for (const { name, data } of entries) {
    const rel = name.split('/').filter(Boolean).slice(2)
    if (!rel.every(isSafeSegment)) continue
    if (rel.length === 1 && rel[0] === MANIFEST_FILE) {
      manifest = data
    } else if (rel.length === 2 && CROP_FILE.test(rel[1])) {
      const files = pages.get(rel[0]) ?? []
      files.push({ name: rel[1], data })
      pages.set(rel[0], files)
    }
  }
  if (pages.size === 0) throw new Error('The zip has no crop JSON in it')

  await fs.mkdir(processedDir, { recursive: true })
  for (const [folder, files] of pages) {
    const pageDir = path.join(processedDir, folder)
    await fs.mkdir(pageDir, { recursive: true })
    for (const old of await fs.readdir(pageDir)) {
      if (CROP_FILE.test(old)) await fs.rm(path.join(pageDir, old), { force: true })
    }
    for (const file of files) await fs.writeFile(path.join(pageDir, file.name), file.data)
  }
  if (manifest) await fs.writeFile(path.join(processedDir, MANIFEST_FILE), manifest)
  return pages.size
}

/**
 * The zip's chapter.json, parsed, or null when it has none or it isn't JSON.
 * Read from the zip rather than from disk: unpacking only writes chapter.json
 * when the zip has one, so the copy on disk can be an earlier upload's.
 */
export function readZipManifest(entries: ZipEntry[]): unknown {
  for (const { name, data } of entries) {
    const rel = name.split('/').filter(Boolean).slice(2)
    if (rel.length !== 1 || rel[0] !== MANIFEST_FILE) continue
    try {
      const text = data.toString('utf-8')
      return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
    } catch {
      return null
    }
  }
  return null
}

// ============ Finding the zips ============

interface ListedZip {
  key: string
  /** Chapter folder name: the key's file name without `.zip`. */
  folder: string
  etag: string
  size: number
}

/** One series folder in R2: its chapter zips and which chapters carry a cropped or reviewed marker. */
interface SeriesListing {
  /** The folder they were found in (`<prefix>crops/<Series>/`), or null when neither place has anything. */
  folder: string | null
  zips: ListedZip[]
  cropped: Set<string>
  reviewed: Set<string>
}

/** Where each series' zips were found last time, so a re-run tries that folder first. */
const foundFolders = new Map<string, string>()

async function listFolder(client: S3Client, config: R2Config, folder: string): Promise<Omit<SeriesListing, 'folder'>> {
  const zips: ListedZip[] = []
  const cropped = new Set<string>()
  const reviewed = new Set<string>()
  let token: string | undefined
  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: config.bucket,
      Prefix: folder,
      ContinuationToken: token
    }))
    for (const obj of page.Contents ?? []) {
      const rest = obj.Key?.slice(folder.length) ?? ''
      if (rest.includes('/')) continue
      if (rest.endsWith(CROPPED_SUFFIX)) {
        cropped.add(rest.slice(0, -CROPPED_SUFFIX.length))
        continue
      }
      if (rest.endsWith(REVIEWED_SUFFIX)) {
        reviewed.add(rest.slice(0, -REVIEWED_SUFFIX.length))
        continue
      }
      // Otherwise only `<Chapter>.zip` directly in the folder.
      if (!rest.toLowerCase().endsWith('.zip')) continue
      zips.push({
        key: obj.Key!,
        folder: rest.slice(0, -'.zip'.length),
        etag: (obj.ETag ?? '').replace(/"/g, ''),
        size: obj.Size ?? 0
      })
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (token)
  return { zips, cropped, reviewed }
}

/**
 * The phone uploads under its own prefix setting, which may not match ours
 * (see readPolledReceipt), so the bucket root is tried too. The first of the
 * two holding anything (a zip or a marker) is the series' folder.
 */
async function listSeries(client: S3Client, config: R2Config, seriesId: string, seriesName: string): Promise<SeriesListing> {
  const rel = `${CROPS_FOLDER}${seriesName}/`
  const candidates = [...new Set([`${config.prefix}${rel}`, rel])]
  const last = foundFolders.get(seriesId)
  if (last) candidates.sort((a, b) => Number(b === last) - Number(a === last))

  for (const folder of candidates) {
    const listed = await listFolder(client, config, folder)
    if (listed.zips.length > 0 || listed.cropped.size > 0 || listed.reviewed.size > 0) {
      foundFolders.set(seriesId, folder)
      return { folder, ...listed }
    }
  }
  foundFolders.delete(seriesId)
  return { folder: null, zips: [], cropped: new Set(), reviewed: new Set() }
}

// ============ Cropped markers ============

/** The marker's body: pretty JSON, read by the phones. */
export interface CroppedMarker {
  schema: typeof CROPPED_SCHEMA
  series: string
  chapter: string
  cropped_at: string
  /** Pages with at least one cut file. */
  pages: number
  /** Files in crops3/. */
  crops: number
}

/** `<folder><Chapter>.cropped.json`, where `folder` is a series folder ending in '/'. */
export function croppedMarkerKey(seriesFolder: string, chapter: string): string {
  return `${seriesFolder}${chapter}${CROPPED_SUFFIX}`
}

/**
 * What crops3/ says about a chapter's cut, or null when it was never cut.
 * `croppedAt` is the newest file's time — the same time the effective review
 * uses (chapterReview.ts), so the marker and the desktop agree.
 */
export async function chapterCropStats(
  folderPath: string,
  seriesTitle: string
): Promise<{ croppedAt: string; pages: number; crops: number } | null> {
  if (!(await readEffectiveReview(folderPath)).reviewed) return null
  const outputs = await listOutputs(folderPath)
  if (outputs.length === 0) return null

  let latest = 0
  for (const { filename } of outputs) {
    try {
      latest = Math.max(latest, (await fs.stat(path.join(getOutputDir(folderPath), filename))).mtimeMs)
    } catch {
      // Gone since the listing.
    }
  }

  // Pages are counted against the manifest by the cutter's own prefix
  // (`<slug>_<stem>_`), since a stem can't be read back out of a file name.
  let pages = 0
  try {
    const slug = seriesSlug(seriesTitle)
    for (const img of (await getChapterManifest(folderPath)).images) {
      const prefix = `${slug}_${stemOf(img.filename)}_`
      if (outputs.some(o => o.filename.startsWith(prefix))) pages++
    }
  } catch {
    // No readable manifest (pages deleted): the crop count still says it was cut.
  }
  return { croppedAt: new Date(latest || Date.now()).toISOString(), pages, crops: outputs.length }
}

export function buildCroppedMarker(
  series: string,
  chapter: string,
  stats: { croppedAt: string; pages: number; crops: number }
): CroppedMarker {
  return { schema: CROPPED_SCHEMA, series, chapter, cropped_at: stats.croppedAt, pages: stats.pages, crops: stats.crops }
}

/**
 * The series folders a marker goes in: the one the series' zips are in, or —
 * when R2 holds nothing for it yet — `crops/<Series>/` in every folder the
 * phone keeps its receipts in (both our prefix and the root when it has
 * never written one), so the phone finds it whatever its prefix setting.
 */
async function markerFolders(client: S3Client, config: R2Config, folder: string | null, seriesName: string): Promise<string[]> {
  if (folder) return [folder]
  return (await phoneFolders(client, config)).map(f => `${f}${CROPS_FOLDER}${seriesName}/`)
}

async function putCroppedMarker(client: S3Client, config: R2Config, folders: string[], marker: CroppedMarker): Promise<void> {
  for (const folder of folders) {
    await client.send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: croppedMarkerKey(folder, marker.chapter),
      Body: JSON.stringify(marker, null, 2) + '\n',
      ContentType: 'application/json'
    }))
  }
}

interface MarkerSeries {
  rootFolder: string
  title: string
  chapters: { id: string; number: number; folderPath: string }[]
}

/**
 * Writes a marker for every cut chapter of the series that R2 doesn't list
 * one for. Never throws: a failure is reported per chapter, and cropping or
 * syncing carries on regardless.
 */
async function backfillCropped(
  client: S3Client,
  config: R2Config,
  series: MarkerSeries,
  listing: SeriesListing
): Promise<CroppedPublish> {
  const result: CroppedPublish = { published: [], failed: [] }
  const seriesName = path.basename(series.rootFolder)
  let folders: string[] | null = null

  for (const chapter of series.chapters) {
    const folder = path.basename(chapter.folderPath)
    if (listing.cropped.has(folder)) continue
    try {
      await assertUnmanagedCropChapter(chapter.folderPath)
      const stats = await chapterCropStats(chapter.folderPath, series.title)
      if (!stats) continue
      folders ??= await markerFolders(client, config, listing.folder, seriesName)
      await withUnmanagedCropChapter(chapter.folderPath,()=>putCroppedMarker(client, config, folders!, buildCroppedMarker(seriesName, folder, stats)))
      result.published.push(folder)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      console.error(`[clipper3] publishing the cropped marker for ${seriesName}/${folder} failed:`, reason)
      result.failed.push({ folder, reason })
    }
  }
  return result
}

/**
 * After a cut: (re)writes that chapter's marker with the new cropped_at.
 * Resolves to null when R2 is not set up or the chapter has no output; never
 * throws, so a failed PUT can't fail the cut that triggered it.
 */
export async function publishChapterCropped(chapterId: string): Promise<{ keys: string[] } | { error: string } | null> {
  const config = getR2Config()
  if (!config) return null
  try {
    const chapter = await prisma.chapter.findUnique({
      where: { id: chapterId },
      select: { folderPath: true, seriesId: true, series: { select: { rootFolder: true, title: true } } }
    })
    if (!chapter) return null
    return await withUnmanagedCropChapter(chapter.folderPath,async()=>{
    const stats = await chapterCropStats(chapter.folderPath, chapter.series.title)
    if (!stats) return null

    const client = createClient(config)
    const seriesName = path.basename(chapter.series.rootFolder)
    // The folder found by the last Sync json, else one LIST to find it.
    const known = foundFolders.get(chapter.seriesId)
    const folder = known ?? (await listSeries(client, config, chapter.seriesId, seriesName)).folder
    const folders = await markerFolders(client, config, folder, seriesName)
    const chapterName = path.basename(chapter.folderPath)
    await putCroppedMarker(client, config, folders, buildCroppedMarker(seriesName, chapterName, stats))
    return { keys: folders.map(f => croppedMarkerKey(f, chapterName)) }
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error(`[clipper3] publishing the cropped marker for chapter ${chapterId} failed:`, reason)
    return { error: reason }
  }
}

// ============ Reviewed markers ============

/** The marker's body: pretty JSON, read by the phones. */
export interface ReviewedMarker {
  schema: typeof REVIEWED_SCHEMA
  series: string
  chapter: string
  reviewed: true
  reviewed_at: string | null
  by: 'desktop'
}

/** `<folder><Chapter>.reviewed.json`, where `folder` is a series folder ending in '/'. */
export function reviewedMarkerKey(seriesFolder: string, chapter: string): string {
  return `${seriesFolder}${chapter}${REVIEWED_SUFFIX}`
}

export function buildReviewedMarker(series: string, chapter: string, reviewedAt: string | null): ReviewedMarker {
  return { schema: REVIEWED_SCHEMA, series, chapter, reviewed: true, reviewed_at: reviewedAt, by: 'desktop' }
}

/** The desktop's own review of the chapter, or null: phone reviews and cuts have their own way to the phones. */
async function desktopReviewedAt(folderPath: string): Promise<{ reviewedAt: string | null } | null> {
  const review = await readChapterReview(folderPath)
  return review.reviewed && review.by === 'desktop' ? { reviewedAt: review.reviewedAt } : null
}

async function putReviewedMarker(client: S3Client, config: R2Config, folders: string[], marker: ReviewedMarker): Promise<void> {
  for (const folder of folders) {
    await client.send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: reviewedMarkerKey(folder, marker.chapter),
      Body: JSON.stringify(marker, null, 2) + '\n',
      ContentType: 'application/json'
    }))
  }
}

async function deleteReviewedMarker(client: S3Client, config: R2Config, folders: string[], chapter: string): Promise<void> {
  for (const folder of folders) {
    await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: reviewedMarkerKey(folder, chapter) }))
  }
}

/**
 * Puts R2's reviewed markers in step with the desktop's reviews: one for each
 * chapter marked reviewed here that R2 doesn't list, and none for a chapter
 * no longer reviewed here. Never throws; a failure is reported per chapter.
 */
async function syncReviewedMarkers(
  client: S3Client,
  config: R2Config,
  series: MarkerSeries,
  listing: SeriesListing
): Promise<ReviewedPublish> {
  const result: ReviewedPublish = { published: [], removed: [], failed: [] }
  const seriesName = path.basename(series.rootFolder)
  let folders: string[] | null = null

  for (const chapter of series.chapters) {
    const folder = path.basename(chapter.folderPath)
    try {
      const review = await desktopReviewedAt(chapter.folderPath)
      const listed = listing.reviewed.has(folder)
      if (review && !listed) {
        folders ??= await markerFolders(client, config, listing.folder, seriesName)
        await putReviewedMarker(client, config, folders, buildReviewedMarker(seriesName, folder, review.reviewedAt))
        result.published.push(folder)
      } else if (!review && listed && listing.folder) {
        await deleteReviewedMarker(client, config, [listing.folder], folder)
        result.removed.push(folder)
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      console.error(`[clipper3] updating the reviewed marker for ${seriesName}/${folder} failed:`, reason)
      result.failed.push({ folder, reason })
    }
  }
  return result
}

/**
 * After the desktop's Mark reviewed or Unmark: writes or removes that
 * chapter's reviewed marker. Resolves to null when R2 is not set up; never
 * throws, so a failed PUT can't fail the review that triggered it (the next
 * Sync json tries again).
 */
export async function publishChapterReviewed(chapterId: string): Promise<{ keys: string[]; reviewed: boolean } | { error: string } | null> {
  const config = getR2Config()
  if (!config) return null
  try {
    const chapter = await prisma.chapter.findUnique({
      where: { id: chapterId },
      select: { folderPath: true, seriesId: true, series: { select: { rootFolder: true } } }
    })
    if (!chapter) return null
    const client = createClient(config)
    const seriesName = path.basename(chapter.series.rootFolder)
    const known = foundFolders.get(chapter.seriesId)
    const folder = known ?? (await listSeries(client, config, chapter.seriesId, seriesName)).folder
    const folders = await markerFolders(client, config, folder, seriesName)
    const chapterName = path.basename(chapter.folderPath)
    const review = await desktopReviewedAt(chapter.folderPath)
    if (review) await putReviewedMarker(client, config, folders, buildReviewedMarker(seriesName, chapterName, review.reviewedAt))
    else await deleteReviewedMarker(client, config, folders, chapterName)
    return { keys: folders.map(f => reviewedMarkerKey(f, chapterName)), reviewed: review != null }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error(`[clipper3] publishing the reviewed marker for chapter ${chapterId} failed:`, reason)
    return { error: reason }
  }
}

/** What the Library's "Publish cropped chapters" did. */
export interface CroppedPublishAll {
  configured: boolean
  /** Series that had at least one cut chapter, and so were listed. */
  series: number
  published: { series: string; chapter: string }[]
  failed: { series: string; folder: string; reason: string }[]
}

/**
 * The backfill for every series: one LIST per series with a cut chapter, plus
 * a PUT per marker R2 doesn't have yet. Series with nothing cut cost nothing.
 */
export async function publishAllCroppedMarkers(): Promise<CroppedPublishAll> {
  const result: CroppedPublishAll = { configured: false, series: 0, published: [], failed: [] }
  const config = getR2Config()
  if (!config) return result
  result.configured = true

  const client = createClient(config)
  const allSeries = await prisma.series.findMany({
    select: {
      id: true,
      rootFolder: true,
      title: true,
      chapters: { select: { id: true, number: true, folderPath: true }, orderBy: { number: 'asc' } }
    }
  })

  for (const series of allSeries) {
    const seriesName = path.basename(series.rootFolder)
    const cut = []
    for (const chapter of series.chapters) {
      if ((await listOutputs(chapter.folderPath)).length > 0) cut.push(chapter)
    }
    if (cut.length === 0) continue
    result.series++
    try {
      const listing = await listSeries(client, config, series.id, seriesName)
      const done = await backfillCropped(client, config, { ...series, chapters: cut }, listing)
      result.published.push(...done.published.map(chapter => ({ series: seriesName, chapter })))
      result.failed.push(...done.failed.map(f => ({ series: seriesName, ...f })))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      console.error(`[clipper3] listing ${seriesName} for cropped markers failed:`, reason)
      result.failed.push({ series: seriesName, folder: '—', reason })
    }
  }
  return result
}

async function readMarkerEtag(processedDir: string): Promise<string | null> {
  try {
    const marker = JSON.parse(await fs.readFile(path.join(processedDir, FETCH_MARKER), 'utf-8'))
    return typeof marker?.etag === 'string' ? marker.etag : null
  } catch {
    return null
  }
}

/** Attach an exact story-link return without changing approved visual inputs or review state. */
async function attachStoryOnlyReturn(chapter: { id: string; number: number; folderPath: string }, slug: string): Promise<boolean> {
  let manifest
  try { manifest = await getChapterManifest(chapter.folderPath) } catch { return false }
  if (!manifest.images.length) return false
  const input = { chapterId: chapter.id, chapterNumber: chapter.number, folderPath: chapter.folderPath,
    seriesSlug: slug, images: manifest.images, storyLinksOnly: true }
  const preview = await syncChapterProcessed({ ...input, dryRun: true })
  if (preview.failed || preview.imported || preview.ready || preview.pages.length !== manifest.images.length ||
      preview.pages.some(page => page.status !== 'replaced' && page.status !== 'skipped')) return false
  const result = await syncChapterProcessed(input)
  if (result.failed) throw new Error('Could not attach the current story-link return; retry Sync json')
  return true
}

// ============ Fetch ============

/**
 * Downloads and unpacks every chapter zip the phone has uploaded for this
 * series that isn't unpacked yet (or was re-uploaded since). `chapterIds`
 * narrows it to those chapters. A chapter that fails is reported and the rest
 * carry on.
 */
export async function fetchPhoneCrops(seriesId: string, chapterIds?: string[]): Promise<PhoneCropsFetch> {
  const result: PhoneCropsFetch = {
    configured: false,
    found: 0,
    fetched: [],
    upToDate: 0,
    unmatched: [],
    failed: [],
    cropped: { published: [], failed: [] },
    reviewedMarkers: { published: [], removed: [], failed: [] }
  }
  const config = getR2Config()
  if (!config) return result
  result.configured = true

  const series = await prisma.series.findUnique({
    where: { id: seriesId },
    select: {
      rootFolder: true,
      title: true,
      chapters: { select: { id: true, number: true, folderPath: true }, orderBy: { number: 'asc' } }
    }
  })
  if (!series) throw new Error('Series not found')

  return withSeriesMutation(path.basename(series.rootFolder), async () => {
  const client = createClient(config)
  const listing = await listSeries(client, config, seriesId, path.basename(series.rootFolder))
  const zips = listing.zips
  result.found = zips.length

  const wanted = chapterIds ? new Set(chapterIds) : null
  const byFolder = new Map(series.chapters.map(c => [path.basename(c.folderPath), c]))
  zips.sort((a, b) => a.folder.localeCompare(b.folder, undefined, { numeric: true }))

  for (const zip of zips) {
    const chapter = byFolder.get(zip.folder)
    if (!chapter) {
      result.unmatched.push(zip.folder)
      continue
    }
    if (wanted && !wanted.has(chapter.id)) continue
    if (pageReplacementActive(chapter.folderPath)) {
      result.failed.push({ folder: zip.folder, reason: 'This chapter’s pages are being replaced. Sync its crops after the replacement finishes.' })
      continue
    }

    const processedDir = getProcessedDir(chapter.folderPath)
    if (zip.etag && (await readMarkerEtag(processedDir)) === zip.etag) {
      // A previous fetch may have staged links before the server stopped or before auto-attach existed.
      await withUnmanagedCropChapter(chapter.folderPath, () => attachStoryOnlyReturn(chapter, seriesSlug(series.title)))
      result.upToDate++
      continue
    }

    let managerObjectVersion: string | null = null
    try {
      await withUnmanagedCropChapter(chapter.folderPath,async()=>{
      if (zip.size > MAX_ZIP_BYTES) throw new Error(`The zip is unexpectedly large (${zip.size} bytes)`)
      const res = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: zip.key }))
      const body = Buffer.from(await res.Body!.transformToByteArray())
      managerObjectVersion = res.VersionId ?? res.ETag ?? zip.etag ?? null
      recordManagerTransfer({ seriesId, chapterId: chapter.id, stage: 'crop_json', phase: 'cloud', objectVersion: managerObjectVersion })
      const entries = readZip(body)
      const manifest = readZipManifest(entries)
      const restartRevision = await requireSeriesRestartReady(path.basename(series.rootFolder), (manifest as { restart_revision?: unknown } | null)?.restart_revision, true)
      if (!matchesPageRevision(await readPageReplacement(chapter.folderPath), (manifest as { page_revision?: unknown } | null)?.page_revision)) {
        throw new Error('These crops belong to an older page revision. Sync the replacement pages on the phone and clip them again.')
      }
      const pages = await unpackChapterZip(entries, processedDir)
      const etag = (res.ETag ?? zip.etag).replace(/"/g, '')
      const review = parseManifestReview(manifest)
      const storyOnlyReturn = await attachStoryOnlyReturn(chapter, seriesSlug(series.title))

      // Downloaded files are only candidates. They do not change Studio's
      // approved store and cannot revoke a desktop review or completed cut.
      const currentReview = await readEffectiveReview(chapter.folderPath)
      const studioFinal = currentReview.reviewed && (currentReview.by === 'desktop' || currentReview.by === 'cropped')
      if (!studioFinal && (review || !storyOnlyReturn)) await writeChapterReview(chapter.folderPath, review
        ? {
            reviewed: true,
            reviewedAt: review.reviewedAt,
            by: 'phone',
            ...(review.device ? { device: review.device } : {}),
            etag,
            editedPages: review.editedPages,
            movedCrops: review.movedCrops,
            deletedCrops: review.deletedCrops
          }
        : notReviewed())

      // `applied: false` asks the next Sync json to put the review over pages
      // already attached from the clipping phone's draft (processedSync.ts).
      const marker: FetchMarker = {
        ...(restartRevision ? { restartRevision } : {}),
        key: zip.key,
        etag,
        fetchedAt: new Date().toISOString(),
        pages,
        reviewed: review != null,
        ...(review ? { applied: false } : {})
      }
      await fs.writeFile(path.join(processedDir, FETCH_MARKER), JSON.stringify(marker, null, 2) + '\n', 'utf-8')
      recordManagerTransfer({ seriesId, chapterId: chapter.id, stage: 'crop_json', phase: 'imported', objectVersion: managerObjectVersion })
      result.fetched.push({ chapterId: chapter.id, chapterNumber: chapter.number, folder: zip.folder, pages, reviewed: review != null })
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      recordManagerTransfer({ seriesId, chapterId: chapter.id, stage: 'crop_json', phase: 'failed', objectVersion: managerObjectVersion })
      console.error(`[clipper3] fetching ${zip.key} failed:`, reason)
      result.failed.push({ folder: zip.folder, reason })
    }
  }

  // Chapters cut before cropped markers existed (or whose marker PUT failed
  // after a cut) get one now, from the listing already made above. The whole
  // series, not just `chapterIds`: it costs no extra LIST, and a phone
  // clipping an already-cut chapter is exactly what the marker prevents.
  result.cropped = await backfillCropped(client, config, series, listing)
  // The desktop's own reviews, so the Master shows them (same listing, no extra LIST).
  result.reviewedMarkers = await syncReviewedMarkers(client, config, series, listing)
  // Ordinary Sync also receives independent Metadata JSON; it never recuts or replaces pointers.
  const {fetchMetadataResults}=await import('./clipper3/metadataSplit.js')
  for (const chapter of series.chapters) {
    if(wanted && !wanted.has(chapter.id))continue
    if(!await fs.stat(path.join(process.env.DOWNLOAD_ROOT || './downloads',chapter.folderPath,'.metadata-cut-receipt.json')).then(()=>true,()=>false))continue
    if(await (await import('./managedCropProjection.js')).managedCropBindingCount(chapter.folderPath))continue
    const metadata=await fetchMetadataResults({...chapter,seriesId,series:{title:series.title}})
    result.metadata ??= {imported:0,errors:[]}
    result.metadata.imported+=metadata.imported
    result.metadata.errors.push(...metadata.errors.map(reason=>`${path.basename(chapter.folderPath)}: ${reason}`))
  }


  return result
  })
}
