/**
 * R2 free-plan usage — the operation ledger.
 *
 * Cloudflare bills R2 on three meters; the free plan covers, per month:
 *   storage           10 GB-month
 *   Class A requests  1,000,000   (writes and lists: PutObject, UploadPart, ListObjectsV2, …)
 *   Class B requests  10,000,000  (reads: GetObject, HeadObject, HeadBucket, …)
 * Deletes and aborts are free, and so is egress.
 *
 * Storage is measured exactly by listing the bucket (see r2Service). Requests
 * cannot be read back through the S3 API, so every request this server sends
 * is counted here by a middleware on the S3 client. Each attempt is counted,
 * retries included, because a failed attempt may still be billed. Requests
 * made outside Manhwa Studio (the Cloudflare dashboard, other tools) are not
 * seen, so the numbers are a floor, not Cloudflare's invoice.
 *
 * The ledger is a small JSON file under DOWNLOAD_ROOT/_r2/, keyed by calendar
 * month (UTC), flushed a couple of seconds after the last request.
 */

import fs from 'fs/promises'
import path from 'path'
import type { S3Client } from '@aws-sdk/client-s3'

export const FREE_PLAN = {
  /** Decimal GB — the smaller reading of "10 GB", so the guard errs safe. */
  storageBytes: 10 * 1000 ** 3,
  classA: 1_000_000,
  classB: 10_000_000
} as const

export type OpClass = 'A' | 'B' | 'free'

// Cloudflare's classification of S3 operations (R2 pricing docs).
const CLASS_A = new Set([
  'ListBuckets', 'PutBucket', 'ListObjects', 'ListObjectsV2', 'PutObject', 'CopyObject',
  'CompleteMultipartUpload', 'CreateMultipartUpload', 'ListMultipartUploads', 'UploadPart',
  'UploadPartCopy', 'ListParts', 'PutBucketEncryption', 'PutBucketCors',
  'PutBucketLifecycleConfiguration'
])
const CLASS_B = new Set([
  'HeadBucket', 'HeadObject', 'GetObject', 'GetBucketEncryption', 'GetBucketLocation',
  'GetBucketCors', 'GetBucketLifecycleConfiguration'
])
const FREE = new Set(['DeleteObject', 'DeleteObjects', 'DeleteBucket', 'AbortMultipartUpload'])

/** Unknown operations count as Class A — the scarcer meter — so the tally never undercounts. */
export function classifyOp(commandName: string): OpClass {
  const op = commandName.replace(/Command$/, '')
  if (FREE.has(op)) return 'free'
  if (CLASS_B.has(op)) return 'B'
  if (CLASS_A.has(op)) return 'A'
  return 'A'
}

export interface MonthUsage {
  classA: number
  classB: number
  free: number
  /** Request count per operation name, for the curious. */
  ops: Record<string, number>
  /** When counting started for this month (later than the 1st on the first month). */
  since: string
}

interface Ledger {
  months: Record<string, MonthUsage>
}

/** "2026-09" for the current UTC month. */
export function monthKey(date = new Date()): string {
  return date.toISOString().slice(0, 7)
}

function ledgerPath(): string {
  return path.join(process.env.DOWNLOAD_ROOT || './downloads', '_r2', 'usage.json')
}

let ledger: Ledger | null = null
let loading: Promise<Ledger> | null = null
let flushTimer: NodeJS.Timeout | null = null

async function load(): Promise<Ledger> {
  if (ledger) return ledger
  loading ??= (async () => {
    try {
      const parsed = JSON.parse(await fs.readFile(ledgerPath(), 'utf-8')) as Ledger
      ledger = parsed && typeof parsed.months === 'object' ? parsed : { months: {} }
    } catch {
      ledger = { months: {} }
    }
    return ledger
  })()
  return loading
}

function monthOf(l: Ledger, key: string): MonthUsage {
  l.months[key] ??= { classA: 0, classB: 0, free: 0, ops: {}, since: new Date().toISOString() }
  return l.months[key]
}

async function flush(): Promise<void> {
  if (!ledger) return
  const file = ledgerPath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  // Write-then-rename so a crash mid-write never leaves half a ledger.
  await fs.writeFile(`${file}.tmp`, JSON.stringify(ledger, null, 2), 'utf-8')
  await fs.rename(`${file}.tmp`, file)
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flush().catch(err => console.error('Could not save the R2 usage ledger:', err))
  }, 2000)
}

export async function recordOp(commandName: string): Promise<void> {
  const l = await load()
  const month = monthOf(l, monthKey())
  const cls = classifyOp(commandName)
  if (cls === 'A') month.classA++
  else if (cls === 'B') month.classB++
  else month.free++
  const op = commandName.replace(/Command$/, '')
  month.ops[op] = (month.ops[op] ?? 0) + 1
  scheduleFlush()
}

export async function getMonthUsage(key = monthKey()): Promise<MonthUsage> {
  const l = await load()
  return l.months[key] ?? { classA: 0, classB: 0, free: 0, ops: {}, since: new Date().toISOString() }
}

/**
 * Count every request the client sends. The `deserialize` step runs inside
 * the retry loop, so each attempt is counted, not just each command.
 */
export function attachUsageCounter(client: S3Client): void {
  client.middlewareStack.add(
    (next, context) => async args => {
      void recordOp(context.commandName ?? 'Unknown')
      return next(args)
    },
    { step: 'deserialize', name: 'r2UsageCounter', override: true }
  )
}
