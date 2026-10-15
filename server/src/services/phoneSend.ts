/**
 * Send chapters to the Sleeper-Cell phone app through Cloudflare R2, one zip per chapter.
 *
 * Each chapter goes up as `<phone prefix>manhwa/<Series>/<Chapter>.zip`, holding
 * `<Series>/<Chapter>/<pages>` (only the page images directly in the chapter
 * folder — the phone needs nothing else). Next to them, `index.json` lists every
 * chapter sent, in reading order, with what the desktop has of it. The phone
 * (ManhwaSync.kt) reads the index, downloads only the chapters it doesn't have
 * and unpacks each one into its series folder, so new chapters join the chapters
 * already there. Its "Clear done chapters" dialog ticks the chapters the index
 * marks done, deletes them from the phone and their zip from R2, and reports
 * them in its receipt.
 *
 * The PhoneChapterSend table is the ledger of what was sent:
 *   - a chapter is sent again only when its pages changed (fingerprint), and
 *   - never once the phone has cleared it, unless it is picked by hand.
 *
 * "Done" on the desktop (what the phone ticks for clearing) is: the video is
 * published, or the chapter has its crops (every page pointed and described in
 * Clipper 3) and its English script. Each index entry also says whether the
 * Hindi (Hinglish) script is done (`scriptHi`); the phone weighs that itself.
 *
 * Auto-send: a series can be set to send new chapters by itself once the
 * download queue goes idle (noteChapterDownloaded / flushAutoSend).
 *
 * After a send, the phone is asked to check R2 at once (requestPhoneUpdate with
 * action 'sync'): through the relay it starts downloading while it is open;
 * without the relay it picks the request up on its 30 s check while open.
 *
 * R2 cost per send: one LIST (the free-plan guard), one PUT per chapter (more
 * for chapters over 16 MB), one PUT for the index, deletes are free. Nothing
 * here runs on a timer.
 */

import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import type { Server } from 'socket.io'
import archiver from 'archiver'
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { prisma } from '../index.js'
import { isLibraryDeleted } from './libraryControls.js'
import { getPublishedChapters } from './storageService.js'
import { getImageFiles } from './chapterManifest.js'
import { listMetadataImageStems, listPointedImageStems, stemOf } from './clipper3/perImageStore.js'
import { phoneName, relayConfigured, relayReceipts } from './phoneRelay.js'
import { mergeSyncReceipts } from './phoneReceipts.js'
import { mergeIndex, type IndexChapter } from './phoneIndexMerge.js'
import {
  PART_SIZE,
  assertWithinFreePlan,
  createClient,
  getR2Config,
  invalidateStorage,
  measureBucket,
  isNotFound,
  missingR2Env,
  phoneFolders,
  readPolledReceipt,
  requestPhoneUpdate,
  setUploadBusy,
  type BucketStorage,
  type PhoneUpdateRequest,
  type R2Config
} from './r2Service.js'

/** Folder for chapter zips inside the phone's prefix. Keep in step with FOLDER in ManhwaSync.kt. */
export const PHONE_FOLDER = 'manhwa/'

/** Each series' chapter list for the phone. Keep in step with SeriesIndex.NAME in SeriesIndex.kt. */
export const INDEX_NAME = 'index.json'
const INDEX_SCHEMA = 'manhwa-studio-phone-index/1'

/** The receipt ManhwaSync.kt writes (RECEIPT_NAME there). */
const PHONE_RECEIPT_NAME = '_sleeper-cell.json'

/** Normal chapters are 14–20 pages; longer ones are stitched first (client LARGE_CHAPTER_PAGES), so auto-send waits for that. */
const LARGE_CHAPTER_PAGES = 40

const autoSendKey = (seriesId: string) => `phoneAutoSend:${seriesId}`
const indexStateKey = (seriesId: string) => `phoneIndex:${seriesId}`

/** Temp zips, one sub-folder per job; wiped at the start of each job. */
const TEMP_ROOT = path.join(os.tmpdir(), 'manhwa-studio-phone-send')

function downloadRoot(): string {
  return process.env.DOWNLOAD_ROOT || './downloads'
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ============ Pages ============

export interface ChapterPage {
  name: string
  size: number
}

/** The page images directly inside a chapter folder (what the phone gets), in page order. */
export async function chapterPages(folderPath: string): Promise<(ChapterPage & { absPath: string })[]> {
  const full = path.join(downloadRoot(), folderPath)
  let names: string[]
  try {
    names = await getImageFiles(full)
  } catch {
    return [] // Never downloaded, or deleted by hand.
  }
  const pages: (ChapterPage & { absPath: string })[] = []
  for (const name of names) {
    if (name.startsWith('.')) continue
    const absPath = path.join(full, name)
    try {
      pages.push({ name, size: (await fsp.stat(absPath)).size, absPath })
    } catch {
      // Vanished between the listing and the stat.
    }
  }
  return pages
}

/**
 * SHA-256 over "<name>\t<size>\n" per page, sorted by name in plain UTF-16
 * order. ChapterFingerprint.kt computes the same on the phone, so a chapter
 * already there with the same pages is kept rather than downloaded again.
 */
export function chapterFingerprint(pages: ChapterPage[]): string | null {
  if (pages.length === 0) return null
  const hash = createHash('sha256')
  const sorted = [...pages].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const page of sorted) hash.update(`${page.name}\t${page.size}\n`)
  return hash.digest('hex')
}

/** `<phone folder><Series>/<Chapter>.zip` */
export function chapterKey(phoneFolder: string, seriesFolder: string, chapterFolder: string): string {
  return `${phoneFolder}${seriesFolder}/${chapterFolder}.zip`
}

// ============ The phone's receipt ============

interface ReceiptChapter { state?: string; etag?: string; sentAt?: string; at?: string }

/** Version 2 of ManhwaSync.kt's receipt; version 1 (whole-series zips) has no `chapters` and is ignored. */
interface SyncReceipt {
  version?: number
  device?: string
  updatedAt?: string
  /** The phone's own R2 prefix, where it looks for `manhwa/`. */
  prefix?: unknown
  series?: Record<string, { chapters?: Record<string, ReceiptChapter>; cleared?: Record<string, { at?: string; sentAt?: string }> }>
}

/**
 * From the relay when it is set up (no R2 operation), every phone's merged
 * (see mergeSyncReceipts: a chapter counts as on the phones once all have it);
 * else R2: a HEAD, plus a GET when it changed, and only when `fresh` or never read.
 */
async function readSyncReceipt(config: R2Config | null, fresh: boolean): Promise<SyncReceipt> {
  const relayed = relayReceipts<Record<string, unknown>>('sync')
  if (relayed) return mergeSyncReceipts(relayed.map(r => ({ device: r.device, name: phoneName(r.device), body: r.body }))) as SyncReceipt
  if (!config) return {}
  return readPolledReceipt<SyncReceipt>(createClient(config), config, PHONE_RECEIPT_NAME, fresh).catch(() => ({}))
}

function receiptSeries(receipt: SyncReceipt, seriesFolder: string) {
  const entry = isObject(receipt.series) ? receipt.series[seriesFolder] : undefined
  return {
    chapters: (isObject(entry?.chapters) ? entry!.chapters : {}) as Record<string, ReceiptChapter>,
    cleared: (isObject(entry?.cleared) ? entry!.cleared : {}) as Record<string, { at?: string; sentAt?: string }>
  }
}

/**
 * Where the phone looks for chapter zips: its reported prefix, else the folder
 * its receipts are in (older builds don't report it), else ours.
 */
async function phoneFolder(client: S3Client, config: R2Config, receipt: SyncReceipt): Promise<string> {
  if (typeof receipt.prefix === 'string') {
    const prefix = receipt.prefix.trim().replace(/^\/+|\/+$/g, '')
    return `${prefix ? `${prefix}/` : ''}${PHONE_FOLDER}`
  }
  const folders = await phoneFolders(client, config).catch(() => [])
  return `${folders[0] ?? config.prefix}${PHONE_FOLDER}`
}

/** Where the phones' chapter zips are (`<prefix>manhwa/`): for Get chapters from phones (phonePull.ts). */
export async function phoneZipFolder(client: S3Client, config: R2Config): Promise<string> {
  return phoneFolder(client, config, await readSyncReceipt(config, false))
}

type Ledger = Awaited<ReturnType<typeof prisma.phoneChapterSend.findMany>>[number]

/**
 * Records the chapters the phone reports cleared. A clear older than the
 * chapter's last send is from before it was sent again, and is ignored.
 * Chapters cleared from an older whole-series copy get a row too, so they
 * aren't sent as new.
 */
async function reconcileCleared(
  seriesId: string,
  seriesFolder: string,
  chapters: { id: string; folderPath: string }[],
  ledger: Map<string, Ledger>,
  receipt: SyncReceipt
): Promise<void> {
  const { cleared } = receiptSeries(receipt, seriesFolder)
  for (const [chapterFolder, entry] of Object.entries(cleared)) {
    const chapter = chapters.find(c => path.basename(c.folderPath) === chapterFolder)
    const at = new Date(isObject(entry) && typeof entry.at === 'string' ? entry.at : '')
    if (!chapter || Number.isNaN(at.getTime())) continue
    const row = ledger.get(chapter.id)
    if (row?.clearedAt) continue
    if (row?.sentAt && at < row.sentAt) continue
    const saved = row
      ? await prisma.phoneChapterSend.update({ where: { chapterId: chapter.id }, data: { clearedAt: at } })
      : await prisma.phoneChapterSend.create({ data: { chapterId: chapter.id, seriesId, clearedAt: at } })
    ledger.set(chapter.id, saved)
  }
}

// ============ Desktop state ============

export interface DesktopChapterState {
  /** Every page has its crop pointers and metadata in Clipper 3. */
  crops: boolean
  /** The English script is done (or edited). */
  script: boolean
  /** The Hindi (Hinglish) script is done (or edited). */
  scriptHi: boolean
  published: boolean
  /** What the phone ticks for clearing: published, or crops and script. */
  done: boolean
}

async function cropsDone(folderPath: string): Promise<boolean> {
  let images: string[]
  try {
    images = await getImageFiles(path.join(downloadRoot(), folderPath))
  } catch {
    return false
  }
  if (images.length === 0) return false
  const [pointed, described] = await Promise.all([listPointedImageStems(folderPath), listMetadataImageStems(folderPath)])
  return images.every(image => pointed.has(stemOf(image)) && described.has(stemOf(image)))
}

async function desktopStates(
  seriesId: string,
  chapters: { id: string; folderPath: string }[],
  published: Awaited<ReturnType<typeof getPublishedChapters>>
): Promise<Map<string, DesktopChapterState>> {
  const scriptedIn = async (language: 'en' | 'hi') => new Set(
    (await prisma.chapterScript.findMany({
      where: { chapter: { seriesId }, language, status: { in: ['done', 'edited'] } },
      select: { chapterId: true }
    })).map(s => s.chapterId)
  )
  const [scripted, scriptedHi] = await Promise.all([scriptedIn('en'), scriptedIn('hi')])
  const states = new Map<string, DesktopChapterState>()
  for (const chapter of chapters) {
    const crops = await cropsDone(chapter.folderPath)
    const script = scripted.has(chapter.id)
    const isPublished = !!published.chapters[chapter.id]
    states.set(chapter.id, {
      crops,
      script,
      scriptHi: scriptedHi.has(chapter.id),
      published: isPublished,
      done: isPublished || (crops && script)
    })
  }
  return states
}

// ============ Plan ============

/**
 * new:         never sent
 * changed:     sent, but its pages have changed since (e.g. stitched)
 * sent:        in R2, the phone hasn't got it yet
 * downloading: the phone is downloading it
 * on_phone:    the phone has this copy
 * cleared:     the phone cleared it; not sent again unless picked
 */
export type PhoneChapterState = 'new' | 'changed' | 'sent' | 'downloading' | 'on_phone' | 'cleared'

export interface PhoneSendChapter {
  chapterId: string
  number: number
  folder: string
  pages: number
  bytes: number
  state: PhoneChapterState
  sentAt: string | null
  clearedAt: string | null
  /** When the phone unpacked this copy. */
  phoneAt: string | null
  /** Over the page limit: stitch it before sending (auto-send skips it). */
  needsStitch: boolean
  desktop: DesktopChapterState
}

export interface PhoneSendSeries {
  seriesId: string
  title: string
  folder: string
  autoSend: boolean
  chapters: PhoneSendChapter[]
  /** What a send picks by default: new or changed, not over the page limit, not done here already. */
  toSend: number
  onPhone: number
  /** Sent, the phone doesn't have them yet. */
  waiting: number
  cleared: number
  /** The index in R2 is behind the desktop (e.g. chapters finished since the last send). */
  indexStale: boolean
}

export interface PhoneSendPlan {
  configured: boolean
  missing: string[]
  device: string | null
  reportedAt: string | null
  series: PhoneSendSeries[]
}

interface SeriesRow {
  id: string
  title: string
  rootFolder: string
  chapters: { id: string; number: number; folderPath: string }[]
}

interface SeriesState {
  plan: PhoneSendSeries
  /** chapterId → folderPath, for the chapters in the plan. */
  folderPaths: Map<string, string>
  ledger: Map<string, Ledger>
  index: { series: string; chapters: IndexChapter[] }
  indexHash: string
}

async function loadSeriesRows(seriesIds?: string[]): Promise<SeriesRow[]> {
  return prisma.series.findMany({
    where: seriesIds ? { id: { in: seriesIds } } : undefined,
    select: { id: true, title: true, rootFolder: true, chapters: { select: { id: true, number: true, folderPath: true }, orderBy: { number: 'asc' } } },
    orderBy: { title: 'asc' }
  })
}

async function autoSendSeries(): Promise<Set<string>> {
  const rows = await prisma.setting.findMany({ where: { key: { startsWith: 'phoneAutoSend:' } } })
  return new Set(rows.filter(r => r.value === 'true').map(r => r.key.slice('phoneAutoSend:'.length)))
}

/** Every chapter of the series that was sent, or could be (unpublished, with pages), and the index for the phone. */
async function seriesState(row: SeriesRow, receipt: SyncReceipt, autoSend: boolean): Promise<SeriesState> {
  const seriesFolder = path.basename(row.rootFolder)
  const ledger = new Map(
    (await prisma.phoneChapterSend.findMany({ where: { seriesId: row.id } })).map(r => [r.chapterId, r])
  )
  await reconcileCleared(row.id, seriesFolder, row.chapters, ledger, receipt)
  const { chapters: onPhone } = receiptSeries(receipt, seriesFolder)
  const published = await getPublishedChapters(row.id)

  const pagesOf = new Map<string, ChapterPage[]>()
  for (const chapter of row.chapters) pagesOf.set(chapter.id, await chapterPages(chapter.folderPath))
  // Published chapters that never went to the phone don't need to now.
  const candidates = row.chapters
    .filter(chapter => ledger.has(chapter.id) || (pagesOf.get(chapter.id)!.length > 0 && !published.chapters[chapter.id]))
    .map(chapter => ({ chapter, pages: pagesOf.get(chapter.id)! }))
  const desktop = await desktopStates(row.id, row.chapters, published)

  const chapters: PhoneSendChapter[] = candidates.map(({ chapter, pages }) => {
    const folder = path.basename(chapter.folderPath)
    const sent = ledger.get(chapter.id)
    const fingerprint = chapterFingerprint(pages)
    const phone = onPhone[folder]
    const current = !!sent?.sentAt && isObject(phone) && phone.sentAt === sent.sentAt.toISOString()
    let state: PhoneChapterState
    if (sent?.clearedAt) state = 'cleared'
    else if (!sent?.sentAt) state = 'new'
    else if (fingerprint && sent.fingerprint !== fingerprint) state = 'changed'
    else if (current) state = phone.state === 'downloading' ? 'downloading' : 'on_phone'
    else state = 'sent'
    return {
      chapterId: chapter.id,
      number: chapter.number,
      folder,
      pages: pages.length,
      bytes: pages.reduce((sum, p) => sum + p.size, 0),
      state,
      sentAt: sent?.sentAt?.toISOString() ?? null,
      clearedAt: sent?.clearedAt?.toISOString() ?? null,
      phoneAt: current && phone.state === 'downloaded' && typeof phone.at === 'string' ? phone.at : null,
      needsStitch: pages.length > LARGE_CHAPTER_PAGES,
      desktop: desktop.get(chapter.id)!
    }
  })

  // Every chapter, sent or not: the phone may hold chapters from a whole-series
  // zip of before, and its clear dialog needs the desktop's state for those too.
  // Only sent ones have a key, so only they are downloaded.
  const indexChapters: IndexChapter[] = row.chapters.map(chapter => {
    const sent = ledger.get(chapter.id)
    const pages = pagesOf.get(chapter.id)!
    const cleared = !!sent?.clearedAt
    return {
      name: path.basename(chapter.folderPath),
      number: chapter.number,
      key: cleared || !sent?.sentAt ? null : sent.key,
      etag: cleared || !sent?.sentAt ? null : sent.etag,
      sentAt: sent?.sentAt?.toISOString() ?? '',
      files: sent?.sentAt ? sent.files : pages.length,
      bytes: sent?.sentAt ? sent.bytes : pages.reduce((sum, p) => sum + p.size, 0),
      fingerprint: sent?.sentAt ? sent.fingerprint : chapterFingerprint(pages),
      ...desktop.get(chapter.id)!,
      cleared
    }
  })
  const index = { series: seriesFolder, chapters: indexChapters }
  const indexHash = createHash('sha256').update(JSON.stringify(index)).digest('hex')
  const written = await prisma.setting.findUnique({ where: { key: indexStateKey(row.id) } })
  const writtenHash = written ? (JSON.parse(written.value) as { hash?: string }).hash : undefined

  return {
    plan: {
      seriesId: row.id,
      title: row.title,
      folder: seriesFolder,
      autoSend,
      chapters,
      toSend: chapters.filter(isDefaultPick).length,
      onPhone: chapters.filter(c => c.state === 'on_phone').length,
      waiting: chapters.filter(c => c.state === 'sent' || c.state === 'downloading').length,
      cleared: chapters.filter(c => c.state === 'cleared').length,
      indexStale: chapters.length > 0 && writtenHash !== indexHash
    },
    folderPaths: new Map(candidates.map(c => [c.chapter.id, c.chapter.folderPath])),
    ledger,
    index,
    indexHash
  }
}

/** New or changed, not over the page limit, and not finished on the desktop already (nothing left for the phone to do). */
function isDefaultPick(chapter: PhoneSendChapter): boolean {
  return (chapter.state === 'new' || chapter.state === 'changed') && !chapter.needsStitch && !chapter.desktop.done
}

/** What each series would send and what the phone has. No R2 operation once the phone's receipt has been read. */
export async function getSendPlan(fresh = false): Promise<PhoneSendPlan> {
  const config = getR2Config()
  const receipt = await readSyncReceipt(config, fresh)
  const auto = await autoSendSeries()
  const series: PhoneSendSeries[] = []
  for (const row of await loadSeriesRows()) {
    const { plan } = await seriesState(row, receipt, auto.has(row.id))
    if (plan.chapters.length > 0) series.push(plan)
  }
  return {
    configured: config !== null,
    missing: missingR2Env(),
    device: typeof receipt.device === 'string' ? receipt.device : null,
    reportedAt: typeof receipt.updatedAt === 'string' ? receipt.updatedAt : null,
    series
  }
}

/** One series' plan, as getSendPlan has it: for Run automation's checklist (phoneReadiness.ts). Null when the series is gone. */
export async function getSeriesSendPlan(seriesId: string): Promise<PhoneSendSeries | null> {
  const [row] = await loadSeriesRows([seriesId])
  if (!row) return null
  const receipt = await readSyncReceipt(getR2Config(), false)
  const auto = await autoSendSeries()
  return (await seriesState(row, receipt, auto.has(row.id))).plan
}

export async function setAutoSend(seriesId: string, enabled: boolean): Promise<void> {
  if (enabled) {
    await prisma.setting.upsert({ where: { key: autoSendKey(seriesId) }, create: { key: autoSendKey(seriesId), value: 'true' }, update: { value: 'true' } })
  } else {
    await prisma.setting.deleteMany({ where: { key: autoSendKey(seriesId) } })
  }
}

// ============ Index and clean-up ============

/**
 * Writes the series' index for the phone and remembers what was written: one
 * GET of the index there, merged with ours (the Master phone writes it too,
 * see phoneIndexMerge.ts), and one PUT.
 */
async function writeIndex(client: S3Client, config: R2Config, folder: string, seriesId: string, state: SeriesState): Promise<void> {
  if (await isLibraryDeleted(state.index.series)) return
  const key = `${folder}${state.index.series}/${INDEX_NAME}`
  let existing: unknown = null
  try {
    const res = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
    existing = JSON.parse((await res.Body?.transformToString()) ?? 'null')
  } catch (error) {
    if (!isNotFound(error) && !(error instanceof SyntaxError)) throw error
  }
  const chapters = mergeIndex(existing, state.index.chapters)
  const body = JSON.stringify({ schema: INDEX_SCHEMA, series: state.index.series, chapters, updatedAt: new Date().toISOString() }, null, 2)
  await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: body, ContentType: 'application/json' }))
  const previous = await prisma.setting.findUnique({ where: { key: indexStateKey(seriesId) } })
  const previousKey = previous ? (JSON.parse(previous.value) as { key?: string }).key : undefined
  // The phone's prefix changed: the old index would only mislead.
  if (previousKey && previousKey !== key) {
    await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: previousKey })).catch(() => {})
  }
  const value = JSON.stringify({ key, hash: state.indexHash, writtenAt: new Date().toISOString() })
  await prisma.setting.upsert({ where: { key: indexStateKey(seriesId) }, create: { key: indexStateKey(seriesId), value }, update: { value } })
}

/**
 * Deletes (free) the zips of chapters the phone cleared, in case it couldn't,
 * and the whole-series zips from before chapters were sent one by one.
 */
async function cleanUp(client: S3Client, config: R2Config, storage: BucketStorage, folder: string, state: SeriesState): Promise<void> {
  // Shared-library ZIPs must remain available to replicas that are offline. Local clears are not global deletes.
  const owner = await prisma.setting.findUnique({ where: { key: `libraryOwner:${state.plan.seriesId}` } })
  if (owner) return
  const present = new Map(storage.objects.map(o => [o.key, o.etag]))
  for (const row of state.ledger.values()) {
    if (!row.clearedAt || !row.key) continue
    // Only our own copy: the Master phone may have sent the chapter again under the same key since.
    const etag = present.get(row.key)
    if (present.has(row.key) && (!etag || !row.etag || etag === row.etag)) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: row.key }))
    }
    const saved = await prisma.phoneChapterSend.update({ where: { chapterId: row.chapterId }, data: { key: null, etag: null } })
    state.ledger.set(row.chapterId, saved)
  }
  const seriesFolder = state.index.series
  const legacy = [`${config.prefix}${seriesFolder}.zip`, `${seriesFolder}.zip`, `${folder}${seriesFolder}.zip`]
  for (const key of new Set(legacy)) {
    if (present.has(key)) await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }))
  }
  invalidateStorage()
}

/**
 * "Update the phone": writes the index of every series (or one) whose index
 * is behind, e.g. after chapters were finished or published, so the phone's
 * clear dialog ticks them. Returns how many indexes were written.
 */
export async function updatePhoneIndexes(seriesId?: string): Promise<{ written: number }> {
  const config = getR2Config()
  if (!config) throw new Error(`R2 is not configured. Missing: ${missingR2Env().join(', ')}`)
  if (currentJob?.state === 'running') throw new Error('Wait for the running send to finish')
  const client = createClient(config)
  const receipt = await readSyncReceipt(config, false)
  const folder = await phoneFolder(client, config, receipt)
  const auto = await autoSendSeries()
  let written = 0
  let storage: BucketStorage | null = null
  for (const row of await loadSeriesRows(seriesId ? [seriesId] : undefined)) {
    let state = await seriesState(row, receipt, auto.has(row.id))
    if (state.index.chapters.length === 0) continue
    if ([...state.ledger.values()].some(r => r.clearedAt && r.key)) {
      storage ??= await measureBucket(client, config.bucket, false, true)
      await cleanUp(client, config, storage, folder, state)
      state = await seriesState(row, receipt, auto.has(row.id))
    }
    if (!state.plan.indexStale) continue
    await writeIndex(client, config, folder, row.id, state)
    written++
  }
  return { written }
}

// ============ Sending ============

export type PhoneSendSeriesState = 'queued' | 'sending' | 'done' | 'skipped' | 'failed' | 'cancelled'

export interface PhoneSendSeriesProgress {
  seriesId: string
  title: string
  state: PhoneSendSeriesState
  /** Chapters picked to send, and how many are up. */
  chaptersTotal: number
  chaptersSent: number
  /** The chapter being zipped or uploaded. */
  current?: { folder: string; phase: 'zipping' | 'uploading' }
  /** Page bytes of the picked chapters, and how much of that is up. */
  bytesTotal: number
  bytesDone: number
  /** The series' folder in R2, once known. */
  folder?: string
  note?: string
  error?: string
}

export interface PhoneSendJob {
  id: string
  state: 'running' | 'done' | 'cancelled'
  bucket: string
  /** Started by auto-send after downloads, not by hand. */
  auto: boolean
  startedAt: string
  finishedAt?: string
  /** How the phone was asked to fetch the new chapters, once it was. */
  phone: PhoneUpdateRequest | null
  phoneError?: string
  series: PhoneSendSeriesProgress[]
}

export interface PhoneSendRequest {
  seriesId: string
  /** Exactly these chapters; without it, the default pick (see isDefaultPick). */
  chapterIds?: string[]
}

let currentJob: PhoneSendJob | null = null
let cancelRequested = false
let activeArchive: archiver.Archiver | null = null
let activeUpload: Upload | null = null

export function getSendJob(): PhoneSendJob | null {
  return currentJob
}

/** Already-compressed images: deflating them costs CPU and saves nothing. */
const STORE_EXTENSIONS = new Set(['.webp', '.jpg', '.jpeg', '.png', '.gif'])

/** Writes `<root>/<page>` entries; resolves once the file is flushed. */
function writeChapterZip(zipPath: string, root: string, pages: { name: string; absPath: string }[], onProgress: (bytes: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath)
    const archive = archiver('zip', { zlib: { level: 6 } })
    activeArchive = archive
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      activeArchive = null
      if (error) reject(error)
      else resolve()
    }
    output.on('close', () => finish(cancelRequested ? new Error('Cancelled') : undefined))
    output.on('error', err => finish(err))
    archive.on('error', err => finish(err))
    archive.on('warning', err => finish(err))
    archive.on('progress', p => onProgress(p.fs.processedBytes))
    archive.pipe(output)
    for (const page of pages) {
      // `store` is a per-entry zip option archiver honours but its types omit.
      archive.file(page.absPath, { name: `${root}/${page.name}`, store: STORE_EXTENSIONS.has(path.extname(page.name).toLowerCase()) } as archiver.EntryData)
    }
    void archive.finalize()
  })
}

async function freeBytes(dir: string): Promise<number | null> {
  try {
    const stats = await fsp.statfs(dir)
    return stats.bavail * stats.bsize
  } catch {
    return null
  }
}

/**
 * Start sending. Returns at once with the job; progress arrives as
 * `phone-send:progress`. Throws if R2 is unconfigured or a send is running.
 */
export async function startPhoneSend(requests: PhoneSendRequest[], io: Server, auto = false): Promise<PhoneSendJob> {
  const config = getR2Config()
  if (!config) throw new Error(`R2 is not configured. Missing: ${missingR2Env().join(', ')}`)
  if (currentJob?.state === 'running') throw new Error('A send is already running')
  if (requests.length === 0) throw new Error('No series selected')

  const rows = await loadSeriesRows(requests.map(r => r.seriesId))
  if (rows.length === 0) throw new Error('None of the selected series exist')
  const order = requests.map(r => r.seriesId)
  rows.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))

  const job: PhoneSendJob = {
    id: randomUUID(),
    state: 'running',
    bucket: config.bucket,
    auto,
    startedAt: new Date().toISOString(),
    phone: null,
    series: rows.map(s => ({ seriesId: s.id, title: s.title, state: 'queued', chaptersTotal: 0, chaptersSent: 0, bytesTotal: 0, bytesDone: 0 }))
  }
  currentJob = job
  cancelRequested = false
  setUploadBusy(true)

  // Progress fires per file and per upload chunk; throttle the socket to ~4/s.
  let lastEmit = 0
  const emit = (force = false) => {
    const now = Date.now()
    if (!force && now - lastEmit < 250) return
    lastEmit = now
    io.emit('phone-send:progress', job)
  }
  emit(true)

  const client = createClient(config)
  const jobDir = path.join(TEMP_ROOT, job.id)

  void (async () => {
    // No job is running, so anything left here is from a crash or a kill.
    await fsp.rm(TEMP_ROOT, { recursive: true, force: true })
    await fsp.mkdir(jobDir, { recursive: true })
    const receipt = await readSyncReceipt(config, false)
    const folder = await phoneFolder(client, config, receipt)
    const autoSeries = await autoSendSeries()
    let sent = 0

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const progress = job.series[i]
      const request = requests.find(r => r.seriesId === row.id)
      if (cancelRequested) {
        progress.state = 'cancelled'
        continue
      }
      let state: SeriesState | null = null
      let sentHere = 0
      try {
        const { isLibraryOrigin } = await import('./librarySync.js')
        const origin = await isLibraryOrigin(row.id)
        if (origin) {
          const { prepareLibrarySeries } = await import('./libraryPreparation.js')
          await prepareLibrarySeries(row.id)
        }
        state = await seriesState(row, receipt, autoSeries.has(row.id))
        progress.folder = `${folder}${state.index.series}/`
        const wanted = request?.chapterIds ? new Set(request.chapterIds) : null
        const complete = origin ? new Set((await prisma.chapter.findMany({ where: { seriesId: row.id, status: 'done', completedAt: null }, select: { id: true } })).map(c => c.id)) : null
        const picked = state.plan.chapters.filter(c => c.pages > 0 && (!complete || complete.has(c.chapterId)) && (wanted ? wanted.has(c.chapterId) : isDefaultPick(c)))
        const waitingForStitch = wanted ? 0 : state.plan.chapters.filter(c => (c.state === 'new' || c.state === 'changed') && c.needsStitch).length
        progress.chaptersTotal = picked.length
        progress.bytesTotal = picked.reduce((sum, c) => sum + c.bytes, 0)
        const notes: string[] = []
        if (waitingForStitch > 0) notes.push(`${waitingForStitch} chapter${waitingForStitch === 1 ? '' : 's'} over ${LARGE_CHAPTER_PAGES} pages left for stitching first`)

        const uploads = picked.map(c => ({ chapter: c, key: chapterKey(folder, state!.index.series, c.folder) }))
        const storage = uploads.length > 0
          ? await assertWithinFreePlan(client, config.bucket, uploads.map(u => ({ key: u.key, bytes: u.chapter.bytes })))
          : await measureBucket(client, config.bucket, false, true)
        const largest = Math.max(0, ...picked.map(c => c.bytes))
        const free = await freeBytes(jobDir)
        if (free !== null && free < largest * 1.05 + 256 * 1024 ** 2) {
          throw new Error(`Not enough disk space to zip a chapter: needs ~${(largest / 1024 ** 3).toFixed(2)} GB`)
        }

        progress.state = 'sending'
        emit(true)
        let doneBytes = 0
        for (const { chapter, key } of uploads) {
          if (await isLibraryDeleted(state.index.series)) throw new Error('Series deleted')
          if (cancelRequested) throw new Error('Cancelled')
          const pages = await chapterPages(state.folderPaths.get(chapter.chapterId)!)
          const pageBytes = pages.reduce((sum, p) => sum + p.size, 0)
          const zipPath = path.join(jobDir, `${chapter.chapterId}.zip`)
          progress.current = { folder: chapter.folder, phase: 'zipping' }
          emit(true)
          try {
            // Half the chapter's share of the bar for zipping, half for uploading.
            await writeChapterZip(zipPath, `${state.index.series}/${chapter.folder}`, pages, processed => {
              progress.bytesDone = doneBytes + Math.min(processed, pageBytes) / 2
              emit()
            })
            const { size } = await fsp.stat(zipPath)
            progress.current = { folder: chapter.folder, phase: 'uploading' }
            emit(true)
            const upload = new Upload({
              client,
              params: { Bucket: config.bucket, Key: key, Body: fs.createReadStream(zipPath), ContentType: 'application/zip', ContentLength: size },
              partSize: PART_SIZE,
              queueSize: config.concurrency
            })
            upload.on('httpUploadProgress', p => {
              progress.bytesDone = doneBytes + pageBytes / 2 + (size > 0 ? Math.min(p.loaded ?? 0, size) / size : 1) * pageBytes / 2
              emit()
            })
            activeUpload = upload
            let etag: string
            try {
              const result = (await upload.done()) as { ETag?: string }
              etag = (result.ETag ?? '').replace(/"/g, '')
            } finally {
              activeUpload = null
            }
            if (await isLibraryDeleted(state.index.series)) {
              await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }))
              throw new Error('Series deleted')
            }
            const sentAt = new Date()
            const data = {
              key,
              etag,
              fingerprint: chapterFingerprint(pages),
              files: pages.length,
              bytes: pageBytes,
              sentAt,
              clearedAt: null
            }
            const saved = await prisma.phoneChapterSend.upsert({
              where: { chapterId: chapter.chapterId },
              create: { chapterId: chapter.chapterId, seriesId: row.id, ...data },
              update: data
            })
            state.ledger.set(chapter.chapterId, saved)
          } finally {
            await fsp.rm(zipPath, { force: true }).catch(() => {})
          }
          doneBytes += pageBytes
          sentHere++
          sent++
          progress.chaptersSent = sentHere
          progress.bytesDone = doneBytes
          emit()
        }
        progress.current = undefined
        invalidateStorage()

        await cleanUp(client, config, storage, folder, state)
        state = await seriesState(row, receipt, autoSeries.has(row.id))
        if (state.plan.indexStale) await writeIndex(client, config, folder, row.id, state)
        if (picked.length === 0) {
          progress.state = 'skipped'
          notes.unshift('Nothing new to send')
        } else {
          progress.state = 'done'
        }
        progress.note = notes.join(' · ') || undefined
      } catch (error) {
        progress.current = undefined
        progress.state = cancelRequested ? 'cancelled' : 'failed'
        if (!cancelRequested) {
          progress.error = errorMessage(error)
          console.error(`Sending ${row.title} to the phone failed:`, error)
        }
        // Chapters already up must still reach the phone's index.
        if (state && sentHere > 0) {
          try {
            state = await seriesState(row, receipt, autoSeries.has(row.id))
            await writeIndex(client, config, folder, row.id, state)
          } catch (indexError) {
            console.error(`Writing the phone index of ${row.title} failed:`, indexError)
          }
        }
      }
      emit(true)
    }

    await fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {})
    if (sent > 0) {
      const { scheduleLibraryPublish } = await import('./librarySync.js')
      scheduleLibraryPublish()
      try {
        job.phone = await requestPhoneUpdate('sync')
      } catch (error) {
        job.phoneError = errorMessage(error)
      }
    }
  })()
    .catch(error => {
      // Only the set-up before the series loop can land here; the loop catches its own.
      console.error('Phone send failed:', error)
      for (const s of job.series) {
        if (s.state === 'queued') {
          s.state = 'failed'
          s.error = errorMessage(error)
        }
      }
    })
    .finally(() => {
      setUploadBusy(false)
      job.state = cancelRequested ? 'cancelled' : 'done'
      job.finishedAt = new Date().toISOString()
      emit(true)
      if (auto) {
        const failed = job.series.filter(s => s.state === 'failed').map(s => s.seriesId)
        if (failed.length) {
          const timer = setTimeout(() => { failed.forEach(id => autoPending.add(id)); flushAutoSend(io) }, 30_000)
          timer.unref()
        }
      }
      // Downloads that finished during this send.
      if (autoPending.size > 0) flushAutoSend(io)
    })

  return job
}

/** Stop the running send: the current zip or upload is aborted, the rest skipped. */
export async function cancelPhoneSend(): Promise<void> {
  if (currentJob?.state !== 'running') return
  cancelRequested = true
  activeArchive?.abort()
  await activeUpload?.abort().catch(() => {})
}

// ============ Auto-send ============

/** Series with chapters downloaded since the last auto-send, waiting for the download queue to go idle. */
const autoPending = new Set<string>()
let preparingAuto = false

/** From the download manager, for each chapter downloaded. */
export async function noteChapterDownloaded(seriesId: string): Promise<void> {
  const row = await prisma.setting.findUnique({ where: { key: autoSendKey(seriesId) } }).catch(() => null)
  if (row?.value === 'true') autoPending.add(seriesId)
}

/** From the download manager when its queue goes idle: sends the new chapters of auto-send series. */
export function flushAutoSend(io: Server): void {
  if (autoPending.size === 0 || preparingAuto || currentJob?.state === 'running') return // retried when the running send ends
  if (!getR2Config()) {
    autoPending.clear()
    return
  }
  const seriesIds = [...autoPending]
  autoPending.clear()
  preparingAuto = true
  void (async () => {
    const { isLibraryOrigin } = await import('./librarySync.js')
    const { prepareLibrarySeries } = await import('./libraryPreparation.js')
    const requests: PhoneSendRequest[] = []
    for (const seriesId of seriesIds) {
      try {
        if (await isLibraryOrigin(seriesId)) {
          await prepareLibrarySeries(seriesId)
          const plan = await getSeriesSendPlan(seriesId)
          const chapters = await prisma.chapter.findMany({ where: { seriesId, status: 'done', completedAt: null }, select: { id: true } })
          const done = new Set(chapters.map(c => c.id))
          const chapterIds = plan?.chapters.filter(c => done.has(c.chapterId) && (c.state === 'new' || c.state === 'changed')).map(c => c.chapterId) ?? []
          if (chapterIds.length) requests.push({ seriesId, chapterIds })
        } else requests.push({ seriesId })
      } catch (error) {
        console.error(`[library-sync] preparation failed for ${seriesId}; no raw pages published:`, error)
        io.emit('library:preparation-error', { seriesId, error: errorMessage(error) })
      }
    }
    if (requests.length) await startPhoneSend(requests, io, true)
  })().catch(error => console.error('Auto-send to the phone failed to start:', error)).finally(() => {
    preparingAuto = false
    if (autoPending.size) flushAutoSend(io)
  })
}

// ============ Status for badges ============

export interface PhoneSeriesSync {
  /**
   * downloaded:  the phone has every chapter sent (and not cleared)
   * downloading: it is downloading some
   * outdated:    some sent chapters aren't on the phone yet
   * missing:     it has none of them
   */
  state: 'downloaded' | 'downloading' | 'outdated' | 'missing'
  /** When the phone last unpacked a chapter. */
  phoneAt: string | null
  /** When a chapter was last sent. */
  uploadedAt: string | null
  sent: number
  onPhone: number
  downloading: number
  cleared: number
}

export interface PhoneSyncStatus {
  configured: boolean
  /** When the phone last reported; null if it never has. */
  reportedAt: string | null
  device: string | null
  /** By series id; only series with chapters sent. */
  series: Record<string, PhoneSeriesSync>
}

/** What the phone has of the chapters sent, per series. Ledger plus the phone's receipt; no bucket listing. */
export async function getPhoneSync(fresh = false): Promise<PhoneSyncStatus> {
  const config = getR2Config()
  if (!config && !relayConfigured()) return { configured: false, reportedAt: null, device: null, series: {} }
  const receipt = await readSyncReceipt(config, fresh)

  const ledgerRows = await prisma.phoneChapterSend.findMany()
  const seriesIds = [...new Set(ledgerRows.map(r => r.seriesId))]
  const rows = await prisma.series.findMany({
    where: { id: { in: seriesIds } },
    select: { id: true, rootFolder: true, chapters: { select: { id: true, folderPath: true } } }
  })
  const series: Record<string, PhoneSeriesSync> = {}
  for (const row of rows) {
    const seriesFolder = path.basename(row.rootFolder)
    const ledger = new Map(ledgerRows.filter(r => r.seriesId === row.id).map(r => [r.chapterId, r]))
    await reconcileCleared(row.id, seriesFolder, row.chapters, ledger, receipt)
    const { chapters: onPhone } = receiptSeries(receipt, seriesFolder)
    const folders = new Map(row.chapters.map(c => [c.id, path.basename(c.folderPath)]))
    const summary: PhoneSeriesSync = { state: 'missing', phoneAt: null, uploadedAt: null, sent: 0, onPhone: 0, downloading: 0, cleared: 0 }
    for (const sent of ledger.values()) {
      if (sent.clearedAt) {
        summary.cleared++
        continue
      }
      if (!sent.sentAt) continue
      summary.sent++
      const sentAt = sent.sentAt.toISOString()
      if (!summary.uploadedAt || sentAt > summary.uploadedAt) summary.uploadedAt = sentAt
      const phone = onPhone[folders.get(sent.chapterId) ?? '']
      if (!isObject(phone) || phone.sentAt !== sentAt) continue
      if (phone.state === 'downloading') {
        summary.downloading++
      } else {
        summary.onPhone++
        if (typeof phone.at === 'string' && (!summary.phoneAt || phone.at > summary.phoneAt)) summary.phoneAt = phone.at
      }
    }
    if (summary.sent === 0 && summary.cleared === 0) continue
    summary.state = summary.downloading > 0 ? 'downloading'
      : summary.onPhone === summary.sent ? 'downloaded'
      : summary.onPhone > 0 ? 'outdated'
      : 'missing'
    series[row.id] = summary
  }
  return {
    configured: true,
    reportedAt: typeof receipt.updatedAt === 'string' ? receipt.updatedAt : null,
    device: typeof receipt.device === 'string' ? receipt.device : null,
    series
  }
}
