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
 * the last fetch, and unpack it into `<Series>/Processed/<Chapter>/`. Sync json
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
 */

import fs from 'fs/promises'
import path from 'path'
import { GetObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3'
import { prisma } from '../index.js'
import { readZip, type ZipEntry } from '../utils/zipReader.js'
import { createClient, getR2Config, type R2Config } from './r2Service.js'
import { FETCH_MARKER, getProcessedDir, type FetchMarker } from './clipper3/processedSync.js'
import { notReviewed, parseManifestReview, writeChapterReview } from './clipper3/chapterReview.js'

/** Folder the phone uploads chapter zips to, inside its R2 prefix. Keep in step with FOLDER in ChapterUpload.kt. */
export const CROPS_FOLDER = 'crops/'

/** In each Processed/<Chapter>/: which R2 zip it was unpacked from. Defined beside Sync json, which reads it too. */
export { FETCH_MARKER }

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

/** Where each series' zips were found last time, so a re-run tries that folder first. */
const foundFolders = new Map<string, string>()

async function listFolder(client: S3Client, config: R2Config, folder: string): Promise<ListedZip[]> {
  const zips: ListedZip[] = []
  let token: string | undefined
  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: config.bucket,
      Prefix: folder,
      ContinuationToken: token
    }))
    for (const obj of page.Contents ?? []) {
      const rest = obj.Key?.slice(folder.length) ?? ''
      // Only `<Chapter>.zip` directly in the folder.
      if (!rest.toLowerCase().endsWith('.zip') || rest.includes('/')) continue
      zips.push({
        key: obj.Key!,
        folder: rest.slice(0, -'.zip'.length),
        etag: (obj.ETag ?? '').replace(/"/g, ''),
        size: obj.Size ?? 0
      })
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (token)
  return zips
}

/**
 * The phone uploads under its own prefix setting, which may not match ours
 * (see readPolledReceipt), so the bucket root is tried too.
 */
async function listSeriesZips(client: S3Client, config: R2Config, seriesId: string, seriesName: string): Promise<ListedZip[]> {
  const rel = `${CROPS_FOLDER}${seriesName}/`
  const candidates = [...new Set([`${config.prefix}${rel}`, rel])]
  const last = foundFolders.get(seriesId)
  if (last) candidates.sort((a, b) => Number(b === last) - Number(a === last))

  for (const folder of candidates) {
    const zips = await listFolder(client, config, folder)
    if (zips.length > 0) {
      foundFolders.set(seriesId, folder)
      return zips
    }
  }
  foundFolders.delete(seriesId)
  return []
}

async function readMarkerEtag(processedDir: string): Promise<string | null> {
  try {
    const marker = JSON.parse(await fs.readFile(path.join(processedDir, FETCH_MARKER), 'utf-8'))
    return typeof marker?.etag === 'string' ? marker.etag : null
  } catch {
    return null
  }
}

// ============ Fetch ============

/**
 * Downloads and unpacks every chapter zip the phone has uploaded for this
 * series that isn't unpacked yet (or was re-uploaded since). `chapterIds`
 * narrows it to those chapters. A chapter that fails is reported and the rest
 * carry on.
 */
export async function fetchPhoneCrops(seriesId: string, chapterIds?: string[]): Promise<PhoneCropsFetch> {
  const result: PhoneCropsFetch = { configured: false, found: 0, fetched: [], upToDate: 0, unmatched: [], failed: [] }
  const config = getR2Config()
  if (!config) return result
  result.configured = true

  const series = await prisma.series.findUnique({
    where: { id: seriesId },
    select: {
      rootFolder: true,
      chapters: { select: { id: true, number: true, folderPath: true }, orderBy: { number: 'asc' } }
    }
  })
  if (!series) throw new Error('Series not found')

  const client = createClient(config)
  const zips = await listSeriesZips(client, config, seriesId, path.basename(series.rootFolder))
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

    const processedDir = getProcessedDir(chapter.folderPath)
    if (zip.etag && (await readMarkerEtag(processedDir)) === zip.etag) {
      result.upToDate++
      continue
    }

    try {
      if (zip.size > MAX_ZIP_BYTES) throw new Error(`The zip is unexpectedly large (${zip.size} bytes)`)
      const res = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: zip.key }))
      const body = Buffer.from(await res.Body!.transformToByteArray())
      const entries = readZip(body)
      const pages = await unpackChapterZip(entries, processedDir)
      const etag = (res.ETag ?? zip.etag).replace(/"/g, '')
      const review = parseManifestReview(readZipManifest(entries))

      // A new zip always rewrites the review record. An unreviewed one means
      // the crops changed since any earlier review, so that review no longer
      // describes what would be cut.
      await writeChapterReview(chapter.folderPath, review
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
        key: zip.key,
        etag,
        fetchedAt: new Date().toISOString(),
        pages,
        reviewed: review != null,
        ...(review ? { applied: false } : {})
      }
      await fs.writeFile(path.join(processedDir, FETCH_MARKER), JSON.stringify(marker, null, 2) + '\n', 'utf-8')
      result.fetched.push({ chapterId: chapter.id, chapterNumber: chapter.number, folder: zip.folder, pages, reviewed: review != null })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      console.error(`[clipper3] fetching ${zip.key} failed:`, reason)
      result.failed.push({ folder: zip.folder, reason })
    }
  }

  return result
}
