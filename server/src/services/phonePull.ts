/**
 * Get chapters from phones: chapters the Master phone (Sleeper-Cell's Master
 * tab) downloaded itself and sent to R2, brought into this library, so Clipper 3,
 * Narration and Editor 2.0 have their pages here too.
 *
 * The Master sends exactly as Send to phone does (phoneSend.ts): one zip per
 * chapter, `<phone folder><Series>/<Chapter>.zip` holding
 * `<Series>/<Chapter>/<pages>`, listed in the series' index.json with
 * `from: "master"` (merged with ours, see phoneIndexMerge.ts). A pull unpacks
 * each picked zip into `<DOWNLOAD_ROOT>/<Series>/<Chapter>/`, makes the series
 * and chapter rows when they're missing (as Import Existing does), and records
 * the send in the PhoneChapterSend ledger as ours: Send to phone then knows the
 * phones have it and never uploads it again.
 *
 * R2 cost, on demand only: one bucket LIST and one GET per series index to see
 * what's there; one GET per chapter pulled.
 */

import fs from 'fs/promises'
import path from 'path'
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import { prisma } from '../index.js'
import { readZip } from '../utils/zipReader.js'
import { FROM_MASTER, indexEntries } from './phoneIndexMerge.js'
import { chapterFingerprint, chapterPages, phoneZipFolder } from './phoneSend.js'
import { createClient, getR2Config, invalidateStorage, isNotFound, measureBucket, type R2Config } from './r2Service.js'

const PAGE_FILE = /\.(jpe?g|png|webp|gif)$/i
/** A chapter zip bigger than this is refused rather than read into memory. */
const MAX_ZIP_BYTES = 512 * 1024 * 1024

export interface PullChapter {
  name: string
  number: number
  key: string
  etag: string | null
  sentAt: string
  files: number
  bytes: number
  fingerprint: string | null
  /** new: not in this library (or no pages here); changed: here, but the Master's pages differ. */
  state: 'new' | 'changed'
}

export interface PullSeries {
  folder: string
  /** This library's series of that folder; null when it would be made. */
  seriesId: string | null
  title: string
  chapters: PullChapter[]
}

export interface PullOffer {
  configured: boolean
  series: PullSeries[]
}

export interface PullResult {
  pulled: { folder: string; chapter: string; pages: number }[]
  failed: { folder: string; chapter: string; reason: string }[]
}

function downloadRoot(): string {
  return process.env.DOWNLOAD_ROOT || './downloads'
}

function isSafeSegment(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && !/[/\\\0]/.test(name)
}

async function readIndex(client: S3Client, config: R2Config, key: string): Promise<{ series: string; entries: ReturnType<typeof indexEntries> } | null> {
  try {
    const res = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
    const json = JSON.parse((await res.Body?.transformToString()) ?? 'null') as { series?: unknown } | null
    return { series: typeof json?.series === 'string' ? json.series : '', entries: indexEntries(json) }
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return null
    throw error
  }
}

/** The Master's chapters in R2 that this library doesn't have, or has with other pages. */
export async function listPhoneChapters(): Promise<PullOffer> {
  const config = getR2Config()
  if (!config) return { configured: false, series: [] }
  const client = createClient(config)
  const folder = await phoneZipFolder(client, config)
  const storage = await measureBucket(client, config.bucket, true)
  const present = new Set(storage.objects.map(o => o.key))
  const indexKeys = storage.objects.map(o => o.key).filter(k => k.startsWith(folder) && k.endsWith('/index.json'))

  const rows = await prisma.series.findMany({
    select: { id: true, title: true, rootFolder: true, chapters: { select: { id: true, folderPath: true } } }
  })
  const series: PullSeries[] = []
  for (const key of indexKeys) {
    const index = await readIndex(client, config, key)
    if (!index) continue
    const seriesFolder = index.series || key.slice(folder.length).split('/')[0]
    const row = rows.find(r => path.basename(r.rootFolder) === seriesFolder) ?? null
    const ledger = row
      ? new Map((await prisma.phoneChapterSend.findMany({ where: { seriesId: row.id } })).map(l => [l.chapterId, l]))
      : new Map()
    const chapters: PullChapter[] = []
    for (const [name, entry] of index.entries) {
      if (entry.from !== FROM_MASTER || entry.cleared === true || typeof entry.key !== 'string' || !present.has(entry.key)) continue
      const sentAt = typeof entry.sentAt === 'string' ? entry.sentAt : ''
      const local = row?.chapters.find(c => path.basename(c.folderPath) === name) ?? null
      let state: PullChapter['state'] = 'new'
      if (local) {
        const pages = await chapterPages(local.folderPath)
        if (pages.length > 0) {
          // This copy is in already, or the pages here are the same ones.
          if (ledger.get(local.id)?.sentAt?.toISOString() === sentAt) continue
          if (chapterFingerprint(pages) === entry.fingerprint) continue
          state = 'changed'
        }
      }
      chapters.push({
        name,
        number: typeof entry.number === 'number' ? entry.number : Number(name.match(/\d+(?:\.\d+)?/)?.[0] ?? 0),
        key: entry.key,
        etag: typeof entry.etag === 'string' ? entry.etag : null,
        sentAt,
        files: Number(entry.files) || 0,
        bytes: Number(entry.bytes) || 0,
        fingerprint: typeof entry.fingerprint === 'string' ? entry.fingerprint : null,
        state
      })
    }
    if (chapters.length === 0) continue
    chapters.sort((a, b) => a.number - b.number)
    series.push({ folder: seriesFolder, seriesId: row?.id ?? null, title: row?.title ?? seriesFolder, chapters })
  }
  series.sort((a, b) => a.title.localeCompare(b.title))
  return { configured: true, series }
}

/** Brings the picked chapters ([folder] and chapter names) into the library. */
export async function pullPhoneChapters(requests: { folder: string; chapters: string[] }[]): Promise<PullResult> {
  const config = getR2Config()
  if (!config) throw new Error('Cloudflare R2 is not set up')
  const client = createClient(config)
  const offer = await listPhoneChapters()
  const result: PullResult = { pulled: [], failed: [] }

  for (const request of requests) {
    const available = offer.series.find(s => s.folder === request.folder)
    for (const name of request.chapters) {
      const chapter = available?.chapters.find(c => c.name === name)
      if (!available || !chapter) {
        result.failed.push({ folder: request.folder, chapter: name, reason: 'Not in R2 any more, or already here' })
        continue
      }
      try {
        const pages = await pullChapter(client, config, available, chapter)
        result.pulled.push({ folder: available.folder, chapter: name, pages })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        console.error(`[phone-pull] ${chapter.key} failed:`, reason)
        result.failed.push({ folder: available.folder, chapter: name, reason })
      }
    }
  }
  invalidateStorage()
  return result
}

async function pullChapter(client: S3Client, config: R2Config, series: PullSeries, chapter: PullChapter): Promise<number> {
  if (!isSafeSegment(series.folder) || !isSafeSegment(chapter.name)) throw new Error('Unsafe folder name')
  const res = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: chapter.key }))
  if ((res.ContentLength ?? 0) > MAX_ZIP_BYTES) throw new Error(`The zip is unexpectedly large (${res.ContentLength} bytes)`)
  const zip = Buffer.from(await res.Body!.transformToByteArray())
  // Entries are <Series>/<Chapter>/<page>: the page images, by their own names.
  const files = readZip(zip)
    .map(entry => ({ name: entry.name.split('/').filter(Boolean).pop() ?? '', data: entry.data }))
    .filter(f => isSafeSegment(f.name) && !f.name.startsWith('.') && PAGE_FILE.test(f.name))
  if (files.length === 0) throw new Error('The zip has no pages in it')

  // The series and chapter rows, made when missing (Import Existing's way).
  let row = series.seriesId ? await prisma.series.findUnique({ where: { id: series.seriesId } }) : null
  row ??= await prisma.series.create({ data: { title: series.folder, sourceSite: 'phone', rootFolder: series.folder } })
  const chapters = await prisma.chapter.findMany({ where: { seriesId: row.id }, select: { id: true, number: true, folderPath: true } })
  let target = chapters.find(c => path.basename(c.folderPath) === chapter.name)
    ?? chapters.find(c => c.number === chapter.number)
    ?? null

  const folderPath = target?.folderPath ?? `${row.rootFolder}/${chapter.name}`
  const dir = path.join(downloadRoot(), folderPath)
  const staging = `${dir}.pull-tmp`
  const old = `${dir}.pull-old`
  await fs.rm(staging, { recursive: true, force: true })
  await fs.mkdir(staging, { recursive: true })
  for (const file of files) await fs.writeFile(path.join(staging, file.name), file.data)
  // Swapped in whole: the chapter is never half old, half new.
  await fs.rm(old, { recursive: true, force: true })
  const had = await fs.stat(dir).then(() => true, () => false)
  if (had) await fs.rename(dir, old)
  await fs.rename(staging, dir)
  if (had) await fs.rm(old, { recursive: true, force: true })

  const written = await chapterPages(folderPath)
  const bytes = written.reduce((sum, p) => sum + p.size, 0)
  target ??= await prisma.chapter.create({
    data: { seriesId: row.id, number: chapter.number, folderPath, status: 'done', pageCount: written.length, downloadedCount: written.length },
    select: { id: true, number: true, folderPath: true }
  })
  await prisma.page.deleteMany({ where: { chapterId: target.id } })
  for (let i = 0; i < written.length; i++) {
    await prisma.page.create({
      data: { chapterId: target.id, index: i + 1, localPath: path.join(folderPath, written[i].name), status: 'done', bytes: written[i].size }
    })
  }
  await prisma.chapter.update({
    where: { id: target.id },
    data: { status: 'done', pageCount: written.length, downloadedCount: written.length, error: null }
  })
  // Ours now in the ledger: Send to phone sees the phones have this copy and doesn't upload it again.
  const send = {
    key: chapter.key,
    etag: chapter.etag,
    fingerprint: chapterFingerprint(written),
    files: written.length,
    bytes,
    sentAt: chapter.sentAt ? new Date(chapter.sentAt) : new Date(),
    clearedAt: null
  }
  await prisma.phoneChapterSend.upsert({
    where: { chapterId: target.id },
    create: { chapterId: target.id, seriesId: row.id, ...send },
    update: send
  })
  return written.length
}
