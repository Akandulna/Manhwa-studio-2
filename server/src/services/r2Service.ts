/**
 * Cloudflare R2 — back up series to an R2 bucket as one zip per series.
 *
 * R2 speaks the S3 API, so this is the AWS S3 client pointed at the account's
 * R2 endpoint. For each selected series:
 *
 *   1. zip   every chapter folder that is NOT published (a rendered video
 *            exists — the same test as the Library's "Published" badge) into a
 *            temp file. Entries are `<Series folder>/<Chapter folder>/…`, so
 *            extracting the zip yields one folder named after the manhwa with
 *            its chapter folders inside.
 *   2. upload the zip as `<R2_PREFIX><Series folder>.zip`, replacing any earlier
 *            backup of that series.
 *   3. delete the temp zip — always, whether the upload worked or not.
 *
 * Free plan guard: before a series is zipped, and again once its real size is
 * known, the upload is refused if it would take the bucket past the free 10 GB
 * or the month's Class A requests past 1M (see r2Usage.ts). Nothing here ever
 * spends past the free plan.
 *
 * Series go one at a time, so the disk only ever holds one zip. Only chapter
 * folders are included; series-level material (about.md, Processed/, Crops/,
 * rendered video folders) is not.
 *
 * Credentials are set in Settings → Cloudflare, which writes them to the
 * server's .env (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
 * R2_BUCKET, optional R2_PREFIX / R2_CONCURRENCY).
 *
 * Only one job runs at a time. Its state lives in memory and is pushed to the
 * client as `r2:progress`; the last finished job stays readable through
 * `getJob()` so the Library page can show the result after a reload.
 */

import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import type { Server } from 'socket.io'
import archiver from 'archiver'
import { S3Client, HeadBucketCommand, ListObjectsV2Command, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { prisma } from '../index.js'
import { writeEnvVars } from '../utils/envFile.js'
import { getPublishedChapters } from './storageService.js'
import { FREE_PLAN, attachUsageCounter, getMonthUsage, monthKey } from './r2Usage.js'

// ============ Config ============

const REQUIRED_ENV = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'] as const

export interface R2Config {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  /** Key prefix inside the bucket, '' or ending in '/'. */
  prefix: string
  concurrency: number
}

/** Env vars still unset. Empty means R2 is configured. */
export function missingR2Env(): string[] {
  return REQUIRED_ENV.filter(key => !process.env[key]?.trim())
}

export function getR2Config(): R2Config | null {
  if (missingR2Env().length > 0) return null
  const rawPrefix = (process.env.R2_PREFIX || '').trim().replace(/^\/+|\/+$/g, '')
  return {
    accountId: process.env.R2_ACCOUNT_ID!.trim(),
    accessKeyId: process.env.R2_ACCESS_KEY_ID!.trim(),
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!.trim(),
    bucket: process.env.R2_BUCKET!.trim(),
    prefix: rawPrefix ? `${rawPrefix}/` : '',
    concurrency: Math.max(1, Number(process.env.R2_CONCURRENCY) || 4)
  }
}

function createClient(config: R2Config): S3Client {
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    }
  })
  attachUsageCounter(client)
  return client
}

/** What the client may see: never the secret, only a hint of the access key. */
export function publicR2Config() {
  const env = (key: string) => (process.env[key] || '').trim()
  const accessKeyId = env('R2_ACCESS_KEY_ID')
  const secret = env('R2_SECRET_ACCESS_KEY')
  return {
    configured: missingR2Env().length === 0,
    missing: missingR2Env(),
    accountId: env('R2_ACCOUNT_ID'),
    bucket: env('R2_BUCKET'),
    prefix: env('R2_PREFIX'),
    concurrency: Math.max(1, Number(env('R2_CONCURRENCY')) || 4),
    hasAccessKey: !!accessKeyId,
    accessKeyHint: accessKeyId ? `…${accessKeyId.slice(-4)}` : null,
    hasSecret: !!secret
  }
}

export interface R2ConfigUpdate {
  accountId?: string
  bucket?: string
  prefix?: string
  concurrency?: number
  accessKeyId?: string
  secretAccessKey?: string
  /** Remove the saved access key and secret. */
  clearKeys?: boolean
}

/**
 * Save R2 settings to the server's .env (and process.env, so they apply
 * without a restart). Blank key fields keep the saved keys, so the form never
 * has to echo a secret back to be re-saved.
 */
export async function updateR2Config(update: R2ConfigUpdate): Promise<void> {
  if (currentJob?.state === 'running') throw new Error('Wait for the running upload to finish before changing R2 settings')
  const vars: Record<string, string> = {}

  if (typeof update.accountId === 'string') {
    // Accept the S3 endpoint URL too — it is what the R2 dashboard shows most prominently.
    const raw = update.accountId.trim()
    const accountId = raw.match(/([a-f0-9]{32})\.r2\.cloudflarestorage\.com/i)?.[1] ?? raw
    if (accountId && !/^[a-f0-9]{32}$/i.test(accountId)) {
      throw new Error('Account ID should be 32 hexadecimal characters (Cloudflare dashboard → R2 → Account Details)')
    }
    vars.R2_ACCOUNT_ID = accountId.toLowerCase()
  }
  if (typeof update.bucket === 'string') {
    const bucket = update.bucket.trim()
    if (bucket && !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) {
      throw new Error('Bucket names are 3–63 lowercase letters, numbers and hyphens')
    }
    vars.R2_BUCKET = bucket
  }
  if (typeof update.prefix === 'string') vars.R2_PREFIX = update.prefix.trim().replace(/^\/+|\/+$/g, '')
  if (typeof update.concurrency === 'number') {
    vars.R2_CONCURRENCY = String(Math.min(16, Math.max(1, Math.round(update.concurrency))))
  }
  if (update.clearKeys) {
    vars.R2_ACCESS_KEY_ID = ''
    vars.R2_SECRET_ACCESS_KEY = ''
  } else {
    if (update.accessKeyId?.trim()) vars.R2_ACCESS_KEY_ID = update.accessKeyId.trim()
    if (update.secretAccessKey?.trim()) vars.R2_SECRET_ACCESS_KEY = update.secretAccessKey.trim()
  }

  await writeEnvVars(vars)
}

/** Confirm the credentials can reach the bucket. Throws with the reason. */
export async function testR2Connection(): Promise<{ bucket: string }> {
  const config = getR2Config()
  if (!config) throw new Error(`R2 is not configured. Missing: ${missingR2Env().join(', ')}`)
  try {
    await createClient(config).send(new HeadBucketCommand({ Bucket: config.bucket }))
  } catch (error) {
    // HEAD responses have no body, so the SDK's message is often just
    // "UnknownError"; the status code is the useful part.
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
    const code = (error as { code?: string }).code
    if (status === 401 || status === 403) {
      throw new Error('Access denied — check the Access Key ID and Secret, and that the token has Object Read & Write on this bucket')
    }
    if (status === 404) throw new Error(`Bucket "${config.bucket}" was not found in this account`)
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      throw new Error('Could not reach R2 — check the Account ID and your internet connection')
    }
    throw error
  }
  return { bucket: config.bucket }
}

// ============ Free plan: storage, usage, guard ============

export interface R2Object {
  key: string
  size: number
  lastModified: string | null
  /** Without the quotes S3 puts around it. */
  etag: string
}

export interface BucketStorage {
  bytes: number
  objects: R2Object[]
  measuredAt: string
}

let storageCache: { bucket: string; value: BucketStorage; at: number } | null = null
const STORAGE_CACHE_MS = 60_000

/**
 * Everything in the bucket, summed. Each 1,000 objects costs one Class A
 * list, so the result is cached for a minute; the guard asks for a fresh one.
 */
async function measureBucket(client: S3Client, bucket: string, fresh = false): Promise<BucketStorage> {
  if (!fresh && storageCache?.bucket === bucket && Date.now() - storageCache.at < STORAGE_CACHE_MS) {
    return storageCache.value
  }
  const objects: R2Object[] = []
  let token: string | undefined
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }))
    for (const obj of page.Contents ?? []) {
      if (!obj.Key) continue
      objects.push({
        key: obj.Key,
        size: obj.Size ?? 0,
        lastModified: obj.LastModified?.toISOString() ?? null,
        etag: (obj.ETag ?? '').replace(/"/g, '')
      })
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (token)
  const value = { bytes: objects.reduce((sum, o) => sum + o.size, 0), objects, measuredAt: new Date().toISOString() }
  storageCache = { bucket, value, at: Date.now() }
  return value
}

function invalidateStorage(): void {
  storageCache = null
}

/** First day of next UTC month, when the monthly request counts reset. */
function nextMonthStart(): string {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString()
}

export async function getR2Usage() {
  const config = getR2Config()
  if (!config) throw new Error(`R2 is not configured. Missing: ${missingR2Env().join(', ')}`)
  // Measure first so the list request this costs is in the count below.
  const storage = await measureBucket(createClient(config), config.bucket)
  const ops = await getMonthUsage()
  return {
    bucket: config.bucket,
    month: monthKey(),
    resetsAt: nextMonthStart(),
    limits: FREE_PLAN,
    storage: {
      bytes: storage.bytes,
      objectCount: storage.objects.length,
      measuredAt: storage.measuredAt,
      objects: [...storage.objects].sort((a, b) => b.size - a.size)
    },
    ops
  }
}

/** Delete one object from the bucket. Free on R2 — the way to get back under 10 GB. */
export async function deleteR2Object(key: string): Promise<void> {
  const config = getR2Config()
  if (!config) throw new Error(`R2 is not configured. Missing: ${missingR2Env().join(', ')}`)
  if (currentJob?.state === 'running') throw new Error('Wait for the running upload to finish before deleting backups')
  await createClient(config).send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }))
  invalidateStorage()
}

// ============ Phone (Sleeper-Cell) receipt ============

/**
 * The Sleeper-Cell Android app downloads these zips. After each sync it writes
 * this object next to them: `{ device, updatedAt, series: { <zip key>: { etag,
 * state: 'downloaded' | 'downloading', at? } } }`. Keep the name in step with
 * RECEIPT_NAME in its ManhwaSync.kt.
 */
const PHONE_RECEIPT_NAME = '_sleeper-cell.json'

export type PhoneSeriesState = 'downloaded' | 'downloading' | 'outdated' | 'missing'

export interface PhoneSeriesSync {
  /**
   * downloaded:  the phone has unzipped the zip now in R2
   * downloading: the phone is downloading it
   * outdated:    the phone has an earlier upload of this series
   * missing:     the phone has none
   */
  state: PhoneSeriesState
  /** When the phone finished unzipping the copy it has. */
  phoneAt: string | null
  /** When the zip now in R2 was uploaded. */
  uploadedAt: string | null
}

export interface PhoneSyncStatus {
  configured: boolean
  /** When the phone last wrote its receipt; null if it never has. */
  reportedAt: string | null
  device: string | null
  /** By series id; only series with a zip in R2. */
  series: Record<string, PhoneSeriesSync>
}

interface PhoneReceipt {
  device?: string
  updatedAt?: string
  series?: Record<string, { etag?: string; state?: string; at?: string }>
}

/** The receipt changes only when the phone syncs, so it is re-read only when its ETag moves. */
let receiptCache: { bucket: string; key: string; etag: string; value: PhoneReceipt } | null = null

async function readPhoneReceipt(client: S3Client, bucket: string, obj: R2Object): Promise<PhoneReceipt> {
  if (receiptCache?.bucket === bucket && receiptCache.key === obj.key && receiptCache.etag === obj.etag) {
    return receiptCache.value
  }
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: obj.key }))
  const text = (await res.Body?.transformToString()) ?? '{}'
  let value: PhoneReceipt = {}
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object') value = parsed
  } catch {
    console.warn(`R2: ${obj.key} is not valid JSON; ignoring it`)
  }
  receiptCache = { bucket, key: obj.key, etag: obj.etag, value }
  return value
}

/**
 * Which series' zips the phone has downloaded. One bucket list (cached for a
 * minute unless `fresh`) plus, when the phone has written a new receipt, one read.
 */
export async function getPhoneSync(fresh = false): Promise<PhoneSyncStatus> {
  const config = getR2Config()
  if (!config) return { configured: false, reportedAt: null, device: null, series: {} }

  const client = createClient(config)
  const storage = await measureBucket(client, config.bucket, fresh)
  const byKey = new Map(storage.objects.map(o => [o.key, o]))
  const receiptObj = byKey.get(`${config.prefix}${PHONE_RECEIPT_NAME}`)
  const receipt = receiptObj ? await readPhoneReceipt(client, config.bucket, receiptObj) : {}
  const phoneSeries = receipt.series && typeof receipt.series === 'object' ? receipt.series : {}

  const rows = await prisma.series.findMany({ select: { id: true, rootFolder: true } })
  const series: Record<string, PhoneSeriesSync> = {}
  for (const row of rows) {
    const key = `${config.prefix}${path.basename(row.rootFolder)}.zip`
    const zip = byKey.get(key)
    if (!zip) continue
    const entry = phoneSeries[key]
    const current = !!entry && (entry.etag ?? '').replace(/"/g, '') === zip.etag
    series[row.id] = {
      state: !entry ? 'missing' : !current ? 'outdated' : entry.state === 'downloading' ? 'downloading' : 'downloaded',
      phoneAt: entry?.state === 'downloaded' ? entry.at ?? null : null,
      uploadedAt: zip.lastModified
    }
  }

  return {
    configured: true,
    reportedAt: receipt.updatedAt ?? null,
    device: receipt.device ?? null,
    series
  }
}

const PART_SIZE = 16 * 1024 * 1024

function formatSize(bytes: number): string {
  return bytes >= 1000 ** 3 ? `${(bytes / 1000 ** 3).toFixed(2)} GB` : `${(bytes / 1000 ** 2).toFixed(1)} MB`
}

/**
 * Throw if uploading `bytes` to `key` would go past the free plan. An upload
 * replacing `key` frees the old object, so its size is netted out.
 */
async function assertWithinFreePlan(client: S3Client, bucket: string, key: string, bytes: number): Promise<void> {
  const storage = await measureBucket(client, bucket, true)
  const replaced = storage.objects.find(o => o.key === key)?.size ?? 0
  const after = storage.bytes - replaced + bytes
  if (after > FREE_PLAN.storageBytes) {
    throw new Error(
      `Blocked to stay on the free plan: the bucket would hold ${formatSize(after)} of the free ` +
      `${formatSize(FREE_PLAN.storageBytes)} (now ${formatSize(storage.bytes)}, this zip ~${formatSize(bytes)}` +
      `${replaced ? `, replacing ${formatSize(replaced)}` : ''}). ` +
      'Delete old backups in Settings → Cloudflare, or upload fewer series.'
    )
  }
  // Create + one per 16 MB part + complete.
  const requests = Math.ceil(bytes / PART_SIZE) + 2
  const { classA } = await getMonthUsage()
  if (classA + requests > FREE_PLAN.classA) {
    throw new Error(
      `Blocked to stay on the free plan: this upload needs ~${requests.toLocaleString()} Class A requests and ` +
      `${classA.toLocaleString()} of ${FREE_PLAN.classA.toLocaleString()} are used this month.`
    )
  }
}

// ============ Job state ============

export type R2SeriesState = 'queued' | 'zipping' | 'uploading' | 'done' | 'skipped' | 'failed' | 'cancelled'
export type R2JobState = 'running' | 'done' | 'cancelled'

export interface R2SeriesProgress {
  seriesId: string
  title: string
  state: R2SeriesState
  /** Unpublished chapters with a folder on disk — what goes in the zip. */
  chaptersIncluded: number
  /** Published chapters left out. */
  chaptersPublished: number
  /** Bytes of chapter files to zip, and how many are in so far. */
  zipBytesTotal: number
  zipBytesDone: number
  /** Size of the finished zip, and how much of it has reached R2. */
  uploadBytesTotal: number
  uploadBytesDone: number
  /** Object key in the bucket once uploaded. */
  key?: string
  /** Why a series was skipped or failed. */
  note?: string
  error?: string
}

export interface R2UploadJob {
  id: string
  state: R2JobState
  bucket: string
  startedAt: string
  finishedAt?: string
  series: R2SeriesProgress[]
}

let currentJob: R2UploadJob | null = null
let cancelRequested = false
let activeArchive: archiver.Archiver | null = null
let activeUpload: Upload | null = null

export function getJob(): R2UploadJob | null {
  return currentJob
}

// ============ Helpers ============

/** Temp zips live here, one sub-folder per job; wiped at the start of each job. */
const TEMP_ROOT = path.join(os.tmpdir(), 'manhwa-studio-r2')

/** Already-compressed formats: deflating them costs CPU and saves ~nothing. */
const STORE_EXTENSIONS = new Set([
  '.webp', '.jpg', '.jpeg', '.png', '.gif', '.avif',
  '.mp3', '.m4a', '.aac', '.ogg', '.flac',
  '.mp4', '.mov', '.mkv', '.webm', '.zip'
])

interface LocalFile {
  absPath: string
  /** POSIX path relative to the chapter folder. */
  relPath: string
  size: number
}

/** Every file under `root`, skipping dotfiles (.DS_Store and the like). */
async function walk(root: string, rel = ''): Promise<LocalFile[]> {
  const entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true })
  const out: LocalFile[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const childRel = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      out.push(...(await walk(root, childRel)))
    } else if (entry.isFile()) {
      const absPath = path.join(root, childRel)
      const { size } = await fsp.stat(absPath)
      out.push({ absPath, relPath: childRel, size })
    }
  }
  return out
}

interface ChapterFiles {
  /** Folder name inside the zip, e.g. "Chapter 001". */
  folderName: string
  files: LocalFile[]
}

/** The unpublished chapters of a series that have files on disk, in chapter order. */
async function collectChapters(
  seriesId: string,
  downloadRoot: string
): Promise<{ chapters: ChapterFiles[]; publishedCount: number }> {
  const [rows, published] = await Promise.all([
    prisma.chapter.findMany({
      where: { seriesId },
      select: { id: true, folderPath: true },
      orderBy: { number: 'asc' }
    }),
    getPublishedChapters(seriesId)
  ])

  const chapters: ChapterFiles[] = []
  let publishedCount = 0
  for (const row of rows) {
    if (published.chapters[row.id]) {
      publishedCount++
      continue
    }
    const folder = path.join(downloadRoot, row.folderPath)
    let files: LocalFile[]
    try {
      files = await walk(folder)
    } catch {
      continue // Never downloaded, or deleted by hand.
    }
    if (files.length > 0) chapters.push({ folderName: path.basename(row.folderPath), files })
  }
  return { chapters, publishedCount }
}

/** Free bytes on the volume holding `dir`, or null if the OS will not say. */
async function freeBytes(dir: string): Promise<number | null> {
  try {
    const stats = await fsp.statfs(dir)
    return stats.bavail * stats.bsize
  } catch {
    return null
  }
}

function formatGB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

/** Write the zip; resolves once the file is fully flushed to disk. */
function writeZip(
  zipPath: string,
  rootName: string,
  chapters: ChapterFiles[],
  onProgress: (processedBytes: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath)
    // Level 6 applies only to the text entries (JSON, scripts); media is stored.
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
    for (const chapter of chapters) {
      for (const file of chapter.files) {
        // `store` is a per-entry zip option archiver honours but its types omit.
        const entry = {
          name: `${rootName}/${chapter.folderName}/${file.relPath}`,
          store: STORE_EXTENSIONS.has(path.extname(file.relPath).toLowerCase())
        }
        archive.file(file.absPath, entry)
      }
    }
    void archive.finalize()
  })
}

// ============ Upload ============

/**
 * Start backing up the given series. Returns immediately with the job;
 * progress arrives over the socket. Throws if R2 is unconfigured or a job is
 * already running.
 */
export async function startUpload(seriesIds: string[], io: Server): Promise<R2UploadJob> {
  const config = getR2Config()
  if (!config) throw new Error(`R2 is not configured. Missing: ${missingR2Env().join(', ')}`)
  if (currentJob?.state === 'running') throw new Error('An upload is already running')
  if (seriesIds.length === 0) throw new Error('No series selected')

  const rows = await prisma.series.findMany({
    where: { id: { in: seriesIds } },
    select: { id: true, title: true, rootFolder: true }
  })
  if (rows.length === 0) throw new Error('None of the selected series exist')
  // Keep the order the user picked them in.
  rows.sort((a, b) => seriesIds.indexOf(a.id) - seriesIds.indexOf(b.id))

  const job: R2UploadJob = {
    id: randomUUID(),
    state: 'running',
    bucket: config.bucket,
    startedAt: new Date().toISOString(),
    series: rows.map(s => ({
      seriesId: s.id,
      title: s.title,
      state: 'queued',
      chaptersIncluded: 0,
      chaptersPublished: 0,
      zipBytesTotal: 0,
      zipBytesDone: 0,
      uploadBytesTotal: 0,
      uploadBytesDone: 0
    }))
  }
  currentJob = job
  cancelRequested = false

  // Progress fires per file / per multipart chunk; throttle the socket to
  // ~4/s and send state changes straight away.
  let lastEmit = 0
  const emit = (force = false) => {
    const now = Date.now()
    if (!force && now - lastEmit < 250) return
    lastEmit = now
    io.emit('r2:progress', job)
  }
  emit(true)

  const client = createClient(config)
  const downloadRoot = process.env.DOWNLOAD_ROOT || './downloads'
  const jobDir = path.join(TEMP_ROOT, job.id)

  void (async () => {
    // No job is running, so anything left here is from a crash or a kill.
    await fsp.rm(TEMP_ROOT, { recursive: true, force: true })
    await fsp.mkdir(jobDir, { recursive: true })

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const progress = job.series[i]
      if (cancelRequested) {
        progress.state = 'cancelled'
        continue
      }

      const rootName = path.basename(row.rootFolder)
      const zipPath = path.join(jobDir, `${rootName}.zip`)
      try {
        const { chapters, publishedCount } = await collectChapters(row.id, downloadRoot)
        progress.chaptersIncluded = chapters.length
        progress.chaptersPublished = publishedCount
        if (chapters.length === 0) {
          progress.state = 'skipped'
          progress.note = publishedCount > 0
            ? 'Every chapter is published — nothing to back up'
            : 'No chapter files on disk'
          emit(true)
          continue
        }

        progress.zipBytesTotal = chapters.reduce(
          (sum, c) => sum + c.files.reduce((s, f) => s + f.size, 0),
          0
        )
        const key = `${config.prefix}${rootName}.zip`
        // Most content is stored, not deflated, so the zip is about the size of its
        // input — close enough to refuse early, before spending time zipping.
        await assertWithinFreePlan(client, config.bucket, key, progress.zipBytesTotal)

        const free = await freeBytes(jobDir)
        if (free !== null && free < progress.zipBytesTotal * 1.05 + 512 * 1024 ** 2) {
          throw new Error(
            `Not enough disk space to build the zip: needs ~${formatGB(progress.zipBytesTotal)}, ${formatGB(free)} free`
          )
        }

        // 1. Zip
        progress.state = 'zipping'
        emit(true)
        await writeZip(zipPath, rootName, chapters, processed => {
          progress.zipBytesDone = Math.min(processed, progress.zipBytesTotal)
          emit()
        })
        progress.zipBytesDone = progress.zipBytesTotal

        // 2. Upload
        const { size } = await fsp.stat(zipPath)
        // Re-check with the real size before sending a single byte.
        await assertWithinFreePlan(client, config.bucket, key, size)
        progress.uploadBytesTotal = size
        progress.state = 'uploading'
        emit(true)

        const upload = new Upload({
          client,
          params: {
            Bucket: config.bucket,
            Key: key,
            Body: fs.createReadStream(zipPath),
            ContentType: 'application/zip',
            ContentLength: size
          },
          partSize: PART_SIZE,
          queueSize: config.concurrency
        })
        upload.on('httpUploadProgress', p => {
          progress.uploadBytesDone = Math.min(p.loaded ?? 0, size)
          emit()
        })
        activeUpload = upload
        try {
          await upload.done()
        } finally {
          activeUpload = null
          invalidateStorage()
        }
        progress.uploadBytesDone = size
        progress.key = key
        progress.state = 'done'
      } catch (error) {
        progress.state = cancelRequested ? 'cancelled' : 'failed'
        if (!cancelRequested) {
          progress.error = error instanceof Error ? error.message : String(error)
          console.error(`R2 backup failed for series ${row.title}:`, error)
        }
      } finally {
        // 3. Never keep the zip, whatever happened above.
        await fsp.rm(zipPath, { force: true }).catch(() => {})
      }
      emit(true)
    }

    await fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {})
    job.state = cancelRequested ? 'cancelled' : 'done'
    job.finishedAt = new Date().toISOString()
    emit(true)
  })().catch(error => {
    // Only the temp-folder setup can land here; the per-series loop catches its own.
    console.error('R2 backup job failed:', error)
    for (const s of job.series) {
      if (s.state === 'queued') {
        s.state = 'failed'
        s.error = error instanceof Error ? error.message : String(error)
      }
    }
    job.state = 'done'
    job.finishedAt = new Date().toISOString()
    emit(true)
  })

  return job
}

/** Stop the running job: the current zip or upload is aborted, the rest skipped. */
export async function cancelUpload(): Promise<void> {
  if (currentJob?.state !== 'running') return
  cancelRequested = true
  activeArchive?.abort()
  await activeUpload?.abort().catch(() => {})
}
