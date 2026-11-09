/**
 * AntiGravity runs, page jobs and attempts (docs/PRD-antigravity-studio.md §9, §10, §13).
 *
 * One page job = one original page + source generation + pinned profile.
 * One attempt = one isolated workspace, one Antigravity conversation and one
 * MCP capability token. The pipeline is:
 *   preparing → uploading → prepared → queued → analyzing → reviewing
 *   → validating → delivering → ready_for_human_review
 * Every transition is persisted before the next stage starts. Results are only
 * ever accepted through Studio's MCP tools (never from the CLI's exit code or
 * its final sentence), checked against the attempt's stage, its delivered
 * slices, the conversation ID and the current source hash.
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PrismaClient } from '@prisma/client'
import type { Server } from 'socket.io'
import { getChapterManifest } from '../chapterManifest.js'
import { managedCropBinding } from '../managedCropProjection.js'
import { readPageRedo } from '../clipper3/pageRedo.js'
import { getOutputDir, getSourceFolderPath, readImageMetadata, readImagePoints } from '../clipper3/perImageStore.js'
import { currentMetadataJobs, importMetadataResult, metadataGenerations, validateMetadataResult } from '../clipper3/metadataSplit.js'
import sharp from 'sharp'
import type { GoogleDriveService } from '../googleDrive/service.js'
import { driveErrorMessage } from '../googleDrive/errors.js'
import { execFileSync } from 'node:child_process'
import { processAlive, runTurn, type AgyTurnResult } from './cli.js'
import { runCodexTurn } from './codexCli.js'
import { describeSession, readSessionEvidence } from './codexSession.js'
import { limitResetFrom, type CodexAccountRef, type CodexAccountStore } from './codexAccounts.js'
import { ENGINE_LABELS, type AiEngine } from './settingsModel.js'
import { MCP_SERVER_NAME, jobSettings } from './compatibility.js'
import { buildPointerFile, compareWithSaved, importPointerFile, pointerFingerprint } from './delivery.js'
import { ensurePageFolders, uploadPackage } from './drivePackage.js'
import * as engine from './engine.js'
import * as stepsFlow from './stepsFlow.js'
import { label as stepLabel, overBudget as stepsOverBudget, parseSteps, resetBudget as stepsResetBudget, start as stepsStart, toJson as stepsToJson } from './review/steps.js'
import type { LumaPage } from './review/types.js'
import { ANTIGRAVITY_MAX_WIDTH, buildHandoff, preparePage, PreparationError, sha256, stemOfFile } from './preparation.js'
import type { PromptPack } from './prompts.js'
import type { AntigravityPublisher } from './publication.js'
import { describeToolUse, readImagesViewed, readToolUse, unopenedImages } from './toolUse.js'
import * as metadataFlow from './metadataFlow.js'
import * as editorFlow from './editorFlow.js'
import type { NarrationLanguage } from '../narrationLanguage.js'

export const JOB_MCP_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'resources', 'antigravity', 'job-mcp.mjs')
export const ATTEMPT_ROOT = path.join(os.homedir(), 'Library', 'Application Support', 'Manhwa Studio', 'antigravity', 'attempts')

export const TERMINAL_STAGES = new Set(['ready_for_human_review', 'done', 'skipped_existing', 'needs_attention', 'failed', 'cancelled', 'stale', 'interrupted', 'publish_failed', 'rejected'])
const ACTIVE_STAGES = new Set(['preparing', 'uploading', 'queued', 'analyzing', 'describing', 'planning', 'reviewing', 'validating', 'delivering', 'publishing'])
/** Stages a person can retry; publish_failed retries only the R2 publication. */
export const RETRYABLE_STAGES = new Set(['failed', 'needs_attention', 'interrupted', 'cancelled', 'publish_failed', 'rejected'])
/** A finished result the operator can still reject (it is in Clipper, before human review). */
export const REJECTABLE_STAGES = new Set(['ready_for_human_review', 'publish_failed'])
/** Correction turns allowed after the first review round (PRD §1.2). */
export const REVIEW_CORRECTION_BUDGET = 2
/** Same-conversation follow-ups per stage when a turn ends without a submission. */
export const CONTINUATION_BUDGET = 2
/** Invalid submissions tolerated within one turn before the turn is abandoned. */
const MAX_SUBMISSIONS_PER_STAGE = 4

/**
 * What a process does: Image Clipper (crop pointers), Metadata (descriptions + English-script links of approved
 * crops) or Timeline (a chapter's Editor 2.0 timeline JSON per language; editorFlow.ts).
 */
export type JobKind = 'clipper' | 'metadata' | 'editor'
export const KIND_LABELS: Record<JobKind, string> = { clipper: 'Image Clipper', metadata: 'Metadata', editor: 'Timeline' }
export const kindOf = (value: string | null | undefined): JobKind => (value === 'metadata' || value === 'editor' ? value : 'clipper')
/** "A Metadata process", "An Image Clipper process", "A Timeline process". */
const aKind = (kind: JobKind) => `${kind === 'clipper' ? 'An' : 'A'} ${KIND_LABELS[kind]}`
/** Studio writes this beside a chapter's sources after a complete cut (clipper3/metadataSplit.ts CUT_RECEIPT). */
const CUT_RECEIPT = '.metadata-cut-receipt.json'
/** Crops are handed to the model at most this big; agy scales images to ≤2000 px anyway. */
const METADATA_IMAGE_MAX = 2000
/** agy models without image input (LocalAntigravityCard TEXT_ONLY). */
const TEXT_ONLY_MODEL = /^gpt-oss/i

export interface RunSettings {
  /** antigravity = agy; codex = ChatGPT through the Codex CLI. */
  engine: AiEngine
  model: string
  modelLabel: string | null
  effort: string | null
  sandbox: boolean
  concurrency: number
  pageTimeoutMinutes: number
  executable: string
  cliVersion: string | null
}

export interface StartRequest {
  seriesId: string
  partNumber: number
  pages: { chapterId: string; filename: string }[]
  /** Slice + upload only; never starts an AI turn. */
  prepareOnly: boolean
  /** Image Clipper (default), Metadata or Timeline. */
  kind?: JobKind
  /** Timeline: the method and languages (pinned to the run). */
  editor?: editorFlow.EditorRunOptions
}

export interface JobsDeps {
  prisma: PrismaClient
  drive: GoogleDriveService
  io?: Server
  /** Studio's API port, for the loopback bridge URL. */
  port: number
  /** Settings for this engine (default: the engine selected for new runs). */
  settings: (engine?: AiEngine) => Promise<RunSettings>
  prompts: () => Promise<PromptPack>
  onPointersChanged?: () => void
  /** R2 publication (Phase 5); absent in tests that only cover the local pipeline. */
  publisher?: AntigravityPublisher
  /** Best-effort "check R2 now" to phones, once per finished run that published something. */
  notifyPhones?: (seriesId: string) => Promise<void>
  /** The run's pinned prompt versions by id (falls back to the current pack). */
  pinnedPrompts?: (ids: Record<string, string>) => Promise<PromptPack | null>
  /** True while a page replacement or series restart is rewriting this chapter's sources. */
  sourceBusy?: (folderPath: string) => Promise<boolean>
  /**
   * Clipper's explicit page rejection (services/clipper3/pageRedo.ts rejectPage + publishPageRedo):
   * backs up and removes the page's pointers and tells phones the old result is void.
   */
  rejectSource?: (page: { chapterId: string; folderPath: string; filename: string }) => Promise<{ revision: string; deliveryError?: string }>
  /** Where attempt workspaces go (tests use a temp dir). */
  attemptRoot?: string
  /** The Antigravity CLI's home, for reading conversation transcripts (tool-use record). */
  cliHome?: string
  /** Codex's home (CODEX_HOME), for reading its session records (tool-use record, model, usage). */
  codexHome?: string
  /**
   * Several ChatGPT accounts for the Codex engine (codexAccounts.ts). Each page runs on one account;
   * when an account reaches its Codex limit, new pages move to the next one. Absent = the Mac's ~/.codex only.
   */
  codexAccounts?: Pick<CodexAccountStore, 'pick' | 'get' | 'autoSwitch' | 'recordEvidence' | 'markLimited'>
  /** Editor 2.0's inputs, small-batches session, processor and save (Timeline kind); absent = no Timeline. */
  editor?: editorFlow.EditorDeps
}

/** What one attempt's turns run with. */
interface TurnContext {
  jobId: string
  attemptId: string
  workspace: string
  signal: AbortSignal
  model: string
  deadline: number
  /** Codex: the account's CODEX_HOME (its ChatGPT sign-in and thread records). */
  codexHome?: string | null
}

interface Live {
  controller: AbortController
  runId: string
  /** prep = slicing + Drive transfer pool; ai = Antigravity conversation pool. */
  kind: 'prep' | 'ai'
}

/** Drive preparation runs in its own bounded pool, apart from AI slots (PRD §13.3). */
export const PREP_SLOTS = 2
/** Hard ceiling for AI slots across all runs on this Mac (PRD §13.3: 1–4). */
export const MAX_AI_SLOTS = 4
/** Stages where a page owns a live Antigravity conversation. */
const AI_STAGES = new Set(['analyzing', 'describing', 'planning', 'reviewing', 'validating', 'delivering', 'publishing'])

/** Account/model failures that should pause the whole run (PRD §17), from agy's envelope and stderr. */
export function classifyProviderFailure(result: AgyTurnResult): 'quota' | 'auth' | 'model' | null {
  if (result.cancelled || result.timedOut) return null
  const env = result.envelope
  if (env?.status === 'SUCCESS' && (env.denied_actions?.length ?? 0) === 0) return null
  const text = `${env?.error ?? ''} ${env?.status ?? ''} ${result.stderrTail ?? ''}`.toLowerCase()
  if (/quota|rate.?limit|resource.?exhausted|too many requests|\b429\b|usage limit/.test(text)) return 'quota'
  if (/not (signed|logged) in|sign in to|log ?in required|unauthenticated|\b401\b|re-?authenticate/.test(text)) return 'auth'
  if (/model/.test(text) && /(not found|unknown|unavailable|unsupported|not available|invalid)/.test(text)) return 'model'
  return null
}

/** Same grouping as client/src/lib/clipperParts.ts (20 chapters per part). */
export const CLIPPER_PART_SIZE = 20
export const clipperPartNumber = (chapterNumber: number) => Math.max(1, Math.ceil(chapterNumber / CLIPPER_PART_SIZE))

/** Is [pid] still an agy or codex process (pids are reused)? */
function isStudioCliProcess(pid: number): boolean {
  try { return /(^|\/)(agy|codex)(\s|$)/.test(execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim()) } catch { return false }
}

const engineOf = (value: string | null | undefined): AiEngine => (value === 'codex' ? 'codex' : 'antigravity')
const label = (engine: AiEngine) => ENGINE_LABELS[engine]

/** Run controls that hold the single process slot (one process at a time, one engine at a time). */
export const LIVE_CONTROLS = new Set(['running', 'preparing', 'pause_requested', 'paused', 'stop_requested'])
/** selectionJson of a Start-process run: it takes the next pending page of its part instead of a fixed list. */
export const NEXT_MODE = JSON.stringify({ mode: 'next' })
/** A page whose last job ended in one of these waits for the operator (Retry / Review again); Start skips it. */
export const WAITS_FOR_OPERATOR = new Set(['failed', 'needs_attention', 'stale', 'publish_failed'])

type RunRow = Awaited<ReturnType<PrismaClient['antigravityRun']['findUniqueOrThrow']>>
export const runMode = (run: { selectionJson: string }): 'next' | 'pages' => (run.selectionJson === NEXT_MODE ? 'next' : 'pages')

interface AcceptedPage { chapterId: string; filename: string; pageIndex: number; sourceSha256: string; width: number; height: number; folderPath: string; preexisting: string; manifestJson?: string }

/** A chapter's current Metadata jobs (page → job) and English script, or why it can't have Metadata yet. */
type MetadataChapterJobs = { jobs: Map<string, metadataFlow.MetadataJobEnvelope>; script: string } | { reason: string }
type ChapterRef = { id: string; number: number; folderPath: string; seriesId?: string; series: { id?: string; title: string } }

/** A job's pinned profile (part of its idempotency key). agy profiles keep their original shape so existing keys stay valid; Codex adds its engine. */
function profileOf(run: { engine: string; model: string; effort: string | null; sandbox: boolean; connectionId: string | null }, hashes: Record<string, string>) {
  return { ...(run.engine === 'codex' && { engine: 'codex' }), model: run.model, effort: run.effort, sandbox: run.sandbox, connection: run.connectionId ?? '', prompts: hashes }
}

const tokenHash = (token: string) => crypto.createHash('sha256').update(token).digest('hex')

export class AntigravityJobs {
  private readonly prisma: PrismaClient
  private readonly live = new Map<string, Live>() // jobId → live pipeline
  private readonly scheduling = new Set<string>() // runIds with an active scheduler loop
  private readonly publishedRuns = new Set<string>() // runIds that published to R2 since their last phone notification
  /** Start-process runs: chapter page lists read once per run, and pages already looked at or handed out. */
  private readonly scans = new Map<string, { manifests: Map<string, { filename: string; width: number; height: number }[]>; settled: Set<string>; emptyAt: number; meta: Map<string, MetadataChapterJobs> }>()
  /** Runs reopened for a retried page while nothing ran: they finish that page and don't go on through the part. */
  private readonly pickOff = new Set<string>()

  constructor(private readonly deps: JobsDeps) {
    this.prisma = deps.prisma
  }

  // ─── Events ───

  private async event(type: string, message: string, ids: { runId?: string | null; jobId?: string | null; attemptId?: string | null }) {
    await this.prisma.antigravityEvent.create({ data: { type, message: message.slice(0, 1000), runId: ids.runId ?? null, jobId: ids.jobId ?? null, attemptId: ids.attemptId ?? null } })
    this.deps.io?.emit('antigravity:progress', { type, runId: ids.runId ?? null, jobId: ids.jobId ?? null, at: new Date().toISOString() })
  }

  private async setStage(jobId: string, stage: string, extra: Record<string, unknown> = {}) {
    const job = await this.prisma.antigravityPageJob.update({ where: { id: jobId }, data: { stage, ...extra } })
    await this.event('stage', `${job.filename}: ${stage}${extra.lastError ? ` — ${extra.lastError}` : ''}`, { runId: job.runId, jobId })
    if (kindOf(job.kind) === 'editor') this.deps.editor?.claimsChanged?.()
    return job
  }

  // ─── Start ───

  async start(request: StartRequest) {
    const { prisma } = this
    if (!Number.isInteger(request.partNumber) || request.partNumber < 1) throw new Error('Invalid part.')
    if (!Array.isArray(request.pages) || request.pages.length === 0) throw new Error('Choose at least one page.')
    if (request.pages.length > 2000) throw new Error('Too many pages in one run.')
    const series = await prisma.series.findUnique({ where: { id: request.seriesId }, select: { id: true, title: true } })
    if (!series) throw new Error('Series not found.')
    const kind = request.kind ?? 'clipper'
    if (kind !== 'clipper' && request.prepareOnly) throw new Error(`${KIND_LABELS[kind]} has no Upload to Drive step.`)
    // One process at a time: selected pages join the live process of this part, or wait for another part's to end.
    const live = await this.liveRun()
    if (live) {
      if (live.seriesId !== series.id || live.partNumber !== request.partNumber || kindOf(live.kind) !== kind) throw new Error(await this.busyMessage(live))
      if (live.control === 'stop_requested') throw new Error('This part\'s process is stopping. Start again in a moment.')
      if (request.prepareOnly) throw new Error('A process is running on this part. Upload to Drive when it has finished, or add the pages to it with Start selected.')
      if (live.control === 'preparing') throw new Error('An Upload to Drive is still running on this part. Start the selected pages when it has finished.')
    }
    const settings = await this.deps.settings()
    const prompts = await this.deps.prompts()
    // Metadata reads the cut crops on this Mac and Timeline is text: no Drive upload.
    const connection = kind === 'clipper' ? await this.deps.drive.requireActiveConnection() : null
    // Timeline: ticked chapters joining a live process run with its pinned method.
    const editorOptions = kind === 'editor' ? (live ? editorFlow.optionsOf(live.promptJson) : editorFlow.normalizeOptions(request.editor)) : null

    const chapterIds = [...new Set(request.pages.map(p => p.chapterId))]
    const chapters = await prisma.chapter.findMany({ where: { id: { in: chapterIds } }, select: { id: true, seriesId: true, number: true, folderPath: true, series: { select: { title: true } } } })
    const metaCache = new Map<string, MetadataChapterJobs>()
    const byId = new Map(chapters.map(c => [c.id, c]))
    const skipped: { chapterId: string; filename: string; reason: string }[] = []
    const accepted: AcceptedPage[] = []

    for (const page of request.pages) {
      const chapter = byId.get(page.chapterId)
      // Scope: the route's series and part only.
      if (!chapter || chapter.seriesId !== series.id || clipperPartNumber(chapter.number) !== request.partNumber) {
        throw new Error('A selected chapter is outside this series and part.')
      }
      if (editorOptions) {
        const language = editorFlow.languageOfFilename(page.filename)
        if (!language) { skipped.push({ ...page, reason: 'Not a timeline of this chapter.' }); continue }
        const checked = await this.inspectEditor(chapter, language, editorOptions.method)
        if ('reason' in checked) skipped.push({ ...page, reason: checked.reason })
        else accepted.push(checked)
        continue
      }
      const manifest = await getChapterManifest(chapter.folderPath)
      const index = manifest.images.findIndex(img => img.filename === page.filename)
      if (index < 0) { skipped.push({ ...page, reason: 'Not in the chapter\'s page list.' }); continue }
      const checked = kind === 'metadata'
        ? await this.inspectMetadataPage(chapter, index, manifest.images[index], metaCache)
        : await this.inspectPage(chapter, index, manifest.images[index])
      if ('reason' in checked) skipped.push({ ...page, reason: checked.reason })
      else accepted.push(checked)
    }
    if (accepted.length === 0) return { runId: live?.id ?? null, created: [], reused: [], skipped }

    if (live) {
      // The live process keeps its pinned engine, model and prompts; the selected pages are queued in it
      // (ahead of the next pending pages it would take itself).
      const liveProfile = profileOf(live, JSON.parse(live.promptJson).hashes)
      const created: string[] = []
      const reused: string[] = []
      for (const page of accepted) {
        const out = await this.admit(live.id, series.id, page, liveProfile, false, kind)
        ;(out.created ? created : reused).push(out.id)
      }
      await this.event('run', `Selected pages added to this process: ${created.length} new, ${reused.length} already owned, ${skipped.length} skipped`, { runId: live.id })
      if (live.control === 'paused' || live.control === 'pause_requested') await this.control(live.id, 'resume')
      else void this.schedule(live.id, false)
      return { runId: live.id, created, reused, skipped }
    }

    const profile = profileOf({ engine: settings.engine, model: settings.model, effort: settings.effort, sandbox: settings.sandbox, connectionId: connection?.id ?? null }, prompts.hashes)
    const runKey = sha256(JSON.stringify({ series: series.id, part: request.partNumber, pages: accepted.map(p => [p.chapterId, p.filename, p.sourceSha256]).sort(), profile, prepareOnly: request.prepareOnly, ...(kind !== 'clipper' && { kind }), ...(editorOptions && { editor: editorOptions }) }))
    const existingRun = await prisma.antigravityRun.findUnique({ where: { idempotencyKey: runKey } })
    if (existingRun && !['stopped', 'completed', 'completed_with_errors', 'interrupted'].includes(existingRun.control)) {
      const jobs = await prisma.antigravityPageJob.findMany({ where: { runId: existingRun.id }, select: { id: true } })
      return { runId: existingRun.id, created: [], reused: jobs.map(j => j.id), skipped }
    }
    const run = await prisma.antigravityRun.create({
      data: {
        seriesId: series.id,
        partNumber: request.partNumber,
        connectionId: connection?.id ?? null,
        kind,
        engine: settings.engine,
        model: settings.model,
        effort: settings.effort,
        sandbox: settings.sandbox,
        concurrency: settings.concurrency,
        promptJson: JSON.stringify({ ids: prompts.ids, hashes: prompts.hashes, ...(editorOptions && { editor: editorOptions }) }),
        selectionJson: JSON.stringify(request.pages),
        control: request.prepareOnly ? 'preparing' : 'running',
        idempotencyKey: existingRun ? `${runKey}:${Date.now()}` : runKey,
        startedAt: new Date()
      }
    })
    const created: string[] = []
    const reused: string[] = []
    for (const page of accepted) {
      const out = await this.admit(run.id, series.id, page, profile, request.prepareOnly, kind)
      ;(out.created ? created : reused).push(out.id)
    }
    await this.event('run', `${request.prepareOnly ? 'Prepare' : kind === 'clipper' ? 'Run' : `${KIND_LABELS[kind]} run`} started${editorOptions ? ` (${editorFlow.METHOD_LABELS[editorOptions.method]})` : ''}: ${created.length} new, ${reused.length} already owned, ${skipped.length} skipped`, { runId: run.id })
    void this.schedule(run.id, request.prepareOnly)
    return { runId: run.id, created, reused, skipped }
  }

  /**
   * Whether one page can go to the AI now (pointers missing or rejected, not managed, narrow enough),
   * with what a job needs to start on it. The source is hashed only for a page that qualifies.
   */
  private async inspectPage(chapter: { id: string; folderPath: string }, index: number, image: { filename: string; width: number; height: number }): Promise<AcceptedPage | { reason: string }> {
    const filename = image.filename
    if (await managedCropBinding(chapter.folderPath, filename)) return { reason: 'Managed page — protected.' }
    const redo = await readPageRedo(chapter.folderPath, filename)
    const saved = await readImagePoints(chapter.folderPath, filename)
    if (saved?.file && redo?.status !== 'pending') return { reason: 'Pointers already saved.' }
    if (image.width > ANTIGRAVITY_MAX_WIDTH) return { reason: `Wider than ${ANTIGRAVITY_MAX_WIDTH} px.` }
    const bytes = await fs.readFile(path.join(getSourceFolderPath(chapter.folderPath), filename))
    return { chapterId: chapter.id, filename, pageIndex: index, sourceSha256: sha256(bytes), width: image.width, height: image.height, folderPath: chapter.folderPath, preexisting: await pointerFingerprint(chapter.folderPath, filename) }
  }

  /** "<Kind> process is running on <series> · Part n" for the one-process rule. */
  private async busyMessage(live: RunRow) {
    const other = await this.prisma.series.findUnique({ where: { id: live.seriesId }, select: { title: true } })
    return `${aKind(kindOf(live.kind))} process is already ${live.control === 'paused' ? 'paused' : 'running'} on ${other?.title ?? 'another series'} · Part ${live.partNumber}. One process at a time: let it finish or stop it in Running processes.`
  }

  /**
   * A chapter's current Metadata jobs, exactly as Studio publishes them to phones (reviewed, cut, English
   * script present, cut bytes unchanged), or the reason it has none yet.
   */
  private async metadataChapter(chapter: ChapterRef, cache?: Map<string, MetadataChapterJobs>): Promise<MetadataChapterJobs> {
    const hit = cache?.get(chapter.id)
    if (hit) return hit
    let out: MetadataChapterJobs
    try {
      const input = { id: chapter.id, number: chapter.number, folderPath: chapter.folderPath, seriesId: chapter.seriesId ?? chapter.series.id ?? '', series: { title: chapter.series.title } }
      const current = await currentMetadataJobs(input, await metadataGenerations(input))
      out = { jobs: new Map(current.jobs.map(j => [JSON.parse(j.payloadText).page as string, j])), script: current.script }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      out = { reason: (error as NodeJS.ErrnoException)?.code === 'ENOENT' && message.includes(CUT_RECEIPT) ? 'Crop Sections has not cut this chapter yet.' : message }
    }
    cache?.set(chapter.id, out)
    return out
  }

  /** Whether one page can have its Metadata made now: in the approved cut, without current Metadata. */
  private async inspectMetadataPage(chapter: ChapterRef, index: number, image: { filename: string }, cache?: Map<string, MetadataChapterJobs>): Promise<AcceptedPage | { reason: string }> {
    const meta = await this.metadataChapter(chapter, cache)
    if ('reason' in meta) return { reason: meta.reason }
    const job = meta.jobs.get(image.filename)
    if (!job) return { reason: 'Not in the chapter\'s approved cut.' }
    if (await this.metadataSaved(chapter.folderPath, image.filename, job, meta.script)) return { reason: 'Metadata already saved.' }
    const payload = metadataFlow.payloadOf(job)
    return { chapterId: chapter.id, filename: image.filename, pageIndex: index, sourceSha256: payload.sourceSha256, width: payload.width, height: payload.height, folderPath: chapter.folderPath, preexisting: 'none', manifestJson: JSON.stringify(job) }
  }

  /** The page already has Metadata that is valid for this exact job (phone or Studio made it). */
  private async metadataSaved(folderPath: string, filename: string, job: metadataFlow.MetadataJobEnvelope, script: string) {
    const existing = await readImageMetadata(folderPath, filename)
    if (!existing) return false
    try { validateMetadataResult(existing, job, script); return true } catch { return false }
  }

  /**
   * Gives one accepted page a job in this run, or shows the job that already owns it. `inRun` is false
   * when another live run keeps the page (one active owner per page across runs and profiles).
   */
  private async admit(runId: string, seriesId: string, page: AcceptedPage, profile: ReturnType<typeof profileOf>, prepareOnly: boolean, kind: JobKind = 'clipper'): Promise<{ id: string; created: boolean; inRun: boolean }> {
    const { prisma } = this
    // One active owner per page across runs and profiles: show the running job instead of starting another agent.
    const active = await prisma.antigravityPageJob.findFirst({ where: { chapterId: page.chapterId, filename: page.filename, kind, stage: { in: [...ACTIVE_STAGES, 'pending', 'queued'] } } })
    if (active) {
      // A page still waiting (pending/queued) in a run that no longer runs — e.g. Studio restarted mid-run —
      // would otherwise never be picked up: move it into this run.
      if ((active.stage === 'pending' || active.stage === 'queued') && !this.live.has(active.id)) {
        const owningRun = await prisma.antigravityRun.findUnique({ where: { id: active.runId }, select: { control: true } })
        if (!owningRun || ['interrupted', 'stopped', 'completed', 'completed_with_errors'].includes(owningRun.control)) {
          const stage = !active.manifestJson ? 'pending' : prepareOnly ? 'prepared' : 'queued'
          await prisma.antigravityPageJob.update({ where: { id: active.id }, data: { runId, stage } })
          return { id: active.id, created: false, inRun: true }
        }
      }
      return { id: active.id, created: false, inRun: active.runId === runId }
    }
    // Clipper keys keep their original shape (existing keys stay valid); a Metadata job is one cut + script revision,
    // a Timeline job one chapter + language + method + Editor inputs revision.
    const metadataRevision = kind === 'metadata' ? (JSON.parse(page.manifestJson!) as metadataFlow.MetadataJobEnvelope).revision : kind === 'editor' ? page.sourceSha256 : null
    const key = kind === 'metadata'
      ? sha256(JSON.stringify({ kind, chapter: page.chapterId, filename: page.filename, revision: metadataRevision, profile }))
      : kind === 'editor'
        ? sha256(JSON.stringify({ kind, chapter: page.chapterId, filename: page.filename, revision: metadataRevision, method: editorFlow.parseManifest(page.manifestJson)?.method, profile }))
        : sha256(JSON.stringify({ chapter: page.chapterId, filename: page.filename, source: page.sourceSha256, profile }))
    const owner = await prisma.antigravityPageJob.findUnique({ where: { idempotencyKey: key } })
    // Only an unfinished job is shown instead of starting again; a finished one (its pointers have since been
    // removed, or it ended without a result) is re-queued for this run, reusing its verified Drive inputs.
    if (owner && !TERMINAL_STAGES.has(owner.stage)) {
      // Another run already owns this page generation: show it, don't dispatch twice.
      if (owner.stage === 'prepared' && !prepareOnly && !this.live.has(owner.id)) {
        await prisma.antigravityPageJob.update({ where: { id: owner.id }, data: { runId, stage: 'queued' } })
        return { id: owner.id, created: false, inRun: true }
      }
      return { id: owner.id, created: false, inRun: owner.runId === runId }
    }
    // Slices and Drive inputs don't depend on the model or effort: a page already prepared under another
    // profile (e.g. "Prepare selected" with one model, Start with another) is handed to this run as it is,
    // instead of being sliced and uploaded again.
    const donor = kind === 'clipper' ? await this.preparedElsewhere(page, profile.connection, profile.prompts, key) : null
    if (donor) {
      // A finished job of this profile would hold the key; it keeps its history under a retired key.
      if (owner) await prisma.antigravityPageJob.update({ where: { id: owner.id }, data: { idempotencyKey: `${key}:retired:${owner.id}` } })
      await prisma.antigravityPageJob.update({
        where: { id: donor.id },
        data: { runId, idempotencyKey: key, pageIndex: page.pageIndex, preexistingPointer: page.preexisting, stage: prepareOnly ? 'prepared' : 'queued', lastError: null }
      })
      return { id: donor.id, created: false, inRun: true }
    }
    const data = {
      runId, seriesId, chapterId: page.chapterId, filename: page.filename, pageIndex: page.pageIndex, kind,
      sourceSha256: page.sourceSha256, width: page.width, height: page.height, stage: kind === 'clipper' ? 'pending' : 'queued', preexistingPointer: page.preexisting,
      lastError: null, currentAttemptId: null, resultJson: null, resultSha256: null, importState: null,
      // Metadata and Timeline jobs need no slicing or upload: their job document is their input.
      ...(kind !== 'clipper' && { manifestJson: page.manifestJson!, manifestSha256: metadataRevision })
    }
    const job = owner
      ? await prisma.antigravityPageJob.update({ where: { id: owner.id }, data })
      : await prisma.antigravityPageJob.create({ data: { ...data, idempotencyKey: key } })
    if (kind === 'editor') this.deps.editor?.claimsChanged?.()
    return { id: job.id, created: true, inRun: true }
  }

  // ─── One process at a time: the next pending page of a part ───

  /** The process that holds the single slot (running, pausing, paused or stopping), newest first. */
  async liveRun() {
    return this.prisma.antigravityRun.findFirst({ where: { control: { in: [...LIVE_CONTROLS] } }, orderBy: { createdAt: 'desc' } })
  }

  /** The live process, else the most recent one (for the Running processes tab). */
  async current() {
    const live = await this.liveRun()
    const run = live ?? await this.prisma.antigravityRun.findFirst({ orderBy: { createdAt: 'desc' } })
    return { live: !!live, run: run ? { id: run.id, seriesId: run.seriesId, partNumber: run.partNumber, kind: kindOf(run.kind), engine: run.engine, model: run.model, control: run.control, mode: runMode(run), createdAt: run.createdAt, finishedAt: run.finishedAt, ...(kindOf(run.kind) === 'editor' && { editor: editorFlow.optionsOf(run.promptJson) }) } : null }
  }

  /**
   * Start process for one part: no page list. The scheduler takes the next pending page in chapter →
   * page order whenever a slot is free (up to the run's parallel pages), until none is left or it is
   * stopped. Only one process exists at a time: pressing Start on the part that is already running (or
   * paused) continues it; another part's process must finish or be stopped first.
   */
  async startNext(request: { seriesId: string; partNumber: number; kind?: JobKind; editor?: editorFlow.EditorRunOptions }) {
    const { prisma } = this
    if (!Number.isInteger(request.partNumber) || request.partNumber < 1) throw new Error('Invalid part.')
    const series = await prisma.series.findUnique({ where: { id: request.seriesId }, select: { id: true, title: true } })
    if (!series) throw new Error('Series not found.')
    const kind = request.kind ?? 'clipper'
    const live = await this.liveRun()
    if (live) {
      if (live.seriesId !== series.id || live.partNumber !== request.partNumber || kindOf(live.kind) !== kind) throw new Error(await this.busyMessage(live))
      if (live.control === 'stop_requested') throw new Error('This part\'s process is stopping. Start again in a moment.')
      // Same part: this process continues and now takes the next pages itself.
      this.pickOff.delete(live.id)
      if (runMode(live) !== 'next') await prisma.antigravityRun.update({ where: { id: live.id }, data: { selectionJson: NEXT_MODE } })
      if (live.control === 'paused' || live.control === 'pause_requested') await this.control(live.id, 'resume')
      else void this.schedule(live.id, false)
      return { runId: live.id, created: [], reused: [], skipped: [] }
    }
    const settings = await this.deps.settings()
    const prompts = await this.deps.prompts()
    const connection = kind === 'clipper' ? await this.deps.drive.requireActiveConnection() : null
    const editorOptions = kind === 'editor' ? editorFlow.normalizeOptions(request.editor) : null
    const run = await prisma.antigravityRun.create({
      data: {
        seriesId: series.id, partNumber: request.partNumber, connectionId: connection?.id ?? null, kind, engine: settings.engine, model: settings.model,
        effort: settings.effort, sandbox: settings.sandbox, concurrency: settings.concurrency,
        promptJson: JSON.stringify({ ids: prompts.ids, hashes: prompts.hashes, ...(editorOptions && { editor: editorOptions }) }), selectionJson: NEXT_MODE,
        control: 'running', idempotencyKey: `next:${series.id}:${request.partNumber}:${crypto.randomUUID()}`, startedAt: new Date()
      }
    })
    await this.event('run', editorOptions
      ? `Timeline process started on Part ${request.partNumber} (${editorFlow.METHOD_LABELS[editorOptions.method]}, ${editorOptions.languages.map(editorFlow.languageLabel).join(' + ')}): the next chapter without a timeline, ${settings.concurrency} at a time (${label(settings.engine)}).`
      : `${KIND_LABELS[kind]} process started on Part ${request.partNumber}: the next pending page in chapter order, ${settings.concurrency} at a time (${label(settings.engine)}).`, { runId: run.id })
    void this.schedule(run.id, false)
    return { runId: run.id, created: [], reused: [], skipped: [] }
  }

  /**
   * Admits the next pending page of the run's part (chapter number, then page order) and returns true,
   * or false when none is left. Pages already settled in this run (done, protected, too wide, or already
   * handed out) are not looked at again; failed pages wait for the operator's Retry.
   */
  private async admitNext(run: RunRow): Promise<boolean> {
    let scan = this.scans.get(run.id)
    if (!scan) this.scans.set(run.id, scan = { manifests: new Map(), settled: new Set(), emptyAt: 0, meta: new Map() })
    // Nothing was left a moment ago: don't re-read every chapter twice a second while the last pages finish.
    if (Date.now() - scan.emptyAt < 3000) return false
    const kind = kindOf(run.kind)
    const chapters = (await this.prisma.chapter.findMany({ where: { seriesId: run.seriesId }, select: { id: true, number: true, folderPath: true, seriesId: true, series: { select: { title: true } } }, orderBy: { number: 'asc' } }))
      .filter(c => clipperPartNumber(c.number) === run.partNumber)
    const jobs = await this.prisma.antigravityPageJob.findMany({ where: { chapterId: { in: chapters.map(c => c.id) }, kind }, orderBy: { updatedAt: 'desc' }, select: { id: true, runId: true, chapterId: true, filename: true, stage: true } })
    const latest = new Map<string, (typeof jobs)[number]>()
    for (const j of jobs) if (!latest.has(`${j.chapterId}|${j.filename}`)) latest.set(`${j.chapterId}|${j.filename}`, j)
    const profile = profileOf(run, JSON.parse(run.promptJson).hashes)
    const editorOptions = kind === 'editor' ? editorFlow.optionsOf(run.promptJson) : null
    for (const chapter of chapters) {
      let images = scan.manifests.get(chapter.id)
      if (!images) {
        // A Timeline process takes each chapter once per language (its "pages" are timeline-en / timeline-hi).
        if (editorOptions) images = editorOptions.languages.map(l => ({ filename: editorFlow.timelineFilename(l), width: 0, height: 0 }))
        else try { images = (await getChapterManifest(chapter.folderPath)).images.map(i => ({ filename: i.filename, width: i.width, height: i.height })) } catch { images = [] }
        scan.manifests.set(chapter.id, images)
      }
      for (const [index, image] of images.entries()) {
        const k = `${chapter.id}|${image.filename}`
        if (scan.settled.has(k)) continue
        const job = latest.get(k)
        if (job && (this.live.has(job.id) || (job.runId === run.id && !TERMINAL_STAGES.has(job.stage)))) continue
        if (job && WAITS_FOR_OPERATOR.has(job.stage)) continue
        const checked = await (editorOptions
          ? this.inspectEditor(chapter, editorFlow.languageOfFilename(image.filename)!, editorOptions.method)
          : kind === 'metadata' ? this.inspectMetadataPage(chapter, index, image, scan.meta) : this.inspectPage(chapter, index, image)).catch((error: Error) => ({ reason: error.message }))
        scan.settled.add(k)
        if ('reason' in checked) continue
        const out = await this.admit(run.id, run.seriesId, checked, profile, false, kind)
        if (out.inRun) {
          await this.event('run', `Next ${editorOptions ? 'timeline' : 'page'}: Chapter ${chapter.number} · ${editorOptions ? editorFlow.languageLabel(editorFlow.languageOfFilename(image.filename)!) : image.filename}`, { runId: run.id, jobId: out.id })
          return true
        }
      }
    }
    scan.emptyAt = Date.now()
    return false
  }

  /**
   * Retry / Process again / Review again keep the one-process rule: the page joins the live process, or,
   * when nothing runs, its own run reopens for that page only (it does not go on through the part).
   */
  private async enterProcess(job: { id: string; runId: string; filename: string; kind?: string }, engine?: AiEngine): Promise<string> {
    const live = await this.liveRun()
    if (live && live.id !== job.runId) {
      if (live.control === 'stop_requested') throw new Error('The running process is stopping. Try again in a moment.')
      if (kindOf(live.kind) !== kindOf(job.kind)) throw new Error(`${await this.busyMessage(live)} This is ${aKind(kindOf(job.kind)).replace(/^A/, 'a')} ${kindOf(job.kind) === 'editor' ? 'job' : 'page'}.`)
      if (engine && engineOf(live.engine) !== engine) throw new Error(`A ${label(engineOf(live.engine))} process is running; this page's conversation is on ${label(engine)}. One engine at a time: review it again after that process finishes.`)
      await this.prisma.antigravityPageJob.update({ where: { id: job.id }, data: { runId: live.id } })
      await this.event('run', `${job.filename}: added to this process`, { runId: live.id, jobId: job.id })
      return live.id
    }
    if (!live) this.pickOff.add(job.runId)
    await this.prisma.antigravityRun.update({ where: { id: job.runId }, data: { control: 'running', finishedAt: null } })
    return job.runId
  }

  /**
   * A job that has this exact page generation sliced and verified in Drive (same source bytes, same Drive
   * connection, same prompt versions in its handoff) and is idle in `prepared`, under any model/effort.
   */
  private async preparedElsewhere(page: { chapterId: string; filename: string; sourceSha256: string }, connectionId: string, hashes: Record<string, string>, key: string) {
    const candidates = await this.prisma.antigravityPageJob.findMany({
      where: { chapterId: page.chapterId, filename: page.filename, sourceSha256: page.sourceSha256, stage: 'prepared', manifestJson: { not: null }, idempotencyKey: { not: key } },
      orderBy: { updatedAt: 'desc' }
    })
    for (const job of candidates) {
      if (this.live.has(job.id)) continue
      const run = await this.prisma.antigravityRun.findUnique({ where: { id: job.runId }, select: { connectionId: true } })
      if (run?.connectionId !== connectionId) continue
      let prompts: Record<string, string> | undefined
      try { prompts = JSON.parse(job.manifestJson!).prompts } catch { continue }
      if (prompts?.analysis !== hashes.analysis || prompts?.review !== hashes.review || prompts?.cropRules !== hashes.crop_rules) continue
      const slices = await this.prisma.driveInputFile.count({ where: { jobId: job.id, state: 'verified' } })
      if (slices === 0) continue
      return job
    }
    return null
  }

  // ─── Scheduler ───

  /**
   * One loop per run. Preparation (slice + Drive) and AI work use separate
   * bounded pools; AI slots are counted across all runs on this Mac so two runs
   * can't exceed the operator's chosen parallelism.
   */
  async schedule(runId: string, prepareOnly: boolean) {
    if (this.scheduling.has(runId)) return
    this.scheduling.add(runId)
    try {
      for (;;) {
        const run = await this.prisma.antigravityRun.findUnique({ where: { id: runId } })
        if (!run || ['paused', 'stopped', 'stop_requested', 'completed', 'completed_with_errors', 'interrupted'].includes(run.control)) break
        const mine = [...this.live.values()].filter(l => l.runId === runId)
        if (run.control === 'pause_requested') {
          if (mine.length === 0) {
            await this.prisma.antigravityRun.update({ where: { id: runId }, data: { control: 'paused' } })
            await this.event('run', 'Run paused by the operator.', { runId })
            break
          }
          await new Promise(r => setTimeout(r, 500))
          continue
        }
        const jobs = await this.prisma.antigravityPageJob.findMany({ where: { runId }, orderBy: [{ chapterId: 'asc' }, { pageIndex: 'asc' }] })
        const prepBusy = mine.filter(l => l.kind === 'prep').length
        const aiBusyAll = [...this.live.values()].filter(l => l.kind === 'ai').length
        const aiLimit = Math.max(1, Math.min(MAX_AI_SLOTS, run.concurrency))
        let dispatched = false
        // Start process: keep up to the parallel-pages limit of this part's next pending pages in flight.
        if (!prepareOnly && run.control === 'running' && runMode(run) === 'next' && !this.pickOff.has(runId)) {
          const inFlight = jobs.filter(j => !TERMINAL_STAGES.has(j.stage)).length
          if (inFlight < aiLimit) {
            let admitted = false
            try { admitted = await this.admitNext(run) } catch (error) {
              await this.pauseRun(runId, `Could not pick the next page: ${error instanceof Error ? error.message : String(error)}`)
              continue
            }
            if (admitted) continue
          }
        }
        const nextPrep = jobs.find(j => !this.live.has(j.id) && j.stage === 'pending')
        if (nextPrep && prepBusy < PREP_SLOTS) {
          this.dispatch(nextPrep.id, runId, 'prep', signal => this.prepareStep(nextPrep.id, signal))
          dispatched = true
        }
        const nextAi = prepareOnly ? undefined : jobs.find(j => !this.live.has(j.id) && (j.stage === 'prepared' || j.stage === 'queued'))
        if (nextAi && aiBusyAll < aiLimit) {
          this.dispatch(nextAi.id, runId, 'ai', signal => this.process(nextAi.id, signal))
          dispatched = true
        }
        if (dispatched) continue
        if (mine.length === 0 && !nextPrep && !nextAi) {
          const failed = jobs.some(j => ['failed', 'needs_attention', 'stale', 'publish_failed', 'interrupted'].includes(j.stage))
          await this.prisma.antigravityRun.update({ where: { id: runId }, data: { control: failed ? 'completed_with_errors' : 'completed', finishedAt: new Date() } })
          await this.event('run', `Run finished${failed ? ' with errors' : ''}.`, { runId })
          if (this.publishedRuns.delete(runId)) await this.notify(run.seriesId, runId)
          this.scans.delete(runId)
          this.pickOff.delete(runId)
          break
        }
        await new Promise(r => setTimeout(r, 500))
      }
    } finally {
      this.scheduling.delete(runId)
    }
  }

  private dispatch(jobId: string, runId: string, kind: Live['kind'], work: (signal: AbortSignal) => Promise<void>) {
    const controller = new AbortController()
    this.live.set(jobId, { controller, runId, kind })
    void work(controller.signal)
      .catch(async error => {
        const message = error instanceof PreparationError || error instanceof Error ? driveErrorMessage(error) : 'Unexpected error'
        const current = await this.prisma.antigravityPageJob.findUnique({ where: { id: jobId } })
        if (current && !TERMINAL_STAGES.has(current.stage)) await this.setStage(jobId, controller.signal.aborted ? 'cancelled' : 'failed', { lastError: message })
        if (current?.currentAttemptId) await this.prisma.antigravityAttempt.updateMany({ where: { id: current.currentAttemptId, status: 'active' }, data: { status: controller.signal.aborted ? 'cancelled' : 'failed', error: message, finishedAt: new Date() } })
      })
      .finally(() => this.live.delete(jobId))
  }

  private async prepareStep(jobId: string, signal: AbortSignal) {
    await this.prepare(jobId, signal)
    // A run that will process pages hands prepared pages straight to the AI queue.
    const job = await this.prisma.antigravityPageJob.findUnique({ where: { id: jobId } })
    const run = job ? await this.prisma.antigravityRun.findUnique({ where: { id: job.runId } }) : null
    if (job?.stage === 'prepared' && run && run.control !== 'preparing') await this.prisma.antigravityPageJob.update({ where: { id: jobId }, data: { stage: 'queued' } })
  }

  /** Studio is quitting: stop only our own agy/codex process groups and mark the work interrupted. */
  async shutdown() {
    const ids = [...this.live.keys()]
    for (const live of this.live.values()) live.controller.abort()
    for (const jobId of ids) {
      const job = await this.prisma.antigravityPageJob.findUnique({ where: { id: jobId } }).catch(() => null)
      if (!job) continue
      if (job.currentAttemptId) await this.prisma.antigravityAttempt.updateMany({ where: { id: job.currentAttemptId, status: 'active' }, data: { status: 'interrupted', error: 'Studio quit while this attempt ran.', finishedAt: new Date() } }).catch(() => undefined)
      if (!TERMINAL_STAGES.has(job.stage)) await this.prisma.antigravityPageJob.update({ where: { id: jobId }, data: { stage: 'interrupted', lastError: 'Studio quit while this page was in progress. Retry or Review again.' } }).catch(() => undefined)
    }
    await this.prisma.antigravityRun.updateMany({ where: { control: { in: ['running', 'preparing', 'pause_requested', 'stop_requested'] } }, data: { control: 'interrupted' } }).catch(() => undefined)
    // runTurn kills each process group on abort; give them a moment to exit.
    if (ids.length) await new Promise(r => setTimeout(r, 300))
  }

  private async chapterOf(chapterId: string) {
    return this.prisma.chapter.findUniqueOrThrow({ where: { id: chapterId }, select: { id: true, number: true, folderPath: true, series: { select: { id: true, title: true } } } })
  }

  async prepare(jobId: string, signal: AbortSignal) {
    let job = await this.setStage(jobId, 'preparing')
    const chapter = await this.chapterOf(job.chapterId)
    const sourcePath = path.join(getSourceFolderPath(chapter.folderPath), job.filename)
    const page = await preparePage(sourcePath, job.filename)
    if (page.sourceSha256 !== job.sourceSha256) {
      await this.setStage(jobId, 'stale', { lastError: 'The source page changed after it was selected.' })
      return
    }
    if (signal.aborted) throw new Error('Stopped.')
    job = await this.setStage(jobId, 'uploading')
    const prompts = await this.deps.prompts()
    const connection = await this.deps.drive.requireActiveConnection()
    const api = this.deps.drive.api(connection.id)
    const identity = {
      jobId, seriesId: chapter.series.id, seriesTitle: chapter.series.title, chapterId: chapter.id, chapterNumber: chapter.number,
      chapterFolder: path.basename(chapter.folderPath), filename: job.filename, pageIndex: job.pageIndex
    }
    const folders = await ensurePageFolders(api, this.prisma, { connectionId: connection.id, seriesId: identity.seriesId, seriesTitle: identity.seriesTitle, chapterId: chapter.id, chapterFolder: identity.chapterFolder, filename: job.filename, page })
    // The handoff is built once per job and reused verbatim on retries.
    const handoff = job.manifestJson
      ? JSON.parse(job.manifestJson)
      : buildHandoff(identity, page, { prompts: { analysis: prompts.hashes.analysis, review: prompts.hashes.review, cropRules: prompts.hashes.crop_rules } })
    const engineHandoff = engine.toEngineHandoff(handoff)
    const analysisPrompt = engine.analysisPrompt(prompts, engineHandoff)
    const files = [
      ...page.slices.map(s => ({ key: s.id, name: s.file, mime: s.mime, data: s.data })),
      { key: 'handoff', name: 'handoff.json', mime: 'application/json', data: Buffer.from(JSON.stringify(handoff, null, 2)) },
      { key: 'crop-prompt', name: 'crop-prompt.txt', mime: 'text/plain', data: Buffer.from(analysisPrompt) },
      { key: 'review-prompt', name: 'review-prompt.txt', mime: 'text/plain', data: Buffer.from(prompts.texts.review) }
    ]
    const uploaded = await uploadPackage(api, this.prisma, { connectionId: connection.id, jobId, folders, files, signal })
    const manifestJson = JSON.stringify(handoff)
    await this.setStage(jobId, 'prepared', {
      manifestJson,
      manifestSha256: sha256(manifestJson),
      driveFolderId: uploaded.pageFolderId,
      lastError: null
    })
    await this.event('drive', `${job.filename}: ${page.slices.length} slices uploaded and verified`, { runId: job.runId, jobId })
  }

  // ─── Analysis + review in one conversation ───

  /** The run's pinned prompt versions (PRD §13.4: edits apply to new runs, not to pages already in flight). */
  private async packFor(runId: string): Promise<PromptPack> {
    const run = await this.prisma.antigravityRun.findUnique({ where: { id: runId }, select: { promptJson: true } })
    const ids = run ? (JSON.parse(run.promptJson).ids as Record<string, string> | undefined) : undefined
    if (ids && this.deps.pinnedPrompts) {
      const pinned = await this.deps.pinnedPrompts(ids).catch(() => null)
      if (pinned) return pinned
    }
    return this.deps.prompts()
  }

  /**
   * A fresh one-attempt capability; returns the token. agy reads it from the workspace MCP config;
   * Codex gets its MCP config on the command line, so the token goes to a 0600 file beside the
   * workspace and only that path is passed (see codexMcp).
   */
  private async grantCapability(workspace: string, engine: AiEngine = 'antigravity') {
    const token = crypto.randomBytes(32).toString('base64url')
    if (engine === 'codex') {
      await fs.mkdir(workspace, { recursive: true, mode: 0o700 })
      await fs.writeFile(this.tokenFile(workspace), token, { mode: 0o600 })
      return token
    }
    await fs.mkdir(path.join(workspace, '.agents'), { recursive: true, mode: 0o700 })
    await fs.writeFile(
      path.join(workspace, '.agents', 'mcp_config.json'),
      JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { command: process.execPath, args: [JOB_MCP_SCRIPT], env: { STUDIO_BRIDGE_URL: `http://127.0.0.1:${this.deps.port}/api/antigravity/bridge`, STUDIO_ATTEMPT_TOKEN: token } } } }, null, 2),
      { mode: 0o600 }
    )
    return token
  }

  private tokenFile(workspace: string) {
    return path.join(path.dirname(workspace), 'capability.token')
  }

  /** Studio's job MCP server as Codex launches it for one attempt. */
  private codexMcp(workspace: string) {
    return {
      command: process.execPath,
      args: [JOB_MCP_SCRIPT],
      env: { STUDIO_BRIDGE_URL: `http://127.0.0.1:${this.deps.port}/api/antigravity/bridge`, STUDIO_ATTEMPT_TOKEN_FILE: this.tokenFile(workspace) }
    }
  }

  /** Another job holds this page right now (any run, any profile): one active owner per page (PRD §13.2). */
  private async ownedElsewhere(job: { id: string; chapterId: string; filename: string; kind?: string }) {
    for (const [id] of this.live) {
      if (id === job.id) continue
      const other = await this.prisma.antigravityPageJob.findUnique({ where: { id }, select: { chapterId: true, filename: true, stage: true, kind: true } })
      if (other && other.chapterId === job.chapterId && other.filename === job.filename && kindOf(other.kind) === kindOf(job.kind) && AI_STAGES.has(other.stage)) return id
    }
    return null
  }

  async process(jobId: string, signal: AbortSignal) {
    let job = await this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
    if (kindOf(job.kind) === 'metadata') return this.processMetadata(jobId, signal)
    if (kindOf(job.kind) === 'editor') return this.processEditor(jobId, signal)
    // The run pinned its engine at Start; a later engine switch in Settings applies to new runs only.
    const run = await this.prisma.antigravityRun.findUnique({ where: { id: job.runId }, select: { engine: true } })
    const settings = await this.deps.settings(engineOf(run?.engine))
    const prompts = await this.packFor(job.runId)
    const chapter = await this.chapterOf(job.chapterId)
    const current = sha256(await fs.readFile(path.join(getSourceFolderPath(chapter.folderPath), job.filename)).catch(() => Buffer.alloc(0)))
    if (current !== job.sourceSha256) return void (await this.setStage(jobId, 'stale', { lastError: 'The source page changed or was removed before processing.' }))
    if (this.deps.sourceBusy && await this.deps.sourceBusy(chapter.folderPath)) return void (await this.setStage(jobId, 'needs_attention', { lastError: 'A page replacement or series restart is in progress for this chapter. Retry when Library has finished.' }))
    if (await this.ownedElsewhere(job)) return void (await this.setStage(jobId, 'needs_attention', { lastError: 'Another run is processing this page right now; its result wins.' }))
    if (!job.manifestJson) throw new Error('The page was not prepared.')
    const handoff = engine.toEngineHandoff(JSON.parse(job.manifestJson))
    // Codex: the page's whole conversation runs on one ChatGPT account.
    let account: CodexAccountRef | null = null
    if (settings.engine === 'codex' && this.deps.codexAccounts) {
      account = await this.deps.codexAccounts.pick()
      if (!account) {
        await this.pauseRun(job.runId, 'Every ChatGPT account Studio can use has reached its Codex limit (or is turned off). Resume when one resets — Settings → AntiGravity → ChatGPT (Codex) shows when.')
        return void (await this.setStage(jobId, 'queued', { lastError: 'Waiting for a ChatGPT account with Codex usage left.' }))
      }
    }

    const number = (await this.prisma.antigravityAttempt.count({ where: { jobId } })) + 1
    const attemptId = crypto.randomUUID()
    const workspace = path.join(this.deps.attemptRoot ?? ATTEMPT_ROOT, attemptId, 'workspace')
    const token = await this.grantCapability(workspace, settings.engine)
    // Gemini 3.8 Flash gets the phone's four-step prompts; every other model the one prompt. Pinned per attempt.
    const flow = stepsFlow.flowFor(settings.engine, settings.model)
    await this.prisma.antigravityAttempt.create({
      data: {
        id: attemptId, jobId, number, status: 'active', stage: 'analyzing', capabilityHash: tokenHash(token), workspace, cliVersion: settings.cliVersion, engine: settings.engine, codexAccount: account?.id ?? null, requestedModel: settings.model,
        flow, stepsStateJson: flow === 'steps' ? stepsToJson(stepsStart(handoff, new Date().toISOString())) : null
      }
    })
    job = await this.setStage(jobId, 'analyzing', { currentAttemptId: attemptId })
    if (account) await this.event('account', `${job.filename}: running on ChatGPT account "${account.label}"`, { runId: job.runId, jobId, attemptId })
    const ctx: TurnContext = { jobId, attemptId, workspace, signal, model: settings.model, deadline: Date.now() + settings.pageTimeoutMinutes * 60_000, codexHome: account?.home ?? null }
    if (flow === 'steps') {
      await this.event('flow', `${job.filename}: ${settings.modelLabel ?? settings.model} uses the 4-step prompts`, { runId: job.runId, jobId, attemptId })
      return this.runSteps(ctx, settings, prompts)
    }
    const turn = this.turnRunner(ctx, settings)
    const finish = this.finisher(jobId, attemptId)

    // Turn 1: analysis. agy's print mode ends a turn on any refused action
    // (observed live: a Python call), so a turn that ended cleanly without a
    // submission is continued in the same conversation, within a small budget.
    let last = await turn(engine.withAnalysisDelivery(engine.analysisPrompt(prompts, handoff), handoff), null)
    let attempt = await this.prisma.antigravityAttempt.findUniqueOrThrow({ where: { id: attemptId } })
    for (let nudge = 0; !attempt.analysisJson && nudge < CONTINUATION_BUDGET; nudge++) {
      if (signal.aborted || !this.continuable(last) || !attempt.conversationId) break
      await this.event('continue', `${job.filename}: analysis not submitted; continuing the same conversation (${nudge + 1}/${CONTINUATION_BUDGET})`, { runId: job.runId, jobId, attemptId })
      last = await turn(engine.continuationPrompt('analysis', this.deniedNames(last)), attempt.conversationId)
      attempt = await this.prisma.antigravityAttempt.findUniqueOrThrow({ where: { id: attemptId } })
    }
    if (signal.aborted) return finish('cancelled', 'cancelled', 'Stopped by the operator.')
    if (!attempt.analysisJson) {
      const stop = await this.providerStop(job.runId, last, attemptId)
      if (stop) return finish('interrupted', stop === 'switched' ? 'queued' : 'interrupted', this.turnFailure(last, 'No analysis.'))
      return finish(last.envelope?.denied_actions?.length ? 'needs_attention' : 'failed', last.envelope?.denied_actions?.length ? 'needs_attention' : 'failed', this.turnFailure(last, 'No valid analysis was submitted through Studio\'s tool.'))
    }
    if (!attempt.conversationId) return finish('failed', 'failed', `${label(settings.engine)} returned no conversation ID, so the review cannot continue the same conversation.`)
    await this.reviewAndFinish(ctx, settings, prompts)
  }

  private turnRunner(ctx: TurnContext, settings: RunSettings, effort = settings.effort) {
    return async (prompt: string, conversationId: string | null) => {
      const remaining = ctx.deadline - Date.now()
      if (remaining <= 0) throw new Error(`The ${settings.pageTimeoutMinutes}-minute page deadline passed.`)
      const onSpawn = (pid: number) => void this.prisma.antigravityAttempt.update({ where: { id: ctx.attemptId }, data: { pid } }).catch(() => undefined)
      const result = settings.engine === 'codex'
        ? await runCodexTurn({
          executable: settings.executable, cwd: ctx.workspace, prompt, model: ctx.model, effort,
          conversationId, mcp: this.codexMcp(ctx.workspace), timeoutMs: remaining, signal: ctx.signal, onSpawn,
          env: ctx.codexHome ? { ...process.env, CODEX_HOME: ctx.codexHome } : undefined
        })
        : await runTurn({
          executable: settings.executable, cwd: ctx.workspace, prompt, model: ctx.model, effort,
          conversationId, settings: jobSettings(), sandbox: settings.sandbox, timeoutMs: remaining, signal: ctx.signal, onSpawn
        })
      await this.recordTurn(ctx.attemptId, result)
      return result
    }
  }

  private finisher(jobId: string, attemptId: string) {
    return async (status: string, stage: string, error: string | null) => {
      await this.prisma.antigravityAttempt.update({ where: { id: attemptId }, data: { status, error, finishedAt: new Date() } })
      await this.recordToolUse(attemptId)
      await this.setStage(jobId, stage, { lastError: error })
    }
  }

  /** The attempt's effective tool set, from its own conversation transcript (never fails the page). */
  private async recordToolUse(attemptId: string) {
    try {
      const attempt = await this.prisma.antigravityAttempt.findUnique({ where: { id: attemptId } })
      if (!attempt?.conversationId) return
      const job = await this.prisma.antigravityPageJob.findUnique({ where: { id: attempt.jobId } })
      if (attempt.engine === 'codex') {
        const account = attempt.codexAccount ? await this.deps.codexAccounts?.get(attempt.codexAccount) : null
        const evidence = await readSessionEvidence(attempt.conversationId, account?.home ?? this.deps.codexHome)
        if (evidence?.model && evidence.model !== attempt.observedModel) await this.prisma.antigravityAttempt.update({ where: { id: attemptId }, data: { observedModel: evidence.model } })
        if (evidence && account) await this.deps.codexAccounts?.recordEvidence(account.id, { rateLimits: evidence.rateLimits, accountId: evidence.accountId })
        await this.event(evidence?.toolUse.unexpected.length ? 'tools_unexpected' : 'tools', `${job?.filename ?? ''}: ${evidence ? describeSession(evidence) : 'tool use not recorded (Codex session file not found)'}`, { runId: job?.runId, jobId: attempt.jobId, attemptId })
        return
      }
      const use = await readToolUse(attempt.conversationId, this.deps.cliHome)
      await this.event(use?.unexpected.length ? 'tools_unexpected' : 'tools', `${job?.filename ?? ''}: ${use ? describeToolUse(use) : 'tool use not recorded (transcript not found)'}`, { runId: job?.runId, jobId: attempt.jobId, attemptId })
    } catch { /* evidence only */ }
  }

  /** Review rounds in the attempt's own conversation, then validate and deliver. */
  private async reviewAndFinish(ctx: TurnContext, settings: RunSettings, prompts: PromptPack, effort = settings.effort) {
    const { jobId, attemptId, signal } = ctx
    const turn = this.turnRunner(ctx, settings, effort)
    const finish = this.finisher(jobId, attemptId)
    const job = await this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
    const chapter = await this.chapterOf(job.chapterId)
    const handoff = engine.toEngineHandoff(JSON.parse(job.manifestJson!))
    let attempt = await this.prisma.antigravityAttempt.findUniqueOrThrow({ where: { id: attemptId } })
    const conversationId = attempt.conversationId!
    await this.setStage(jobId, 'reviewing')
    await this.prisma.antigravityAttempt.update({ where: { id: attemptId }, data: { stage: 'reviewing' } })
    const luma = await engine.lumaFor(path.join(getSourceFolderPath(chapter.folderPath), job.filename))
    // Already resolved (e.g. review-again on a page whose last round cleared everything)?
    let resolved = attempt.reviewRounds > 0 && engine.blockers(attempt.reviewStateJson!, handoff, luma).length === 0
    for (let round = 0; !resolved && round <= REVIEW_CORRECTION_BUDGET; round++) {
      attempt = await this.prisma.antigravityAttempt.findUniqueOrThrow({ where: { id: attemptId } })
      const before = attempt.reviewRounds
      const prompt = engine.withReviewDelivery(engine.reviewPrompt(prompts, attempt.reviewStateJson!, handoff, luma), handoff)
      let result = await turn(prompt, conversationId)
      attempt = await this.prisma.antigravityAttempt.findUniqueOrThrow({ where: { id: attemptId } })
      for (let nudge = 0; attempt.reviewRounds === before && nudge < CONTINUATION_BUDGET; nudge++) {
        if (signal.aborted || !this.continuable(result)) break
        await this.event('continue', `${job.filename}: review not submitted; continuing the same conversation (${nudge + 1}/${CONTINUATION_BUDGET})`, { runId: job.runId, jobId, attemptId })
        result = await turn(engine.continuationPrompt('review', this.deniedNames(result)), conversationId)
        attempt = await this.prisma.antigravityAttempt.findUniqueOrThrow({ where: { id: attemptId } })
      }
      if (signal.aborted) return finish('cancelled', 'cancelled', 'Stopped by the operator.')
      if (result.envelope?.conversation_id && result.envelope.conversation_id !== conversationId) return finish('failed', 'failed', 'The review turn answered from a different conversation.')
      if (attempt.reviewRounds === before) {
        const stop = await this.providerStop(job.runId, result, attemptId)
        if (stop) return finish('interrupted', stop === 'switched' ? 'queued' : 'interrupted', this.turnFailure(result, 'No review.'))
        if (round === REVIEW_CORRECTION_BUDGET) return finish('needs_attention', 'needs_attention', this.turnFailure(result, 'No valid review was submitted through Studio\'s tool.'))
        continue
      }
      const remaining = engine.blockers(attempt.reviewStateJson!, handoff, luma)
      if (remaining.length === 0) resolved = true
      else if (round === REVIEW_CORRECTION_BUDGET) return finish('needs_attention', 'needs_attention', `Review unresolved after ${REVIEW_CORRECTION_BUDGET} correction turns: ${remaining.slice(0, 3).join('; ')}`)
    }
    await this.commitResult(ctx)
  }

  /** The page's luminance, for the audit; cached by source hash (a page decodes once per process). */
  private lumaCache = new Map<string, LumaPage>()
  private async lumaOf(sourcePath: string, sourceSha256: string): Promise<LumaPage> {
    const hit = this.lumaCache.get(sourceSha256)
    if (hit) return hit
    const luma = await engine.lumaFor(sourcePath)
    if (this.lumaCache.size >= 8) this.lumaCache.delete(this.lumaCache.keys().next().value!)
    this.lumaCache.set(sourceSha256, luma)
    return luma
  }

  /**
   * The four-step flow (Gemini 3.8 Flash), port of the phone's STEPS auto-run: each step is its own turn in
   * the attempt's one conversation, answered through submit_step; then validate and deliver like Classic.
   */
  private async runSteps(ctx: TurnContext, settings: RunSettings, prompts: PromptPack, effort = settings.effort) {
    const { jobId, attemptId, signal } = ctx
    const turn = this.turnRunner(ctx, settings, effort)
    const finish = this.finisher(jobId, attemptId)
    const job = await this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
    const chapter = await this.chapterOf(job.chapterId)
    const handoff = engine.toEngineHandoff(JSON.parse(job.manifestJson!))
    const luma = await this.lumaOf(path.join(getSourceFolderPath(chapter.folderPath), job.filename), job.sourceSha256)
    const load = () => this.prisma.antigravityAttempt.findUniqueOrThrow({ where: { id: attemptId } })
    const viewOf = (a: { stepsStateJson: string | null; reviewStateJson: string | null }) => stepsFlow.view(a.stepsStateJson, a.reviewStateJson, handoff, () => luma, new Date().toISOString())
    /** Moves when a reply is accepted, or when the page is sent back a step. */
    const progress = (a: { stepsStateJson: string | null; reviewStateJson: string | null }) => {
      const s = viewOf(a).state
      return `${s.accepted}|${s.stage}|${s.queue.length}`
    }
    /** Counts a message against the page's budget (the phone's MAX_MESSAGES). */
    const countMessage = async () => {
      const a = await load()
      const s = viewOf(a).state
      await this.prisma.antigravityAttempt.update({ where: { id: attemptId }, data: { stepsStateJson: stepsToJson({ ...s, messages: s.messages + 1 }) } })
    }
    let stalls = 0
    for (;;) {
      if (signal.aborted) return finish('cancelled', 'cancelled', 'Stopped by the operator.')
      let attempt = await load()
      const v = viewOf(attempt)
      if (!v.plan) break
      const over = stepsOverBudget(v.state, v.plan)
      if (over) return finish('needs_attention', 'needs_attention', `${over}${v.blockers.length ? `: ${v.blockers.slice(0, 3).join('; ')}` : ''}`)
      const stage = attempt.reviewStateJson ? 'reviewing' : 'analyzing'
      if (attempt.stage !== stage) {
        await this.prisma.antigravityAttempt.update({ where: { id: attemptId }, data: { stage } })
        await this.setStage(jobId, stage)
      }
      await this.event('step', `${job.filename}: ${stepLabel(v.plan)}`, { runId: job.runId, jobId, attemptId })
      const before = progress(attempt)
      await countMessage()
      let result = await turn(stepsFlow.stepPrompt(prompts, v, handoff, () => luma), attempt.conversationId)
      attempt = await load()
      for (let nudge = 0; progress(attempt) === before && nudge < CONTINUATION_BUDGET; nudge++) {
        if (signal.aborted || !this.continuable(result) || !attempt.conversationId) break
        await this.event('continue', `${job.filename}: ${stepLabel(v.plan)} not submitted; continuing the same conversation (${nudge + 1}/${CONTINUATION_BUDGET})`, { runId: job.runId, jobId, attemptId })
        await countMessage()
        result = await turn(stepsFlow.continuationPrompt(v.plan, this.deniedNames(result)), attempt.conversationId)
        attempt = await load()
      }
      if (signal.aborted) return finish('cancelled', 'cancelled', 'Stopped by the operator.')
      if (result.envelope?.conversation_id && attempt.conversationId && result.envelope.conversation_id !== attempt.conversationId) return finish('failed', 'failed', 'A step turn answered from a different conversation.')
      if (progress(attempt) !== before) {
        stalls = 0
        if (!attempt.conversationId) return finish('failed', 'failed', `${label(settings.engine)} returned no conversation ID, so the next step cannot continue the same conversation.`)
        continue
      }
      const stop = await this.providerStop(job.runId, result, attemptId)
      if (stop) return finish('interrupted', stop === 'switched' ? 'queued' : 'interrupted', this.turnFailure(result, `No ${stepLabel(v.plan)}.`))
      // Ask the same step once more, whole, with a fresh submission allowance.
      if (++stalls > 1 || !this.continuable(result)) {
        // Nothing to keep before step 1 is in (as Classic without an analysis); after it, Review again resumes here.
        const status = v.plan.part === 1 && v.state.accepted === 0 && !result.envelope?.denied_actions?.length ? 'failed' : 'needs_attention'
        return finish(status, status, this.turnFailure(result, `No valid ${stepLabel(v.plan)} was submitted through Studio's tool.`))
      }
      await this.prisma.antigravityAttempt.update({ where: { id: attemptId }, data: { submissions: 0 } })
    }
    await this.commitResult(ctx)
  }

  /** Commit boundary (PRD §13.4): a stopped or superseded attempt never imports or publishes. */
  private async commitResult(ctx: TurnContext) {
    const { jobId, attemptId, signal } = ctx
    const job = await this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
    const attempt = await this.prisma.antigravityAttempt.findUniqueOrThrow({ where: { id: attemptId } })
    const now = await this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
    if (signal.aborted || attempt.status !== 'active' || now.currentAttemptId !== attemptId) return void (await this.event('stage', `${job.filename}: result discarded (attempt stopped or superseded)`, { runId: job.runId, jobId, attemptId }))
    await this.setStage(jobId, 'validating')
    const crops = engine.finalCrops(attempt.reviewStateJson!)
    const pointer = buildPointerFile(crops, { filename: job.filename, width: job.width, height: job.height, sourceSha256: job.sourceSha256 })
    await this.prisma.antigravityPageJob.update({ where: { id: jobId }, data: { resultJson: pointer.text, resultSha256: pointer.sha256 } })
    await this.prisma.antigravityAttempt.update({ where: { id: attemptId }, data: { stage: 'done', status: 'completed', finishedAt: new Date() } })
    await this.recordToolUse(attemptId)
    await this.deliver(jobId)
  }

  private async pauseRun(runId: string, reason: string) {
    await this.prisma.antigravityRun.updateMany({ where: { id: runId, control: { in: ['running', 'pause_requested'] } }, data: { control: 'paused' } })
    await this.event('run', `Run paused: ${reason}`, { runId })
  }

  /**
   * Account/model problems stop new dispatch for the run instead of burning
   * every remaining page (PRD §17): 'paused'. With several ChatGPT accounts, a
   * Codex account that reached its limit (or lost its sign-in) is kept off
   * until it resets and the page goes back to the queue for the next account:
   * 'switched'. The page's analysis restarts there, because a thread lives in
   * the account that started it.
   */
  private async providerStop(runId: string, result: AgyTurnResult, attemptId?: string): Promise<false | 'paused' | 'switched'> {
    const kind = classifyProviderFailure(result)
    if (!kind) return false
    const run = await this.prisma.antigravityRun.findUnique({ where: { id: runId }, select: { engine: true } })
    const engine = engineOf(run?.engine)
    const pool = this.deps.codexAccounts
    const attempt = attemptId ? await this.prisma.antigravityAttempt.findUnique({ where: { id: attemptId } }) : null
    if (engine === 'codex' && pool && attempt?.codexAccount && (kind === 'quota' || kind === 'auth')) {
      const account = await pool.get(attempt.codexAccount)
      const name = account?.label ?? attempt.codexAccount
      let until: string | null = null
      if (account && attempt.conversationId && kind === 'quota') {
        const evidence = await readSessionEvidence(attempt.conversationId, account.home).catch(() => null)
        if (evidence) await pool.recordEvidence(account.id, { rateLimits: evidence.rateLimits, accountId: evidence.accountId })
        until = limitResetFrom(evidence?.rateLimits)
      }
      until = await pool.markLimited(attempt.codexAccount, kind === 'quota' ? 'Codex usage limit reached.' : 'Codex is not signed in on this account.', until)
      await this.event('account', `ChatGPT account "${name}" ${kind === 'quota' ? 'reached its Codex limit' : 'is not signed in'}; Studio keeps new pages off it until ${until ? new Date(until).toLocaleString() : 'it is fixed'}.`, { runId, attemptId })
      const next = (await pool.autoSwitch()) ? await pool.pick() : null
      if (next) {
        await this.event('account', `Continuing on ChatGPT account "${next.label}".`, { runId })
        // A Review again outside a live run: make sure the run schedules the re-queued page.
        await this.prisma.antigravityRun.updateMany({ where: { id: runId, control: { in: ['completed', 'completed_with_errors', 'interrupted'] } }, data: { control: 'running', finishedAt: null } })
        void this.schedule(runId, false)
        return 'switched'
      }
      await this.pauseRun(runId, (await pool.autoSwitch())
        ? 'Every ChatGPT account Studio can use has reached its Codex limit (or is not signed in). Resume when one resets — Settings → AntiGravity → ChatGPT (Codex) shows when.'
        : `ChatGPT account "${name}" ${kind === 'quota' ? 'reached its Codex limit' : 'is not signed in'} and automatic switching is off. Switch accounts in Settings → AntiGravity → ChatGPT (Codex), then resume.`)
      return 'paused'
    }
    const reason = engine === 'codex'
      ? {
        quota: 'Codex reports the ChatGPT plan\'s usage limit is reached. Resume the run after it resets (the 5-hour and weekly windows show in Settings → AntiGravity).',
        auth: 'Codex is not signed in with ChatGPT. Sign in (Settings → AntiGravity → ChatGPT (Codex)), then resume the run.',
        model: 'The pinned Codex model is no longer available on this plan. Choose another model and run the compatibility test; this run stays paused.'
      }[kind]
      : {
        quota: 'Antigravity reports the account or model quota is used up. Resume the run after the quota resets.',
        auth: 'The Antigravity CLI is not signed in. Sign in (AntiGravity → Settings), then resume the run.',
        model: 'The pinned model is no longer available. Choose another model and run the compatibility test; this run stays paused.'
      }[kind]
    await this.pauseRun(runId, reason)
    return 'paused'
  }

  /**
   * Review again in the same conversation (PRD §16.2 /jobs/:id/review): a page
   * left in Needs attention after review gets new review rounds on its pinned
   * candidate, with a fresh capability. No new analysis, no new conversation.
   */
  async reviewAgain(jobId: string) {
    const job = await this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
    if (this.live.has(jobId)) throw new Error('This page is still running.')
    if (kindOf(job.kind) === 'metadata') return this.metadataAgain(jobId)
    if (kindOf(job.kind) === 'editor') return this.editorAgain(jobId)
    if (!['needs_attention', 'interrupted'].includes(job.stage) || job.importState === 'conflict') throw new Error('Review again is for pages left in Needs attention or Interrupted after their review.')
    const attempt = job.currentAttemptId ? await this.prisma.antigravityAttempt.findUnique({ where: { id: job.currentAttemptId } }) : null
    const steps = attempt?.flow === 'steps'
    // The four-step flow resumes at whatever step it stopped on once step 1 is in; Classic needs its analysis.
    const resumable = steps ? !!attempt?.stepsStateJson && (parseSteps(attempt.stepsStateJson)?.accepted ?? 0) > 0 : !!attempt?.reviewStateJson
    if (!attempt?.conversationId || !resumable) throw new Error('This page has no accepted analysis in a known conversation; use Retry instead.')
    const run = await this.prisma.antigravityRun.findUniqueOrThrow({ where: { id: job.runId } })
    // The conversation belongs to the CLI (and, for Codex, the ChatGPT account) that started it.
    const settings = await this.deps.settings(engineOf(attempt.engine))
    const account = attempt.codexAccount && this.deps.codexAccounts ? await this.deps.codexAccounts.get(attempt.codexAccount) : null
    if (attempt.codexAccount && this.deps.codexAccounts && !account) throw new Error('The ChatGPT account this conversation ran on was removed; use Retry (new conversation) instead.')
    // Shown as part of the one process; the conversation keeps the engine it started on.
    const runId = await this.enterProcess(job, engineOf(attempt.engine))
    const token = await this.grantCapability(attempt.workspace, engineOf(attempt.engine))
    await this.prisma.antigravityAttempt.update({
      where: { id: attempt.id },
      data: {
        status: 'active', stage: steps && !attempt.reviewStateJson ? 'analyzing' : 'reviewing', capabilityHash: tokenHash(token), submissions: 0, error: null, finishedAt: null,
        // A fresh message and review-round budget; the progress stays.
        ...(steps && { stepsStateJson: stepsToJson(stepsResetBudget(parseSteps(attempt.stepsStateJson)!, new Date().toISOString())) })
      }
    })
    await this.event('review', `${job.filename}: ${steps ? 'continue the 4-step prompts' : 'review again'} in conversation ${attempt.conversationId}`, { runId, jobId, attemptId: attempt.id })
    const controller = new AbortController()
    this.live.set(jobId, { controller, runId, kind: 'ai' })
    const prompts = await this.packFor(job.runId)
    // The conversation stays on the model it started with.
    const ctx: TurnContext = { jobId, attemptId: attempt.id, workspace: attempt.workspace, signal: controller.signal, model: attempt.requestedModel, deadline: Date.now() + settings.pageTimeoutMinutes * 60_000, codexHome: account?.home ?? null }
    void (steps ? this.runSteps(ctx, settings, prompts, run.effort) : this.reviewAndFinish(ctx, settings, prompts, run.effort))
      .catch(async error => {
        const current = await this.prisma.antigravityPageJob.findUnique({ where: { id: jobId } })
        if (current && !TERMINAL_STAGES.has(current.stage)) await this.setStage(jobId, 'failed', { lastError: error instanceof Error ? error.message : String(error) })
      })
      .finally(() => this.live.delete(jobId))
    void this.schedule(runId, false)
    return this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
  }

  /**
   * Local import, then R2 publication (two independent targets, PRD §14.1).
   * Never calls the AI; safe to retry. A local import survives an R2 failure.
   */
  async deliver(jobId: string) {
    let job = await this.setStage(jobId, 'delivering')
    if (!job.resultJson) throw new Error('No validated result to deliver.')
    const chapter = await this.chapterOf(job.chapterId)
    let pointer = JSON.parse(job.resultJson)
    // A page rejected in Studio: the replacement carries the rejection's revision, like a phone's redo export,
    // so phones accept it over the voided result (SharedCrops.takePage) and Fetch can tell the two apart.
    const redo = await readPageRedo(chapter.folderPath, job.filename)
    if (redo?.status === 'pending' && redo.sourceSha256 === job.sourceSha256 && pointer.studioRedoRevision !== redo.revision) {
      pointer = { ...pointer, studioRedoRevision: redo.revision }
      const text = JSON.stringify(pointer, null, 2) + '\n'
      job = await this.prisma.antigravityPageJob.update({ where: { id: jobId }, data: { resultJson: text, resultSha256: sha256(text) } })
    }
    const outcome = await importPointerFile({ folderPath: chapter.folderPath, filename: job.filename, pointer, preexisting: job.preexistingPointer ?? 'none' })
    if (outcome.state === 'conflict') return void (await this.setStage(jobId, 'needs_attention', { importState: 'conflict', lastError: outcome.reason }))
    if (outcome.state === 'stale') return void (await this.setStage(jobId, 'stale', { importState: 'skipped', lastError: outcome.reason }))
    if (outcome.state === 'imported') this.deps.onPointersChanged?.()
    await this.prisma.antigravityPageJob.update({ where: { id: jobId }, data: { importState: 'imported' } })
    await this.publishStep(jobId)
  }

  private async publishStep(jobId: string) {
    const publisher = this.deps.publisher
    if (!publisher) return void (await this.setStage(jobId, 'ready_for_human_review', { lastError: null }))
    const job = await this.setStage(jobId, 'publishing')
    try {
      const published = await publisher.publish(jobId)
      if (published.state === 'published') {
        this.publishedRuns.add(job.runId)
        await this.event('r2', `${job.filename}: shared with phones (${published.key.split('/').slice(-3).join('/')})`, { runId: job.runId, jobId })
      } else {
        await this.event('r2', `${job.filename}: ${published.device} had already shared this page; its work was kept on the phones`, { runId: job.runId, jobId })
      }
      await this.setStage(jobId, 'ready_for_human_review', { lastError: null })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.setStage(jobId, 'publish_failed', { lastError: `Imported into Clipper; R2 publication failed: ${message.slice(0, 300)}` })
    }
  }

  /** Re-publish an already imported result (delivery only, no AI). */
  async publishAgain(jobId: string) {
    const job = await this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
    if (this.live.has(jobId)) throw new Error('This page is still running.')
    if (kindOf(job.kind) === 'metadata') throw new Error('Metadata is saved in Studio only; there is nothing to publish.')
    if (kindOf(job.kind) === 'editor') throw new Error('A timeline goes to the phones through Editor 2.0\'s own sending; there is nothing to publish here.')
    if (!job.resultJson || job.importState !== 'imported') throw new Error('Only results imported into Clipper can be published.')
    await this.publishStep(jobId)
    const after = await this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
    if (this.publishedRuns.delete(job.runId)) await this.notify(job.seriesId, job.runId)
    return after
  }

  private async notify(seriesId: string, runId: string) {
    if (!this.deps.notifyPhones) return
    try {
      await this.deps.notifyPhones(seriesId)
      await this.event('phones', 'Asked phones to check R2 for new AntiGravity results.', { runId })
    } catch (error) {
      await this.event('phones', `Phones not notified (they will catch up on their next sync): ${error instanceof Error ? error.message : String(error)}`.slice(0, 300), { runId })
    }
  }

  /** A turn that ended normally (not stopped, timed out or errored) can be continued. */
  private continuable(result: AgyTurnResult) {
    return !result.cancelled && !result.timedOut && result.envelope?.status === 'SUCCESS'
  }

  private deniedNames(result: AgyTurnResult) {
    return result.envelope?.denied_actions?.map(d => d.display_name ?? d.action) ?? []
  }

  private turnFailure(result: AgyTurnResult, fallback: string) {
    const codex = 'summary' in result
    const name = codex ? 'Codex' : 'Antigravity'
    if (result.cancelled) return 'Stopped by the operator.'
    if (result.timedOut) return `The ${name} turn timed out.`
    const denied = result.envelope?.denied_actions?.map(d => d.display_name ?? d.action) ?? []
    if (denied.length) return `${name} was denied: ${denied.join(', ')}. ${fallback}`
    if (result.envelope?.status && result.envelope.status !== 'SUCCESS') return `${name} reported ${result.envelope.status}: ${(result.envelope.error ?? '').slice(0, 300)}`
    if (!result.envelope) return `${codex ? 'codex' : 'agy'} produced no result (exit ${result.exitCode ?? 'signal'}). ${result.stderrTail.slice(-200)}`
    return fallback
  }

  private async recordTurn(attemptId: string, result: AgyTurnResult) {
    const attempt = await this.prisma.antigravityAttempt.findUniqueOrThrow({ where: { id: attemptId } })
    const id = result.envelope?.conversation_id || null
    const data: Record<string, unknown> = {}
    if (id && !attempt.conversationId) data.conversationId = id
    if (result.envelope?.denied_actions?.length) {
      const earlier = attempt.deniedActions ? (JSON.parse(attempt.deniedActions) as unknown[]) : []
      data.deniedActions = JSON.stringify([...earlier, ...result.envelope.denied_actions])
    }
    if (Object.keys(data).length) await this.prisma.antigravityAttempt.update({ where: { id: attemptId }, data })
    const job = await this.prisma.antigravityPageJob.findUnique({ where: { id: attempt.jobId } })
    await this.event('turn', `${job?.filename ?? ''}: turn ${result.envelope?.status ?? 'no result'} in ${(result.durationMs / 1000).toFixed(0)} s${id ? ` (conversation ${id})` : ''}`, { runId: job?.runId, jobId: attempt.jobId, attemptId })
  }

  // ─── MCP bridge (called by resources/antigravity/job-mcp.mjs over loopback) ───

  /** The tools the attempt holding [token] works with: the four-step flow has its own set. */
  async tools(token?: string) {
    const attempt = token ? await this.prisma.antigravityAttempt.findFirst({ where: { capabilityHash: tokenHash(token) }, select: { flow: true } }) : null
    if (attempt?.flow === 'metadata') return metadataFlow.METADATA_TOOL_DEFINITIONS
    if (attempt?.flow?.startsWith('editor-')) return editorFlow.toolsFor(attempt.flow)
    return stepsFlow.toolsFor(attempt?.flow === 'steps' ? 'steps' : 'classic')
  }

  async call(token: string, input: { tool: string; arguments: Record<string, unknown>; conversationId: string | null }) {
    const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError && { isError: true }) })
    const attempt = await this.prisma.antigravityAttempt.findFirst({ where: { capabilityHash: tokenHash(token) } })
    if (!attempt || attempt.status !== 'active') return text('This job capability is no longer active (finished, stopped or superseded). Stop working on this page.', true)
    if (input.conversationId) {
      if (attempt.conversationId && attempt.conversationId !== input.conversationId) return text('This capability belongs to a different conversation.', true)
      if (!attempt.conversationId) await this.prisma.antigravityAttempt.update({ where: { id: attempt.id }, data: { conversationId: input.conversationId } })
    }
    const job = await this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: attempt.jobId } })
    if (job.currentAttemptId !== attempt.id || TERMINAL_STAGES.has(job.stage)) return text('This attempt was superseded or stopped.', true)
    if (attempt.flow === 'metadata') return this.callMetadata(attempt, job, input)
    if (attempt.flow?.startsWith('editor-')) return this.callEditor(attempt, job, input)
    const handoff = engine.toEngineHandoff(JSON.parse(job.manifestJson!))
    const delivered = new Set<string>(JSON.parse(attempt.deliveredJson))

    switch (input.tool) {
      case 'get_job_context':
        return text(engine.jobContextText(handoff, attempt.stage))
      case 'fetch_slice': {
        const sliceId = String(input.arguments.slice_id ?? '')
        const slice = handoff.slices.find(s => s.id === sliceId)
        if (!slice) return text(`Unknown slice_id "${sliceId}". Valid: ${handoff.slices.map(s => s.id).join(', ')}.`, true)
        const row = await this.prisma.driveInputFile.findUnique({ where: { jobId_sliceId: { jobId: job.id, sliceId } } })
        if (!row || row.state !== 'verified') return text('That slice is not available in Drive.', true)
        const connection = await this.prisma.driveConnection.findUnique({ where: { id: row.connectionId } })
        if (!connection) return text('The Drive connection for this job is gone.', true)
        const bytes = await this.deps.drive.api(row.connectionId).download(row.fileId)
        if (sha256(bytes) !== row.sha256) return text('The slice in Drive no longer matches the prepared bytes; this attempt cannot continue.', true)
        delivered.add(sliceId)
        await this.prisma.antigravityAttempt.update({ where: { id: attempt.id }, data: { deliveredJson: JSON.stringify([...delivered]) } })
        return {
          content: [
            { type: 'text', text: `${slice.id}: ${slice.width}×${slice.height} px, original page y=${slice.y0}..${slice.y1} (page ${handoff.source.width}×${handoff.source.height}).\n${engine.OPEN_IMAGE_HINT}` },
            { type: 'image', data: bytes.toString('base64'), mimeType: row.mime }
          ]
        }
      }
      case 'fetch_step_image': {
        if (attempt.flow !== 'steps') return text('fetch_step_image belongs to the four-step flow; this page is on the one-prompt flow.', true)
        const id = String(input.arguments.image_id ?? '')
        const sourcePath = path.join(getSourceFolderPath((await this.chapterOf(job.chapterId)).folderPath), job.filename)
        const source = await fs.readFile(sourcePath).catch(() => null)
        if (!source || sha256(source) !== job.sourceSha256) return text('The source page changed or was removed; this attempt cannot continue.', true)
        const luma = await this.lumaOf(sourcePath, job.sourceSha256)
        const v = stepsFlow.view(attempt.stepsStateJson, attempt.reviewStateJson, handoff, () => luma, new Date().toISOString())
        const got = await stepsFlow.stepImage(id, v, handoff, source)
        if (!got) {
          const valid = v.plan ? stepsFlow.requiredImages(v.plan, handoff) : null
          return text(valid?.kind === 'step' && valid.ids.length
            ? `Unknown image_id "${id}" for this step. Valid: ${valid.ids.join(', ')}.`
            : 'This step has no Studio-made images; use fetch_slice for the page slices.', true)
        }
        delivered.add(`img:${id}`)
        await this.prisma.antigravityAttempt.update({ where: { id: attempt.id }, data: { deliveredJson: JSON.stringify([...delivered]) } })
        return { content: [{ type: 'text', text: `${got.caption}\n${engine.OPEN_IMAGE_HINT}` }, { type: 'image', data: got.image.data.toString('base64'), mimeType: got.image.mime }] }
      }
      case 'submit_step': {
        if (attempt.flow !== 'steps') return text('submit_step belongs to the four-step flow; use submit_analysis or submit_review.', true)
        if (attempt.submissions >= MAX_SUBMISSIONS_PER_STAGE) return text('Too many invalid submissions for this step.', true)
        const sourcePath = path.join(getSourceFolderPath((await this.chapterOf(job.chapterId)).folderPath), job.filename)
        const luma = await this.lumaOf(sourcePath, job.sourceSha256)
        const now = new Date().toISOString()
        const v = stepsFlow.view(attempt.stepsStateJson, attempt.reviewStateJson, handoff, () => luma, now)
        if (!v.plan) return text('This page has nothing left to submit. Reply with one word: SUBMITTED.')
        const need = stepsFlow.requiredImages(v.plan, handoff)
        const missing = need.ids.filter(id => !delivered.has(need.kind === 'slice' ? id : `img:${id}`))
        if (missing.length) return text(`Fetch and inspect every image of this step first (${need.kind === 'slice' ? 'fetch_slice' : 'fetch_step_image'}). Not yet fetched: ${missing.join(', ')}.`, true)
        // agy saves MCP images to files the model only sees by opening them; a step answered without opening
        // its images is a guess (live 2026-11-08: Gemini 3.8 Flash returned the prompt's example instead).
        if (attempt.engine === 'antigravity' && attempt.conversationId && need.ids.length) {
          const viewed = await readImagesViewed(attempt.conversationId, this.deps.cliHome)
          const unopened = viewed ? unopenedImages(viewed, need.ids) : []
          if (unopened.length) {
            await this.prisma.antigravityAttempt.update({ where: { id: attempt.id }, data: { submissions: { increment: 1 } } })
            return text([
              `Refused: you have not looked at ${unopened.map(u => u.id).join(', ')}. Studio's tools save each image to a file, and you only see it by opening that file.`,
              'Call read_file on each path below, look at the image, then answer this step again from what you see and call submit_step:',
              ...unopened.map(u => `- ${u.id}: ${u.file}`)
            ].join('\n'), true)
          }
        }
        const raw = typeof input.arguments.json === 'string' ? input.arguments.json : JSON.stringify(input.arguments.json ?? '')
        const out = stepsFlow.submit(raw, v, handoff, () => luma, now)
        if (!out.ok) {
          await this.prisma.antigravityAttempt.update({ where: { id: attempt.id }, data: { submissions: { increment: 1 }, ...(out.stepsJson && { stepsStateJson: out.stepsJson }) } })
          return text(out.reply, true)
        }
        await this.prisma.antigravityAttempt.update({
          where: { id: attempt.id },
          data: {
            stepsStateJson: out.stepsJson,
            ...(out.reviewJson && { reviewStateJson: out.reviewJson }),
            ...(out.analysisJson && { analysisJson: out.analysisJson, analysisSha256: sha256(out.analysisJson) }),
            ...(v.plan.stage === 'review' && { reviewRounds: { increment: 1 } }),
            submissions: 0,
            // Step images are per step: the next one is fetched afresh.
            deliveredJson: JSON.stringify([...delivered].filter(d => !d.startsWith('img:')))
          }
        })
        await this.event('checkpoint', `${job.filename}: ${out.event}`, { runId: job.runId, jobId: job.id, attemptId: attempt.id })
        return text(out.reply)
      }
      case 'submit_analysis': {
        if (attempt.flow === 'steps') return text('This page is on the four-step flow: answer the current step through submit_step.', true)
        if (attempt.stage !== 'analyzing') return text('The analysis was already accepted; wait for the review instructions.', true)
        const missing = handoff.slices.filter(s => !delivered.has(s.id)).map(s => s.id)
        if (missing.length) return text(`Fetch and inspect every slice first. Not yet fetched: ${missing.join(', ')}.`, true)
        if (attempt.submissions >= MAX_SUBMISSIONS_PER_STAGE) return text('Too many invalid submissions for this stage.', true)
        const raw = typeof input.arguments.json === 'string' ? input.arguments.json : JSON.stringify(input.arguments.json ?? '')
        const parsed = engine.acceptAnalysis(raw, handoff)
        if (!parsed.ok) {
          await this.prisma.antigravityAttempt.update({ where: { id: attempt.id }, data: { submissions: { increment: 1 } } })
          return text(parsed.correction, true)
        }
        await this.prisma.antigravityAttempt.update({
          where: { id: attempt.id },
          data: { analysisJson: parsed.analysisJson, analysisSha256: sha256(parsed.analysisJson), reviewStateJson: parsed.stateJson, stage: 'analysis_saved', submissions: 0 }
        })
        await this.event('checkpoint', `${job.filename}: analysis accepted (${parsed.count} candidates)`, { runId: job.runId, jobId: job.id, attemptId: attempt.id })
        return text('Analysis checkpoint accepted. Reply with one word: SUBMITTED.')
      }
      case 'submit_review': {
        if (attempt.flow === 'steps') return text('This page is on the four-step flow: answer the current step through submit_step.', true)
        if (attempt.stage !== 'reviewing') return text('No review is open right now.', true)
        if (attempt.submissions >= MAX_SUBMISSIONS_PER_STAGE) return text('Too many invalid submissions for this round.', true)
        const raw = typeof input.arguments.json === 'string' ? input.arguments.json : JSON.stringify(input.arguments.json ?? '')
        const luma = await engine.lumaFor(path.join(getSourceFolderPath((await this.chapterOf(job.chapterId)).folderPath), job.filename))
        const applied = engine.acceptReview(raw, attempt.reviewStateJson!, handoff, luma)
        if (!applied.ok) {
          await this.prisma.antigravityAttempt.update({ where: { id: attempt.id }, data: { submissions: { increment: 1 } } })
          return text(applied.correction, true)
        }
        await this.prisma.antigravityAttempt.update({ where: { id: attempt.id }, data: { reviewStateJson: applied.stateJson, reviewRounds: { increment: 1 }, submissions: 0 } })
        await this.event('checkpoint', `${job.filename}: review round accepted (${applied.count} crops${applied.blockers.length ? `, ${applied.blockers.length} open checks` : ''})`, { runId: job.runId, jobId: job.id, attemptId: attempt.id })
        return text(applied.blockers.length
          ? `Review accepted as revision ${applied.revision}. Studio will send a follow-up review for: ${applied.blockers.slice(0, 5).join('; ')}. Reply with one word: SUBMITTED.`
          : 'Review accepted. Reply with one word: SUBMITTED.')
      }
      default:
        return text(`Unknown tool ${input.tool}.`, true)
    }
  }

  // ─── Metadata (descriptions + English-script links of approved crops; one conversation per page) ───

  /**
   * One Metadata page: the chapter's current job (reviewed, cut, script) is re-read, a page that already has
   * valid Metadata is skipped, a page without crops is finished without the AI, and every other page gets a
   * conversation of its own that answers batch after batch through submit_metadata.
   */
  private async processMetadata(jobId: string, signal: AbortSignal) {
    let job = await this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
    const run = await this.prisma.antigravityRun.findUnique({ where: { id: job.runId }, select: { engine: true } })
    const settings = await this.deps.settings(engineOf(run?.engine))
    const chapter = await this.chapterOf(job.chapterId)
    if (this.deps.sourceBusy && await this.deps.sourceBusy(chapter.folderPath)) return void (await this.setStage(jobId, 'needs_attention', { lastError: 'A page replacement or series restart is in progress for this chapter. Retry when Library has finished.' }))
    if (await this.ownedElsewhere(job)) return void (await this.setStage(jobId, 'needs_attention', { lastError: 'Another run is making this page\'s Metadata right now; its result wins.' }))
    const meta = await this.metadataChapter(chapter)
    if ('reason' in meta) return void (await this.setStage(jobId, 'needs_attention', { lastError: meta.reason }))
    const current = meta.jobs.get(job.filename)
    if (!current) return void (await this.setStage(jobId, 'needs_attention', { lastError: 'This page is no longer in the chapter\'s approved cut.' }))
    if (await this.metadataSaved(chapter.folderPath, job.filename, current, meta.script)) return void (await this.setStage(jobId, 'skipped_existing', { lastError: 'Metadata was already saved for this cut (by a phone or by hand).' }))
    const payload = metadataFlow.payloadOf(current)
    // The cut or script may have changed since the page was queued: the job always works on the current one.
    if (job.manifestSha256 !== current.revision) {
      job = await this.prisma.antigravityPageJob.update({ where: { id: jobId }, data: { manifestJson: JSON.stringify(current), manifestSha256: current.revision, sourceSha256: payload.sourceSha256, width: payload.width, height: payload.height } })
    }
    if (payload.crops.length === 0) {
      // Nothing to describe: the page's (empty) Metadata needs no AI.
      const text = metadataFlow.buildResult(current, payload, metadataFlow.scriptOf(meta.script), metadataFlow.startState(current.revision))
      await this.prisma.antigravityPageJob.update({ where: { id: jobId }, data: { resultJson: text, resultSha256: sha256(text) } })
      return this.deliverMetadata(jobId)
    }
    if (settings.engine === 'antigravity' && TEXT_ONLY_MODEL.test(settings.model)) {
      await this.pauseRun(job.runId, `${settings.modelLabel ?? settings.model} has no image input, so it cannot see crops. Choose a vision model in Settings → AntiGravity, then start Metadata again.`)
      return void (await this.setStage(jobId, 'queued', { lastError: 'Waiting for a model that can see images.' }))
    }
    let account: CodexAccountRef | null = null
    if (settings.engine === 'codex' && this.deps.codexAccounts) {
      account = await this.deps.codexAccounts.pick()
      if (!account) {
        await this.pauseRun(job.runId, 'Every ChatGPT account Studio can use has reached its Codex limit (or is turned off). Resume when one resets — Settings → AntiGravity → ChatGPT (Codex) shows when.')
        return void (await this.setStage(jobId, 'queued', { lastError: 'Waiting for a ChatGPT account with Codex usage left.' }))
      }
    }
    const number = (await this.prisma.antigravityAttempt.count({ where: { jobId } })) + 1
    const attemptId = crypto.randomUUID()
    const workspace = path.join(this.deps.attemptRoot ?? ATTEMPT_ROOT, attemptId, 'workspace')
    const token = await this.grantCapability(workspace, settings.engine)
    await this.prisma.antigravityAttempt.create({
      data: {
        id: attemptId, jobId, number, status: 'active', stage: 'describing', capabilityHash: tokenHash(token), workspace, cliVersion: settings.cliVersion, engine: settings.engine, codexAccount: account?.id ?? null, requestedModel: settings.model,
        flow: 'metadata', stepsStateJson: metadataFlow.stateJson(metadataFlow.startState(current.revision))
      }
    })
    job = await this.setStage(jobId, 'describing', { currentAttemptId: attemptId, lastError: null })
    if (account) await this.event('account', `${job.filename}: running on ChatGPT account "${account.label}"`, { runId: job.runId, jobId, attemptId })
    await this.event('flow', `${job.filename}: Metadata for ${payload.crops.length} crops, ${metadataFlow.BATCH_SIZE} per batch, on ${settings.modelLabel ?? settings.model}`, { runId: job.runId, jobId, attemptId })
    const ctx: TurnContext = { jobId, attemptId, workspace, signal, model: settings.model, deadline: Date.now() + settings.pageTimeoutMinutes * 60_000, codexHome: account?.home ?? null }
    return this.runMetadata(ctx, settings)
  }

  /** The English script exactly as the Metadata job was made with (its hash is in the job). */
  private async metadataScript(folderPath: string, payload: metadataFlow.MetadataPayload): Promise<metadataFlow.Script | null> {
    const text = await fs.readFile(path.join(getSourceFolderPath(folderPath), 'script.md'), 'utf8').catch(() => null)
    if (text === null) return null
    try {
      const script = metadataFlow.scriptOf(text)
      return script.sha256 === payload.scriptSha256 ? script : null
    } catch { return null }
  }

  /** Batches in the attempt's one conversation until every crop has a record, then commit. */
  private async runMetadata(ctx: TurnContext, settings: RunSettings, effort = settings.effort) {
    const { jobId, attemptId, signal } = ctx
    const turn = this.turnRunner(ctx, settings, effort)
    const finish = this.finisher(jobId, attemptId)
    const job = await this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
    const chapter = await this.chapterOf(job.chapterId)
    const envelope = JSON.parse(job.manifestJson!) as metadataFlow.MetadataJobEnvelope
    const payload = metadataFlow.payloadOf(envelope)
    const script = await this.metadataScript(chapter.folderPath, payload)
    if (!script) return finish('needs_attention', 'needs_attention', 'The chapter\'s English script changed or is missing since this page was queued. Retry to use the current script.')
    const load = () => this.prisma.antigravityAttempt.findUniqueOrThrow({ where: { id: attemptId } })
    const done = (a: { stepsStateJson: string | null }) => Object.keys(metadataFlow.parseState(a.stepsStateJson, envelope.revision).records).length
    let stalls = 0
    for (;;) {
      if (signal.aborted) return finish('cancelled', 'cancelled', 'Stopped by the operator.')
      let attempt = await load()
      const state = metadataFlow.parseState(attempt.stepsStateJson, envelope.revision)
      const batch = metadataFlow.nextBatch(payload, state)
      if (!batch.length) break
      await this.event('step', `${job.filename}: Metadata batch ${state.batches + 1} (${batch.length} of ${payload.crops.length} crops)`, { runId: job.runId, jobId, attemptId })
      const before = done(attempt)
      let result = await turn(metadataFlow.batchPrompt(envelope, payload, script, state), attempt.conversationId)
      attempt = await load()
      for (let nudge = 0; done(attempt) === before && nudge < CONTINUATION_BUDGET; nudge++) {
        if (signal.aborted || !this.continuable(result) || !attempt.conversationId) break
        await this.event('continue', `${job.filename}: Metadata not submitted; continuing the same conversation (${nudge + 1}/${CONTINUATION_BUDGET})`, { runId: job.runId, jobId, attemptId })
        result = await turn(metadataFlow.continuationPrompt(this.deniedNames(result), batch), attempt.conversationId)
        attempt = await load()
      }
      if (signal.aborted) return finish('cancelled', 'cancelled', 'Stopped by the operator.')
      if (result.envelope?.conversation_id && attempt.conversationId && result.envelope.conversation_id !== attempt.conversationId) return finish('failed', 'failed', 'A Metadata turn answered from a different conversation.')
      if (done(attempt) !== before) {
        stalls = 0
        if (!attempt.conversationId) return finish('failed', 'failed', `${label(settings.engine)} returned no conversation ID, so the next batch cannot continue the same conversation.`)
        continue
      }
      const stop = await this.providerStop(job.runId, result, attemptId)
      if (stop) return finish('interrupted', stop === 'switched' ? 'queued' : 'interrupted', this.turnFailure(result, 'No Metadata.'))
      // Ask the same batch once more, whole, with a fresh submission allowance.
      if (++stalls > 1 || !this.continuable(result) || !attempt.conversationId) {
        const status = before === 0 && !result.envelope?.denied_actions?.length ? 'failed' : 'needs_attention'
        return finish(status, status, this.turnFailure(result, 'No valid Metadata was submitted through Studio\'s tool.'))
      }
      await this.prisma.antigravityAttempt.update({ where: { id: attemptId }, data: { submissions: 0 } })
    }
    await this.commitMetadata(ctx)
  }

  /** Commit boundary: only the current, active attempt of an unchanged cut + script is saved. */
  private async commitMetadata(ctx: TurnContext) {
    const { jobId, attemptId, signal } = ctx
    const job = await this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
    const attempt = await this.prisma.antigravityAttempt.findUniqueOrThrow({ where: { id: attemptId } })
    if (signal.aborted || attempt.status !== 'active' || job.currentAttemptId !== attemptId) return void (await this.event('stage', `${job.filename}: Metadata discarded (attempt stopped or superseded)`, { runId: job.runId, jobId, attemptId }))
    const finish = this.finisher(jobId, attemptId)
    await this.setStage(jobId, 'validating')
    const envelope = JSON.parse(job.manifestJson!) as metadataFlow.MetadataJobEnvelope
    const meta = await this.metadataChapter(await this.chapterOf(job.chapterId))
    if ('reason' in meta) return finish('needs_attention', 'needs_attention', meta.reason)
    const current = meta.jobs.get(job.filename)
    if (current?.revision !== envelope.revision) return finish('needs_attention', 'needs_attention', 'The approved cut or the English script changed while this page ran. Retry to make its Metadata again.')
    const text = metadataFlow.buildResult(envelope, metadataFlow.payloadOf(envelope), metadataFlow.scriptOf(meta.script), metadataFlow.parseState(attempt.stepsStateJson, envelope.revision))
    validateMetadataResult(text, current, meta.script)
    await this.prisma.antigravityPageJob.update({ where: { id: jobId }, data: { resultJson: text, resultSha256: sha256(text) } })
    await this.prisma.antigravityAttempt.update({ where: { id: attemptId }, data: { stage: 'done', status: 'completed', finishedAt: new Date() } })
    await this.recordToolUse(attemptId)
    await this.deliverMetadata(jobId)
  }

  /** Saves the page's Metadata through Clipper's own importer (it validates against the current cut again). Never calls the AI. */
  async deliverMetadata(jobId: string) {
    const job = await this.setStage(jobId, 'delivering')
    if (!job.resultJson) throw new Error('No validated Metadata to save.')
    const chapter = await this.chapterOf(job.chapterId)
    let written: boolean
    try {
      written = await importMetadataResult({ id: chapter.id, number: chapter.number, folderPath: chapter.folderPath, seriesId: chapter.series.id, series: { title: chapter.series.title } }, job.filename, job.resultJson)
    } catch (error) {
      // A result for an older cut or script can never be saved: Retry makes it again.
      return void (await this.setStage(jobId, 'needs_attention', { importState: 'failed', resultJson: null, resultSha256: null, lastError: `Metadata not saved: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500) }))
    }
    if (written) this.deps.onPointersChanged?.()
    const crops = (JSON.parse(job.resultJson).crops ?? []).length
    await this.setStage(jobId, 'done', { importState: 'imported', lastError: null })
    await this.event('metadata', `${job.filename}: Metadata saved (${crops} crop${crops === 1 ? '' : 's'})`, { runId: job.runId, jobId })
  }

  /** Continue a Metadata page left in Needs attention / Interrupted, in its own conversation, from the batches already accepted. */
  private async metadataAgain(jobId: string) {
    const job = await this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
    if (!['needs_attention', 'interrupted'].includes(job.stage)) throw new Error('Continue is for Metadata pages left in Needs attention or Interrupted.')
    const attempt = job.currentAttemptId ? await this.prisma.antigravityAttempt.findUnique({ where: { id: job.currentAttemptId } }) : null
    if (!attempt?.conversationId || attempt.flow !== 'metadata' || !job.manifestJson) throw new Error('This page has no Metadata conversation to continue; use Retry instead.')
    const envelope = JSON.parse(job.manifestJson) as metadataFlow.MetadataJobEnvelope
    const meta = await this.metadataChapter(await this.chapterOf(job.chapterId))
    if ('reason' in meta) throw new Error(meta.reason)
    if (meta.jobs.get(job.filename)?.revision !== envelope.revision) throw new Error('The approved cut or the English script changed since this conversation; use Retry.')
    const run = await this.prisma.antigravityRun.findUniqueOrThrow({ where: { id: job.runId } })
    const settings = await this.deps.settings(engineOf(attempt.engine))
    const account = attempt.codexAccount && this.deps.codexAccounts ? await this.deps.codexAccounts.get(attempt.codexAccount) : null
    if (attempt.codexAccount && this.deps.codexAccounts && !account) throw new Error('The ChatGPT account this conversation ran on was removed; use Retry (new conversation) instead.')
    const runId = await this.enterProcess(job, engineOf(attempt.engine))
    const token = await this.grantCapability(attempt.workspace, engineOf(attempt.engine))
    await this.prisma.antigravityAttempt.update({ where: { id: attempt.id }, data: { status: 'active', stage: 'describing', capabilityHash: tokenHash(token), submissions: 0, error: null, finishedAt: null } })
    await this.setStage(jobId, 'describing', { lastError: null })
    await this.event('review', `${job.filename}: continue Metadata in conversation ${attempt.conversationId}`, { runId, jobId, attemptId: attempt.id })
    const controller = new AbortController()
    this.live.set(jobId, { controller, runId, kind: 'ai' })
    const ctx: TurnContext = { jobId, attemptId: attempt.id, workspace: attempt.workspace, signal: controller.signal, model: attempt.requestedModel, deadline: Date.now() + settings.pageTimeoutMinutes * 60_000, codexHome: account?.home ?? null }
    void this.runMetadata(ctx, settings, run.effort)
      .catch(async error => {
        const now = await this.prisma.antigravityPageJob.findUnique({ where: { id: jobId } })
        if (now && !TERMINAL_STAGES.has(now.stage)) await this.setStage(jobId, 'failed', { lastError: error instanceof Error ? error.message : String(error) })
        await this.prisma.antigravityAttempt.updateMany({ where: { id: attempt.id, status: 'active' }, data: { status: 'failed', error: error instanceof Error ? error.message : String(error), finishedAt: new Date() } })
      })
      .finally(() => this.live.delete(jobId))
    void this.schedule(runId, false)
    return this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
  }

  /** One approved crop as the model sees it: the cut file itself (checked against the cut receipt), at most 2000 px. */
  private async metadataCropImage(folderPath: string, payload: metadataFlow.MetadataPayload, crop: metadataFlow.MetadataCrop): Promise<{ data: Buffer; width: number; height: number } | { error: string }> {
    const bytes = await fs.readFile(path.join(getOutputDir(folderPath), crop.exportedFilename)).catch(() => null)
    if (!bytes) return { error: `${crop.exportedFilename} is missing from the chapter's crops; this attempt cannot continue.` }
    const receipt = await fs.readFile(path.join(getSourceFolderPath(folderPath), CUT_RECEIPT), 'utf8').then(t => JSON.parse(t), () => null)
    const entry = Array.isArray(receipt?.files) ? receipt.files.find((f: { filename?: string }) => f.filename === crop.exportedFilename) : null
    if (receipt?.revision !== payload.cutRevision || !entry || entry.sha256 !== sha256(bytes)) return { error: 'The chapter was cut again after this page was queued; this attempt cannot continue.' }
    const out = await sharp(bytes).resize({ width: METADATA_IMAGE_MAX, height: METADATA_IMAGE_MAX, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer({ resolveWithObject: true })
    return { data: out.data, width: out.info.width, height: out.info.height }
  }

  /** MCP tools of a Metadata attempt: get_job_context, fetch_crop, submit_metadata. */
  private async callMetadata(attempt: AttemptRow, job: JobRow, input: { tool: string; arguments: Record<string, unknown> }) {
    const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError && { isError: true }) })
    const envelope = JSON.parse(job.manifestJson!) as metadataFlow.MetadataJobEnvelope
    const payload = metadataFlow.payloadOf(envelope)
    const state = metadataFlow.parseState(attempt.stepsStateJson, envelope.revision)
    const delivered = new Set<string>(JSON.parse(attempt.deliveredJson))
    const folderPath = (await this.chapterOf(job.chapterId)).folderPath
    switch (input.tool) {
      case 'get_job_context':
        return text(metadataFlow.jobContextText(job.id, payload, state))
      case 'fetch_crop': {
        const id = String(input.arguments.image_id ?? '')
        const index = payload.crops.findIndex(c => c.exportedFilename === id)
        if (index < 0) return text(`Unknown image_id "${id}". Requested now: ${metadataFlow.nextBatch(payload, state).map(c => c.exportedFilename).join(', ') || 'none'}.`, true)
        const image = await this.metadataCropImage(folderPath, payload, payload.crops[index])
        if ('error' in image) return text(image.error, true)
        delivered.add(`crop:${id}`)
        await this.prisma.antigravityAttempt.update({ where: { id: attempt.id }, data: { deliveredJson: JSON.stringify([...delivered]) } })
        return {
          content: [
            { type: 'text', text: `${id}: crop ${index + 1} of ${payload.crops.length} on ${payload.page} (${image.width}×${image.height} px as shown).\n${engine.OPEN_IMAGE_HINT}` },
            { type: 'image', data: image.data.toString('base64'), mimeType: 'image/jpeg' }
          ]
        }
      }
      case 'submit_metadata': {
        if (attempt.stage !== 'describing') return text('No Metadata batch is open right now.', true)
        if (attempt.submissions >= MAX_SUBMISSIONS_PER_STAGE) return text('Too many invalid submissions for this batch.', true)
        const batch = metadataFlow.nextBatch(payload, state)
        if (!batch.length) return text('Every crop on this page already has Metadata. Reply with one word: SUBMITTED.')
        const missing = batch.filter(c => !delivered.has(`crop:${c.exportedFilename}`)).map(c => c.exportedFilename)
        if (missing.length) return text(`Fetch and inspect every requested crop first (fetch_crop). Not yet fetched: ${missing.join(', ')}.`, true)
        // agy saves MCP images to files the model only sees by opening them (see submit_step).
        if (attempt.engine === 'antigravity' && attempt.conversationId) {
          const viewed = await readImagesViewed(attempt.conversationId, this.deps.cliHome)
          const unopened = viewed ? unopenedImages(viewed, batch.map(c => c.exportedFilename)) : []
          if (unopened.length) {
            await this.prisma.antigravityAttempt.update({ where: { id: attempt.id }, data: { submissions: { increment: 1 } } })
            return text([
              `Refused: you have not looked at ${unopened.map(u => u.id).join(', ')}. Studio's tools save each image to a file, and you only see it by opening that file.`,
              'Call read_file on each path below, look at the image, then describe the batch again from what you see and call submit_metadata:',
              ...unopened.map(u => `- ${u.id}: ${u.file}`)
            ].join('\n'), true)
          }
        }
        const script = await this.metadataScript(folderPath, payload)
        if (!script) return text('The chapter\'s English script changed since this page was queued. Stop working on this page.', true)
        const raw = typeof input.arguments.json === 'string' ? input.arguments.json : JSON.stringify(input.arguments.json ?? '')
        const accepted = metadataFlow.acceptBatch(raw, envelope, script, batch)
        if (!accepted.ok) {
          await this.prisma.antigravityAttempt.update({ where: { id: attempt.id }, data: { submissions: { increment: 1 } } })
          return text(metadataFlow.correctionText(accepted.errors), true)
        }
        const next: metadataFlow.MetadataState = { ...state, batches: state.batches + 1, records: { ...state.records, ...Object.fromEntries(accepted.records.map(r => [r.exportedFilename, r])) } }
        await this.prisma.antigravityAttempt.update({ where: { id: attempt.id }, data: { stepsStateJson: metadataFlow.stateJson(next), submissions: 0 } })
        const left = metadataFlow.remaining(payload, next).length
        const count = payload.crops.length - left
        await this.event('checkpoint', `${job.filename}: Metadata batch accepted (${count} of ${payload.crops.length} crops)`, { runId: job.runId, jobId: job.id, attemptId: attempt.id })
        return text(left
          ? `Batch accepted (${count} of ${payload.crops.length} crops). Studio will send the next batch. Reply with one word: SUBMITTED.`
          : 'Metadata accepted for every crop on this page. Reply with one word: SUBMITTED.')
      }
      default:
        return text(`Unknown tool ${input.tool}. This page's tools are get_job_context, fetch_crop and submit_metadata.`, true)
    }
  }

  // ─── Timeline (a chapter's Editor 2.0 timeline JSON per language; one conversation per chapter) ───

  private editorDeps(): editorFlow.EditorDeps {
    if (!this.deps.editor) throw new Error('Timeline is not available in this Studio build.')
    return this.deps.editor
  }

  /** "Chapter 12 · English" for a Timeline job's events. */
  private async editorLabel(job: { chapterId: string; filename: string }) {
    const chapter = await this.prisma.chapter.findUnique({ where: { id: job.chapterId }, select: { number: true } })
    const language = editorFlow.languageOfFilename(job.filename)
    return `Chapter ${chapter?.number ?? '?'} · ${language ? editorFlow.languageLabel(language) : job.filename}`
  }

  /** The current Editor inputs' revision for [method] (one-shot: package + Editor 2.0 prompt; small batches: the workflow's sources). Throws why there is none. */
  private async editorRevision(chapterId: string, language: NarrationLanguage, method: editorFlow.EditorMethod): Promise<string> {
    const editor = this.editorDeps()
    if (method === 'oneshot') {
      const input = await editor.oneShot(chapterId, language)
      if ('reason' in input) throw new Error(input.reason)
      return input.revision
    }
    return (await editor.batches(chapterId, language)).sourceHash
  }

  /** Whether one chapter can have its timeline made now: ready in Editor 2.0 (voiceover, alignment, cut crops + metadata), no timeline saved. */
  private async inspectEditor(chapter: { id: string; folderPath: string }, language: NarrationLanguage, method: editorFlow.EditorMethod): Promise<AcceptedPage | { reason: string }> {
    const editor = this.editorDeps()
    if (await editor.savedTimeline(chapter.id, language)) return { reason: 'Timeline already saved.' }
    const blockers = await editor.blockers(chapter.id, language)
    if (blockers.length) return { reason: `Not ready in Editor 2.0: ${blockers.join(', ')}` }
    let revision: string
    try { revision = await this.editorRevision(chapter.id, language, method) } catch (error) { return { reason: error instanceof Error ? error.message : String(error) } }
    const manifest: editorFlow.EditorManifest = { schema: editorFlow.MANIFEST_SCHEMA, method, language, revision }
    return {
      chapterId: chapter.id, filename: editorFlow.timelineFilename(language), pageIndex: editorFlow.languageIndex(language), sourceSha256: revision,
      width: 0, height: 0, folderPath: chapter.folderPath, preexisting: 'none', manifestJson: JSON.stringify(manifest)
    }
  }

  private async chapterInfo(chapterId: string): Promise<editorFlow.ChapterInfo> {
    const chapter = await this.prisma.chapter.findUniqueOrThrow({ where: { id: chapterId }, select: { number: true, title: true, series: { select: { title: true } } } })
    return { series: chapter.series.title, number: chapter.number, title: chapter.title }
  }

  /**
   * One chapter's timeline in one language: its inputs are re-read (a chapter that got a timeline meanwhile is
   * skipped), then a conversation of its own makes it by the run's method.
   */
  private async processEditor(jobId: string, signal: AbortSignal) {
    let job = await this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
    const run = await this.prisma.antigravityRun.findUnique({ where: { id: job.runId }, select: { engine: true } })
    const settings = await this.deps.settings(engineOf(run?.engine))
    const chapter = await this.chapterOf(job.chapterId)
    const manifest = editorFlow.parseManifest(job.manifestJson)
    if (!manifest) return void (await this.setStage(jobId, 'needs_attention', { lastError: 'This timeline job has no inputs. Start the chapter again from the Timeline page.' }))
    if (this.deps.sourceBusy && await this.deps.sourceBusy(chapter.folderPath)) return void (await this.setStage(jobId, 'needs_attention', { lastError: 'A page replacement or series restart is in progress for this chapter. Retry when Library has finished.' }))
    if (await this.ownedElsewhere(job)) return void (await this.setStage(jobId, 'needs_attention', { lastError: 'Another run is making this chapter\'s timeline right now; its result wins.' }))
    if (await this.editorDeps().savedTimeline(chapter.id, manifest.language)) return void (await this.setStage(jobId, 'skipped_existing', { lastError: 'A timeline was already saved for this chapter (pasted, fetched from a phone or made earlier).' }))
    const checked = await this.inspectEditor(chapter, manifest.language, manifest.method)
    if ('reason' in checked) return void (await this.setStage(jobId, 'needs_attention', { lastError: checked.reason }))
    // The inputs may have changed since the chapter was queued: the job always works on the current ones.
    if (checked.sourceSha256 !== job.sourceSha256) job = await this.prisma.antigravityPageJob.update({ where: { id: jobId }, data: { manifestJson: checked.manifestJson!, manifestSha256: checked.sourceSha256, sourceSha256: checked.sourceSha256 } })
    const current = editorFlow.parseManifest(job.manifestJson)!
    let account: CodexAccountRef | null = null
    if (settings.engine === 'codex' && this.deps.codexAccounts) {
      account = await this.deps.codexAccounts.pick()
      if (!account) {
        await this.pauseRun(job.runId, 'Every ChatGPT account Studio can use has reached its Codex limit (or is turned off). Resume when one resets — Settings → AntiGravity → ChatGPT (Codex) shows when.')
        return void (await this.setStage(jobId, 'queued', { lastError: 'Waiting for a ChatGPT account with Codex usage left.' }))
      }
    }
    const number = (await this.prisma.antigravityAttempt.count({ where: { jobId } })) + 1
    const attemptId = crypto.randomUUID()
    const workspace = path.join(this.deps.attemptRoot ?? ATTEMPT_ROOT, attemptId, 'workspace')
    const token = await this.grantCapability(workspace, settings.engine)
    await this.prisma.antigravityAttempt.create({
      data: {
        id: attemptId, jobId, number, status: 'active', stage: 'planning', capabilityHash: tokenHash(token), workspace, cliVersion: settings.cliVersion, engine: settings.engine, codexAccount: account?.id ?? null, requestedModel: settings.model,
        flow: `editor-${current.method}`, stepsStateJson: editorFlow.stateJson(editorFlow.startState(current))
      }
    })
    job = await this.setStage(jobId, 'planning', { currentAttemptId: attemptId, lastError: null })
    const name = await this.editorLabel(job)
    if (account) await this.event('account', `${name}: running on ChatGPT account "${account.label}"`, { runId: job.runId, jobId, attemptId })
    await this.event('flow', `${name}: ${editorFlow.METHOD_LABELS[current.method]} timeline on ${settings.modelLabel ?? settings.model}`, { runId: job.runId, jobId, attemptId })
    const ctx: TurnContext = { jobId, attemptId, workspace, signal, model: settings.model, deadline: Date.now() + settings.pageTimeoutMinutes * 60_000, codexHome: account?.home ?? null }
    return this.runEditor(ctx, settings)
  }

  /** The attempt's turns: one-shot until a timeline is accepted, small batches until every batch is in; then commit. */
  private async runEditor(ctx: TurnContext, settings: RunSettings, effort = settings.effort) {
    const { jobId, attemptId, signal } = ctx
    const turn = this.turnRunner(ctx, settings, effort)
    const finish = this.finisher(jobId, attemptId)
    const job = await this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
    const manifest = editorFlow.parseManifest(job.manifestJson)!
    const editor = this.editorDeps()
    const chapter = await this.chapterInfo(job.chapterId)
    const name = await this.editorLabel(job)
    const load = () => this.prisma.antigravityAttempt.findUniqueOrThrow({ where: { id: attemptId } })
    const stateOf = (a: { stepsStateJson: string | null }) => editorFlow.parseState(a.stepsStateJson, manifest)
    // Each turn gets the full time limit: a chapter in small batches takes many turns.
    const freshDeadline = () => { ctx.deadline = Date.now() + settings.pageTimeoutMinutes * 60_000 }

    if (manifest.method === 'oneshot') {
      const input = await editor.oneShot(job.chapterId, manifest.language)
      if ('reason' in input) return finish('needs_attention', 'needs_attention', input.reason)
      if (input.revision !== manifest.revision) return finish('needs_attention', 'needs_attention', 'The chapter\'s Editor inputs or the Editor 2.0 prompt changed since it was queued. Retry to use the current ones.')
      let attempt = await load()
      if (!stateOf(attempt).json) {
        const prompt = attempt.conversationId
          ? editorFlow.oneShotContinuation([], stateOf(attempt).issues, manifest.language)
          : editorFlow.oneShotPrompt(input, chapter, manifest.language)
        if (Buffer.byteLength(prompt) > editorFlow.MAX_PROMPT_BYTES) return finish('failed', 'failed', `This chapter's one-shot prompt is ${Math.round(Buffer.byteLength(prompt) / 1000)} kB, more than the CLI can take in one message. Use Small batches for it.`)
        freshDeadline()
        let result = await turn(prompt, attempt.conversationId)
        attempt = await load()
        for (let nudge = 0; !stateOf(attempt).json && nudge < CONTINUATION_BUDGET; nudge++) {
          if (signal.aborted || !this.continuable(result) || !attempt.conversationId) break
          await this.event('continue', `${name}: timeline not accepted; continuing the same conversation (${nudge + 1}/${CONTINUATION_BUDGET})`, { runId: job.runId, jobId, attemptId })
          await this.prisma.antigravityAttempt.update({ where: { id: attemptId }, data: { submissions: 0 } })
          freshDeadline()
          result = await turn(editorFlow.oneShotContinuation(this.deniedNames(result), stateOf(attempt).issues, manifest.language), attempt.conversationId)
          attempt = await load()
        }
        if (signal.aborted) return finish('cancelled', 'cancelled', 'Stopped by the operator.')
        if (result.envelope?.conversation_id && attempt.conversationId && result.envelope.conversation_id !== attempt.conversationId) return finish('failed', 'failed', 'A timeline turn answered from a different conversation.')
        if (!stateOf(attempt).json) {
          const stop = await this.providerStop(job.runId, result, attemptId)
          if (stop) return finish('interrupted', stop === 'switched' ? 'queued' : 'interrupted', this.turnFailure(result, 'No timeline.'))
          const issues = stateOf(attempt).issues
          const status = attempt.conversationId && (issues.length || result.envelope?.denied_actions?.length) ? 'needs_attention' : 'failed'
          return finish(status, status, this.turnFailure(result, issues.length ? `The timeline still has problems: ${issues.slice(0, 3).join(' ')}` : 'No timeline was submitted through Studio\'s tool.'))
        }
      }
      return this.commitEditor(ctx)
    }

    // Small batches: the checkpoint is Editor's own, so every accepted batch stays even if this attempt stops.
    let stalls = 0
    for (let turns = 0; ; turns++) {
      if (signal.aborted) return finish('cancelled', 'cancelled', 'Stopped by the operator.')
      let view: editorFlow.BatchView
      try { view = await editor.batches(job.chapterId, manifest.language) } catch (error) { return finish('needs_attention', 'needs_attention', error instanceof Error ? error.message : String(error)) }
      if (view.sourceHash !== manifest.revision) return finish('needs_attention', 'needs_attention', 'The chapter\'s Editor inputs changed since it was queued. Retry to use the current ones.')
      if (view.error) return finish('needs_attention', 'needs_attention', view.error)
      if (!view.task) break
      if (turns >= editorFlow.MAX_BATCH_TURNS) return finish('needs_attention', 'needs_attention', `Stopped after ${editorFlow.MAX_BATCH_TURNS} turns with ${view.completed} batches accepted. Continue goes on from there.`)
      let attempt = await load()
      await this.prisma.antigravityAttempt.update({ where: { id: attemptId }, data: { stepsStateJson: editorFlow.stateJson({ ...stateOf(attempt), tasksThisTurn: 0 }), submissions: 0 } })
      await this.event('step', `${name}: small batches — ${view.completed} accepted, next ${view.task.label}`, { runId: job.runId, jobId, attemptId })
      const before = view.revision
      const moved = async () => (await editor.batches(job.chapterId, manifest.language).catch(() => null))?.revision !== before
      freshDeadline()
      let result = await turn(attempt.conversationId ? editorFlow.batchesNextTurn(view) : editorFlow.batchesPrompt(chapter, manifest, view), attempt.conversationId)
      attempt = await load()
      for (let nudge = 0; !(await moved()) && nudge < CONTINUATION_BUDGET; nudge++) {
        if (signal.aborted || !this.continuable(result) || !attempt.conversationId) break
        await this.event('continue', `${name}: no batch accepted; continuing the same conversation (${nudge + 1}/${CONTINUATION_BUDGET})`, { runId: job.runId, jobId, attemptId })
        await this.prisma.antigravityAttempt.update({ where: { id: attemptId }, data: { stepsStateJson: editorFlow.stateJson({ ...stateOf(attempt), tasksThisTurn: 0 }), submissions: 0 } })
        freshDeadline()
        result = await turn(editorFlow.batchesNextTurn(view, this.deniedNames(result)), attempt.conversationId)
        attempt = await load()
      }
      if (signal.aborted) return finish('cancelled', 'cancelled', 'Stopped by the operator.')
      if (result.envelope?.conversation_id && attempt.conversationId && result.envelope.conversation_id !== attempt.conversationId) return finish('failed', 'failed', 'A timeline turn answered from a different conversation.')
      if (await moved()) {
        stalls = 0
        if (!attempt.conversationId) return finish('failed', 'failed', `${label(settings.engine)} returned no conversation ID, so the next batches cannot continue the same conversation.`)
        continue
      }
      const stop = await this.providerStop(job.runId, result, attemptId)
      if (stop) return finish('interrupted', stop === 'switched' ? 'queued' : 'interrupted', this.turnFailure(result, 'No batch answered.'))
      if (++stalls > 1 || !this.continuable(result) || !attempt.conversationId) {
        const status = stateOf(attempt).accepted === 0 && !result.envelope?.denied_actions?.length ? 'failed' : 'needs_attention'
        return finish(status, status, this.turnFailure(result, `No valid answer for ${view.task.label} was submitted through Studio's tool.`))
      }
    }
    return this.commitEditor(ctx)
  }

  /** Commit boundary: only the current, active attempt's timeline for unchanged inputs is checked by Editor's processor and saved. */
  private async commitEditor(ctx: TurnContext) {
    const { jobId, attemptId, signal } = ctx
    const job = await this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
    const attempt = await this.prisma.antigravityAttempt.findUniqueOrThrow({ where: { id: attemptId } })
    const name = await this.editorLabel(job)
    if (signal.aborted || attempt.status !== 'active' || job.currentAttemptId !== attemptId) return void (await this.event('stage', `${name}: timeline discarded (attempt stopped or superseded)`, { runId: job.runId, jobId, attemptId }))
    const finish = this.finisher(jobId, attemptId)
    await this.setStage(jobId, 'validating')
    const manifest = editorFlow.parseManifest(job.manifestJson)!
    const editor = this.editorDeps()
    const state = editorFlow.parseState(attempt.stepsStateJson, manifest)
    let json: string | null
    try {
      if (await this.editorRevision(job.chapterId, manifest.language, manifest.method) !== manifest.revision) return finish('needs_attention', 'needs_attention', 'The chapter\'s Editor inputs changed while its timeline was made. Retry to make it again.')
      json = manifest.method === 'oneshot' ? state.json : (await editor.batches(job.chapterId, manifest.language)).json
    } catch (error) { return finish('needs_attention', 'needs_attention', error instanceof Error ? error.message : String(error)) }
    if (!json) return finish('needs_attention', 'needs_attention', 'No finished timeline to save.')
    const processed = await editor.process(job.chapterId, json, manifest.language).catch((error: Error) => ({ missingRefs: [] as string[], warnings: [] as string[], error: error.message }))
    if ('error' in processed) return finish('needs_attention', 'needs_attention', `Editor 2.0 cannot read this timeline: ${processed.error}`)
    if (processed.missingRefs.length) {
      // One-shot: Continue asks the same conversation to fix exactly these.
      const issues = processed.missingRefs.slice(0, 25).map(r => `"${r}" doesn't resolve to a crop file of this chapter.`)
      if (manifest.method === 'oneshot') await this.prisma.antigravityAttempt.update({ where: { id: attemptId }, data: { stepsStateJson: editorFlow.stateJson({ ...state, json: null, issues }) } })
      return finish('needs_attention', 'needs_attention', `Editor 2.0 cannot find ${processed.missingRefs.length} image${processed.missingRefs.length === 1 ? '' : 's'}: ${processed.missingRefs.slice(0, 3).join(', ')}`)
    }
    await this.prisma.antigravityPageJob.update({ where: { id: jobId }, data: { resultJson: json, resultSha256: sha256(json) } })
    await this.prisma.antigravityAttempt.update({ where: { id: attemptId }, data: { stage: 'done', status: 'completed', finishedAt: new Date() } })
    await this.recordToolUse(attemptId)
    if (processed.warnings.length) await this.event('timeline', `${name}: Editor 2.0 notes — ${processed.warnings.slice(0, 3).join('; ')}`.slice(0, 900), { runId: job.runId, jobId })
    await this.deliverEditor(jobId)
  }

  /** Saves the timeline in Editor 2.0 (unprocessed, like a paste) unless one was saved meanwhile; Editor sends it to the phones. Never calls the AI. */
  async deliverEditor(jobId: string) {
    const job = await this.setStage(jobId, 'delivering')
    if (!job.resultJson) throw new Error('No checked timeline to save.')
    const manifest = editorFlow.parseManifest(job.manifestJson)
    if (!manifest) throw new Error('This timeline job has no inputs.')
    const editor = this.editorDeps()
    const name = await this.editorLabel(job)
    if (await editor.savedTimeline(job.chapterId, manifest.language)) {
      return void (await this.setStage(jobId, 'skipped_existing', { importState: 'skipped', lastError: 'A timeline was saved for this chapter while this one was made (pasted or from a phone); that one was kept.' }))
    }
    const attempt = job.currentAttemptId ? await this.prisma.antigravityAttempt.findUnique({ where: { id: job.currentAttemptId } }) : null
    const engine = engineOf(attempt?.engine)
    // agy doesn't report the model it served ("unknown"): the requested one stands in.
    const served = attempt?.observedModel && attempt.observedModel !== 'unknown' ? attempt.observedModel : attempt?.requestedModel ?? 'unknown model'
    const model = `Studio AntiGravity (${label(engine)} · ${served}, ${editorFlow.METHOD_LABELS[manifest.method]})`
    try {
      await editor.save(job.chapterId, manifest.language, job.resultJson, model)
    } catch (error) {
      return void (await this.setStage(jobId, 'needs_attention', { importState: 'failed', lastError: `Timeline not saved: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500) }))
    }
    await this.setStage(jobId, 'done', { importState: 'imported', lastError: null })
    await this.event('timeline', `${name}: timeline saved in Editor 2.0 — open the chapter there and Start Processing. Editor sends it to the phones.`, { runId: job.runId, jobId })
  }

  /** Continue a timeline left in Needs attention / Interrupted, in its own conversation (small batches: from the accepted batches). */
  private async editorAgain(jobId: string) {
    const job = await this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
    if (!['needs_attention', 'interrupted'].includes(job.stage)) throw new Error('Continue is for timelines left in Needs attention or Interrupted.')
    const attempt = job.currentAttemptId ? await this.prisma.antigravityAttempt.findUnique({ where: { id: job.currentAttemptId } }) : null
    const manifest = editorFlow.parseManifest(job.manifestJson)
    if (!attempt?.conversationId || !attempt.flow?.startsWith('editor-') || !manifest) throw new Error('This chapter has no timeline conversation to continue; use Retry instead.')
    if (await this.editorDeps().savedTimeline(job.chapterId, manifest.language)) throw new Error('This chapter has a timeline saved now (pasted or from a phone).')
    let revision: string
    try { revision = await this.editorRevision(job.chapterId, manifest.language, manifest.method) } catch (error) { throw new Error(`Not ready: ${error instanceof Error ? error.message : String(error)}`) }
    if (revision !== manifest.revision) throw new Error('The chapter\'s Editor inputs changed since this conversation; use Retry.')
    const run = await this.prisma.antigravityRun.findUniqueOrThrow({ where: { id: job.runId } })
    const settings = await this.deps.settings(engineOf(attempt.engine))
    const account = attempt.codexAccount && this.deps.codexAccounts ? await this.deps.codexAccounts.get(attempt.codexAccount) : null
    if (attempt.codexAccount && this.deps.codexAccounts && !account) throw new Error('The ChatGPT account this conversation ran on was removed; use Retry (new conversation) instead.')
    const runId = await this.enterProcess(job, engineOf(attempt.engine))
    const token = await this.grantCapability(attempt.workspace, engineOf(attempt.engine))
    const state = editorFlow.parseState(attempt.stepsStateJson, manifest)
    await this.prisma.antigravityAttempt.update({ where: { id: attempt.id }, data: { status: 'active', stage: 'planning', capabilityHash: tokenHash(token), submissions: 0, error: null, finishedAt: null, stepsStateJson: editorFlow.stateJson({ ...state, tasksThisTurn: 0 }) } })
    await this.setStage(jobId, 'planning', { lastError: null })
    await this.event('review', `${await this.editorLabel(job)}: continue the timeline in conversation ${attempt.conversationId}`, { runId, jobId, attemptId: attempt.id })
    const controller = new AbortController()
    this.live.set(jobId, { controller, runId, kind: 'ai' })
    const ctx: TurnContext = { jobId, attemptId: attempt.id, workspace: attempt.workspace, signal: controller.signal, model: attempt.requestedModel, deadline: Date.now() + settings.pageTimeoutMinutes * 60_000, codexHome: account?.home ?? null }
    void this.runEditor(ctx, settings, run.effort)
      .catch(async error => {
        const now = await this.prisma.antigravityPageJob.findUnique({ where: { id: jobId } })
        if (now && !TERMINAL_STAGES.has(now.stage)) await this.setStage(jobId, 'failed', { lastError: error instanceof Error ? error.message : String(error) })
        await this.prisma.antigravityAttempt.updateMany({ where: { id: attempt.id, status: 'active' }, data: { status: 'failed', error: error instanceof Error ? error.message : String(error), finishedAt: new Date() } })
      })
      .finally(() => this.live.delete(jobId))
    void this.schedule(runId, false)
    return this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
  }

  /** MCP tools of a Timeline attempt: get_job_context + submit_timeline (one-shot) or get_task + submit_task (small batches). */
  private async callEditor(attempt: AttemptRow, job: JobRow, input: { tool: string; arguments: Record<string, unknown> }) {
    const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError && { isError: true }) })
    const manifest = editorFlow.parseManifest(job.manifestJson)
    if (!manifest) return text('This job has no timeline inputs. Stop working on it.', true)
    const editor = this.editorDeps()
    const state = editorFlow.parseState(attempt.stepsStateJson, manifest)
    const saveState = (next: Partial<editorFlow.EditorState>, extra: Record<string, unknown> = {}) =>
      this.prisma.antigravityAttempt.update({ where: { id: attempt.id }, data: { stepsStateJson: editorFlow.stateJson({ ...state, ...next }), ...extra } })
    const raw = typeof input.arguments.json === 'string' ? input.arguments.json : JSON.stringify(input.arguments.json ?? '')
    const oneshot = manifest.method === 'oneshot'
    const changed = 'The chapter\'s Editor inputs changed since this job started. Stop working on this chapter and reply with one word: SUBMITTED.'
    const readView = async (): Promise<editorFlow.BatchView | { error: string }> => {
      try { return await editor.batches(job.chapterId, manifest.language) } catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
    }
    switch (input.tool) {
      case 'get_job_context': {
        const chapter = await this.chapterInfo(job.chapterId)
        return text(oneshot
          ? editorFlow.oneShotContextText(job.id, chapter, manifest, await editor.oneShot(job.chapterId, manifest.language))
          : editorFlow.batchesContextText(job.id, chapter, manifest, await readView()))
      }
      case 'submit_timeline': {
        if (!oneshot) return text('This chapter is on small batches: use get_task and submit_task.', true)
        if (state.json) return text('The timeline was already accepted. Reply with one word: SUBMITTED.')
        if (attempt.submissions >= MAX_SUBMISSIONS_PER_STAGE) return text('Too many invalid timelines in this turn. Reply with one word: SUBMITTED; Studio decides what happens next.', true)
        const current = await editor.oneShot(job.chapterId, manifest.language)
        if ('reason' in current || current.revision !== manifest.revision) return text(changed, true)
        const checked = editorFlow.checkOneShot(raw, current, manifest.language)
        let issues = checked.issues
        if (checked.json && !issues.length) {
          const processed = await editor.process(job.chapterId, checked.json, manifest.language).catch((error: Error) => ({ missingRefs: [] as string[], error: error.message }))
          issues = 'error' in processed ? [processed.error] : processed.missingRefs.slice(0, 25).map(r => `"${r}" doesn't resolve to a crop file of this chapter.`)
        }
        if (!checked.json || issues.length) {
          await saveState({ issues }, { submissions: { increment: 1 } })
          return text(editorFlow.fixText(issues, manifest.language), true)
        }
        await saveState({ json: checked.json, issues: [] }, { submissions: 0 })
        const sections = (JSON.parse(checked.json).sections as unknown[]).length
        await this.event('checkpoint', `${await this.editorLabel(job)}: timeline accepted (${sections} section${sections === 1 ? '' : 's'})`, { runId: job.runId, jobId: job.id, attemptId: attempt.id })
        return text('Timeline accepted. Reply with one word: SUBMITTED.')
      }
      case 'get_task': {
        if (oneshot) return text('This chapter is one-shot: send the whole timeline through submit_timeline.', true)
        const view = await readView()
        if ('error' in view && !('counts' in view)) return text(`Studio cannot read this chapter's batches: ${view.error}`, true)
        const v = view as editorFlow.BatchView
        if (v.sourceHash !== manifest.revision) return text(changed, true)
        if (v.error) return text(`Studio cannot go on with this chapter: ${v.error} Reply with one word: SUBMITTED.`, true)
        return text(editorFlow.taskText(v))
      }
      case 'submit_task': {
        if (oneshot) return text('This chapter is one-shot: send the whole timeline through submit_timeline.', true)
        if (state.tasksThisTurn >= editorFlow.TASKS_PER_TURN) return text('That is enough batches for this turn. Reply with one word: SUBMITTED; Studio continues in a moment.')
        if (attempt.submissions >= MAX_SUBMISSIONS_PER_STAGE) return text('Too many invalid answers for this batch. Reply with one word: SUBMITTED; Studio decides what happens next.', true)
        const read = await readView()
        if (!('counts' in read)) return text(`Studio cannot read this chapter's batches: ${read.error}`, true)
        if (read.sourceHash !== manifest.revision) return text(changed, true)
        if (!read.task) return text('Every batch is done. Reply with one word: SUBMITTED.')
        const taskId = String(input.arguments.task_id ?? '')
        if (taskId !== read.task.id) return text(`"${taskId}" is not the current batch. Answer this one:\n\n${editorFlow.taskText(read)}`, true)
        let view: editorFlow.BatchView
        try {
          view = await editor.batches(job.chapterId, manifest.language, { taskId, fingerprint: read.task.fingerprint, reply: raw })
        } catch (error) {
          await saveState({}, { submissions: { increment: 1 } })
          return text(editorFlow.batchFixText(error instanceof Error ? error.message : String(error), taskId), true)
        }
        const tasksThisTurn = state.tasksThisTurn + 1
        await saveState({ accepted: state.accepted + 1, tasksThisTurn }, { submissions: 0 })
        await this.event('checkpoint', `${await this.editorLabel(job)}: batch ${read.task.label} accepted (${view.completed} done)`, { runId: job.runId, jobId: job.id, attemptId: attempt.id })
        if (view.error) return text(`Accepted. Studio cannot go on with this chapter: ${view.error} Reply with one word: SUBMITTED.`)
        if (!view.task) return text('Accepted. Every batch is done. Reply with one word: SUBMITTED.')
        if (tasksThisTurn >= editorFlow.TASKS_PER_TURN) return text('Accepted. That is enough for this turn: reply with one word: SUBMITTED. Studio continues with the next batch.')
        return text(`Accepted. Next batch:\n\n${editorFlow.taskText(view)}`)
      }
      default:
        return text(`Unknown tool ${input.tool}. This chapter's tools are ${editorFlow.toolsFor(attempt.flow ?? '').map(t => t.name).join(', ')}.`, true)
    }
  }

  // ─── Controls ───

  async control(runId: string, action: 'pause' | 'resume' | 'stop') {
    const run = await this.prisma.antigravityRun.findUniqueOrThrow({ where: { id: runId } })
    if (action === 'pause') {
      if (['running', 'preparing'].includes(run.control)) await this.prisma.antigravityRun.update({ where: { id: runId }, data: { control: 'pause_requested' } })
    } else if (action === 'resume') {
      if (['paused', 'pause_requested', 'interrupted'].includes(run.control)) {
        const live = await this.liveRun()
        if (live && live.id !== runId) throw new Error('Another process is running. One process at a time: let it finish or stop it first.')
        const scan = this.scans.get(runId)
        if (scan) scan.emptyAt = 0
        await this.prisma.antigravityRun.update({ where: { id: runId }, data: { control: 'running', finishedAt: null } })
        void this.schedule(runId, false)
      }
    } else {
      await this.prisma.antigravityRun.update({ where: { id: runId }, data: { control: 'stop_requested' } })
      // Revoke capabilities first so a late tool call cannot commit.
      const jobs = await this.prisma.antigravityPageJob.findMany({ where: { runId } })
      for (const job of jobs) {
        if (job.currentAttemptId) await this.prisma.antigravityAttempt.updateMany({ where: { id: job.currentAttemptId, status: 'active' }, data: { status: 'cancelled', finishedAt: new Date() } })
        this.live.get(job.id)?.controller.abort()
        if (!TERMINAL_STAGES.has(job.stage) && job.stage !== 'prepared') await this.setStage(job.id, 'cancelled', { lastError: 'Stopped by the operator.' })
      }
      await this.prisma.antigravityRun.update({ where: { id: runId }, data: { control: 'stopped', finishedAt: new Date() } })
      this.scans.delete(runId)
      this.pickOff.delete(runId)
      await this.event('run', 'Run stopped.', { runId })
    }
    return this.prisma.antigravityRun.findUniqueOrThrow({ where: { id: runId } })
  }

  /**
   * The operator rejects a finished result (it is not acceptable). Goes through Clipper's explicit
   * page rejection: this page's pointers are backed up and removed, and phones are told the old
   * result is void, so neither Studio nor a phone counts the page as done. Optionally runs the page
   * again at once: a fresh attempt and conversation from the prepared Drive inputs.
   */
  async reject(jobId: string, options: { rerun: boolean; note?: string }) {
    const job = await this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
    if (this.live.has(jobId)) throw new Error('This page is still running.')
    if (kindOf(job.kind) === 'metadata') throw new Error('Metadata pages are not rejected here; edit or clear the page\'s Metadata in Clipper.')
    if (kindOf(job.kind) === 'editor') throw new Error('Timelines are not rejected here; clear the chapter\'s timeline in Editor 2.0, then start it again.')
    if (!REJECTABLE_STAGES.has(job.stage) || job.importState !== 'imported' || !job.resultJson) throw new Error('Only a result imported into Clipper can be rejected.')
    if (!this.deps.rejectSource) throw new Error('Page rejection is not available.')
    const chapter = await this.chapterOf(job.chapterId)
    const saved = await compareWithSaved(chapter.folderPath, job.filename, JSON.parse(job.resultJson))
    if (saved === 'different') throw new Error('This page\'s pointers were changed after this result (edited or replaced). Reject them from Clipper instead.')
    const redo = await this.deps.rejectSource({ chapterId: chapter.id, folderPath: chapter.folderPath, filename: job.filename })
    const note = options.note?.replace(/\s+/g, ' ').trim().slice(0, 300)
    await this.setStage(jobId, 'rejected', {
      importState: 'rejected',
      lastError: `Rejected by the operator${note ? `: ${note}` : ''}.${redo.deliveryError ? ` Phones not told yet (${redo.deliveryError.slice(0, 200)}); use Clipper's Resend redo request.` : ''}`
    })
    this.deps.onPointersChanged?.()
    if (options.rerun) return this.runAgain(jobId)
    return this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
  }

  /** A rejected page: new attempt and conversation, reusing the verified Drive inputs. */
  private async runAgain(jobId: string) {
    const job = await this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
    const chapter = await this.chapterOf(job.chapterId)
    const saved = await readImagePoints(chapter.folderPath, job.filename)
    const redo = await readPageRedo(chapter.folderPath, job.filename)
    if (saved?.file && redo?.status !== 'pending') throw new Error('This page already has new pointers (from a phone or by hand).')
    await this.prisma.antigravityPageJob.update({
      where: { id: jobId },
      data: { stage: job.manifestJson ? 'queued' : 'pending', lastError: null, resultJson: null, resultSha256: null, importState: null, preexistingPointer: await pointerFingerprint(chapter.folderPath, job.filename) }
    })
    const runId = await this.enterProcess(job)
    await this.event('run', `${job.filename}: running again after rejection`, { runId, jobId })
    void this.schedule(runId, false)
    return this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
  }

  /** Retry a failed/interrupted page from its last valid checkpoint (prepared inputs are reused). */
  async retry(jobId: string) {
    const job = await this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
    if (!RETRYABLE_STAGES.has(job.stage)) throw new Error('Only failed, interrupted, stopped or rejected pages can be retried.')
    if (this.live.has(jobId)) throw new Error('This page is still running.')
    if (job.stage === 'rejected') return this.runAgain(jobId)
    if (job.stage === 'publish_failed' && job.importState === 'imported') return this.publishAgain(jobId)
    if (job.resultJson && job.importState !== 'imported') {
      // Delivery-only retry: no new AI request.
      await (kindOf(job.kind) === 'metadata' ? this.deliverMetadata(jobId) : kindOf(job.kind) === 'editor' ? this.deliverEditor(jobId) : this.deliver(jobId))
      return this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
    }
    await this.prisma.antigravityPageJob.update({ where: { id: jobId }, data: { stage: job.manifestJson ? 'queued' : 'pending', lastError: null } })
    const runId = await this.enterProcess(job)
    void this.schedule(runId, false)
    return this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
  }

  /** After a backend restart: nothing is silently resumed or re-dispatched. */
  async recoverAfterRestart() {
    const attempts = await this.prisma.antigravityAttempt.findMany({ where: { status: 'active' } })
    for (const attempt of attempts) {
      // A crash can leave our detached agy group running: stop it (only if that pid is still an agy process).
      if (attempt.pid && processAlive(attempt.pid) && isStudioCliProcess(attempt.pid)) {
        try { process.kill(-attempt.pid, 'SIGTERM') } catch { /* already gone */ }
      }
      await this.prisma.antigravityAttempt.update({ where: { id: attempt.id }, data: { status: 'interrupted', finishedAt: new Date(), error: 'Studio stopped while this attempt ran.' } })
    }
    const jobs = await this.prisma.antigravityPageJob.findMany({ where: { stage: { in: [...ACTIVE_STAGES] } } })
    for (const job of jobs) await this.setStage(job.id, 'interrupted', { lastError: 'Studio stopped while this page was in progress. Retry to continue from its last checkpoint.' })
    await this.prisma.antigravityRun.updateMany({ where: { control: { in: ['running', 'preparing', 'pause_requested', 'stop_requested'] } }, data: { control: 'interrupted' } })
  }

  // ─── Reads ───

  async runDetail(runId: string) {
    const run = await this.prisma.antigravityRun.findUnique({ where: { id: runId } })
    if (!run) return null
    let jobs = await this.prisma.antigravityPageJob.findMany({ where: { runId }, orderBy: [{ chapterId: 'asc' }, { pageIndex: 'asc' }] })
    if (await this.syncClipperRejections(jobs)) jobs = await this.prisma.antigravityPageJob.findMany({ where: { runId }, orderBy: [{ chapterId: 'asc' }, { pageIndex: 'asc' }] })
    const attempts = await this.prisma.antigravityAttempt.findMany({ where: { jobId: { in: jobs.map(j => j.id) } }, orderBy: { number: 'asc' } })
    const events = await this.prisma.antigravityEvent.findMany({ where: { runId }, orderBy: { seq: 'desc' }, take: 200 })
    const deliveries = await this.prisma.antigravityDelivery.findMany({ where: { jobId: { in: jobs.map(j => j.id) } }, orderBy: { createdAt: 'asc' } })
    return {
      run: { ...run, mode: runMode(run), promptJson: JSON.parse(run.promptJson) },
      jobs: jobs.map(j => ({ ...publicJob(j), attempts: attempts.filter(a => a.jobId === j.id).map(publicAttempt), deliveries: deliveries.filter(d => d.jobId === j.id).map(publicDelivery) })),
      events: events.reverse()
    }
  }

  /**
   * A result rejected from Clipper (its Reject) instead of from AntiGravity: the page has an open
   * rejection for the same source and its pointers are gone, so the finished job is Rejected too and
   * can be processed again. Jobs for other pages are left as they are.
   */
  private async syncClipperRejections(jobs: JobRow[]) {
    const folders = new Map<string, string>()
    let changed = false
    for (const job of jobs) {
      if (kindOf(job.kind) !== 'clipper' || !REJECTABLE_STAGES.has(job.stage) || job.importState !== 'imported' || this.live.has(job.id)) continue
      const folder = folders.get(job.chapterId) ?? (await this.chapterOf(job.chapterId)).folderPath
      folders.set(job.chapterId, folder)
      const redo = await readPageRedo(folder, job.filename).catch(() => null)
      if (redo?.status !== 'pending' || redo.sourceSha256 !== job.sourceSha256) continue
      if ((await readImagePoints(folder, job.filename))?.file) continue
      await this.setStage(job.id, 'rejected', { importState: 'rejected', lastError: 'Rejected in Clipper.' })
      changed = true
    }
    return changed
  }

  /** Latest job per page for one chapter list (Image Clipper screen). */
  async pageJobs(chapterIds: string[], kind: JobKind = 'clipper') {
    let jobs = await this.prisma.antigravityPageJob.findMany({ where: { chapterId: { in: chapterIds }, kind }, orderBy: { updatedAt: 'desc' } })
    if (await this.syncClipperRejections(jobs)) jobs = await this.prisma.antigravityPageJob.findMany({ where: { chapterId: { in: chapterIds }, kind }, orderBy: { updatedAt: 'desc' } })
    const latest = new Map<string, (typeof jobs)[number]>()
    for (const j of jobs) if (!latest.has(`${j.chapterId}|${j.filename}`)) latest.set(`${j.chapterId}|${j.filename}`, j)
    const attempts = await this.prisma.antigravityAttempt.findMany({ where: { id: { in: [...latest.values()].map(j => j.currentAttemptId).filter((x): x is string => !!x) } } })
    return [...latest.values()].map(j => ({ ...publicJob(j), attempt: attempts.find(a => a.id === j.currentAttemptId) ? publicAttempt(attempts.find(a => a.id === j.currentAttemptId)!) : null }))
  }
}

type JobRow = Awaited<ReturnType<PrismaClient['antigravityPageJob']['findUniqueOrThrow']>>
type AttemptRow = Awaited<ReturnType<PrismaClient['antigravityAttempt']['findUniqueOrThrow']>>

/** Sanitized views: no workspace paths, tokens or raw handoff blobs. */
export function publicJob(j: JobRow) {
  return {
    id: j.id, runId: j.runId, chapterId: j.chapterId, filename: j.filename, pageIndex: j.pageIndex, stage: j.stage, kind: kindOf(j.kind),
    sourceSha256: j.sourceSha256, width: j.width, height: j.height, driveFolderId: j.driveFolderId,
    resultSha256: j.resultSha256, importState: j.importState, lastError: j.lastError, updatedAt: j.updatedAt,
    pageStem: stemOfFile(j.filename)
  }
}

type DeliveryRow = Awaited<ReturnType<PrismaClient['antigravityDelivery']['findUniqueOrThrow']>>

export function publicDelivery(d: DeliveryRow) {
  return {
    id: d.id, destination: d.destination, state: d.state, resultSha256: d.resultSha256, pointerKey: d.pointerKey, indexKey: d.indexKey,
    indexRevision: d.indexRevision, tries: d.tries, error: d.error, publishedAt: d.publishedAt
  }
}

export function publicAttempt(a: AttemptRow) {
  return {
    id: a.id, number: a.number, status: a.status, stage: a.stage, conversationId: a.conversationId, cliVersion: a.cliVersion, engine: engineOf(a.engine), codexAccount: a.codexAccount,
    requestedModel: a.requestedModel, observedModel: a.observedModel, reviewRounds: a.reviewRounds,
    delivered: JSON.parse(a.deliveredJson) as string[], analysisSha256: a.analysisSha256, deniedActions: a.deniedActions ? JSON.parse(a.deniedActions) : null,
    error: a.error, startedAt: a.startedAt, finishedAt: a.finishedAt
  }
}
