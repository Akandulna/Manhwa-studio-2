import { withSeriesActivity, recordPhoneActivity } from './seriesActivity.js'
/**
 * Cloudflare R2: settings, the free-plan guard, and what the Sleeper-Cell phone
 * app reports back.
 *
 * R2 speaks the S3 API, so this is the AWS S3 client pointed at the account's
 * R2 endpoint. Sending chapters to the phone (one zip per chapter) lives in
 * phoneSend.ts; this file holds what both share:
 *
 *   - config: credentials are set in Settings → Cloudflare, which writes them to
 *     the server's .env (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
 *     R2_BUCKET, optional R2_PREFIX / R2_CONCURRENCY). An unset R2_PREFIX means
 *     DEFAULT_R2_PREFIX.
 *   - free plan guard: an upload is refused if it would take the bucket past the
 *     free 10 GB or the month's Class A requests past 1M (see r2Usage.ts).
 *   - the phone's receipts (scripts, crops) and "Refresh from phone" requests.
 */

import path from 'path'
import { randomUUID } from 'crypto'
import { S3Client, HeadBucketCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { prisma } from '../index.js'
import { writeEnvVars } from '../utils/envFile.js'
import type { PhoneSeriesSync, PhoneSyncStatus } from './phoneSend.js'
import { FREE_PLAN, attachUsageCounter, getMonthUsage, monthKey } from './r2Usage.js'
import { phoneName, relayConfigured, relayPhones, relayReceipts, sendPhoneRequest, type PhoneAction, type PhoneLeft, type ReceiptKind } from './phoneRelay.js'
import type { NarrationLanguage } from './narrationLanguage.js'
import { mergeCropsReceipts, mergeScriptsReceipts, type PhoneReceipt } from './phoneReceipts.js'
import { analyticsConfigured, getCloudflareMonthOps, invalidateAnalytics } from './r2Analytics.js'
import { filterReplacedCropFacts } from './chapterPageReplacement.js'

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

/** Bucket folder used when R2_PREFIX is absent from .env. An explicit empty value means the bucket root. */
export const DEFAULT_R2_PREFIX = 'Manhwa'

function prefixEnv(): string {
  return (process.env.R2_PREFIX ?? DEFAULT_R2_PREFIX).trim().replace(/^\/+|\/+$/g, '')
}

export function getR2Config(): R2Config | null {
  if (missingR2Env().length > 0) return null
  const rawPrefix = prefixEnv()
  return {
    accountId: process.env.R2_ACCOUNT_ID!.trim(),
    accessKeyId: process.env.R2_ACCESS_KEY_ID!.trim(),
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!.trim(),
    bucket: process.env.R2_BUCKET!.trim(),
    prefix: rawPrefix ? `${rawPrefix}/` : '',
    concurrency: Math.max(1, Number(process.env.R2_CONCURRENCY) || 4)
  }
}

export function createClient(config: R2Config): S3Client {
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
    prefix: prefixEnv(),
    concurrency: Math.max(1, Number(env('R2_CONCURRENCY')) || 4),
    hasAccessKey: !!accessKeyId,
    accessKeyHint: accessKeyId ? `…${accessKeyId.slice(-4)}` : null,
    hasSecret: !!secret,
    hasAnalyticsToken: analyticsConfigured()
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
  /** API token with Account Analytics → Read, for Cloudflare's own request counts (see r2Analytics.ts). */
  analyticsToken?: string
  clearAnalyticsToken?: boolean
}

/**
 * Save R2 settings to the server's .env (and process.env, so they apply
 * without a restart). Blank key fields keep the saved keys, so the form never
 * has to echo a secret back to be re-saved.
 */
export async function updateR2Config(update: R2ConfigUpdate): Promise<void> {
  if (uploadBusy) throw new Error('Wait for the running upload to finish before changing R2 settings')
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
  if (update.clearAnalyticsToken) vars.CF_ANALYTICS_TOKEN = ''
  else if (update.analyticsToken?.trim()) vars.CF_ANALYTICS_TOKEN = update.analyticsToken.trim()

  await writeEnvVars(vars)
  invalidateAnalytics()
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

/** Set by phoneSend.ts while it sends chapters, so settings and deletes wait for it. */
let uploadBusy = false

export function isUploadBusy(): boolean {
  return uploadBusy
}

export function setUploadBusy(busy: boolean): void {
  uploadBusy = busy
}

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
 * `anyAge` takes the cached copy however old it is.
 */
export async function measureBucket(client: S3Client, bucket: string, fresh = false, anyAge = false): Promise<BucketStorage> {
  if (!fresh && storageCache?.bucket === bucket && (anyAge || Date.now() - storageCache.at < STORAGE_CACHE_MS)) {
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

export function invalidateStorage(): void {
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
  // Cloudflare's own count covers every client (the phone, the dashboard); ours only this server.
  let cloudflare = null
  let analyticsError: string | null = null
  try {
    cloudflare = await getCloudflareMonthOps()
  } catch (error) {
    analyticsError = error instanceof Error ? error.message : String(error)
  }
  const ops = cloudflare
    ? { ...cloudflare, source: 'cloudflare' as const }
    : { ...(await getMonthUsage()), source: 'local' as const }
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
    ops,
    analyticsError
  }
}

/** Delete one object from the bucket. Free on R2 — the way to get back under 10 GB. */
export async function deleteR2Object(key: string): Promise<void> {
  const config = getR2Config()
  if (!config) throw new Error(`R2 is not configured. Missing: ${missingR2Env().join(', ')}`)
  if (uploadBusy) throw new Error('Wait for the running upload to finish before deleting objects')
  await createClient(config).send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }))
  invalidateStorage()
}

// ============ Phone (Sleeper-Cell) scripts receipt ============

/**
 * Sleeper-Cell also writes narration scripts on the phone. When asked (see
 * requestPhoneUpdate) it writes this object: `{ device, updatedAt, answers,
 * series: { <series folder>: { total, done, chapters: { <chapter folder>:
 * { status, savedAt? } } } } }`, leaving out chapters with no script. Keep the
 * name in step with RECEIPT_NAME in its ScriptReceipt.kt.
 *
 * Each series may also carry its Hinglish progress: `"hi": { total, done,
 * uploadedAt, chapters: { <chapter folder>: { status: done|review|stale,
 * savedAt } } }`, where `done` counts done + review and chapters not converted
 * yet are left out.
 */
const SCRIPTS_RECEIPT_NAME = '_sleeper-cell-scripts.json'

export type PhoneScriptState = 'done' | 'needs_summary' | 'stale'

export interface PhoneChapterScript {
  status: PhoneScriptState
  /** When the phone saved the reply. */
  savedAt: string | null
}

export interface PhoneScriptsStatus {
  configured: boolean
  /** When the phone last wrote the receipt; null if it never has. */
  reportedAt: string | null
  device: string | null
  /** The id of the update request the receipt answered (see requestPhoneUpdate). */
  answers: string | null
  /** By series id: chapters done on the phone out of those it has. */
  series: Record<string, { done: number; total: number }>
  /** By chapter id, for the series asked for; chapters with no script are left out. */
  chapters: Record<string, PhoneChapterScript>
  /** The same for the phone's Hinglish scripts, from each series' optional `hi` block. */
  hi: {
    /** By series id: chapters converted (done or review) out of those on the phone. */
    series: Record<string, { done: number; total: number; uploadedAt: string | null }>
    /** By chapter id, for the series asked for; chapters not converted yet are left out. */
    chapters: Record<string, PhoneChapterHinglish>
  }
  /** Runs going now in the phone's Narration, Editor 2.0 and Voiceover libraries; empty from builds before they were reported. */
  runs: PhoneScriptRun[]
}

/**
 * A run going on the phone: Auto-run writing a series' scripts in AI Studio
 * (narration), making its Editor 2.0 timelines in ChatGPT (editor), or voicing
 * its splits (voiceover). `done` of `total` counts chapters for narration and
 * editor, and the run's splits for voiceover. Each tab is the
 * chapter (folder name) and, for voiceover, the 1-based split it's on; a tab
 * between splits is left out. `at` is when the run last changed.
 */
export interface PhoneScriptRun {
  kind: 'narration' | 'editor' | 'voiceover'
  /** The series folder, as on the phone. */
  series: string
  done: number
  total: number
  paused: boolean
  /** Ends once the chapter or splits it's on are saved. */
  stopping: boolean
  /** The browser profile the tabs are on, when the phone has more than one. */
  account: string | null
  since: string | null
  at: string | null
  tabs: PhoneScriptRunTab[]
  /** The phone it runs on: its id ("" for the old app, or the one phone R2 carries) and name; null when not known. */
  device: string | null
  phone: string | null
}

export interface PhoneScriptRunTab {
  chapter: string
  language: 'en' | 'hi'
  split: number | null
  splits: number | null
  since: string | null
  step?: string
}

interface ScriptsReceipt {
  device?: string
  updatedAt?: string
  answers?: string
  series?: Record<string, {
    total?: number
    done?: number
    chapters?: Record<string, { status?: string; savedAt?: string }>
    hi?: {
      total?: number
      done?: number
      uploadedAt?: string
      chapters?: Record<string, { status?: string; savedAt?: string }>
    }
  }>
  runs?: unknown
}

const PHONE_SCRIPT_STATES = new Set<string>(['done', 'needs_summary', 'stale'])

/**
 * A chapter's Hinglish script on the phone: converted and passing the check,
 * saved despite failing it, or converted from an English script the phone has
 * since changed.
 */
export type PhoneHinglishState = 'done' | 'review' | 'stale'

const PHONE_HINGLISH_STATES = new Set<string>(['done', 'review', 'stale'])

export interface PhoneChapterHinglish {
  status: PhoneHinglishState
  savedAt: string | null
}

/**
 * The last copy of each phone receipt, by receipt name. Pages are served from
 * here; R2 is asked again only on a "Refresh from phone" (see requestPhoneUpdate),
 * so looking at a page costs no R2 operations.
 */
interface ReceiptCache { bucket: string; key: string | null; etag: string | null; value: object }
const receiptCaches = new Map<string, ReceiptCache>()

export function isNotFound(error: unknown): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
  return status === 404 || (error as { name?: string }).name === 'NotFound'
}

/**
 * The cached copy unless `fresh` (or nothing is cached yet). The phone writes
 * under its own prefix setting, which may not match ours, so the bucket root is
 * tried too. One HEAD (Class B) per look; the body is fetched only when the
 * phone has written a new receipt.
 */
export async function readPolledReceipt<T extends object>(client: S3Client, config: R2Config, name: string, fresh: boolean): Promise<T> {
  const found = receiptCaches.get(name)
  const cached = found?.bucket === config.bucket ? found : null
  if (cached && !fresh) return cached.value as T

  const candidates = [...new Set([`${config.prefix}${name}`, name])]
  // Try wherever it was found last time first, so a steady poll is a single HEAD.
  if (cached?.key) candidates.sort((a, b) => Number(b === cached.key) - Number(a === cached.key))

  for (const key of candidates) {
    let etag: string
    try {
      const head = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }))
      etag = (head.ETag ?? '').replace(/"/g, '')
    } catch (error) {
      if (isNotFound(error)) continue
      throw error
    }
    if (cached?.key === key && cached.etag === etag) return cached.value as T
    const res = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
    let value: object = {}
    try {
      const parsed = JSON.parse((await res.Body?.transformToString()) ?? '{}')
      if (parsed && typeof parsed === 'object') value = parsed
    } catch {
      console.warn(`R2: ${key} is not valid JSON; ignoring it`)
    }
    receiptCaches.set(name, { bucket: config.bucket, key, etag, value })
    return value as T
  }

  receiptCaches.set(name, { bucket: config.bucket, key: null, etag: null, value: {} })
  return {} as T
}

/**
 * Every phone's copy of a receipt: from the relay, one per phone, or else the
 * one in R2 (only one phone can report through R2: they would all write the
 * same object). Null when neither is set up.
 */
export async function readPhoneReceipts<T extends object>(kind: ReceiptKind, name: string, fresh: boolean): Promise<PhoneReceipt<T>[] | null> {
  const relayed = relayReceipts<T>(kind)
  if (relayed) return relayed.map(r => ({ device: r.device, name: phoneName(r.device), body: r.body }))
  const config = getR2Config()
  if (!config) return null
  const body = await readPolledReceipt<T>(createClient(config), config, name, fresh)
  if (!Object.keys(body).length) return []
  const device = (body as { device?: unknown }).device
  recordPhoneActivity(kind, 'r2', body)
  return [{ device: '', name: typeof device === 'string' && device ? device : 'Phone', body }]
}

/**
 * Which chapters have a narration script on the phones. Series and chapters are
 * matched by folder name, the names the R2 zip carries to the phone.
 */
export async function getPhoneScripts(seriesId?: string, fresh = false): Promise<PhoneScriptsStatus> {
  const list = await readPhoneReceipts<ScriptsReceipt>('scripts', SCRIPTS_RECEIPT_NAME, fresh)
  if (!list) {
    return { configured: false, reportedAt: null, device: null, answers: null, series: {}, chapters: {}, hi: { series: {}, chapters: {} }, runs: [] }
  }

  const receipt = mergeScriptsReceipts(list as PhoneReceipt<Record<string, unknown>>[]) as ScriptsReceipt
  const phoneSeries = receipt.series && typeof receipt.series === 'object' ? receipt.series : {}

  const rows = await prisma.series.findMany({ select: { id: true, rootFolder: true } })
  const series: PhoneScriptsStatus['series'] = {}
  const chapters: PhoneScriptsStatus['chapters'] = {}
  const hi: PhoneScriptsStatus['hi'] = { series: {}, chapters: {} }
  for (const row of rows) {
    const entry = phoneSeries[path.basename(row.rootFolder)]
    if (!entry || typeof entry !== 'object') continue
    series[row.id] = { done: Number(entry.done) || 0, total: Number(entry.total) || 0 }
    const hinglish = entry.hi && typeof entry.hi === 'object' ? entry.hi : null
    if (hinglish) {
      hi.series[row.id] = {
        done: Number(hinglish.done) || 0,
        total: Number(hinglish.total) || 0,
        uploadedAt: typeof hinglish.uploadedAt === 'string' ? hinglish.uploadedAt : null
      }
    }

    const englishChapters = entry.chapters && typeof entry.chapters === 'object' ? entry.chapters : null
    const hinglishChapters = hinglish?.chapters && typeof hinglish.chapters === 'object' ? hinglish.chapters : null
    if (row.id !== seriesId || (!englishChapters && !hinglishChapters)) continue
    const byFolder = new Map(
      (await prisma.chapter.findMany({ where: { seriesId: row.id }, select: { id: true, folderPath: true } }))
        .map(c => [path.basename(c.folderPath), c.id])
    )
    for (const [folder, chapter] of Object.entries(englishChapters ?? {})) {
      const id = byFolder.get(folder)
      if (!id || !chapter || !PHONE_SCRIPT_STATES.has(chapter.status ?? '')) continue
      chapters[id] = { status: chapter.status as PhoneScriptState, savedAt: chapter.savedAt ?? null }
    }
    for (const [folder, chapter] of Object.entries(hinglishChapters ?? {})) {
      const id = byFolder.get(folder)
      if (!id || !chapter || !PHONE_HINGLISH_STATES.has(chapter.status ?? '')) continue
      hi.chapters[id] = { status: chapter.status as PhoneHinglishState, savedAt: chapter.savedAt ?? null }
    }
  }

  return {
    configured: true,
    reportedAt: receipt.updatedAt ?? null,
    device: receipt.device ?? null,
    answers: receipt.answers ?? null,
    series,
    chapters,
    hi,
    runs: parseScriptRuns(receipt.runs)
  }
}

/**
 * The receipt's `runs`, dropping anything malformed. The phone drops a run
 * when it ends, but one killed with the app is never dropped, so a run that
 * hasn't changed in WORKING_STALE_MS is taken as dead (a chapter's script, the
 * longest step, takes well under that).
 */
export function parseScriptRuns(raw: unknown, now = Date.now()): PhoneScriptRun[] {
  if (!Array.isArray(raw)) return []
  const runs: PhoneScriptRun[] = []
  for (const run of raw) {
    if (!isObject(run) || (run.kind !== 'narration' && run.kind !== 'editor' && run.kind !== 'voiceover') || typeof run.series !== 'string' || !run.series) continue
    const at = isTime(run.at) ? run.at : null
    if (at && now - Date.parse(at) > WORKING_STALE_MS) continue
    const tabs = (Array.isArray(run.tabs) ? run.tabs : [])
      .filter((tab): tab is Record<string, unknown> => isObject(tab) && typeof tab.chapter === 'string' && !!tab.chapter)
      .map(tab => ({
        chapter: tab.chapter as string,
        language: tab.language === 'hi' ? 'hi' as const : 'en' as const,
        split: count(tab.split) || null,
        splits: count(tab.splits) || null,
        since: isTime(tab.since) ? tab.since : null,
        ...(typeof tab.step === 'string' && tab.step ? { step: tab.step.slice(0, 240) } : {})
      }))
    runs.push({
      kind: run.kind,
      series: run.series,
      done: count(run.done),
      total: count(run.total),
      paused: run.paused === true,
      stopping: run.stopping === true,
      account: typeof run.account === 'string' && run.account ? run.account : null,
      since: isTime(run.since) ? run.since : null,
      at,
      tabs,
      ...phoneOf(run)
    })
  }
  return runs
}

/**
 * Sleeper-Cell also makes crop pointers on the phone (Image Clipper's
 * Auto-run, page after page in ChatGPT). When asked (see requestPhoneUpdate)
 * it writes this object: `{ device, updatedAt, answers, series: { <series folder>: { total, done,
 * working?: { chapter, page, since, paused }, workingPages?: [{ chapter, page, since, paused }, …],
 * chapters: { <chapter folder>: { total, done, pages: { <page file>: done|in_progress|changed },
 * finished?: { <page file>: { at, took?, run?, profile?, account?, models? } } } } } } }`,
 * leaving out pages not started and chapters with none started. `finished` has
 * the done pages: `at` is when the JSON was exported, `took` the seconds from
 * sections made to then (wall clock), `run` auto|manual, and for Auto-run the
 * ChatGPT account (`profile`, `account`) and `models` that answered. Older phone
 * builds leave it out, or send only `at` and `took`. Auto-run can
 * clip several pages at once (one per ChatGPT tab, across chapters):
 * `workingPages` lists them all, each with its own `since`, and `working` is
 * the first of them, kept for older readers. Older phone builds send only
 * `working`. Both are there only while Auto-run is on that series. Keep the
 * name in step with RECEIPT_NAME in its ClipperReceipt.kt.
 *
 * `profiles` (UploadLedger.kt) lists every browser profile on the phone with
 * the images it uploaded to ChatGPT in the last day, in 5-minute slots
 * (`uploads: [[slot start, images], …]`), and the limits ChatGPT put on it
 * (`limits: [{ at, until, used, countedSince, complete, flagged, reason }]`):
 * `used` is how many images it took, counted from the limit before, and
 * `counting: { since, images }` is the count so far towards the next one.
 *
 * `speech` and `narration` (AiStudioLedger.kt) are each profile's Gemini
 * requests in AI Studio since the daily reset (`resetsAt`, midnight Pacific),
 * for the voiceover and narration runs, which have separate limits:
 * `{ resetsAt, profiles: [{ id, name, selected, today, limit, limitedUntil }] }`.
 * `limit` is the count the profile got to before its last limit, if known.
 */
const CROPS_RECEIPT_NAME = '_sleeper-cell-crops.json'

export type PhonePageState = 'done' | 'in_progress' | 'changed'

export interface PhoneCropsWorking {
  chapterId: string
  /** The page file, the same name as the image in the chapter folder. */
  page: string
  /** When Auto-run started this page. */
  since: string | null
  paused: boolean
  /** The phone clipping it (see PhoneScriptRun). */
  device: string | null
  phone: string | null
}

/** How a done page was finished on the phone. */
export interface PhonePageFinish {
  /** When its JSON files were exported. */
  at: string
  /** Seconds from making the page's sections to exporting its JSON files, wall clock (pauses count); null if unknown. */
  took: number | null
  /** auto: Sleeper-Cell's Auto-run; manual: pasted by hand. null for exports from before this was kept. */
  run: 'auto' | 'manual' | null
  /** The browser profile of the ChatGPT account Auto-run used, and that account's name in Sleeper-Cell. */
  profile: string | null
  account: string | null
  /** The ChatGPT models that answered, in order (a fix round can be answered by another). */
  models: string[]
  /** The phone that finished it; null when not known. */
  phone: string | null
}

/** A limit ChatGPT put on a phone profile. */
export interface PhoneUploadLimit {
  at: string
  /** When ChatGPT said it would lift (the phone's reading of its words; an hour when it said nothing). */
  until: string
  /** Images the profile uploaded from `countedSince` up to the limit. */
  used: number
  countedSince: string
  /** False for the first limit after tracking began: its count may have started mid-window. */
  complete: boolean
  /** A flag for suspicious activity, not the upload limit; its `used` says nothing about the limit. */
  flagged: boolean
  reason: string
}

/** One of the phone's browser profiles (one ChatGPT account each) and its uploads to ChatGPT. */
export interface PhoneUploadProfile {
  id: string
  name: string
  /** The profile the phone's browser is on, which the next run starts in. */
  selected: boolean
  /** While ChatGPT's limit on it is noted as running; null otherwise. */
  limitedUntil: string | null
  /** When the phone began counting this profile's uploads; null before its first upload. */
  trackingSince: string | null
  /** Images uploaded towards the next limit: since the last one, or since tracking began. */
  counting: { since: string; images: number } | null
  /** Images uploaded in the last day, by 5-minute slot, oldest first. */
  uploads: { at: string; images: number }[]
  /** Oldest first. */
  limits: PhoneUploadLimit[]
  /** The phone the profile is on (see PhoneScriptRun). With several phones, `id` is "<device>:<profile id>". */
  device: string | null
  phone: string | null
  /** The phone's own id for it, which requests name it by (`id` may carry the device). */
  profileId: string
  /** What its ChatGPT account offered when last read, for Run automation's choices; null from older builds. */
  chatGpt: PhoneChatGptProfile | null
  /** Sleeper-Cell's Tools → Profiles → Check of it, as last done there: sign-ins and plans; null when never checked. */
  check: PhoneProfileCheck | null
  /** Its plan limits (5-hour and weekly), read in the check and during runs; null when never read or from older builds. */
  usage: PhoneChatGptUsage | null
}

/** One plan-limit window of a ChatGPT account (Codex, Work and the like share it; chats don't count). */
export interface PhoneUsageWindow {
  /** Its length: 18000 is the 5-hour limit, 604800 the weekly one. */
  seconds: number
  /** 0–100. */
  usedPercent: number
  /** When it's back to 0; null when ChatGPT didn't say. */
  resetAt: string | null
}

/** A ChatGPT account's plan limits as the phone last read them (ChatGptUsage.kt). */
export interface PhoneChatGptUsage {
  checkedAt: string
  limitReached: boolean
  /** Why the last read failed, when nothing better was kept (`windows` then empty). */
  error: string | null
  windows: PhoneUsageWindow[]
}

/** One site's part of a profile check. */
export interface PhoneSiteCheck {
  signedIn: boolean
  email: string | null
  /** ChatGPT's planType ("free", "go", "plus"…); Gemini's "free", "paid" or "Google AI Pro" and the like. */
  plan: string | null
  error: string | null
}

export interface PhoneProfileCheck {
  checkedAt: string
  chatGpt: PhoneSiteCheck | null
  gemini: PhoneSiteCheck | null
}

/** A ChatGPT setting's choices in one mode, as the phone read them off the account. */
export interface PhoneChatGptMode {
  /** "Chat" or "Work"; null for an account with no switch. */
  name: string | null
  models: { name: string; picked: boolean }[]
  /** The Power slider's steps, lowest first; a locked step's name isn't known (it isn't touched to learn it). */
  efforts: { name: string | null; locked: boolean; picked: boolean }[]
}

export interface PhoneChatGptProfile {
  /** Null until read. Free and Go list no modes: they have neither the switch nor the model picker. */
  options: { readAt: string | null; current: string | null; modes: PhoneChatGptMode[] } | null
  /** A read of the options is going on. */
  reading: boolean
  /** Why the last read failed. */
  error: string | null
}

/** One phone profile's Gemini requests in AI Studio today, for one kind of run. */
export interface PhoneGeminiProfile {
  id: string
  name: string
  selected: boolean
  /** Requests since the last daily reset. */
  today: number
  /** How many requests it got to before its last limit; null until it has hit one. */
  limit: number | null
  /** While its speech limit is noted as used up; null otherwise. */
  limitedUntil: string | null
  /** The phone the profile is on (see PhoneUploadProfile). */
  device: string | null
  phone: string | null
}

/** Gemini's limit for one kind of run on the phone's profiles. */
export interface PhoneGeminiUsage {
  /** Gemini's next daily reset, midnight Pacific. */
  resetsAt: string
  profiles: PhoneGeminiProfile[]
}

export interface PhoneCropsStatus {
  configured: boolean
  /** When the phone last wrote the receipt; null if it never has. */
  reportedAt: string | null
  device: string | null
  /** The id of the update request the receipt answered (see requestPhoneUpdate). */
  answers: string | null
  /** By series id: pages with their JSON files on the phone out of those it has. */
  series: Record<string, { done: number; total: number }>
  /** By chapter id, for the series asked for; chapters with no page started are left out. */
  chapters: Record<string, { done: number; total: number }>
  /** The page Auto-run is on in the series asked for, or null when it isn't running there. The first of `workingPages`. */
  working: PhoneCropsWorking | null
  /** Every page Auto-run is on in the series asked for (one per ChatGPT tab; may span chapters). */
  workingPages: PhoneCropsWorking[]
  /** By page file, for the chapter asked for; pages not started are left out. */
  pages: Record<string, PhonePageState>
  /** By page file, for the chapter asked for: how each done page was finished. */
  finished: Record<string, PhonePageFinish>
  /** Every browser profile on the phone, in its order, with its ChatGPT uploads; empty from older phone builds. */
  profiles: PhoneUploadProfile[]
}

interface CropsReceipt {
  device?: string
  updatedAt?: string
  answers?: string
  profiles?: unknown
  speech?: unknown
  narration?: unknown
  automation?: unknown
  series?: Record<string, {
    total?: number
    done?: number
    working?: CropsReceiptWorking
    workingPages?: CropsReceiptWorking[]
    chapters?: Record<string, { total?: number; done?: number; pages?: Record<string, string>; finished?: Record<string, Record<string, unknown>>; zip?: unknown }>
  }>
}

interface CropsReceiptWorking { chapter?: string; page?: string; since?: string; paused?: boolean }

const PHONE_PAGE_STATES = new Set<string>(['done', 'in_progress', 'changed'])

/**
 * The phone clears "working" when Auto-run ends, but a run killed with the app
 * never does. A page takes minutes, fix rounds included, so one still "working"
 * after this long is taken as a dead run rather than a slow one.
 */
export const WORKING_STALE_MS = 45 * 60_000

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isTime(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/** The phone an item of a merged receipt is from (see phoneReceipts.ts). */
function phoneOf(item: Record<string, unknown>): { device: string | null; phone: string | null } {
  return {
    device: typeof item.device === 'string' ? item.device : null,
    phone: typeof item.phone === 'string' && item.phone ? item.phone : null
  }
}

/** The receipt's `profiles`, dropping anything malformed. */
export function parseUploadProfiles(raw: unknown): PhoneUploadProfile[] {
  if (!Array.isArray(raw)) return []
  const profiles: PhoneUploadProfile[] = []
  for (const entry of raw) {
    if (!isObject(entry) || typeof entry.id !== 'string' || !entry.id) continue
    const uploads = (Array.isArray(entry.uploads) ? entry.uploads : [])
      .filter((u): u is [string, number] => Array.isArray(u) && isTime(u[0]) && count(u[1]) > 0)
      .map(([at, images]) => ({ at, images: count(images) }))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    const limits = (Array.isArray(entry.limits) ? entry.limits : [])
      .filter((l): l is Record<string, unknown> => isObject(l) && isTime(l.at) && isTime(l.until))
      .map(l => ({
        at: l.at as string,
        until: l.until as string,
        used: count(l.used),
        countedSince: isTime(l.countedSince) ? l.countedSince : (l.at as string),
        complete: l.complete === true,
        flagged: l.flagged === true,
        reason: typeof l.reason === 'string' ? l.reason : ''
      }))
    profiles.push({
      id: entry.id,
      name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id,
      selected: entry.selected === true,
      limitedUntil: isTime(entry.limitedUntil) ? entry.limitedUntil : null,
      trackingSince: isTime(entry.trackingSince) ? entry.trackingSince : null,
      counting: isObject(entry.counting) && isTime(entry.counting.since)
        ? { since: entry.counting.since, images: count(entry.counting.images) }
        : null,
      uploads,
      limits,
      ...phoneOf(entry),
      profileId: typeof entry.profileId === 'string' && entry.profileId ? entry.profileId : entry.id,
      chatGpt: parseChatGptProfile(entry.chatGpt),
      check: parseProfileCheck(entry.check),
      usage: parseChatGptUsage(entry.usage)
    })
  }
  return profiles
}

/** A profile's `check` (ProfileCheck.kt on the phone), dropping anything malformed. */
function parseProfileCheck(raw: unknown): PhoneProfileCheck | null {
  if (!isObject(raw) || !isTime(raw.checkedAt)) return null
  const site = (value: unknown): PhoneSiteCheck | null => {
    if (!isObject(value)) return null
    const text = (v: unknown) => (typeof v === 'string' && v ? v : null)
    return { signedIn: value.signedIn === true, email: text(value.email), plan: text(value.plan), error: text(value.error) }
  }
  return { checkedAt: raw.checkedAt, chatGpt: site(raw.chatGpt), gemini: site(raw.gemini) }
}

/** A profile's `usage` (ChatGptUsage.kt on the phone), dropping anything malformed. */
function parseChatGptUsage(raw: unknown): PhoneChatGptUsage | null {
  if (!isObject(raw) || !isTime(raw.checkedAt)) return null
  const windows = (Array.isArray(raw.windows) ? raw.windows : [])
    .filter((w): w is Record<string, unknown> => isObject(w) && typeof w.usedPercent === 'number')
    .map(w => ({
      seconds: typeof w.seconds === 'number' ? w.seconds : 0,
      usedPercent: Math.min(100, Math.max(0, w.usedPercent as number)),
      resetAt: isTime(w.resetAt) ? w.resetAt : null
    }))
  return {
    checkedAt: raw.checkedAt,
    limitReached: raw.limitReached === true,
    error: typeof raw.error === 'string' && raw.error ? raw.error : null,
    windows
  }
}

/** Run automation's ChatGPT choices as the phone reports them back: each a name or null. */
function runSettingsOf(raw: Record<string, unknown>): ChatGptRunSettings {
  const name = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
  return { mode: raw.mode === 'Chat' || raw.mode === 'Work' ? raw.mode : null, model: name(raw.model), effort: name(raw.effort) }
}

/** A profile's `chatGpt` (ChatGptSettings.kt on the phone), dropping anything malformed. */
function parseChatGptProfile(raw: unknown): PhoneChatGptProfile | null {
  if (!isObject(raw)) return null
  const name = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
  const options = isObject(raw.options) ? raw.options : null
  return {
    options: options
      ? {
          readAt: isTime(options.readAt) ? options.readAt : null,
          current: name(options.current),
          modes: (Array.isArray(options.modes) ? options.modes : []).filter(isObject).map(mode => ({
            name: name(mode.name),
            models: (Array.isArray(mode.models) ? mode.models : [])
              .filter(isObject)
              .filter(m => name(m.name))
              .map(m => ({ name: m.name as string, picked: m.picked === true })),
            efforts: (Array.isArray(mode.efforts) ? mode.efforts : [])
              .filter(isObject)
              .map(e => ({ name: name(e.name), locked: e.locked === true, picked: e.picked === true }))
          }))
        }
      : null,
    reading: raw.reading === true,
    error: name(raw.error)
  }
}

/** The receipt's `speech` or `narration`; null from Sleeper-Cell builds before it was sent. */
export function parseGeminiUsage(raw: unknown): PhoneGeminiUsage | null {
  if (!isObject(raw) || !isTime(raw.resetsAt) || !Array.isArray(raw.profiles)) return null
  const profiles: PhoneGeminiProfile[] = []
  for (const entry of raw.profiles) {
    if (!isObject(entry) || typeof entry.id !== 'string' || !entry.id) continue
    profiles.push({
      id: entry.id,
      name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id,
      selected: entry.selected === true,
      today: count(entry.today),
      limit: count(entry.limit) || null,
      limitedUntil: isTime(entry.limitedUntil) ? entry.limitedUntil : null,
      ...phoneOf(entry)
    })
  }
  return { resetsAt: raw.resetsAt, profiles }
}

/**
 * Crop progress on the phone. Series, chapters and pages are matched by
 * folder and file name, the names the R2 zip carries to the phone.
 */
export async function getPhoneCrops(seriesId?: string, chapterId?: string, fresh = false): Promise<PhoneCropsStatus> {
  const empty = { reportedAt: null, device: null, answers: null, series: {}, chapters: {}, working: null, workingPages: [], pages: {}, finished: {}, profiles: [] }
  const list = await readPhoneReceipts<CropsReceipt>('crops', CROPS_RECEIPT_NAME, fresh)
  if (!list) return { configured: false, ...empty }

  const filtered = await Promise.all(list.map(async r => ({ ...r, body: await filterReplacedCropFacts(r.body) })))
  const receipt = mergeCropsReceipts(filtered as PhoneReceipt<Record<string, unknown>>[]) as CropsReceipt
  const phoneSeries = isObject(receipt.series) ? receipt.series : {}

  const rows = await prisma.series.findMany({ select: { id: true, rootFolder: true } })
  const status: PhoneCropsStatus = { configured: true, ...empty }
  status.reportedAt = receipt.updatedAt ?? null
  status.device = receipt.device ?? null
  status.answers = receipt.answers ?? null
  status.profiles = parseUploadProfiles(receipt.profiles)
  for (const row of rows) {
    const entry = phoneSeries[path.basename(row.rootFolder)]
    if (!isObject(entry)) continue
    status.series[row.id] = { done: Number(entry.done) || 0, total: Number(entry.total) || 0 }
    if (row.id !== seriesId) continue

    const chapterRows = await prisma.chapter.findMany({ where: { seriesId: row.id }, select: { id: true, folderPath: true } })
    const byFolder = new Map(chapterRows.map(c => [path.basename(c.folderPath), c.id]))
    const phoneChapters = isObject(entry.chapters) ? entry.chapters : {}
    for (const [folder, chapter] of Object.entries(phoneChapters)) {
      const id = byFolder.get(folder)
      if (!id || !isObject(chapter)) continue
      status.chapters[id] = { done: Number(chapter.done) || 0, total: Number(chapter.total) || 0 }
      if (id !== chapterId || !isObject(chapter.pages)) continue
      for (const [page, state] of Object.entries(chapter.pages)) {
        if (PHONE_PAGE_STATES.has(state)) status.pages[page] = state as PhonePageState
      }
      for (const [page, finish] of Object.entries(isObject(chapter.finished) ? chapter.finished : {})) {
        if (status.pages[page] !== 'done') continue
        const parsed = parseFinish(finish)
        if (parsed) status.finished[page] = parsed
      }
    }

    const toWorking = (working: unknown): PhoneCropsWorking | null => {
      const parsed = parseWorking(working)
      const chapterId = parsed ? byFolder.get(parsed.chapter) : undefined
      if (!parsed || !chapterId) return null
      return { chapterId, page: parsed.page, since: parsed.since, paused: parsed.paused, device: parsed.device, phone: parsed.phone }
    }
    status.working = toWorking(entry.working)
    status.workingPages = workingEntries(entry).map(toWorking).filter((w): w is PhoneCropsWorking => w !== null)
  }
  return status
}

/** One of `finished`'s entries, or null when malformed. */
function parseFinish(finish: unknown): PhonePageFinish | null {
  if (!isObject(finish) || typeof finish.at !== 'string') return null
  const text = (value: unknown) => (typeof value === 'string' && value ? value : null)
  const took = typeof finish.took === 'number' && Number.isFinite(finish.took) && finish.took >= 0 ? finish.took : null
  return {
    at: finish.at,
    took,
    run: finish.run === 'auto' || finish.run === 'manual' ? finish.run : null,
    profile: text(finish.profile),
    account: text(finish.account),
    models: Array.isArray(finish.models) ? finish.models.filter((m): m is string => typeof m === 'string' && !!m) : [],
    phone: phoneOf(finish).phone
  }
}

/** A `working` entry by chapter folder, or null when malformed or stale (see WORKING_STALE_MS). */
function parseWorking(working: unknown): {
  chapter: string; page: string; since: string | null; paused: boolean; device: string | null; phone: string | null
} | null {
  if (!isObject(working) || typeof working.page !== 'string' || !working.page || typeof working.chapter !== 'string') return null
  const since = typeof working.since === 'string' ? working.since : null
  if (since && Date.now() - Date.parse(since) > WORKING_STALE_MS) return null
  return { chapter: working.chapter, page: working.page, since, paused: working.paused === true, ...phoneOf(working) }
}

/** A series entry's pages in progress; older phone builds send only `working`. */
function workingEntries(entry: Record<string, unknown>): unknown[] {
  return Array.isArray(entry.workingPages) ? entry.workingPages : entry.working ? [entry.working] : []
}

// ============ Phone (Sleeper-Cell) overview ============

/** Where a page is: the series and chapter in the library when they match, else the phone's folder names. */
interface PhoneOverviewPlace {
  seriesId: string | null
  series: string
  chapterId: string | null
  chapter: string
  chapterNumber: number | null
}

export interface PhoneOverviewWorking extends PhoneOverviewPlace {
  page: string
  since: string | null
  paused: boolean
  /** The phone clipping it (see PhoneScriptRun). */
  device: string | null
  phone: string | null
}

export interface PhoneOverviewFinish extends PhoneOverviewPlace, PhonePageFinish {
  page: string
}

/** A chapter the phone zipped with its JSON files and uploaded to R2. */
export interface PhoneOverviewChapterZip extends PhoneOverviewPlace {
  uploadedAt: string | null
  pages: number
}

export interface PhoneOverviewSeries {
  id: string
  title: string
  /** What the phone has of the chapters sent to it; null when none were sent. */
  sync: PhoneSeriesSync | null
  /** Chapters with a narration script on the phone; null when it has none. */
  scripts: { done: number; total: number } | null
  /** Pages with crop JSON on the phone; null when it has started none. */
  crops: { done: number; total: number } | null
  /** Chapters the phone has uploaded with their JSON files. */
  chaptersUploaded: number
  /** Pages Auto-run is on in this series right now. */
  working: number
  /** Narration and voiceover runs going in this series right now. */
  runs: PhoneScriptRun['kind'][]
}

export interface PhoneOverviewRunTab extends PhoneOverviewPlace, Omit<PhoneScriptRunTab, 'chapter'> {}

/** A narration or voiceover run on the phone, placed in the library (see PhoneScriptRun). */
export interface PhoneOverviewRun extends Omit<PhoneScriptRun, 'series' | 'tabs'> {
  seriesId: string | null
  series: string
  tabs: PhoneOverviewRunTab[]
}

/** Sleeper-Cell's automation settings, and the run it will start by itself (Automation.json on the phone). */
export interface PhoneAutomation {
  /** personal: shows over the lock screen, PIN kept. dedicated: dismisses the lock screen, locks after. */
  wakeMode: 'personal' | 'dedicated'
  resumeAfterLimit: boolean
  /** Manhwa Studio may start and stop its runs (sendAutomationCommand). */
  remoteStart: boolean
  /** The run waiting for a ChatGPT limit to lift, or for the phone to come online; null when none is. */
  resume: { seriesId: string | null; series: string; tabs: number; at: string } | null
  /** The runs Manhwa Studio can start there; builds from before the others can start only Image Clipper. */
  runs: PhoneRunKind[]
  /** How Image Clipper last ran there, the choices to offer first; null from builds before it was sent. */
  /** How Image Clipper last ran; `chatGpt` is the mode, model and effort last picked in Run automation (older builds: null). */
  clipper: { ai: PhoneClipperAi; flow: PhoneClipperFlow; tabs: number; chatGpt: ChatGptRunSettings | null } | null
  /** Editor 2.0's tabs last used there; null from builds whose Editor 2.0 run takes neither tabs nor chapters (no split). */
  editor: { tabs: number; staged?: boolean; chatGpt?: ChatGptRunSettings } | null
  /** The runs whose start takes a `chapters` list (a share of a split); empty from builds before it was said. */
  chapterRuns: PhoneRunKind[]
  /**
   * A run going there takes a start of the same run on the same series with `chapters` as its new scope, keeping
   * the chapters it's on, without starting over (a split around it). Builds before would start over.
   */
  rescope: boolean
  /** It can stop a run once what it's on is done (stop with `after`); builds before can only stop it now. */
  stopAfter: boolean
  /** Image Clipper ends once the pages it's on are done. */
  clipperStopping: boolean
}

/**
 * The runs Sleeper-Cell can start from here: Image Clipper's crops (ChatGPT or
 * Gemini in AI Studio, in one prompt or four steps), the narration scripts
 * (Gemini), Editor 2.0's timelines (ChatGPT) and the voiceover (Gemini speech).
 */
export type PhoneRunKind = 'clipper' | 'narration' | 'editor' | 'voiceover'
export const PHONE_RUN_KINDS: readonly PhoneRunKind[] = ['clipper', 'narration', 'editor', 'voiceover']
export type PhoneClipperAi = 'chatgpt' | 'aistudio' | 'gemini'
export type PhoneClipperFlow = 'classic' | 'steps'

/** One phone running Sleeper-Cell. */
export interface PhoneOverviewPhone {
  /** Its id; "" for a build from before phones had one, which can't be started on its own. */
  id: string
  name: string
  /** Sleeper-Cell's socket to the relay is open (the app is open, or listening for starts); null without the relay. */
  connected: boolean | null
  /** When the relay last heard from it, and how it went when not connected (see RelayPhone); null without them. */
  seenAt: string | null
  left: PhoneLeft | null
  /** Its newest receipt. */
  reportedAt: string | null
  /** Its automation settings; null from builds before automation. */
  automation: PhoneAutomation | null
  /** Pages Auto-run is on there. */
  working: number
  /** Narration and voiceover runs going there. */
  runs: number
}

/** Everything Sleeper-Cell has reported, across every series and phone, for the Sleeper Cells page. */
export interface PhoneOverview {
  configured: boolean
  /** Every phone's name, joined. */
  device: string | null
  /** Each phone, by name. One without the relay: R2 carries one phone's receipts. */
  phones: PhoneOverviewPhone[]
  /** The latest of the three receipts. */
  reportedAt: string | null
  /** When each receipt was last written; null if never. */
  reported: { sync: string | null; scripts: string | null; crops: string | null }
  /** The id of the "Refresh from phone" request the crops receipt last answered. */
  answers: string | null
  /** Every page Auto-run is on, across series. */
  working: PhoneOverviewWorking[]
  /** Narration and voiceover runs going now (from the scripts receipt). */
  runs: PhoneOverviewRun[]
  series: PhoneOverviewSeries[]
  /** Done pages, newest first, at most OVERVIEW_RECENT. */
  recent: PhoneOverviewFinish[]
  /** True when there were more done pages than `recent` holds. */
  recentCapped: boolean
  /** Chapter zips the phone uploaded, newest first. */
  uploads: PhoneOverviewChapterZip[]
  profiles: PhoneUploadProfile[]
  /** Gemini requests per profile today: the voiceover run's speech and the narration run's scripts; null from builds before each was sent. */
  gemini: { speech: PhoneGeminiUsage | null; narration: PhoneGeminiUsage | null }
  /** The first phone's that may be started from here, else the first phone's; null from Sleeper-Cell builds before automation. */
  automation: PhoneAutomation | null
}

const OVERVIEW_RECENT = 300
const OVERVIEW_UPLOADS = 30

/**
 * All three receipts at once. Served from the relay or the server's copies;
 * `fresh` re-reads the scripts and crops receipts from R2 (one HEAD each, a
 * GET only when changed). The sync receipt comes with the last bucket listing,
 * however old, so this never lists the bucket once it has been listed.
 */
export async function getPhoneOverview(sync: PhoneSyncStatus | null, fresh = false): Promise<PhoneOverview> {
  const empty: PhoneOverview = {
    configured: false, device: null, phones: [], reportedAt: null, reported: { sync: null, scripts: null, crops: null },
    answers: null, working: [], runs: [], series: [], recent: [], recentCapped: false, uploads: [], profiles: [], gemini: { speech: null, narration: null }, automation: null
  }
  const [scripts, cropsList] = await Promise.all([
    getPhoneScripts(undefined, fresh).catch(() => null),
    readPhoneReceipts<CropsReceipt>('crops', CROPS_RECEIPT_NAME, fresh)
  ])
  if (!cropsList) return empty
  const filteredCrops = await Promise.all(cropsList.map(async r => ({ ...r, body: await filterReplacedCropFacts(r.body) })))
  const crops = mergeCropsReceipts(filteredCrops as PhoneReceipt<Record<string, unknown>>[]) as CropsReceipt

  const rows = await prisma.series.findMany({
    select: { id: true, title: true, rootFolder: true, createdAt: true, chapters: { select: { id: true, folderPath: true, number: true } } }
  })
  const byFolder = new Map(rows.map(row => [path.basename(row.rootFolder), row]))
  const place = (seriesFolder: string, chapterFolder: string): PhoneOverviewPlace => {
    const row = byFolder.get(seriesFolder)
    const chapter = row?.chapters.find(c => path.basename(c.folderPath) === chapterFolder)
    return {
      seriesId: row?.id ?? null,
      series: row?.title ?? seriesFolder,
      chapterId: chapter?.id ?? null,
      chapter: chapterFolder,
      chapterNumber: chapter?.number ?? null
    }
  }

  const overview: PhoneOverview = { ...empty, configured: true }
  overview.answers = crops.answers ?? null
  overview.profiles = parseUploadProfiles(crops.profiles)
  overview.gemini = { speech: parseGeminiUsage(crops.speech), narration: parseGeminiUsage(crops.narration) }
  const seriesFor = (folder: string) => byFolder.get(folder) ?? null
  const automations = new Map(cropsList.map(r => [r.device, parseAutomation(r.body.automation, seriesFor)]))
  overview.automation = [...automations.values()].find(a => a?.remoteStart) ?? [...automations.values()].find(a => a) ?? null
  overview.reported = { sync: sync?.reportedAt ?? null, scripts: scripts?.reportedAt ?? null, crops: crops.updatedAt ?? null }
  overview.reportedAt = Object.values(overview.reported)
    .filter((at): at is string => !!at)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null
  overview.device = crops.device ?? scripts?.device ?? sync?.device ?? null
  overview.runs = (scripts?.runs ?? []).map(run => ({
    ...run,
    seriesId: byFolder.get(run.series)?.id ?? null,
    series: byFolder.get(run.series)?.title ?? run.series,
    tabs: run.tabs.map(({ chapter, ...tab }) => ({ ...place(run.series, chapter), ...tab }))
  }))

  const cropsBySeries = new Map<string, { done: number; total: number; chaptersUploaded: number; working: number }>()
  for (const [seriesFolder, entry] of Object.entries(isObject(crops.series) ? crops.series : {})) {
    if (!isObject(entry)) continue
    const summary = { done: Number(entry.done) || 0, total: Number(entry.total) || 0, chaptersUploaded: 0, working: 0 }
    for (const raw of workingEntries(entry)) {
      const working = parseWorking(raw)
      if (!working) continue
      overview.working.push({
        ...place(seriesFolder, working.chapter),
        page: working.page,
        since: working.since,
        paused: working.paused,
        device: working.device,
        phone: working.phone
      })
      summary.working++
    }
    for (const [chapterFolder, chapter] of Object.entries(isObject(entry.chapters) ? entry.chapters : {})) {
      if (!isObject(chapter)) continue
      const pages = isObject(chapter.pages) ? chapter.pages : {}
      for (const [page, finish] of Object.entries(isObject(chapter.finished) ? chapter.finished : {})) {
        const parsed = pages[page] === 'done' ? parseFinish(finish) : null
        if (parsed) overview.recent.push({ ...place(seriesFolder, chapterFolder), page, ...parsed })
      }
      const zip = chapter.zip
      if (isObject(zip)) {
        summary.chaptersUploaded++
        overview.uploads.push({
          ...place(seriesFolder, chapterFolder),
          uploadedAt: isTime(zip.uploadedAt) ? zip.uploadedAt : null,
          pages: count(zip.pages)
        })
      }
    }
    const row = byFolder.get(seriesFolder)
    if (row) cropsBySeries.set(row.id, summary)
  }
  const newest = (a: string | null, b: string | null) => (Date.parse(b ?? '') || 0) - (Date.parse(a ?? '') || 0)
  overview.recentCapped = overview.recent.length > OVERVIEW_RECENT
  overview.recent = overview.recent.sort((a, b) => newest(a.at, b.at)).slice(0, OVERVIEW_RECENT)
  overview.uploads = overview.uploads.sort((a, b) => newest(a.uploadedAt, b.uploadedAt)).slice(0, OVERVIEW_UPLOADS)

  for (const row of rows) {
    const cropped = cropsBySeries.get(row.id)
    const entry: PhoneOverviewSeries = {
      id: row.id,
      title: row.title,
      sync: sync?.series[row.id] ?? null,
      scripts: scripts?.series[row.id] ?? null,
      crops: cropped ? { done: cropped.done, total: cropped.total } : null,
      chaptersUploaded: cropped?.chaptersUploaded ?? 0,
      working: cropped?.working ?? 0,
      runs: overview.runs.filter(run => run.seriesId === row.id).map(run => run.kind)
    }
    if (entry.sync || entry.scripts || entry.crops || entry.runs.length) overview.series.push(entry)
  }
  overview.series = await withSeriesActivity(overview.series.map(entry => {
    const row = rows.find(row => row.id === entry.id)!
    return { ...entry, rootFolder: row.rootFolder, createdAt: row.createdAt }
  }))
  overview.phones = overviewPhones(overview, automations)
  return overview
}

/**
 * Each phone: the relay's list (connected, or with receipts kept), each with
 * its newest receipt and what it's doing. Without the relay, the one phone
 * whose receipts are in R2.
 */
function overviewPhones(overview: PhoneOverview, automations: Map<string, PhoneAutomation | null>): PhoneOverviewPhone[] {
  const busy = (device: string) => ({
    working: overview.working.filter(w => (w.device ?? '') === device).length,
    runs: overview.runs.filter(r => (r.device ?? '') === device).length
  })
  if (!relayConfigured()) {
    if (!overview.reportedAt) return []
    return [{
      id: '', name: overview.device ?? 'Phone', connected: null, seenAt: null, left: null, reportedAt: overview.reportedAt,
      automation: automations.get('') ?? null, ...busy('')
    }]
  }
  const reported = new Map<string, string>()
  for (const kind of ['sync', 'scripts', 'crops'] as const) {
    for (const receipt of relayReceipts<{ updatedAt?: unknown }>(kind) ?? []) {
      const at = receipt.body.updatedAt
      const before = reported.get(receipt.device)
      if (isTime(at) && (!before || Date.parse(at) > Date.parse(before))) reported.set(receipt.device, at)
    }
  }
  return relayPhones().map(phone => ({
    id: phone.id,
    name: phone.name,
    connected: phone.connected,
    seenAt: phone.seenAt,
    left: phone.left,
    reportedAt: reported.get(phone.id) ?? null,
    automation: automations.get(phone.id) ?? null,
    ...busy(phone.id)
  }))
}

function parseAutomation(raw: unknown, seriesFor: (folder: string) => { id: string; title: string } | null): PhoneAutomation | null {
  if (!isObject(raw)) return null
  const resume = isObject(raw.resume) && typeof raw.resume.series === 'string' && isTime(raw.resume.at) ? raw.resume : null
  const row = resume ? seriesFor(resume.series as string) : null
  return {
    wakeMode: raw.wakeMode === 'dedicated' ? 'dedicated' : 'personal',
    resumeAfterLimit: raw.resumeAfterLimit === true,
    remoteStart: raw.remoteStart === true,
    resume: resume
      ? { seriesId: row?.id ?? null, series: row?.title ?? (resume.series as string), tabs: Number(resume.tabs) || 1, at: resume.at as string }
      : null,
    runs: phoneRuns(raw),
    clipper: isObject(raw.clipper)
      ? {
          ai: raw.clipper.ai === 'gemini' ? 'gemini' : raw.clipper.ai === 'aistudio' ? 'aistudio' : 'chatgpt',
          flow: raw.clipper.flow === 'steps' ? 'steps' : 'classic',
          tabs: Math.min(PHONE_MAX_TABS, Math.max(1, Number(raw.clipper.tabs) || 1)),
          chatGpt: isObject(raw.clipper.chatGpt) ? runSettingsOf(raw.clipper.chatGpt) : null
        }
      : null,
    editor: isObject(raw.editor) ? { tabs: Math.min(PHONE_MAX_TABS, Math.max(1, Number(raw.editor.tabs) || 1)),
      staged: raw.editor.staged === true,
      ...(isObject(raw.editor.chatGpt) ? { chatGpt: runSettingsOf(raw.editor.chatGpt) } : {}) } : null,
    chapterRuns: Array.isArray(raw.chapterRuns) ? PHONE_RUN_KINDS.filter(kind => (raw.chapterRuns as unknown[]).includes(kind)) : [],
    rescope: raw.rescope === true,
    stopAfter: raw.stopAfter === true,
    clipperStopping: raw.clipperStopping === true
  }
}

/** The runs a crops receipt's `automation` says the phone can start: Image Clipper only from builds that don't say. */
function phoneRuns(automation: Record<string, unknown>): PhoneRunKind[] {
  if (!Array.isArray(automation.runs)) return ['clipper']
  return PHONE_RUN_KINDS.filter(kind => (automation.runs as unknown[]).includes(kind))
}

/** The most tabs a phone run takes at once (MAX_TABS in ClipperRun, EditorRun and VoiceoverRun on the phone). */
export const PHONE_MAX_TABS = 4

export interface PhoneAutomationTarget {
  device: string
  name: string
  /** The chapter folders it was given; null for the whole series (or a stop). */
  chapters: string[] | null
  /** It was connected, so it got the command at once (else it acts on it if it connects within 10 minutes). */
  reached: boolean
  /** A split's share: started, rescoped (a run already on it), or told to finish what it's on (see phoneSplit.ts). */
  action?: 'start' | 'rescope' | 'finish'
}

export interface PhoneAutomationSent extends PhoneUpdateRequest {
  /** Each phone sent the command; one entry with device "*" when it went to every phone. */
  targets: PhoneAutomationTarget[]
  /** A split's chapter numbers by folder, to show the shares. */
  numbers?: Record<string, number>
}

export type ChatGptRunSettings = { mode: 'Chat' | 'Work' | null; model: string | null; effort: string | null }

export interface PhoneAutomationOptions {
  /** The run to start; Image Clipper when left out. A stop stops whichever run is going. */
  kind?: PhoneRunKind
  seriesId?: string
  /** Production sequence: a validated scope on one phone, excluding completed work. */
  chapters?: string[]
  /** Image Clipper's, Editor 2.0's and the voiceover's tabs. */
  tabs?: number
  /** Image Clipper: ChatGPT, AI Studio, or Gemini on the web, and one prompt (classic) or four steps. */
  ai?: PhoneClipperAi
  flow?: PhoneClipperFlow
  /** Image Clipper on ChatGPT: the mode, model and effort (each null: as the account has it); the phone keeps them. */
  chatGpt?: ChatGptRunSettings
  /** Editor 2.0 and the voiceover: the narration language. */
  language?: NarrationLanguage
  device?: string
  split?: boolean
  /**
   * A split as confirmed (planSplit, then Run automation's confirm): each phone's whole share, by device id. Sent
   * as it is, not planned again; an empty share has a phone already on this run finish what it's on. Without it, a
   * split is planned and sent at once.
   */
  assignments?: Record<string, string[]>
  /** A stop: once the pages, chapter or splits the run is on are done, as the phone's "Finish …, then stop". */
  after?: boolean
}

const START_ACTION: Record<PhoneRunKind, PhoneAction> = {
  clipper: 'clipper_start',
  narration: 'narration_start',
  editor: 'editor_start',
  voiceover: 'voiceover_start'
}

export const RUN_LABEL: Record<PhoneRunKind, string> = {
  clipper: 'Image Clipper',
  narration: 'Narration scripts',
  editor: 'Editor 2.0 timelines',
  voiceover: 'Voiceover'
}

/**
 * Starts or stops a run on the phones, through the relay: a phone acts on it
 * with "Start from Manhwa Studio" on, waking itself if need be, and ignores it
 * after 10 minutes. `start` runs `kind` (Image Clipper when left out) on
 * `seriesId`; Image Clipper alone may leave the series out, to go on with the
 * phone's last run in its last tab count. `stop` stops whichever run is going,
 * or only Image Clipper on builds that can't start the others; with `after`,
 * once what the run is on is done (builds that can't say so refuse it).
 *
 * `device` sends it to that phone only. `split` (any run but Narration
 * scripts, which one phone writes in order; with a series) sends
 * each phone its share of the series' chapters, as `assignments` says (the plan
 * planSplit made and Run automation confirmed), or as planned now without it:
 * a start with its chapters, to a phone already on this run too (it takes them
 * as its new scope). So no two phones work on the same page or chapter, and a
 * phone busy with something else is left alone. Without either, every phone
 * gets it.
 */
export async function sendAutomationCommand(
  command: 'start' | 'stop',
  options: PhoneAutomationOptions = {}
): Promise<PhoneAutomationSent> {
  if (!relayConfigured()) throw new Error('Starting runs on the phone needs the phone relay (Settings → Cloudflare)')
  const { device } = options
  const kind = options.kind ?? 'clipper'
  if (device !== undefined && !relayPhones().some(p => p.id === device && p.id)) throw new Error('That phone is not known to the relay')
  const target = (sent: { phones: number }, chapters: string[] | null = null): PhoneAutomationTarget =>
    device ? { device, name: phoneName(device), chapters, reached: sent.phones > 0 } : { device: '*', name: 'Every phone', chapters, reached: sent.phones > 0 }
  const runsOn = automationRuns(device)

  if (command === 'stop') {
    if (options.after) {
      if (!automationOf(device).every(a => a.stopAfter === true)) {
        throw new Error('Update Sleeper-Cell to finish the run first: this build can only stop it now')
      }
      const sent = await sendPhoneRequest('run_finish', { device })
      return { ...sent, via: 'relay', targets: [target(sent)] }
    }
    // A build that can only start Image Clipper only knows its stop.
    const action = runsOn.length && runsOn.every(runs => runs.length > 1) ? 'run_stop' : 'clipper_stop'
    const sent = await sendPhoneRequest(action, { device })
    return { ...sent, via: 'relay', targets: [target(sent)] }
  }
  const old = runsOn.length > 0 && runsOn.every(runs => !runs.includes(kind))
  if (old) throw new Error(`Update Sleeper-Cell to start ${RUN_LABEL[kind]} from here: this build can only start Image Clipper`)
  if (kind !== 'clipper' && !options.seriesId) throw new Error(`Pick a series for ${RUN_LABEL[kind]}`)
  let series: string | undefined
  if (options.seriesId) {
    const row = await prisma.series.findUnique({ where: { id: options.seriesId }, select: { rootFolder: true } })
    if (!row) throw new Error('Series not found')
    // The phone names series by their folder (see place() in getPhoneOverview).
    series = path.basename(row.rootFolder)
  }
  const takesTabs = kind === 'clipper' || kind === 'editor' || kind === 'voiceover'
  if (options.chapters !== undefined) {
    if (!device || !options.seriesId || options.split) throw new Error('A chapter scope needs one device and series')
    if (!Array.isArray(options.chapters) || !options.chapters.length || options.chapters.some(c => typeof c !== 'string' || !c)) throw new Error('Pick chapters to run')
    if (!automationOf(device).some(a => Array.isArray(a.chapterRuns) && a.chapterRuns.includes(kind))) throw new Error('Update Sleeper-Cell to run only the unfinished chapters')
    const chapters = await prisma.chapter.findMany({ where: { seriesId: options.seriesId }, select: { folderPath: true } })
    const known = new Set(chapters.map(c => path.basename(c.folderPath)))
    if (options.chapters.some(c => !known.has(c))) throw new Error('A chapter in the run is not in this series')
  }
  if (options.tabs !== undefined && !(Number.isInteger(options.tabs) && options.tabs >= 1 && options.tabs <= PHONE_MAX_TABS)) {
    throw new Error(`tabs must be 1 to ${PHONE_MAX_TABS}`)
  }
  const args = {
    series,
    ...(options.chapters ? { chapters: [...new Set(options.chapters)] } : {}),
    tabs: takesTabs ? options.tabs : undefined,
    ...(kind === 'clipper' ? { ai: options.ai, flow: options.flow, chatGpt: options.chatGpt } : {}),
    ...(kind === 'editor' ? { chatGpt: options.chatGpt } : {}),
    // Narration's AI only when asked for: Run automation has no choice of it, so the phone keeps its own.
    ...(kind === 'narration' && options.ai ? { ai: options.ai } : {}),
    ...(kind === 'editor' || kind === 'voiceover' ? { language: options.language ?? 'en' } : {})
  }
  if (!options.split) {
    if (kind === 'narration' && series) assertNarrationFree(series, device)
    const sent = await sendPhoneRequest(START_ACTION[kind], { ...args, device })
    return { ...sent, via: 'relay', targets: [target(sent, options.chapters ?? null)] }
  }

  const split = await import('./phoneSplit.js')
  if (kind === 'narration') throw new Error(split.NARRATION_ONE_PHONE)
  if (!options.seriesId || !series) throw new Error('Pick a series to split between the phones')
  let assignments = options.assignments
  let numbers: Record<string, number> | undefined
  if (!assignments) {
    const plan = await split.planSplit(kind, options.seriesId, options.language ?? 'en')
    numbers = plan.numbers
    assignments = Object.fromEntries(plan.targets.filter(t => t.action !== 'skip').map(t => [t.device, t.chapters]))
  }
  const known = new Set(relayPhones().map(p => p.id).filter(Boolean))
  const given = new Set<string>()
  for (const [phone, chapters] of Object.entries(assignments)) {
    if (!known.has(phone)) throw new Error('A phone in the split is not known to the relay')
    if (!Array.isArray(chapters) || chapters.some(c => typeof c !== 'string' || !c)) throw new Error('Each phone’s share must be a list of chapter folders')
    for (const chapter of chapters) {
      if (given.has(chapter)) throw new Error(`${chapter} is in two phones’ shares`)
      given.add(chapter)
    }
  }
  if (!given.size) throw new Error('The split gives no phone a chapter')
  if (!numbers) {
    const row = await prisma.series.findUnique({ where: { id: options.seriesId }, select: { chapters: { select: { folderPath: true, number: true } } } })
    numbers = Object.fromEntries((row?.chapters ?? []).map(c => [path.basename(c.folderPath), c.number]).filter(([folder]) => given.has(folder as string)))
  }
  const targets: PhoneAutomationTarget[] = []
  let first: (PhoneUpdateRequest & { phones: number }) | null = null
  let reached = 0
  for (const [phone, chapters] of Object.entries(assignments)) {
    // A phone already on this run with nothing left for it finishes what it's on, rather than go on with its old scope.
    const sent = chapters.length
      ? await sendPhoneRequest(START_ACTION[kind], { ...args, chapters, device: phone })
      : await sendPhoneRequest('run_finish', { device: phone })
    first ??= { ...sent, via: 'relay' }
    reached += sent.phones
    const action = !chapters.length ? 'finish' : split.onThisRun(kind, series, options.language ?? 'en', phone) ? 'rescope' : 'start'
    targets.push({ device: phone, name: phoneName(phone), chapters, reached: sent.phones > 0, action })
  }
  return { ...first!, phones: reached, targets, numbers }
}

/**
 * Narration scripts run on one phone at a time per series (each chapter's prompt goes on from the one before's
 * summary): a start is refused while another phone has a narration run on `series` (paused or not; a run gone quiet
 * past WORKING_STALE_MS is dead). The phone running it may be started again (it just resumes). Without `device`,
 * the start goes to the one phone connected, or to every phone, when no phone may have it running.
 */
function assertNarrationFree(series: string, device: string | undefined): void {
  const connected = relayPhones().filter(p => p.connected)
  const target = device ?? (connected.length === 1 ? connected[0].id : null)
  for (const receipt of relayReceipts<{ runs?: unknown }>('scripts') ?? []) {
    if (target !== null && receipt.device === target) continue
    if (parseScriptRuns(receipt.body.runs).some(r => r.kind === 'narration' && r.series === series)) {
      throw new Error(`${phoneName(receipt.device)} is already writing ${series}'s scripts. Stop it there first.`)
    }
  }
}

/** The `automation` of each phone a command goes to, from its crops receipt: `device`'s, or every phone's. */
function automationOf(device: string | undefined): Record<string, unknown>[] {
  return (relayReceipts<{ automation?: unknown }>('crops') ?? [])
    .filter(r => (device === undefined || r.device === device) && isObject(r.body.automation))
    .map(r => r.body.automation as Record<string, unknown>)
}

/** The runs each phone a command goes to can start. */
function automationRuns(device: string | undefined): PhoneRunKind[][] {
  return automationOf(device).map(phoneRuns)
}

/** Phones the relay can start on their own now: connected, with an id, and "Start from Manhwa Studio" on. */
export function startablePhones(): { id: string; name: string }[] {
  const remote = new Set(
    (relayReceipts<{ automation?: { remoteStart?: unknown } }>('crops') ?? [])
      .filter(r => r.body.automation?.remoteStart === true)
      .map(r => r.device)
  )
  return relayPhones().filter(p => p.id && p.connected && remote.has(p.id))
}

/**
 * "Refresh from phone": Sleeper-Cell writes its scripts and crops receipts only
 * when asked, to keep R2 operations inside the free tier. This object is the
 * ask, `{ id, requestedAt }`; while the app is open the phone reads it every
 * 30 s and answers a new id by writing both receipts with `answers: id`. Keep
 * the name in step with REQUEST_NAME in its StudioRequests.kt.
 */
const REQUEST_NAME = '_sleeper-cell-request.json'

/** Where the phone keeps its receipts, which is where it looks for the request. */
export async function phoneFolders(client: S3Client, config: R2Config): Promise<string[]> {
  const folderOf = (key: string) => key.slice(0, key.lastIndexOf('/') + 1)
  const known = (): string[] => {
    const keys = [...receiptCaches.values()].filter(c => c.bucket === config.bucket && c.key).map(c => c.key!)
    // The bucket listing is cached anyway; reading it here costs nothing.
    if (storageCache?.bucket === config.bucket) {
      keys.push(...storageCache.value.objects.map(o => o.key).filter(k => /(^|\/)_sleeper-cell[^/]*\.json$/.test(k) && !k.endsWith(REQUEST_NAME)))
    }
    return [...new Set(keys.map(folderOf))]
  }
  let folders = known()
  if (folders.length === 0) {
    await readPolledReceipt(client, config, SCRIPTS_RECEIPT_NAME, true)
    folders = known()
  }
  // Never heard from the phone: ask in both places it may be looking.
  return folders.length > 0 ? folders : [...new Set([config.prefix, ''])]
}

export interface PhoneUpdateRequest {
  id: string
  requestedAt: string
  /** relay: sent through the phone relay, answered the moment Sleeper-Cell is open. r2: left in the bucket. */
  via: 'relay' | 'r2'
  /** Through the relay: Sleeper-Cell sockets open when it was sent (0 = it answers once opened). */
  phones: number | null
}

/**
 * Asks the phone for fresh receipts: through the relay when it is set up (no
 * R2 operations), else one PUT (Class A), two if its folder is unknown.
 * `action: 'sync'` also has it check R2 for chapters just sent (see phoneSend.ts).
 */
export async function requestPhoneUpdate(action?: 'sync'): Promise<PhoneUpdateRequest> {
  if (relayConfigured()) return { ...(await sendPhoneRequest(action)), via: 'relay' }
  const config = getR2Config()
  if (!config) throw new Error('Cloudflare R2 is not set up')
  const client = createClient(config)
  const request = { id: randomUUID(), requestedAt: new Date().toISOString(), ...(action ? { action } : {}) }
  const body = JSON.stringify(request)
  for (const folder of await phoneFolders(client, config)) {
    await client.send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: `${folder}${REQUEST_NAME}`,
      Body: body,
      ContentType: 'application/json'
    }))
  }
  return { ...request, via: 'r2', phones: null }
}

export const PART_SIZE = 16 * 1024 * 1024

function formatSize(bytes: number): string {
  return bytes >= 1000 ** 3 ? `${(bytes / 1000 ** 3).toFixed(2)} GB` : `${(bytes / 1000 ** 2).toFixed(1)} MB`
}

/**
 * Class A requests used this month: Cloudflare's count when the analytics
 * token is set, else only this server's. Cloudflare's runs a few minutes
 * behind, so it is never taken below our own.
 */
async function classAUsed(): Promise<number> {
  const local = (await getMonthUsage()).classA
  const cloudflare = await getCloudflareMonthOps().catch(() => null)
  return Math.max(local, cloudflare?.classA ?? 0)
}

/**
 * Throw if these uploads would go past the free plan. An upload replacing a
 * key frees the old object, so its size is netted out. One fresh bucket list.
 */
export async function assertWithinFreePlan(client: S3Client, bucket: string, uploads: { key: string; bytes: number }[]): Promise<BucketStorage> {
  const storage = await measureBucket(client, bucket, true)
  const sizes = new Map(storage.objects.map(o => [o.key, o.size]))
  const replaced = uploads.reduce((sum, u) => sum + (sizes.get(u.key) ?? 0), 0)
  const bytes = uploads.reduce((sum, u) => sum + u.bytes, 0)
  const after = storage.bytes - replaced + bytes
  if (after > FREE_PLAN.storageBytes) {
    throw new Error(
      `Blocked to stay on the free plan: the bucket would hold ${formatSize(after)} of the free ` +
      `${formatSize(FREE_PLAN.storageBytes)} (now ${formatSize(storage.bytes)}, these zips ~${formatSize(bytes)}` +
      `${replaced ? `, replacing ${formatSize(replaced)}` : ''}). ` +
      'Clear done chapters on the phone, or delete old objects in Settings → Cloudflare.'
    )
  }
  // Per upload: create + one per 16 MB part + complete (a small one is a single PUT, so this overestimates).
  const requests = uploads.reduce((sum, u) => sum + Math.ceil(u.bytes / PART_SIZE) + 2, 0)
  const classA = await classAUsed()
  if (classA + requests > FREE_PLAN.classA) {
    throw new Error(
      `Blocked to stay on the free plan: this upload needs ~${requests.toLocaleString()} Class A requests and ` +
      `${classA.toLocaleString()} of ${FREE_PLAN.classA.toLocaleString()} are used this month.`
    )
  }
  return storage
}
