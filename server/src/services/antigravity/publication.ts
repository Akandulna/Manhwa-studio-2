/**
 * AntiGravity ⇄ phones through Sleeper-Cell's own shared-page protocol (operator
 * decision 2026-11-07, replacing PRD §14.2's separate namespace):
 *
 *   <root>shared/crops/<Series>/<Chapter>/<page stem>.page.json   (sleeper-cell-shared-page/1)
 *
 * This is the folder where every phone already publishes the pages it finishes
 * (SharedCrops.kt) and from which every phone takes pages others finished, so
 * an AntiGravity page arrives on a phone exactly like a page another phone did:
 * it counts as done there and Auto-run doesn't pick it again. In the other
 * direction, Fetch reads the pages phones finished and imports their geometry
 * pointers into Image Clipper, so they show as done in AntiGravity.
 *
 * What makes the page done on a phone (PageSections.status): chatgpt-handoff.json
 * (handoff/1.0, signed with the phone's checksum), source-manifest.json (bytes +
 * sha256), export-report.json (stage geometry, destination, files, pointer_sha256)
 * and the pointer file in output. Studio still treats the result as a candidate:
 * human review, Crop Sections and Metadata stay manual on the desktop.
 *
 * Safety: a page.json a phone already published is never overwritten (that
 * phone's finished work wins); Studio only replaces its own earlier publication
 * (If-Match). Revisions (series restart, page replacement) are the desktop's
 * current ones, which phones check before taking a page.
 *
 * R2 cost: publish = 1 GET + 1 PUT + 1 GET (read-back) per page. Fetch = 1 LIST
 * per series (paginated) + 1 GET per page.json whose ETag changed since the last
 * fetch. Never on a timer.
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { readPageRedo } from '../clipper3/pageRedo.js'
import { getSourceFolderPath } from '../clipper3/perImageStore.js'
import { importPointerFile } from './delivery.js'
import { stringify, type WritableJson } from './review/json.js'

export const SHARED_PAGE_SCHEMA = 'sleeper-cell-shared-page/1'
export const SHARED_CROPS_FOLDER = 'shared/crops/'
const HANDOFF_SCHEMA = 'handoff/1.0'

const sha256 = (data: Buffer | string) => crypto.createHash('sha256').update(data).digest('hex')

// ─── Transport ───

export interface ExchangeObject {
  body: Buffer
  etag: string
}

export type WriteCondition = { ifMatch: string } | { ifNoneMatch: '*' }

export interface ExchangeTransport {
  bucket: string
  /** Normalized shared exchange root, the prefix the phones use ("Manhwa/" or ""). */
  root: string
  get(key: string): Promise<ExchangeObject | null>
  /** Conditional write; throws ConditionFailed when the condition does not hold. */
  put(key: string, body: Buffer, condition: WriteCondition): Promise<string>
  /** Every object under a prefix (paginated by the implementation). */
  list(prefix: string): Promise<{ key: string; etag: string }[]>
  close(): void
}

export class ConditionFailed extends Error {
  constructor(key: string) { super(`R2 object changed concurrently: ${key}`) }
}

export function destinationOf(t: Pick<ExchangeTransport, 'bucket' | 'root'>) {
  return `r2:${t.bucket}/${t.root}`
}

// ─── Phone naming (PageSections, PageExport, PhoneShare) ───

/** PhoneShare.isFileName */
export const isPhoneFileName = (name: string) => name.length > 0 && !name.includes('/') && !name.includes('\\') && !name.startsWith('.')

/** Kotlin File.nameWithoutExtension */
export const phoneStem = (filename: string) => (filename.lastIndexOf('.') > 0 ? filename.slice(0, filename.lastIndexOf('.')) : filename)

/** HandoffFormat.chapterToken: "21" → "021", "10.5" → "010.5" */
export function chapterToken(chapterNumber: string): string {
  const whole = chapterNumber.split('.')[0]
  const fraction = chapterNumber.includes('.') ? chapterNumber.slice(chapterNumber.indexOf('.') + 1) : ''
  return whole.padStart(3, '0') + (fraction ? `.${fraction}` : '')
}

/** PageExport.processedNames */
export function processedNames(chapterNumber: string, stem: string) {
  const match = /(\d+)(?!.*\d)/.exec(stem)
  const page = match ? Number(match[1]) : null
  const pageToken = page !== null ? String(page).padStart(3, '0') : stem
  const suffix = `ch${chapterToken(chapterNumber)}-p${pageToken}`
  return { pageFolder: page !== null ? `page_${pageToken}` : stem, pointers: `crop-pointers-${suffix}.json` }
}

/** HandoffFormat.seriesSlug */
export const seriesSlug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'series'

/** HandoffFormat.jobIdFor */
export function phoneJobId(slug: string, chapterNumber: string, stem: string, sourceSha: string) {
  const safe = (v: string) => v.toLowerCase().replace(/[^a-z0-9._]+/g, '-').replace(/^-+|-+$/g, '')
  return [safe(slug), `ch${chapterToken(chapterNumber)}`, safe(stem), sourceSha.slice(0, 12)].join('-')
}

/** Kotlin's Json.number for a chapter number: 21 → "21", 10.5 → "10.5". */
export const chapterNumberText = (n: number) => (Number.isInteger(n) ? String(n) : String(n))

export function sharedPageKey(root: string, seriesFolder: string, chapterFolder: string, filename: string) {
  const stem = phoneStem(filename)
  for (const segment of [seriesFolder, chapterFolder, stem]) if (!isPhoneFileName(segment)) throw new Error(`"${segment}" is not a safe shared-page name.`)
  return `${root}${SHARED_CROPS_FOLDER}${seriesFolder}/${chapterFolder}/${stem}.page.json`
}

// ─── Building the phone's page package ───

export interface StudioHandoffSlice { id: string; file: string; x0: number; y0: number; x1: number; y1: number; width: number; height: number; sha256: string }

/** HandoffFormat.manifest(signed) with manifest_sha256 = sha256(Json.stringify(unsigned manifest)). */
export function phoneHandoff(input: {
  jobId: string; createdAt: string; seriesTitle: string; chapterFolder: string; chapterNumber: number; stem: string
  filename: string; sha256: string; width: number; height: number; format: string; sliceHeight: number; slices: StudioHandoffSlice[]
}): { text: string; manifestSha256: string } {
  const unsigned: { [key: string]: WritableJson } = {
    schema_version: HANDOFF_SCHEMA,
    job_id: input.jobId,
    created_at: input.createdAt,
    source: {
      series_title: input.seriesTitle,
      series_slug: seriesSlug(input.seriesTitle),
      chapter_folder: input.chapterFolder,
      chapter_number: input.chapterNumber,
      page_stem: input.stem,
      original_filename: input.filename,
      sha256: input.sha256,
      width: input.width,
      height: input.height,
      format: input.format,
      orientation: 'stored_pixels'
    },
    coordinate_system: 'canonical_original_pixels',
    slicing: { mode: 'full_width_fixed_height', slice_height: input.sliceHeight, encoding: 'webp_lossless' },
    slices: input.slices.map(s => ({ id: s.id, file: s.file, x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1, width: s.width, height: s.height, sha256: s.sha256 })),
    verification: { tiling: 'exact', pixels: 'identical', verified_at: input.createdAt }
  }
  const manifestSha256 = sha256(stringify(unsigned))
  return { text: stringify({ ...unsigned, manifest_sha256: manifestSha256 }), manifestSha256 }
}

export interface SharedPageInput {
  seriesFolder: string
  seriesTitle: string
  chapterFolder: string
  chapterNumber: number
  filename: string
  sourceSha256: string
  sourceBytes: number
  width: number
  height: number
  format: string
  restartRevision: string | null
  pageRevision: string | null
  /** The Studio page rejection this result replaces (pointerText carries the same value), else null. */
  studioRedoRevision?: string | null
  /** The time the page counts as exported (stable across retries). */
  exportedAt: string
  studioDeviceId: string
  handoffCreatedAt: string
  sliceHeight: number
  slices: StudioHandoffSlice[]
  pointerText: string
  reviewStateJson: string | null
  reviewRevision: number
  cropCount: number
  requestedModel: string
  promptText: string | null
  provenance: Record<string, unknown>
}

/** The sleeper-cell-shared-page/1 bundle (SharedCrops.bundle) for one AntiGravity page. */
export function buildSharedPage(p: SharedPageInput): { text: string; pointerSha256: string } {
  const stem = phoneStem(p.filename)
  const chapterNumber = chapterNumberText(p.chapterNumber)
  const names = processedNames(chapterNumber, stem)
  const handoff = phoneHandoff({
    jobId: phoneJobId(seriesSlug(p.seriesTitle), chapterNumber, stem, p.sourceSha256), createdAt: p.handoffCreatedAt, seriesTitle: p.seriesTitle,
    chapterFolder: p.chapterFolder, chapterNumber: p.chapterNumber, stem, filename: p.filename, sha256: p.sourceSha256, width: p.width, height: p.height,
    format: p.format, sliceHeight: p.sliceHeight, slices: p.slices
  })
  const pointerSha256 = sha256(p.pointerText)
  const report = {
    schema_version: 'crop-studio-export/2', stage: 'geometry', status: 'completed', origin: 'antigravity',
    exported_at: p.exportedAt, source_sha256: p.sourceSha256, source_width: p.width, source_height: p.height,
    review_revision: p.reviewRevision, crop_count: p.cropCount, destination: `${p.seriesFolder}/${p.chapterFolder}/${names.pageFolder}`,
    files: [names.pointers], pointer_sha256: pointerSha256, original_filename: p.filename,
    job_id: phoneJobId(seriesSlug(p.seriesTitle), chapterNumber, stem, p.sourceSha256),
    made_by: { run: 'antigravity', account: 'Manhwa Studio', models: [`AntiGravity / ${p.requestedModel}`] }
  }
  // SharedCrops sorts the working files by name.
  const working: Record<string, string> = {
    'antigravity-result.json': JSON.stringify(p.provenance, null, 2) + '\n',
    'chatgpt-handoff.json': handoff.text,
    'export-report.json': JSON.stringify(report, null, 2),
    'geometry-workflow.json': JSON.stringify({ schema: 'clipper-geometry-workflow/1', sourceSha256: p.sourceSha256 }),
    ...(p.promptText ? { 'prompt.txt': p.promptText } : {}),
    ...(p.reviewStateJson ? { 'review-state.json': p.reviewStateJson } : {}),
    'source-manifest.json': JSON.stringify({ page: { bytes: p.sourceBytes, sha256: p.sourceSha256 } })
  }
  const sorted = Object.fromEntries(Object.keys(working).sort().map(k => [k, working[k]]))
  const bundle = {
    schema: SHARED_PAGE_SCHEMA,
    series: p.seriesFolder,
    restartRevision: p.restartRevision,
    chapter: p.chapterFolder,
    pageRevision: p.pageRevision,
    page: p.filename,
    stem,
    studioRedoRevision: p.studioRedoRevision ?? null,
    exportedAt: p.exportedAt,
    sourceSha256: p.sourceSha256,
    sourceBytes: p.sourceBytes,
    device: 'Manhwa Studio (AntiGravity)',
    deviceId: p.studioDeviceId,
    sharedAt: p.exportedAt,
    working: sorted,
    output: { folder: names.pageFolder, files: { [names.pointers]: p.pointerText } }
  }
  return { text: JSON.stringify(bundle), pointerSha256 }
}

/** The geometry pointer a phone's shared page carries, if any (for Studio collection). */
export function pointerFromSharedPage(bundle: any, expect: { series: string; chapter: string; filename: string }):
  | { ok: true; pointerText: string; exportedAt: string; deviceId: string; restartRevision: string | null; pageRevision: string | null; sourceSha256: string; studioRedoRevision: string | null }
  | { ok: false; reason: string } {
  if (bundle?.schema !== SHARED_PAGE_SCHEMA) return { ok: false, reason: 'not a shared page' }
  if (bundle.series !== expect.series || bundle.chapter !== expect.chapter || bundle.page !== expect.filename || bundle.stem !== phoneStem(expect.filename)) return { ok: false, reason: 'names do not match' }
  let report: any
  try { report = JSON.parse(bundle.working?.['export-report.json'] ?? 'null') } catch { return { ok: false, reason: 'unreadable export report' } }
  if (report?.stage !== 'geometry') return { ok: false, reason: 'not a geometry export (Sync json handles legacy pages)' }
  const name = Array.isArray(report.files) ? String(report.files[0] ?? '') : ''
  const pointerText = bundle.output?.files?.[name]
  if (typeof pointerText !== 'string') return { ok: false, reason: 'pointer file missing' }
  if (sha256(pointerText) !== report.pointer_sha256) return { ok: false, reason: 'pointer hash mismatch' }
  if (report.source_sha256 !== bundle.sourceSha256) return { ok: false, reason: 'source hash mismatch' }
  const nonBlank = (v: unknown) => (typeof v === 'string' && v && v !== 'null' ? v : null)
  return { ok: true, pointerText, exportedAt: String(bundle.exportedAt ?? ''), deviceId: String(bundle.deviceId ?? ''), restartRevision: nonBlank(bundle.restartRevision), pageRevision: nonBlank(bundle.pageRevision), sourceSha256: String(bundle.sourceSha256), studioRedoRevision: nonBlank(bundle.studioRedoRevision) }
}

// ─── Publisher / collector ───

export interface LibraryRevisions {
  /** Desktop's current series-restart revision (null = none) and whether it is still synchronizing. */
  restart: (seriesFolder: string) => Promise<{ revision: string | null; pending: boolean }>
  /** Desktop's current page-replacement revision for a chapter (null = none). */
  pageRevision: (folderPath: string) => Promise<string | null>
}

export interface PublisherDeps {
  prisma: PrismaClient
  open: () => Promise<ExchangeTransport | null>
  installationId: () => Promise<string>
  revisions: LibraryRevisions
  /** Rendered analysis prompt for the page (provenance in prompt.txt), or null. */
  promptFor?: (jobId: string) => Promise<string | null>
  /** ETags of phone pages already read by Fetch, per series (avoids re-GET). */
  seen: { read: (seriesId: string) => Promise<Record<string, string>>; write: (seriesId: string, map: Record<string, string>) => Promise<void> }
}

export type PublishOutcome =
  | { state: 'published'; key: string; destination: string }
  | { state: 'phone_has_page'; key: string; destination: string; device: string }

export type FetchOutcome = { listed: number; read: number; imported: number; already: number; ours: number; conflicts: number; stale: number; skipped: number; rejected: number; errors: string[] }

export class AntigravityPublisher {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: PublisherDeps) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => undefined)
    return next
  }

  publish(jobId: string) { return this.serial(() => this.publishNow(jobId)) }

  private async publishNow(jobId: string): Promise<PublishOutcome> {
    const { prisma } = this.deps
    const job = await prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
    if (!job.resultJson || !job.resultSha256 || !job.currentAttemptId || !job.manifestJson) throw new Error('No validated result to publish.')
    if (job.importState !== 'imported') throw new Error('Only results imported into Clipper are published.')
    if (sha256(job.resultJson) !== job.resultSha256) throw new Error('The saved result does not match its recorded hash.')
    const attempt = await prisma.antigravityAttempt.findUniqueOrThrow({ where: { id: job.currentAttemptId } })
    const run = await prisma.antigravityRun.findUniqueOrThrow({ where: { id: job.runId } })
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: job.chapterId }, select: { id: true, number: true, folderPath: true, series: { select: { id: true, title: true, rootFolder: true } } } })
    const seriesFolder = path.basename(chapter.series.rootFolder)
    const chapterFolder = path.basename(chapter.folderPath)
    const restart = await this.deps.revisions.restart(seriesFolder)
    if (restart.pending) throw new Error('A series restart is still synchronizing; publish after Library finishes.')
    const pageRevision = await this.deps.revisions.pageRevision(chapter.folderPath)
    const sourcePath = path.join(getSourceFolderPath(chapter.folderPath), job.filename)
    const bytes = await fs.readFile(sourcePath)
    if (sha256(bytes) !== job.sourceSha256) throw new Error('The source page changed since this result was made.')

    const t = await this.deps.open()
    if (!t) throw new Error('Cloudflare R2 is not set up (Settings → Cloudflare).')
    try {
      const destination = destinationOf(t)
      const key = sharedPageKey(t.root, seriesFolder, chapterFolder, job.filename)
      const delivery = await prisma.antigravityDelivery.upsert({
        where: { resultSha256_destination: { resultSha256: job.resultSha256, destination } },
        create: {
          jobId, attemptId: attempt.id, seriesId: chapter.series.id, chapterId: chapter.id, filename: job.filename, sourceSha256: job.sourceSha256,
          resultSha256: job.resultSha256, resultBytes: Buffer.byteLength(job.resultJson), destination, pointerKey: key, envelopeKey: key,
          indexKey: `${t.root}${SHARED_CROPS_FOLDER}${seriesFolder}/${chapterFolder}/`, state: 'pending', tries: 1
        },
        update: { tries: { increment: 1 }, error: null }
      })
      try {
        const studioDeviceId = await this.deps.installationId()
        const handoff = JSON.parse(job.manifestJson)
        const pointer = JSON.parse(job.resultJson)
        const prompts = JSON.parse(run.promptJson)
        const exportedAt = delivery.createdAt.toISOString()
        const page = buildSharedPage({
          seriesFolder, seriesTitle: chapter.series.title, chapterFolder, chapterNumber: chapter.number, filename: job.filename,
          sourceSha256: job.sourceSha256, sourceBytes: bytes.length, width: job.width, height: job.height,
          format: String(handoff?.source?.format ?? path.extname(job.filename).slice(1).toLowerCase()),
          restartRevision: restart.revision, pageRevision, exportedAt, studioDeviceId,
          studioRedoRevision: typeof pointer.studioRedoRevision === 'string' ? pointer.studioRedoRevision : null,
          handoffCreatedAt: String(handoff?.createdAt ?? job.createdAt.toISOString()),
          sliceHeight: Number(handoff?.slicing?.sliceHeight ?? 2000),
          slices: (handoff?.slicing?.slices ?? []).map((s: any) => ({ id: s.id, file: s.file, x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1, width: s.width, height: s.height, sha256: s.sha256 })),
          pointerText: job.resultJson, reviewStateJson: attempt.reviewStateJson, reviewRevision: attempt.reviewRounds,
          cropCount: Array.isArray(pointer.crops) ? pointer.crops.length : 0, requestedModel: attempt.requestedModel,
          promptText: (await this.deps.promptFor?.(jobId)) ?? null,
          provenance: {
            schema: 'studio-antigravity-crop-result/1', approval: 'candidate_only', studio: studioDeviceId,
            run: { runId: run.id, jobId, attemptId: attempt.id, conversationId: attempt.conversationId },
            provider: { name: 'antigravity-cli', cliVersion: attempt.cliVersion, requestedModel: attempt.requestedModel, observedModel: attempt.observedModel, effort: run.effort },
            prompts, aiReview: { analysisSha256: attempt.analysisSha256, rounds: attempt.reviewRounds },
            result: { sha256: job.resultSha256 }
          }
        })
        const body = Buffer.from(page.text)
        const existing = await t.get(key)
        if (existing) {
          const current = (() => { try { return JSON.parse(existing.body.toString('utf8')) } catch { return null } })()
          // A phone's page made before this page was rejected is void; one made for the same rejection wins.
          const voided = typeof pointer.studioRedoRevision === 'string' && current?.studioRedoRevision !== pointer.studioRedoRevision
          if (current?.deviceId !== studioDeviceId && !voided) {
            // A phone already finished and shared this page: its work wins.
            await prisma.antigravityDelivery.update({ where: { id: delivery.id }, data: { state: 'phone_has_page', error: `${current?.device ?? 'A phone'} already shared this page.` } })
            return { state: 'phone_has_page', key, destination, device: String(current?.device ?? 'a phone') }
          }
        }
        if (!existing || sha256(existing.body) !== sha256(body)) {
          try {
            await t.put(key, body, existing ? { ifMatch: existing.etag } : { ifNoneMatch: '*' })
          } catch (error) {
            if (error instanceof ConditionFailed) throw new Error('This page was shared by a phone at the same moment; fetch, then publish again.')
            throw error
          }
        }
        const back = await t.get(key)
        if (!back || sha256(back.body) !== sha256(body)) throw new Error('Read-back of the shared page does not match what was written.')
        await prisma.antigravityDelivery.update({ where: { id: delivery.id }, data: { state: 'published', envelopeSha256: sha256(body), publishedAt: delivery.publishedAt ?? new Date(), error: null } })
        return { state: 'published', key, destination }
      } catch (error) {
        await prisma.antigravityDelivery.update({ where: { id: delivery.id }, data: { state: 'failed', error: error instanceof Error ? error.message.slice(0, 500) : 'Unknown error' } })
        throw error
      }
    } finally {
      t.close()
    }
  }

  /**
   * Studio collection: read the shared pages phones finished (and our own, for a
   * library that didn't run the job) for chapters in scope, and import geometry
   * pointers that are missing here. Saved pointers are never replaced.
   */
  fetch(scope: { seriesId: string; chapterIds?: string[] }) { return this.serial(() => this.fetchNow(scope)) }

  private async fetchNow(scope: { seriesId: string; chapterIds?: string[] }): Promise<FetchOutcome> {
    const { prisma } = this.deps
    const series = await prisma.series.findUniqueOrThrow({ where: { id: scope.seriesId }, select: { id: true, rootFolder: true } })
    const chapters = await prisma.chapter.findMany({
      where: { seriesId: scope.seriesId, ...(scope.chapterIds?.length ? { id: { in: scope.chapterIds } } : {}) },
      select: { id: true, folderPath: true }
    })
    if (scope.chapterIds?.length && chapters.length !== new Set(scope.chapterIds).size) throw new Error('A chapter is outside this series.')
    const seriesFolder = path.basename(series.rootFolder)
    const byFolder = new Map(chapters.map(c => [path.basename(c.folderPath), c]))
    const t = await this.deps.open()
    if (!t) throw new Error('Cloudflare R2 is not set up (Settings → Cloudflare).')
    const out: FetchOutcome = { listed: 0, read: 0, imported: 0, already: 0, ours: 0, conflicts: 0, stale: 0, skipped: 0, rejected: 0, errors: [] }
    try {
      const restart = await this.deps.revisions.restart(seriesFolder)
      const base = `${t.root}${SHARED_CROPS_FOLDER}${seriesFolder}/`
      const seen = await this.deps.seen.read(series.id)
      const studioDeviceId = await this.deps.installationId()
      for (const object of await t.list(base)) {
        const parts = object.key.slice(base.length).split('/')
        if (parts.length !== 2 || !parts[1].endsWith('.page.json')) continue
        const chapter = byFolder.get(parts[0])
        if (!chapter) continue
        out.listed++
        if (seen[object.key] === object.etag) continue
        const got = await t.get(object.key)
        if (!got) continue
        out.read++
        let bundle: any
        try { bundle = JSON.parse(got.body.toString('utf8')) } catch { out.errors.push(`${parts[1]}: unreadable`); continue }
        const filename = typeof bundle?.page === 'string' ? bundle.page : ''
        const parsed = filename && isPhoneFileName(filename) ? pointerFromSharedPage(bundle, { series: seriesFolder, chapter: parts[0], filename }) : { ok: false as const, reason: 'no page name' }
        seen[object.key] = got.etag
        if (!parsed.ok) { out.skipped++; continue }
        if (parsed.deviceId === studioDeviceId) out.ours++
        if (parsed.restartRevision !== restart.revision || parsed.pageRevision !== await this.deps.revisions.pageRevision(chapter.folderPath)) { out.stale++; continue }
        let pointer: any
        try { pointer = JSON.parse(parsed.pointerText) } catch { out.errors.push(`${filename}: unreadable pointer`); continue }
        if (pointer?.workflow !== 'clipper-geometry/1' || pointer?.sourceSha256 !== parsed.sourceSha256 || pointer?.image?.filename !== filename) { out.skipped++; continue }
        // A page rejected here only takes a result made for that rejection (as phones do), never the rejected one again.
        const redo = await readPageRedo(chapter.folderPath, filename)
        if (redo?.status === 'pending' && (parsed.studioRedoRevision !== redo.revision || pointer.studioRedoRevision !== redo.revision)) { out.rejected++; continue }
        const result = await importPointerFile({ folderPath: chapter.folderPath, filename, pointer, preexisting: 'none' })
        if (result.state === 'imported') out.imported++
        else if (result.state === 'already_imported') out.already++
        else if (result.state === 'conflict') out.conflicts++
        else out.stale++
      }
      await this.deps.seen.write(series.id, seen)
      return out
    } finally {
      t.close()
    }
  }
}

// ─── Real transport (Cloudflare R2 through the existing client) ───

export async function openR2Exchange(): Promise<ExchangeTransport | null> {
  const { createClient, getR2Config, isNotFound } = await import('../r2Service.js')
  const { phoneZipFolder } = await import('../phoneSend.js')
  const { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } = await import('@aws-sdk/client-s3')
  const config = getR2Config()
  if (!config) return null
  const client = createClient(config)
  try {
    // Same resolution as librarySync: the prefix the phones report (…manhwa/ minus "manhwa/").
    const root = (await phoneZipFolder(client, config)).slice(0, -'manhwa/'.length)
    return {
      bucket: config.bucket,
      root,
      async get(key) {
        const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key })).catch(error => { if (isNotFound(error)) return null; throw error })
        if (!response?.Body) return null
        return { body: Buffer.from(await response.Body.transformToByteArray()), etag: (response.ETag ?? '').replace(/"/g, '') }
      },
      async put(key, body, condition) {
        try {
          const response = await client.send(new PutObjectCommand({
            Bucket: config.bucket, Key: key, Body: body, ContentType: 'application/json',
            ...('ifMatch' in condition ? { IfMatch: `"${condition.ifMatch}"` } : { IfNoneMatch: '*' })
          }))
          return response.ETag ?? ''
        } catch (error: any) {
          const status = error?.$metadata?.httpStatusCode
          if (status === 412 || status === 409 || error?.name === 'PreconditionFailed') throw new ConditionFailed(key)
          throw error
        }
      },
      async list(prefix) {
        const items: { key: string; etag: string }[] = []
        let token: string | undefined
        do {
          const page = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix, ContinuationToken: token }))
          for (const item of page.Contents ?? []) if (item.Key) items.push({ key: item.Key, etag: (item.ETag ?? '').replace(/"/g, '') })
          token = page.IsTruncated ? page.NextContinuationToken : undefined
        } while (token)
        return items
      },
      close: () => client.destroy()
    }
  } catch (error) {
    client.destroy()
    throw error
  }
}
