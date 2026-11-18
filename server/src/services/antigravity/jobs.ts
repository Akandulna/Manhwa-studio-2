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
import { currentMetadataJobs, importMetadataResult, metadataGenerations, publishMetadataJobs, saveRecreatedMetadata, validateMetadataResult } from '../clipper3/metadataSplit.js'
import sharp from 'sharp'
import type { GoogleDriveService } from '../googleDrive/service.js'
import { driveErrorMessage } from '../googleDrive/errors.js'
import { execFileSync } from 'node:child_process'
import { processAlive, runTurn, type AgyTurnResult } from './cli.js'
import { runCodexTurn } from './codexCli.js'
import { claudeMcpConfig, describeClaudeEvidence, readClaudeEvidence, runClaudeTurn, type ClaudeRateLimit, type ClaudeTurnResult } from './claudeCli.js'
import { describeSession, readSessionEvidence } from './codexSession.js'
import { limitResetFrom, type CodexAccountRef, type CodexAccountStore } from './codexAccounts.js'
import { AI_ENGINES, ENGINE_LABELS, type AiEngine } from './settingsModel.js'
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
import { CLI_HOME, describeToolUse, readImagesViewed, readToolUse, unopenedImages } from './toolUse.js'
import * as metadataFlow from './metadataFlow.js'
import * as editorFlow from './editorFlow.js'
import { narrationWords } from '../narrationRules.js'
import * as narrationFlow from './narrationFlow.js'
import * as hinglishFlow from './narrationHinglish.js'
import { PREPARATION as NARRATION_PREPARATION, prepareChapterPages } from './narrationPieces.js'
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
 * crops), Timeline (a chapter's Editor 2.0 timeline JSON per language; editorFlow.ts) or Narration (a chapter's
 * English script written from its pages; narrationFlow.ts).
 */
export type JobKind = 'clipper' | 'metadata' | 'editor' | 'narration'
export const KIND_LABELS: Record<JobKind, string> = { clipper: 'Image Clipper', metadata: 'Metadata', editor: 'Timeline', narration: 'Narration' }
export const kindOf = (value: string | null | undefined): JobKind => (value === 'metadata' || value === 'editor' || value === 'narration' ? value : 'clipper')
/**
 * Engines that may write Narration scripts: Antigravity (agy) and ChatGPT (Codex; added 2026-11-16 at the user's
 * request, same pieces ≤2,000 px and tools). Claude is not used for scripts; Gemini CLI joins when it is an engine.
 */
export const NARRATION_ENGINES: readonly AiEngine[] = ['antigravity', 'codex']
export const narrationEngineError = (engine: AiEngine) =>
  `Narration scripts are written with ${NARRATION_ENGINES.map(e => ENGINE_LABELS[e]).join(' or ')} only, and ${ENGINE_LABELS[engine]} is selected. Choose one of those in Settings → AntiGravity → AI engine, then start Narration again.`
/** A Narration turn whose agent shows no activity (tool calls, transcript) for this long is stopped as stalled. */
export const NARRATION_STALL_MS = 10 * 60_000

/** Kinds whose job is a whole chapter, not a page. */
const chapterKind = (kind: JobKind) => kind === 'editor' || kind === 'narration'
/** A Narration job's language, from its "page" filename (narration-en / narration-hi); null for anything else. */
const narrationLanguageOf = (filename: string): 'en' | 'hi' | null =>
  filename === narrationFlow.FILENAME ? 'en' : filename === hinglishFlow.FILENAME_HI ? 'hi' : null
const narrationLanguageLabel = (language: 'en' | 'hi') => (language === 'hi' ? 'Hinglish' : 'English')
/** "A Metadata process", "An Image Clipper process", "A Timeline process". */
const aKind = (kind: JobKind) => `${kind === 'clipper' ? 'An' : 'A'} ${KIND_LABELS[kind]}`
/** Studio writes this beside a chapter's sources after a complete cut (clipper3/metadataSplit.ts CUT_RECEIPT). */
const CUT_RECEIPT = '.metadata-cut-receipt.json'
/** Crops are handed to the model at most this big; agy scales images to ≤2000 px anyway. */
const METADATA_IMAGE_MAX = 2000
/** agy models without image input (LocalAntigravityCard TEXT_ONLY). */
const TEXT_ONLY_MODEL = /^gpt-oss/i

export interface RunSettings {
  /** antigravity = agy; codex = ChatGPT through the Codex CLI; claude = Claude Code. */
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
  /** Metadata: ticked pages that already have Metadata are made again and replace it in Studio, R2 and on phones. */
  recreate?: boolean
}

/** A Metadata job's preexistingPointer when it remakes a page that already had Metadata. */
const METADATA_RECREATE = 'recreate'

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
  /** Recreated Metadata → R2 + phone sync (default publishMetadataJobs; tests replace it). */
  publishMetadata?: (chapter: { id: string; number: number; folderPath: string; seriesId: string; series: { title: string } }) => Promise<{ queued: number; results?: number; waiting?: string }>
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
  /** Claude Code's config folder (CLAUDE_CONFIG_DIR, default ~/.claude), for reading its session transcripts. */
  claudeConfigDir?: string
  /** Keeps the Claude plan's usage windows Claude Code reported in each turn (for Usage limits). */
  claudeUsage?: { record: (limits: ClaudeRateLimit[]) => Promise<void> }
  /** Editor 2.0's inputs, small-batches session, processor and save (Timeline kind); absent = no Timeline. */
  editor?: editorFlow.EditorDeps
  /** The chapter's narration inputs and Narration's script replacement (Narration kind); absent = no Narration. */
  narration?: narrationFlow.NarrationDeps
  /** Narration stall limit in ms (default NARRATION_STALL_MS; tests use a short one). */
  stallMs?: number
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
  /** Stop a turn that shows no activity for the stall limit (Narration). */
  watchStalls?: boolean
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
  if (/quota|rate.?limit|resource.?exhausted|too many requests|\b429\b|usage limit|hit your (?:usage )?limit/.test(text)) return 'quota'
  if (/not (signed|logged) in|sign in to|log ?in required|unauthenticated|\b401\b|re-?authenticate|please run \/login|invalid api key|oauth token/.test(text)) return 'auth'
  if (/model/.test(text) && /(not found|unknown|unavailable|unsupported|not available|invalid|not exist|have access)/.test(text)) return 'model'
  return null
}

/** Same grouping as client/src/lib/clipperParts.ts (20 chapters per part). */
export const CLIPPER_PART_SIZE = 20
export const clipperPartNumber = (chapterNumber: number) => Math.max(1, Math.ceil(chapterNumber / CLIPPER_PART_SIZE))

/** Is [pid] still an agy, codex or claude process (pids are reused)? */
function isStudioCliProcess(pid: number): boolean {
  try { return /(^|\/)(agy|codex|claude)(\s|$)/.test(execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim()) } catch { return false }
}

const engineOf = (value: string | null | undefined): AiEngine => (AI_ENGINES.includes(value as AiEngine) ? value as AiEngine : 'antigravity')
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

/** A job's pinned profile (part of its idempotency key). agy profiles keep their original shape so existing keys stay valid; Codex and Claude add their engine. */
function profileOf(run: { engine: string; model: string; effort: string | null; sandbox: boolean; connectionId: string | null }, hashes: Record<string, string>) {
  return { ...(run.engine !== 'antigravity' && { engine: run.engine }), model: run.model, effort: run.effort, sandbox: run.sandbox, connection: run.connectionId ?? '', prompts: hashes }
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
  /** Claude: the usage windows reported during each attempt's turns (for its tool-use record). */
  private readonly claudeLimits = new Map<string, ClaudeRateLimit[]>()
  /** A model can fetch several pieces at once. Keep narration checkpoint updates in request order. */
  private readonly narrationCalls = new Map<string, Promise<unknown>>()
  /** Last MCP call per attempt: the agent is alive while it calls Studio's tools (Narration stall watch). */
  private readonly lastToolCall = new Map<string, number>()
  /** Narration jobs whose next attempt starts over instead of taking over the previous attempt's work. */
  private readonly narrationFresh = new Set<string>()

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
      if (live.control === 'stop_requested') throw new Error('This part\'s process is stopping after the page in progress. Start again once it has stopped, or use Stop now.')
      if (request.prepareOnly) throw new Error('A process is running on this part. Upload to Drive when it has finished, or add the pages to it with Start selected.')
      if (live.control === 'preparing') throw new Error('An Upload to Drive is still running on this part. Start the selected pages when it has finished.')
    }
    const settings = await this.deps.settings()
    if (kind === 'narration') {
      const engine = live ? engineOf(live.engine) : settings.engine
      if (!NARRATION_ENGINES.includes(engine)) throw new Error(narrationEngineError(engine))
    }
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
      if (kind === 'narration') {
        const language = narrationLanguageOf(page.filename)
        if (!language) { skipped.push({ ...page, reason: 'Not a narration of this chapter.' }); continue }
        // Ticked chapters are written even when they have a script: that is how a wrong script is rewritten.
        const checked = await this.inspectNarration(chapter, true, language)
        if ('reason' in checked) skipped.push({ ...page, reason: checked.reason })
        else accepted.push(checked)
        continue
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
        ? await this.inspectMetadataPage(chapter, index, manifest.images[index], metaCache, request.recreate === true)
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

  /**
   * Whether one page can have its Metadata made now: in the approved cut, without current Metadata.
   * [recreate]: a page with current Metadata is taken too, and its new Metadata replaces the old one.
   */
  private async inspectMetadataPage(chapter: ChapterRef, index: number, image: { filename: string }, cache?: Map<string, MetadataChapterJobs>, recreate = false): Promise<AcceptedPage | { reason: string }> {
    const meta = await this.metadataChapter(chapter, cache)
    if ('reason' in meta) return { reason: meta.reason }
    const job = meta.jobs.get(image.filename)
    if (!job) return { reason: 'Not in the chapter\'s approved cut.' }
    const saved = await this.metadataSaved(chapter.folderPath, image.filename, job, meta.script)
    if (saved && !recreate) return { reason: 'Metadata already saved.' }
    const payload = metadataFlow.payloadOf(job)
    return { chapterId: chapter.id, filename: image.filename, pageIndex: index, sourceSha256: payload.sourceSha256, width: payload.width, height: payload.height, folderPath: chapter.folderPath, preexisting: saved ? METADATA_RECREATE : 'none', manifestJson: JSON.stringify(job) }
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
    const metadataRevision = kind === 'metadata' ? (JSON.parse(page.manifestJson!) as metadataFlow.MetadataJobEnvelope).revision : chapterKind(kind) ? page.sourceSha256 : null
    const key = kind === 'metadata' || kind === 'narration'
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
    return { live: !!live, run: run ? { id: run.id, seriesId: run.seriesId, partNumber: run.partNumber, kind: kindOf(run.kind), engine: run.engine, model: run.model, concurrency: run.concurrency, control: run.control, mode: runMode(run), createdAt: run.createdAt, finishedAt: run.finishedAt, ...(kindOf(run.kind) === 'editor' && { editor: editorFlow.optionsOf(run.promptJson) }) } : null }
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
    if (kind === 'narration') {
      const engine = live && kindOf(live.kind) === 'narration' ? engineOf(live.engine) : (await this.deps.settings()).engine
      if (!NARRATION_ENGINES.includes(engine)) throw new Error(narrationEngineError(engine))
    }
    if (live) {
      if (live.seriesId !== series.id || live.partNumber !== request.partNumber || kindOf(live.kind) !== kind) throw new Error(await this.busyMessage(live))
      if (live.control === 'stop_requested') throw new Error('This part\'s process is stopping after the page in progress. Start again once it has stopped, or use Stop now.')
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
    // Narration writes one chapter at a time: each needs the previous chapter's summary and closing.
    if (kind === 'narration' && jobs.some(j => j.runId === run.id && !TERMINAL_STAGES.has(j.stage))) return false
    for (const chapter of chapters) {
      let images = scan.manifests.get(chapter.id)
      if (!images) {
        // A Timeline process takes each chapter once per language (its "pages" are timeline-en / timeline-hi);
        // a Narration process each chapter once per language: English first, then its Hinglish (written from it).
        if (kind === 'narration') images = [narrationFlow.FILENAME, ...(this.deps.narration?.hinglish ? [hinglishFlow.FILENAME_HI] : [])].map(filename => ({ filename, width: 0, height: 0 }))
        else if (editorOptions) images = editorOptions.languages.map(l => ({ filename: editorFlow.timelineFilename(l), width: 0, height: 0 }))
        else try { images = (await getChapterManifest(chapter.folderPath)).images.map(i => ({ filename: i.filename, width: i.width, height: i.height })) } catch { images = [] }
        scan.manifests.set(chapter.id, images)
      }
      for (const [index, image] of images.entries()) {
        const k = `${chapter.id}|${image.filename}`
        if (scan.settled.has(k)) continue
        const job = latest.get(k)
        if (job && (this.live.has(job.id) || (job.runId === run.id && !TERMINAL_STAGES.has(job.stage)))) continue
        if (job && WAITS_FOR_OPERATOR.has(job.stage)) continue
        const checked: AcceptedPage | { reason: string; wait?: boolean } = await (kind === 'narration'
          ? this.inspectNarration(chapter, false, narrationLanguageOf(image.filename) ?? 'en')
          : editorOptions
          ? this.inspectEditor(chapter, editorFlow.languageOfFilename(image.filename)!, editorOptions.method)
          : kind === 'metadata' ? this.inspectMetadataPage(chapter, index, image, scan.meta) : this.inspectPage(chapter, index, image)).catch((error: Error) => ({ reason: error.message }))
        // A chapter waiting for an earlier chapter's script is looked at again later; nothing after it can go first.
        if ('wait' in checked && checked.wait) { scan.emptyAt = Date.now(); return false }
        scan.settled.add(k)
        if ('reason' in checked) continue
        const out = await this.admit(run.id, run.seriesId, checked, profile, false, kind)
        if (out.inRun) {
          await this.event('run', `Next ${kind === 'narration' ? 'script' : editorOptions ? 'timeline' : 'page'}: Chapter ${chapter.number} · ${kind === 'narration' ? narrationLanguageLabel(narrationLanguageOf(image.filename) ?? 'en') : editorOptions ? editorFlow.languageLabel(editorFlow.languageOfFilename(image.filename)!) : image.filename}`, { runId: run.id, jobId: out.id })
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
      if (live.control === 'stop_requested') throw new Error('The running process is stopping after the page in progress. Try again once it has stopped.')
      if (kindOf(live.kind) !== kindOf(job.kind)) throw new Error(`${await this.busyMessage(live)} This is ${aKind(kindOf(job.kind)).replace(/^A/, 'a')} ${chapterKind(kindOf(job.kind)) ? 'job' : 'page'}.`)
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
        if (!run || ['paused', 'stopped', 'completed', 'completed_with_errors', 'interrupted'].includes(run.control)) break
        const mine = [...this.live.values()].filter(l => l.runId === runId)
        // Stop: nothing new starts; the pages already in progress finish (and save), then the run stops.
        if (run.control === 'stop_requested') {
          if (mine.length === 0) { await this.finishStop(runId); break }
          await new Promise(r => setTimeout(r, 500))
          continue
        }
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
        const waiting = kindOf(run.kind) === 'narration' ? await this.narrationWaiting(jobs) : null
        const nextAi = prepareOnly || (kindOf(run.kind) === 'narration' && mine.some(l => l.kind === 'ai')) ? undefined : jobs.find(j => !this.live.has(j.id) && (j.stage === 'prepared' || j.stage === 'queued') && !waiting?.has(j.id))
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
   * workspace and only that path is passed (see codexMcp). Claude reads a 0600 MCP config file
   * beside the workspace that names the same token file (see claudeMcpFile).
   */
  private async grantCapability(workspace: string, engine: AiEngine = 'antigravity') {
    const token = crypto.randomBytes(32).toString('base64url')
    if (engine === 'codex' || engine === 'claude') {
      await fs.mkdir(workspace, { recursive: true, mode: 0o700 })
      await fs.writeFile(this.tokenFile(workspace), token, { mode: 0o600 })
      if (engine === 'claude') await fs.writeFile(this.claudeMcpFile(workspace), claudeMcpConfig(this.codexMcp(workspace)), { mode: 0o600 })
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

  /** Claude Code's --mcp-config for one attempt (outside the workspace, like the token file). */
  private claudeMcpFile(workspace: string) {
    return path.join(path.dirname(workspace), 'claude-mcp.json')
  }

  /** Studio's job MCP server as Codex (and Claude Code) launch it for one attempt. */
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
    if (kindOf(job.kind) === 'narration') return this.processNarration(jobId, signal)
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
      const watch = ctx.watchStalls ? this.stallWatch(ctx, settings.engine, conversationId) : null
      try {
        const result = await this.runEngineTurn(watch ? { ...ctx, signal: watch.signal } : ctx, settings, effort, prompt, conversationId, remaining)
        if (watch?.stalled()) {
          result.cancelled = false
          result.stalled = true
          const job = await this.prisma.antigravityPageJob.findUnique({ where: { id: ctx.jobId }, select: { runId: true } })
          await this.event('stall', `Turn stopped: no activity for ${Math.round((this.deps.stallMs ?? NARRATION_STALL_MS) / 60_000)} min (no Studio tool call and no transcript change)`, { runId: job?.runId, jobId: ctx.jobId, attemptId: ctx.attemptId })
        }
        return result
      } finally { watch?.stop() }
    }
  }

  /**
   * Watches one turn: when its agent makes no Studio tool call and (agy) its conversation transcript doesn't change
   * for the stall limit, the turn is stopped. A broken reply stream otherwise leaves the CLI idle until the page
   * deadline (47 minutes on 2026-11-11). Real agy turns showed gaps of at most ~5 minutes between transcript steps.
   */
  private stallWatch(ctx: TurnContext, engine: AiEngine, conversationId: string | null) {
    const limit = this.deps.stallMs ?? NARRATION_STALL_MS
    const controller = new AbortController()
    const started = Date.now()
    let stalled = false
    const onAbort = () => controller.abort()
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    if (ctx.signal.aborted) controller.abort()
    const lastActivity = async () => {
      let last = Math.max(started, this.lastToolCall.get(ctx.attemptId) ?? 0)
      if (engine === 'antigravity') {
        const conv = conversationId ?? (await this.prisma.antigravityAttempt.findUnique({ where: { id: ctx.attemptId }, select: { conversationId: true } }).catch(() => null))?.conversationId
        if (conv && /^[A-Za-z0-9-]{8,64}$/.test(conv)) {
          const dir = path.join(this.deps.cliHome ?? CLI_HOME, 'brain', conv)
          for (const file of [path.join(dir, '.system_generated', 'logs', 'transcript.jsonl'), dir]) {
            const stat = await fs.stat(file).catch(() => null)
            if (stat) last = Math.max(last, stat.mtimeMs)
          }
        }
      }
      return last
    }
    let checking = false
    const timer = setInterval(() => {
      if (checking || stalled || controller.signal.aborted) return
      checking = true
      void lastActivity().then(last => {
        if (!stalled && !controller.signal.aborted && Date.now() - last > limit) { stalled = true; controller.abort() }
      }).finally(() => { checking = false })
    }, Math.max(200, Math.min(15_000, Math.floor(limit / 4))))
    return { signal: controller.signal, stalled: () => stalled, stop: () => { clearInterval(timer); ctx.signal.removeEventListener('abort', onAbort) } }
  }

  /** One turn on the run's engine. */
  private async runEngineTurn(ctx: TurnContext, settings: RunSettings, effort: string | null, prompt: string, conversationId: string | null, remaining: number) {
    const onSpawn = (pid: number) => void this.prisma.antigravityAttempt.update({ where: { id: ctx.attemptId }, data: { pid } }).catch(() => undefined)
    const result = settings.engine === 'claude'
      ? await runClaudeTurn({
        executable: settings.executable, cwd: ctx.workspace, prompt, model: ctx.model, effort,
        conversationId, mcpConfigPath: this.claudeMcpFile(ctx.workspace), timeoutMs: remaining, signal: ctx.signal, onSpawn
      })
      : settings.engine === 'codex'
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
    if ('claude' in result) await this.recordClaudeTurn(ctx.attemptId, result as ClaudeTurnResult)
    return result as AgyTurnResult
  }

  /** Claude names the served model in its stream and reports the plan's usage windows on every turn. */
  private async recordClaudeTurn(attemptId: string, result: ClaudeTurnResult) {
    const { model, rateLimits } = result.claude
    if (rateLimits.length) {
      const earlier = this.claudeLimits.get(attemptId) ?? []
      this.claudeLimits.set(attemptId, [...earlier.filter(l => !rateLimits.some(r => r.type === l.type)), ...rateLimits])
      await this.deps.claudeUsage?.record(rateLimits).catch(() => undefined)
    }
    if (model) await this.prisma.antigravityAttempt.updateMany({ where: { id: attemptId, NOT: { observedModel: model } }, data: { observedModel: model } }).catch(() => undefined)
  }

  private finisher(jobId: string, attemptId: string) {
    return async (status: string, stage: string, error: string | null) => {
      this.lastToolCall.delete(attemptId)
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
      if (attempt.engine === 'claude') {
        const evidence = await readClaudeEvidence(attempt.conversationId, attempt.workspace, this.deps.claudeConfigDir)
        const limits = this.claudeLimits.get(attemptId) ?? []
        this.claudeLimits.delete(attemptId)
        if (evidence?.model && evidence.model !== attempt.observedModel) await this.prisma.antigravityAttempt.update({ where: { id: attemptId }, data: { observedModel: evidence.model } })
        await this.event(evidence?.unexpected.length ? 'tools_unexpected' : 'tools', `${job?.filename ?? ''}: ${evidence ? describeClaudeEvidence(evidence, limits) : 'tool use not recorded (Claude Code transcript not found)'}`, { runId: job?.runId, jobId: attempt.jobId, attemptId })
        return
      }
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
    const reason = engine === 'claude'
      ? {
        quota: `Claude Code reports the Claude plan's usage limit is reached${this.limitReset(result)}. Resume the run after it resets (Running processes → Usage limits shows the last reported windows).`,
        auth: 'Claude Code is not signed in. Sign in (Settings → AntiGravity → Claude), then resume the run.',
        model: 'The pinned Claude model is not available on this plan. Choose another model in Settings → AntiGravity → Claude and run the compatibility test; this run stays paused.'
      }[kind]
      : engine === 'codex'
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
    if (kindOf(job.kind) === 'narration') return this.narrationAgain(jobId)
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
    if (kindOf(job.kind) === 'metadata') {
      if (job.preexistingPointer !== METADATA_RECREATE || job.importState !== 'imported') throw new Error('Metadata is saved in Studio only; there is nothing to publish.')
      await this.publishRecreatedMetadata(jobId)
      return this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
    }
    if (kindOf(job.kind) === 'editor') throw new Error('A timeline goes to the phones through Editor 2.0\'s own sending; there is nothing to publish here.')
    if (kindOf(job.kind) === 'narration') throw new Error('A script goes to the phones when it is saved; there is nothing to publish here.')
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

  /** " (resets <time>)" when a Claude turn reported its refused window's reset. */
  private limitReset(result: AgyTurnResult) {
    const limit = 'claude' in result ? (result as ClaudeTurnResult).claude.rateLimits.find(l => l.status === 'rejected') : null
    return limit?.resetsAt ? ` (resets ${new Date(limit.resetsAt).toLocaleString()})` : ''
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
    const claude = 'claude' in result
    const name = claude ? 'Claude Code' : codex ? 'Codex' : 'Antigravity'
    if (result.stalled) return `The ${name} turn stopped responding (no activity for ${Math.round((this.deps.stallMs ?? NARRATION_STALL_MS) / 60_000)} min).`
    if (result.cancelled) return 'Stopped by the operator.'
    if (result.timedOut) return `The ${name} turn timed out.`
    const denied = result.envelope?.denied_actions?.map(d => d.display_name ?? d.action) ?? []
    if (denied.length) return `${name} was denied: ${denied.join(', ')}. ${fallback}`
    if (result.envelope?.status && result.envelope.status !== 'SUCCESS') return `${name} reported ${result.envelope.status}: ${(result.envelope.error ?? '').slice(0, 300)}`
    if (!result.envelope) return `${claude ? 'claude' : codex ? 'codex' : 'agy'} produced no result (exit ${result.exitCode ?? 'signal'}). ${result.stderrTail.slice(-200)}`
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
    if (attempt?.flow === 'narration-notes') return narrationFlow.NOTES_TOOLS
    if (attempt?.flow === 'metadata') return metadataFlow.METADATA_TOOL_DEFINITIONS
    if (attempt?.flow?.startsWith('editor-')) return editorFlow.toolsFor(attempt.flow)
    if (attempt?.flow === 'narration') return narrationFlow.TOOLS
    if (attempt?.flow === 'narration-hi') return hinglishFlow.HINGLISH_TOOLS
    return stepsFlow.toolsFor(attempt?.flow === 'steps' ? 'steps' : 'classic')
  }

  async call(token: string, input: { tool: string; arguments: Record<string, unknown>; conversationId: string | null }) {
    const attempt = await this.prisma.antigravityAttempt.findFirst({ where: { capabilityHash: tokenHash(token) }, select: { id: true, flow: true, stepsStateJson: true } })
    if (attempt?.flow !== 'narration' && attempt?.flow !== 'narration-notes' && attempt?.flow !== 'narration-hi') return this.callAttempt(token, input)
    this.lastToolCall.set(attempt.id, Date.now())
    const key = narrationFlow.parseNotesTask(attempt.stepsStateJson)?.parentAttemptId ?? attempt.id
    return this.withNarrationLock(key, () => this.callAttempt(token, input))
  }

  private async withNarrationLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.narrationCalls.get(key) ?? Promise.resolve()
    const pending = previous.catch(() => undefined).then(work)
    this.narrationCalls.set(key, pending)
    try { return await pending } finally {
      if (this.narrationCalls.get(key) === pending) this.narrationCalls.delete(key)
    }
  }

  private async callAttempt(token: string, input: { tool: string; arguments: Record<string, unknown>; conversationId: string | null }) {
    const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError && { isError: true }) })
    const attempt = await this.prisma.antigravityAttempt.findFirst({ where: { capabilityHash: tokenHash(token) } })
    if (!attempt || attempt.status !== 'active') return text('This job capability is no longer active (finished, stopped or superseded). Stop working on this page.', true)
    if (input.conversationId) {
      if (attempt.conversationId && attempt.conversationId !== input.conversationId) return text('This capability belongs to a different conversation.', true)
      if (!attempt.conversationId) await this.prisma.antigravityAttempt.update({ where: { id: attempt.id }, data: { conversationId: input.conversationId } })
    }
    const job = await this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: attempt.jobId } })
    if (attempt.flow === 'narration-notes') return this.callNarrationNotes(attempt, job, input)
    if (job.currentAttemptId !== attempt.id || TERMINAL_STAGES.has(job.stage)) return text('This attempt was superseded or stopped.', true)
    if (attempt.flow === 'metadata') return this.callMetadata(attempt, job, input)
    if (attempt.flow?.startsWith('editor-')) return this.callEditor(attempt, job, input)
    if (attempt.flow === 'narration') return this.callNarration(attempt, job, input)
    if (attempt.flow === 'narration-hi') return this.callHinglish(attempt, job, input)
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
    if (job.preexistingPointer !== METADATA_RECREATE && await this.metadataSaved(chapter.folderPath, job.filename, current, meta.script)) return void (await this.setStage(jobId, 'skipped_existing', { lastError: 'Metadata was already saved for this cut (by a phone or by hand).' }))
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
    if (job.preexistingPointer === METADATA_RECREATE) return this.deliverRecreatedMetadata(jobId)
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

  /**
   * Recreate: the new Metadata replaces the page's old one in Studio (old file kept in .metadata-resets/), under a
   * new job revision; then the result and job go to R2 and the phones are asked to sync, so each phone drops its
   * old result and takes this one. When R2 fails the page stays saved in Studio and waits in Publish failed (Retry).
   */
  private async deliverRecreatedMetadata(jobId: string) {
    const job = await this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
    const chapter = await this.chapterOf(job.chapterId)
    const ref = { id: chapter.id, number: chapter.number, folderPath: chapter.folderPath, seriesId: chapter.series.id, series: { title: chapter.series.title } }
    try {
      await saveRecreatedMetadata(ref, job.filename, job.resultJson!)
    } catch (error) {
      return void (await this.setStage(jobId, 'needs_attention', { importState: 'failed', resultJson: null, resultSha256: null, lastError: `Metadata not saved: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500) }))
    }
    this.deps.onPointersChanged?.()
    await this.setStage(jobId, 'delivering', { importState: 'imported' })
    const crops = (JSON.parse(job.resultJson!).crops ?? []).length
    await this.event('metadata', `${job.filename}: Metadata recreated (${crops} crop${crops === 1 ? '' : 's'}); old file kept in .metadata-resets`, { runId: job.runId, jobId })
    return this.publishRecreatedMetadata(jobId)
  }

  /** Sends a recreated page's result + new job to R2 and asks the phones to sync. */
  private async publishRecreatedMetadata(jobId: string) {
    const job = await this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
    const chapter = await this.chapterOf(job.chapterId)
    const ref = { id: chapter.id, number: chapter.number, folderPath: chapter.folderPath, seriesId: chapter.series.id, series: { title: chapter.series.title } }
    try {
      const out = await (this.deps.publishMetadata ?? publishMetadataJobs)(ref)
      if ('waiting' in out && out.waiting) throw new Error(out.waiting)
      await this.setStage(jobId, 'done', { importState: 'imported', lastError: null })
      await this.event('metadata', `${job.filename}: recreated Metadata sent to R2 (${out.results ?? 0} result file${out.results === 1 ? '' : 's'}); phones asked to sync`, { runId: job.runId, jobId })
    } catch (error) {
      await this.setStage(jobId, 'publish_failed', { importState: 'imported', lastError: `Recreated Metadata is saved in Studio, but R2/phones were not updated: ${error instanceof Error ? error.message : String(error)}. Retry sends it again.`.slice(0, 500) })
    }
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

  // ─── Narration (a chapter's English script written from its pages; narrationFlow.ts) ───

  private narrationDeps(): narrationFlow.NarrationDeps {
    if (!this.deps.narration) throw new Error('Narration is not available in this Studio build.')
    return this.deps.narration
  }

  /** "Chapter 12 · English script" / "Chapter 12 · Hinglish script" for a Narration job's events. */
  private async narrationLabel(job: { chapterId: string; filename?: string }) {
    const chapter = await this.prisma.chapter.findUnique({ where: { id: job.chapterId }, select: { number: true } })
    return `Chapter ${chapter?.number ?? '?'} · ${narrationLanguageLabel(job.filename ? narrationLanguageOf(job.filename) ?? 'en' : 'en')} script`
  }

  private hinglishDeps(): hinglishFlow.HinglishDeps {
    const deps = this.narrationDeps().hinglish
    if (!deps) throw new Error('Hinglish narration is not available in this Studio build.')
    return deps
  }

  /**
   * Whether a chapter's script can be written now. [rewrite]: the operator ticked it, so a chapter that has a
   * script is written again (that script is backed up and replaced when the new one is saved).
   */
  private async inspectNarration(chapter: { id: string; folderPath: string }, rewrite: boolean, language: 'en' | 'hi' = 'en'): Promise<AcceptedPage | { reason: string; wait?: boolean }> {
    if (language === 'hi') {
      if (!this.narrationDeps().hinglish) return { reason: 'Hinglish narration is not available in this Studio build.' }
      const input = await this.hinglishDeps().input(chapter.id)
      if ('reason' in input) return input
      if (input.scriptSha256 && !rewrite) return { reason: 'Already has a Hinglish script. Tick the chapter to rewrite it.' }
      const manifest: narrationFlow.NarrationManifest = { schema: narrationFlow.MANIFEST_SCHEMA, language: 'hi', revision: input.revision, scriptSha256: input.scriptSha256, rewrite }
      return {
        chapterId: chapter.id, filename: hinglishFlow.FILENAME_HI, pageIndex: 1, sourceSha256: input.revision,
        width: 0, height: 0, folderPath: chapter.folderPath, preexisting: input.scriptSha256 ? 'script' : 'none', manifestJson: JSON.stringify(manifest)
      }
    }
    const input = await this.narrationDeps().input(chapter.id)
    if ('reason' in input) return input
    if (input.scriptSha256 && !rewrite) return { reason: 'Already has an English script. Tick the chapter to rewrite it.' }
    const manifest: narrationFlow.NarrationManifest = { schema: narrationFlow.MANIFEST_SCHEMA, language: 'en', revision: input.revision, scriptSha256: input.scriptSha256, rewrite }
    return {
      chapterId: chapter.id, filename: narrationFlow.FILENAME, pageIndex: 0, sourceSha256: input.revision,
      width: 0, height: 0, folderPath: chapter.folderPath, preexisting: input.scriptSha256 ? 'script' : 'none', manifestJson: JSON.stringify(manifest)
    }
  }

  /**
   * A run's Narration jobs that must wait: an earlier script of the same run isn't written yet. Each chapter is
   * written from the previous chapter's summary and closing, and its Hinglish from its English, so a rewrite of
   * chapters 1–3 goes 1 English, 1 Hinglish, 2 English, 2 Hinglish, … A Hinglish job that stopped for the operator
   * holds nothing up (no later English depends on it); a stopped English job does.
   */
  private async narrationWaiting(jobs: { id: string; chapterId: string; filename: string; stage: string }[]): Promise<Set<string>> {
    const unwritten = jobs.filter(j => j.stage !== 'done' && j.stage !== 'skipped_existing')
    if (unwritten.length < 2) return new Set()
    const chapters = await this.prisma.chapter.findMany({ where: { id: { in: unwritten.map(j => j.chapterId) } }, select: { id: true, number: true } })
    const number = new Map(chapters.map(c => [c.id, c.number]))
    const hi = (j: { filename: string }) => narrationLanguageOf(j.filename) === 'hi'
    const order = (j: { chapterId: string; filename: string }) => (number.get(j.chapterId) ?? Infinity) * 2 + (hi(j) ? 1 : 0)
    const blocking = unwritten.filter(j => !hi(j) || !TERMINAL_STAGES.has(j.stage))
    if (!blocking.length) return new Set()
    const first = Math.min(...blocking.map(order))
    return new Set(unwritten.filter(j => order(j) > first).map(j => j.id))
  }

  /** One chapter: its current inputs are re-read, its pages cut into labelled pieces agy shows at full size, then one attempt writes it. */
  private async processNarration(jobId: string, signal: AbortSignal) {
    let job = await this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
    const run = await this.prisma.antigravityRun.findUnique({ where: { id: job.runId }, select: { engine: true } })
    const settings = await this.deps.settings(engineOf(run?.engine))
    const chapter = await this.chapterOf(job.chapterId)
    const manifest = narrationFlow.parseManifest(job.manifestJson)
    if (!manifest) return void (await this.setStage(jobId, 'needs_attention', { lastError: 'This narration job has no inputs. Start the chapter again from the Narration page.' }))
    if (this.deps.sourceBusy && await this.deps.sourceBusy(chapter.folderPath)) return void (await this.setStage(jobId, 'needs_attention', { lastError: 'A page replacement or series restart is in progress for this chapter. Retry when Library has finished.' }))
    if (await this.ownedElsewhere(job)) return void (await this.setStage(jobId, 'needs_attention', { lastError: 'Another run is writing this chapter\'s script right now; its result wins.' }))
    if (manifest.language === 'hi') return this.processHinglish(jobId, signal, settings)
    const input = await this.narrationDeps().input(chapter.id)
    if ('reason' in input) return void (await this.setStage(jobId, 'needs_attention', { lastError: input.reason }))
    if (!manifest.rewrite && input.scriptSha256) return void (await this.setStage(jobId, 'skipped_existing', { lastError: 'The chapter got an English script meanwhile (from a phone or by hand); it was kept.' }))
    if (manifest.rewrite && input.scriptSha256 !== manifest.scriptSha256) return void (await this.setStage(jobId, 'needs_attention', { lastError: 'The chapter\'s script changed since it was ticked. Tick it again to rewrite the current one.' }))
    // An earlier chapter may have been written since this one was queued: always work on the current inputs.
    if (input.revision !== manifest.revision) {
      const next: narrationFlow.NarrationManifest = { ...manifest, revision: input.revision }
      job = await this.prisma.antigravityPageJob.update({ where: { id: jobId }, data: { manifestJson: JSON.stringify(next), manifestSha256: input.revision, sourceSha256: input.revision } })
    }
    if (!NARRATION_ENGINES.includes(settings.engine)) return void (await this.setStage(jobId, 'needs_attention', { lastError: narrationEngineError(settings.engine) }))
    if (settings.engine === 'antigravity' && TEXT_ONLY_MODEL.test(settings.model)) {
      await this.pauseRun(job.runId, `${settings.modelLabel ?? settings.model} has no image input, so it cannot read pages. Choose a vision model in Settings → AntiGravity, then start Narration again.`)
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
    const number = (await this.prisma.antigravityAttempt.count({ where: { jobId, flow: { not: 'narration-notes' } } })) + 1
    const attemptId = crypto.randomUUID()
    const attemptDir = path.join(this.deps.attemptRoot ?? ATTEMPT_ROOT, attemptId)
    const workspace = path.join(attemptDir, 'workspace')
    // Retry, Stop + Start and a new run keep the work already accepted for these exact inputs (Start over doesn't).
    const fresh = this.narrationFresh.delete(jobId)
    const earlier = fresh ? null : await this.narrationEarlierWork(job.chapterId, input.revision)
    let pieces: Awaited<ReturnType<typeof prepareChapterPages>>
    if (earlier) pieces = earlier.pieces
    else {
      try {
        pieces = await prepareChapterPages(input.pages, path.join(attemptDir, 'pieces'), this.narrationDeps().checkCode)
      } catch (error) {
        return void (await this.setStage(jobId, 'needs_attention', { lastError: `The pages could not be cut into pieces: ${error instanceof Error ? error.message : String(error)}` }))
      }
    }
    if (!pieces.length) return void (await this.setStage(jobId, 'needs_attention', { lastError: 'This chapter has no pages to read.' }))
    const startingState = earlier ? narrationFlow.carryOver(earlier) : narrationFlow.startState(input.revision, pieces, NARRATION_PREPARATION)
    const token = await this.grantCapability(workspace, settings.engine)
    await this.prisma.antigravityAttempt.create({
      data: {
        id: attemptId, jobId, number, status: 'active', stage: 'analyzing', capabilityHash: tokenHash(token), workspace, cliVersion: settings.cliVersion, engine: settings.engine, codexAccount: account?.id ?? null, requestedModel: settings.model,
        flow: 'narration', stepsStateJson: narrationFlow.stateJson(startingState)
      }
    })
    job = await this.setStage(jobId, 'analyzing', { currentAttemptId: attemptId, lastError: null })
    const name = await this.narrationLabel(job)
    if (account) await this.event('account', `${name}: running on ChatGPT account "${account.label}"`, { runId: job.runId, jobId, attemptId })
    await this.event('flow', `${name}: ${input.pages.length} pages cut into ${pieces.length} labelled pieces of at most 2,000 px, ${narrationFlow.batches(pieces).length} note batches, on ${settings.modelLabel ?? settings.model}${manifest.rewrite && input.scriptSha256 ? ' (rewrite: the current script is backed up when the new one is saved)' : ''}`, { runId: job.runId, jobId, attemptId })
    if (earlier) await this.event('flow', `${name}: kept ${narrationFlow.progressText(earlier)} from the previous attempt (same pages and inputs); only the rest is done again`, { runId: job.runId, jobId, attemptId })
    else if (fresh) await this.event('flow', `${name}: starting over — the pages are read again from the first one`, { runId: job.runId, jobId, attemptId })
    const ctx: TurnContext = { jobId, attemptId, workspace, signal, model: settings.model, deadline: Date.now() + settings.pageTimeoutMinutes * 60_000, codexHome: account?.home ?? null, watchStalls: true }
    return this.runNarration(ctx, settings)
  }

  /**
   * The newest earlier unfinished attempt's work on this chapter that a new attempt can take over: the same inputs
   * (pages, script, previous chapter's summary), pages prepared the same way and still on disk, and something accepted.
   */
  private async narrationEarlierWork(chapterId: string, revision: string): Promise<narrationFlow.NarrationState | null> {
    const jobIds = (await this.prisma.antigravityPageJob.findMany({ where: { chapterId, kind: 'narration' }, select: { id: true } })).map(j => j.id)
    if (!jobIds.length) return null
    const attempts = await this.prisma.antigravityAttempt.findMany({ where: { jobId: { in: jobIds }, flow: 'narration' }, orderBy: { startedAt: 'desc' }, take: 10, select: { stepsStateJson: true } })
    for (const attempt of attempts) {
      const state = narrationFlow.parseState(attempt.stepsStateJson)
      // Unfinished work only: a finished attempt's script was saved (or is retried as a delivery on its own).
      if (!state || state.stage === 'done' || state.revision !== revision || state.preparation !== NARRATION_PREPARATION || !Object.keys(state.notes).length) continue
      const present = await Promise.all(state.pieces.map(p => fs.stat(p.file).then(() => true, () => false)))
      if (present.every(Boolean)) return state
    }
    return null
  }

  /** One persisted notes worker per batch. Every worker stays on the parent attempt's engine/account/model. */
  private async parallelNarrationNotes(ctx: TurnContext, settings: RunSettings, effort: string | null): Promise<boolean> {
    const { jobId, attemptId, signal } = ctx
    const parent = await this.prisma.antigravityAttempt.findUniqueOrThrow({ where: { id: attemptId } })
    const initial = narrationFlow.parseState(parent.stepsStateJson)!
    if (initial.stage !== 'notes') return true
    const job = await this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
    const run = await this.prisma.antigravityRun.findUniqueOrThrow({ where: { id: job.runId } })
    const input = await this.narrationDeps().input(job.chapterId)
    if ('reason' in input) { await this.finisher(jobId, attemptId)('needs_attention', 'needs_attention', input.reason); return false }
    const all = narrationFlow.batches(initial.pieces)
    const pending = all.map((pieces, i) => ({ pieces, number: i + 1, total: all.length }))
      .filter(b => b.pieces.some(p => !initial.notes[p.id]))
    if (!pending.length) return true
    const limit = Math.max(1, Math.min(MAX_AI_SLOTS, run.concurrency, pending.length))
    const name = await this.narrationLabel(job)
    await this.event('step', `${name}: reading ${pending.length} pending notes batches in up to ${limit} parallel conversations; merge in page order before drafting`, { runId: job.runId, jobId, attemptId })
    const previous = await this.prisma.antigravityAttempt.findMany({ where: { jobId, flow: 'narration-notes' }, orderBy: { startedAt: 'desc' } })
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) controller.abort()
    let index = 0
    let failure: { status: string; error: string; result?: AgyTurnResult; childId?: string } | null = null
    const fail = (value: NonNullable<typeof failure>) => { failure ??= value; controller.abort() }

    const worker = async () => {
      while (!controller.signal.aborted) {
        const batch = pending[index++]
        if (!batch) return
        let child: AttemptRow | null = null
        try {
          // Reuse a durable failed/interrupted batch conversation made for exactly these pieces (a batch number alone
          // means other pieces once the batch size changes); accepted batches never enter this pool again.
          child = previous.find(a => {
            const task = narrationFlow.parseNotesTask(a.stepsStateJson)
            return task?.parentAttemptId === attemptId && narrationFlow.readsPieces(task, batch.pieces)
          }) ?? null
          const childId = child?.id ?? crypto.randomUUID()
          const workspace = child?.workspace ?? path.join(path.dirname(ctx.workspace), 'notes', childId, 'workspace')
          const task: narrationFlow.NotesTask = { schema: 'studio-ag-narration-notes/1', parentAttemptId: attemptId, batchNumber: batch.number, pieceIds: batch.pieces.map(p => p.id), accepted: false, issues: [] }
          const token = await this.grantCapability(workspace, settings.engine)
          const data = { status: 'active', stage: 'analyzing', capabilityHash: tokenHash(token), submissions: 0, error: null, finishedAt: null }
          child = child
            ? await this.prisma.antigravityAttempt.update({ where: { id: child.id }, data })
            : await this.prisma.antigravityAttempt.create({ data: { ...data, id: childId, jobId, number: parent.number, workspace,
                flow: 'narration-notes', stepsStateJson: JSON.stringify(task), engine: parent.engine, codexAccount: parent.codexAccount,
                requestedModel: ctx.model, cliVersion: settings.cliVersion } })
          await this.event('step', `${name}: notes batch ${batch.number} of ${batch.total} (${batch.pieces[0].id}…${batch.pieces.at(-1)!.id})`, { runId: job.runId, jobId, attemptId: childId })
          const childCtx: TurnContext = { ...ctx, attemptId: childId, workspace, signal: controller.signal, deadline: Date.now() + settings.pageTimeoutMinutes * 60_000 }
          const turn = this.turnRunner(childCtx, settings, effort)
          const load = () => this.prisma.antigravityAttempt.findUniqueOrThrow({ where: { id: childId } })
          const accepted = (a: AttemptRow) => narrationFlow.parseNotesTask(a.stepsStateJson)?.accepted === true
          const state = narrationFlow.parseState((await this.prisma.antigravityAttempt.findUniqueOrThrow({ where: { id: attemptId } })).stepsStateJson)!
          const expectedConversation = child.conversationId
          let result = await turn(narrationFlow.notesPrompt(input, state, batch), expectedConversation)
          child = await load()
          // Check every returned session id, including resumed turns from engines without conversation MCP metadata.
          let mismatch = !!(expectedConversation && result.envelope?.conversation_id && result.envelope.conversation_id !== expectedConversation)
          let stallRetried = false
          for (let nudge = 0; !accepted(child) && !mismatch && nudge < CONTINUATION_BUDGET; nudge++) {
            const afterStall = !!result.stalled && !stallRetried
            if (controller.signal.aborted || (!this.continuable(result) && !afterStall) || !child.conversationId) break
            if (afterStall) stallRetried = true
            await this.event('continue', afterStall
              ? `${name}: notes batch ${batch.number} stopped responding; continuing its conversation once`
              : `${name}: notes batch ${batch.number} not accepted; continuing its conversation (${nudge + 1}/${CONTINUATION_BUDGET})`, { runId: job.runId, jobId, attemptId: childId })
            const conversation = child.conversationId
            const issues = narrationFlow.parseNotesTask(child.stepsStateJson)?.issues ?? []
            await this.prisma.antigravityAttempt.update({ where: { id: childId }, data: { submissions: 0 } })
            childCtx.deadline = Date.now() + settings.pageTimeoutMinutes * 60_000
            result = await turn(narrationFlow.continuationPrompt('notes', this.deniedNames(result), issues), conversation)
            mismatch = !!(result.envelope?.conversation_id && result.envelope.conversation_id !== conversation)
            child = await load()
          }
          if (!controller.signal.aborted && accepted(child) && !mismatch) {
            await this.prisma.antigravityAttempt.update({ where: { id: childId }, data: { status: 'completed', stage: 'done', finishedAt: new Date() } })
          } else if (!controller.signal.aborted) {
            if (mismatch) await this.withNarrationLock(attemptId, async () => {
              const now = await this.prisma.antigravityAttempt.findUniqueOrThrow({ where: { id: attemptId } })
              const checkpoint = narrationFlow.parseState(now.stepsStateJson)!
              const notes = { ...checkpoint.notes }
              for (const piece of batch.pieces) delete notes[piece.id]
              await this.prisma.$transaction([
                this.prisma.antigravityAttempt.update({ where: { id: attemptId }, data: { stepsStateJson: narrationFlow.stateJson({ ...checkpoint, notes }) } }),
                this.prisma.antigravityAttempt.update({ where: { id: childId }, data: { stepsStateJson: JSON.stringify({ ...narrationFlow.parseNotesTask(child!.stepsStateJson)!, accepted: false, issues: ['Different conversation returned.'] }) } })
              ])
            })
            const issues = narrationFlow.parseNotesTask(child.stepsStateJson)?.issues ?? []
            const status = classifyProviderFailure(result) ? 'interrupted' : issues.length || child.conversationId ? 'needs_attention' : 'failed'
            const error = mismatch ? 'A notes turn answered from a different conversation.' : this.turnFailure(result, `Notes batch ${batch.number} was not accepted.${issues.length ? ' ' + issues.join(' ') : ''}`)
            await this.prisma.antigravityAttempt.update({ where: { id: childId }, data: { status, error, finishedAt: new Date() } })
            fail({ status, error, result, childId })
          } else {
            await this.prisma.antigravityAttempt.updateMany({ where: { id: childId, status: 'active' }, data: { status: signal.aborted ? 'cancelled' : 'interrupted', finishedAt: new Date(), error: 'Notes worker stopped; accepted checkpoints are retained.' } })
          }
          await this.recordToolUse(childId)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (child) await this.prisma.antigravityAttempt.updateMany({ where: { id: child.id, status: 'active' }, data: { status: signal.aborted ? 'cancelled' : 'interrupted', error: message, finishedAt: new Date() } })
          if (!controller.signal.aborted) fail({ status: 'needs_attention', error: message })
        }
      }
    }
    try {
      await Promise.all(Array.from({ length: limit }, () => worker().catch(error => {
        fail({ status: 'needs_attention', error: error instanceof Error ? error.message : String(error) })
      })))
    } finally { signal.removeEventListener('abort', onAbort) }
    const finish = this.finisher(jobId, attemptId)
    if (signal.aborted) { await finish('cancelled', 'cancelled', 'Stopped by the operator.'); return false }
    const failed = failure as { status: string; error: string; result?: AgyTurnResult; childId?: string } | null
    if (failed) {
      const stop = failed.result ? await this.providerStop(job.runId, failed.result, failed.childId) : false
      await finish(stop ? 'interrupted' : failed.status, stop === 'switched' ? 'queued' : stop ? 'interrupted' : failed.status, failed.error)
      return false
    }
    const done = narrationFlow.parseState((await this.prisma.antigravityAttempt.findUniqueOrThrow({ where: { id: attemptId } })).stepsStateJson)!
    if (done.pieces.some(p => !done.notes[p.id])) { await finish('needs_attention', 'needs_attention', 'Some page batches have no accepted notes. Continue to retry only those batches.'); return false }
    return true
  }

  /** A notes capability can only read/submit its assigned batch; merges are serialized by parent attempt id. */
  private async callNarrationNotes(attempt: AttemptRow, job: JobRow, input: { tool: string; arguments: Record<string, unknown> }) {
    const text = (message: string, isError = false) => ({ content: [{ type: 'text', text: message }], ...(isError && { isError: true }) })
    const task = narrationFlow.parseNotesTask(attempt.stepsStateJson)
    const parent = task ? await this.prisma.antigravityAttempt.findUnique({ where: { id: task.parentAttemptId } }) : null
    const state = narrationFlow.parseState(parent?.stepsStateJson)
    if (!task || !parent || !state || parent.jobId !== job.id || parent.status !== 'active' || job.currentAttemptId !== parent.id || TERMINAL_STAGES.has(job.stage)) return text('This notes capability was stopped or superseded.', true)
    if (task.accepted) return text('Notes accepted. Reply with one word: SUBMITTED.')
    if (state.stage !== 'notes') return text('Notes collection has ended. Stop working on this batch.', true)
    const all = narrationFlow.batches(state.pieces)
    const pieces = narrationFlow.taskPieces(task, state)
    if (!pieces?.length) return text('This notes batch no longer exists.', true)
    const chapter = await this.narrationDeps().input(job.chapterId)
    if ('reason' in chapter || chapter.revision !== state.revision) return text('The chapter inputs changed. Stop working on this batch.', true)
    switch (input.tool) {
      case 'get_job_context': return text(narrationFlow.contextText(job.id, chapter, state, { pieces, number: task.batchNumber, total: all.length }))
      case 'fetch_piece': {
        const id = String(input.arguments.piece_id ?? '')
        const piece = pieces.find(p => p.id === id)
        if (!piece) return text(`This conversation may only read its assigned pages: ${pieces.map(p => p.id).join(', ')}.`, true)
        const bytes = await fs.readFile(piece.file)
        const delivered = new Set<string>(JSON.parse(attempt.deliveredJson))
        delivered.add(`piece:${id}`)
        await this.prisma.antigravityAttempt.update({ where: { id: attempt.id }, data: { deliveredJson: JSON.stringify([...delivered]) } })
        return { content: [{ type: 'text', text: `${id}: page ${piece.page}, ${piece.parts > 1 ? `part ${piece.part} of ${piece.parts}` : 'whole page'} (${piece.width}×${piece.height} px). Read its CHECK code from the band.\n${engine.OPEN_IMAGE_HINT}` }, { type: 'image', data: bytes.toString('base64'), mimeType: 'image/jpeg' }] }
      }
      case 'submit_notes': {
        if (attempt.submissions >= narrationFlow.MAX_SUBMISSIONS) return text('Too many invalid submissions. Stop and reply SUBMITTED.', true)
        try {
          const delivered = new Set<string>(JSON.parse(attempt.deliveredJson))
          const missing = pieces.filter(p => !delivered.has(`piece:${p.id}`))
          if (missing.length) throw new narrationFlow.InvalidReply(`Fetch and look at every assigned page first. Not fetched yet: ${missing.map(p => p.id).join(', ')}.`)
          if (attempt.engine === 'antigravity' && attempt.conversationId) {
            const viewed = await readImagesViewed(attempt.conversationId, this.deps.cliHome)
            const unopened = viewed ? unopenedImages(viewed, pieces.map(p => p.id)) : []
            if (unopened.length) throw new narrationFlow.InvalidReply(`Open the delivered image files with read_file before submitting: ${unopened.map(p => `${p.id}: ${p.file}`).join('; ')}.`)
          }
          const notes = narrationFlow.readNotes(narrationFlow.submittedText(input.arguments, 'json', 'pieces'), pieces)
          await this.prisma.$transaction([
            this.prisma.antigravityAttempt.update({ where: { id: parent.id }, data: { stepsStateJson: narrationFlow.stateJson({ ...state, notes: { ...state.notes, ...Object.fromEntries(notes.map(n => [n.id, n])) }, issues: [] }) } }),
            this.prisma.antigravityAttempt.update({ where: { id: attempt.id }, data: { stepsStateJson: JSON.stringify({ ...task, accepted: true, issues: [] }), submissions: 0 } })
          ])
          await this.event('checkpoint', `${await this.narrationLabel(job)}: notes batch ${task.batchNumber} accepted for ${notes.map(n => n.id).join(', ')} (${Object.keys(state.notes).length + notes.filter(n => !state.notes[n.id]).length} of ${state.pieces.length})`, { runId: job.runId, jobId: job.id, attemptId: attempt.id })
          return text('Notes accepted. Reply with one word: SUBMITTED.')
        } catch (error) {
          if (!(error instanceof narrationFlow.InvalidReply)) throw error
          await this.prisma.antigravityAttempt.update({ where: { id: attempt.id }, data: { stepsStateJson: JSON.stringify({ ...task, issues: [error.message] }), submissions: { increment: 1 } } })
          return text(`Not accepted: ${error.message}\nFix it and submit again.`, true)
        }
      }
      default: return text('This conversation only has get_job_context, fetch_piece and submit_notes. Writing and review happen after all batches finish.', true)
    }
  }

  /** Read notes batches in parallel, then draft, review and final check in one writing conversation. */
  private async runNarration(ctx: TurnContext, settings: RunSettings, effort = settings.effort) {
    const { jobId, attemptId, signal } = ctx
    const turn = this.turnRunner(ctx, settings, effort)
    const finish = this.finisher(jobId, attemptId)
    const job = await this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
    const manifest = narrationFlow.parseManifest(job.manifestJson)!
    const name = await this.narrationLabel(job)
    const input = await this.narrationDeps().input(job.chapterId)
    if ('reason' in input) return finish('needs_attention', 'needs_attention', input.reason)
    if (input.revision !== manifest.revision) return finish('needs_attention', 'needs_attention', 'The chapter\'s pages, script or the previous chapter\'s summary changed since this attempt began. Retry to write it from the current ones.')
    const load = () => this.prisma.antigravityAttempt.findUniqueOrThrow({ where: { id: attemptId } })
    const stateOf = (a: { stepsStateJson: string | null }) => narrationFlow.parseState(a.stepsStateJson)!
    const saveState = (state: narrationFlow.NarrationState) => this.prisma.antigravityAttempt.update({ where: { id: attemptId }, data: { stepsStateJson: narrationFlow.stateJson(state) } })

    /** One stage's turn in [conversation] (null: a new one), with same-conversation nudges, until [done]. */
    const stage = async (what: narrationFlow.Stage, prompt: string, conversation: string | null, done: (s: narrationFlow.NarrationState) => boolean): Promise<boolean> => {
      await this.prisma.antigravityAttempt.update({ where: { id: attemptId }, data: { submissions: 0, conversationId: conversation } })
      ctx.deadline = Date.now() + settings.pageTimeoutMinutes * 60_000
      let result = await turn(prompt, conversation)
      let attempt = await load()
      // The writing conversation is kept for the review and the check, and for Continue.
      if (what === 'draft' && attempt.conversationId && !stateOf(attempt).writingConversation) {
        await saveState({ ...stateOf(attempt), writingConversation: attempt.conversationId })
        attempt = await load()
      }
      let stallRetried = false
      for (let nudge = 0; !done(stateOf(attempt)) && nudge < CONTINUATION_BUDGET; nudge++) {
        // A stalled turn (no activity) gets one more turn in its conversation; a second stall stops for Continue.
        const afterStall = !!result.stalled && !stallRetried
        if (signal.aborted || (!this.continuable(result) && !afterStall) || !attempt.conversationId) break
        if (afterStall) stallRetried = true
        await this.event('continue', afterStall
          ? `${name}: the ${what} turn stopped responding; continuing the same conversation once`
          : `${name}: ${what} not accepted; continuing the same conversation (${nudge + 1}/${CONTINUATION_BUDGET})`, { runId: job.runId, jobId, attemptId })
        await this.prisma.antigravityAttempt.update({ where: { id: attemptId }, data: { submissions: 0 } })
        ctx.deadline = Date.now() + settings.pageTimeoutMinutes * 60_000
        result = await turn(narrationFlow.continuationPrompt(what, this.deniedNames(result), stateOf(attempt).issues), attempt.conversationId)
        attempt = await load()
      }
      if (signal.aborted) { await finish('cancelled', 'cancelled', 'Stopped by the operator.'); return false }
      if (result.envelope?.conversation_id && attempt.conversationId && result.envelope.conversation_id !== attempt.conversationId) { await finish('failed', 'failed', 'A narration turn answered from a different conversation.'); return false }
      if (done(stateOf(attempt))) return true
      const stop = await this.providerStop(job.runId, result, attemptId)
      if (stop) { await finish('interrupted', stop === 'switched' ? 'queued' : 'interrupted', this.turnFailure(result, `No ${what} accepted.`)); return false }
      const issues = stateOf(attempt).issues
      // A stall or timeout leaves the conversation usable: Needs attention, so Continue picks it up there.
      const status = attempt.conversationId && (issues.length || result.envelope?.denied_actions?.length || result.stalled || result.timedOut) ? 'needs_attention' : 'failed'
      await finish(status, status, this.turnFailure(result, issues.length ? `The ${what} still has problems: ${issues.slice(0, 3).join(' ')}` : `No ${what} was submitted through Studio's tool.`))
      return false
    }

    // Notes workers have independent workspaces/capabilities/conversations; only merged checkpoints are shared.
    if (!(await this.parallelNarrationNotes(ctx, settings, effort))) return
    let state = stateOf(await load())
    if (state.stage === 'notes') await saveState(state = { ...state, stage: 'draft', issues: [] })
    if (state.stage === 'draft') {
      await this.setStage(jobId, 'planning')
      await this.event('step', `${name}: writing the draft from ${state.pieces.length} pieces' notes`, { runId: job.runId, jobId, attemptId })
      const prompt = state.writingConversation ? narrationFlow.continuationPrompt('draft', [], state.issues) : narrationFlow.draftPrompt(input, state)
      if (!(await stage('draft', prompt, state.writingConversation, s => s.stage !== 'draft'))) return
      state = stateOf(await load())
    }
    if (state.stage === 'review') {
      await this.setStage(jobId, 'reviewing')
      await this.event('step', `${name}: reviewing the draft against the notes`, { runId: job.runId, jobId, attemptId })
      if (!(await stage('review', narrationFlow.reviewPrompt(input, state), state.writingConversation, s => s.stage !== 'review'))) return
      state = stateOf(await load())
    }
    if (state.stage === 'check') {
      await this.event('step', `${name}: final spoken-narration check`, { runId: job.runId, jobId, attemptId })
      if (!(await stage('check', narrationFlow.checkPrompt(state), state.writingConversation, s => s.stage !== 'check'))) return
    }
    return this.commitNarration(ctx)
  }

  /** Commit boundary: only the current, active attempt's checked script for unchanged inputs is saved. */
  private async commitNarration(ctx: TurnContext) {
    const { jobId, attemptId, signal } = ctx
    const job = await this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
    const attempt = await this.prisma.antigravityAttempt.findUniqueOrThrow({ where: { id: attemptId } })
    const name = await this.narrationLabel(job)
    if (signal.aborted || attempt.status !== 'active' || job.currentAttemptId !== attemptId) return void (await this.event('stage', `${name}: script discarded (attempt stopped or superseded)`, { runId: job.runId, jobId, attemptId }))
    const finish = this.finisher(jobId, attemptId)
    await this.setStage(jobId, 'validating')
    const manifest = narrationFlow.parseManifest(job.manifestJson)!
    const state = narrationFlow.parseState(attempt.stepsStateJson)
    if (!state?.final) return finish('needs_attention', 'needs_attention', 'No checked script to save.')
    const input = await this.narrationDeps().input(job.chapterId)
    if ('reason' in input) return finish('needs_attention', 'needs_attention', input.reason)
    if (input.revision !== manifest.revision) return finish('needs_attention', 'needs_attention', 'The chapter\'s pages, script or the previous chapter\'s summary changed while the script was written. Retry to write it again.')
    const output: narrationFlow.NarrationOutput = { ...state.final.reply, audit: narrationFlow.auditJson(state, state.final) }
    const json = JSON.stringify(output)
    await this.prisma.antigravityPageJob.update({ where: { id: jobId }, data: { resultJson: json, resultSha256: sha256(json) } })
    await this.prisma.antigravityAttempt.update({ where: { id: attemptId }, data: { stage: 'done', status: 'completed', finishedAt: new Date() } })
    await this.recordToolUse(attemptId)
    await this.deliverNarration(jobId)
  }

  /** Saves the script like Narration's Replace (backup, reset, send to phones). Never calls the AI. */
  async deliverNarration(jobId: string) {
    const job = await this.setStage(jobId, 'delivering')
    if (!job.resultJson) throw new Error('No checked script to save.')
    const manifest = narrationFlow.parseManifest(job.manifestJson)
    if (!manifest) throw new Error('This narration job has no inputs.')
    const name = await this.narrationLabel(job)
    const attempt = job.currentAttemptId ? await this.prisma.antigravityAttempt.findUnique({ where: { id: job.currentAttemptId } }) : null
    const served = attempt?.observedModel && attempt.observedModel !== 'unknown' ? attempt.observedModel : attempt?.requestedModel ?? 'unknown model'
    const model = `Studio AntiGravity (${label(engineOf(attempt?.engine))} · ${served})`
    const hinglish = manifest.language === 'hi'
    let sent: { phoneSent: boolean; phoneError?: string }
    try {
      if (hinglish) {
        const result = JSON.parse(job.resultJson) as hinglishFlow.HinglishResult
        sent = await this.hinglishDeps().save(job.chapterId, result.text, manifest.scriptSha256, result.sourceSha256, model)
      } else {
        sent = await this.narrationDeps().save(job.chapterId, JSON.parse(job.resultJson) as narrationFlow.NarrationOutput, manifest.scriptSha256, model)
      }
    } catch (error) {
      return void (await this.setStage(jobId, 'needs_attention', { importState: 'failed', lastError: `Script not saved: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500) }))
    }
    await this.setStage(jobId, 'done', { importState: 'imported', lastError: sent.phoneSent ? null : `Saved on this Mac, not sent to the phones: ${sent.phoneError ?? 'R2 is not set up'}. Use Replace in Narration to send it.`.slice(0, 500) })
    await this.event('narration', `${name}: script saved${manifest.scriptSha256 ? ` (the previous one is backed up; this chapter's ${hinglish ? 'Hindi ' : ''}voiceover, alignment and timeline were reset)` : ''}${sent.phoneSent ? ' and sent to the phones for voiceover' : ''}.`, { runId: job.runId, jobId })
    // The chapter's Hinglish is written from the English just saved.
    if (!hinglish) await this.queueHinglishAfter(job)
  }

  /** Continue a script left in Needs attention / Interrupted with its pieces and accepted notes. */
  private async narrationAgain(jobId: string) {
    const job = await this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
    if (!['needs_attention', 'interrupted', 'failed', 'cancelled'].includes(job.stage)) throw new Error('Continue is for scripts that stopped before they were saved (Needs attention, Interrupted, Failed or Stopped).')
    if (job.resultJson && job.importState !== 'imported') throw new Error('This script is written; use Retry to save it again.')
    if ([...this.live.values()].some(l => l.kind === 'ai')) throw new Error('Wait for the current chapter to finish before continuing another narration chapter.')
    const attempt = job.currentAttemptId ? await this.prisma.antigravityAttempt.findUnique({ where: { id: job.currentAttemptId } }) : null
    if (attempt?.flow === 'narration-hi') return this.hinglishAgain(job, attempt)
    const manifest = narrationFlow.parseManifest(job.manifestJson)
    const state = narrationFlow.parseState(attempt?.stepsStateJson)
    if (!attempt || attempt.flow !== 'narration' || !manifest || !state) throw new Error('This chapter has no narration attempt to continue; use Retry instead.')
    if (!NARRATION_ENGINES.includes(engineOf(attempt.engine))) throw new Error(`${narrationEngineError(engineOf(attempt.engine))} Retry keeps the notes already accepted.`)
    if (state.preparation !== NARRATION_PREPARATION) throw new Error('This attempt\'s pages were prepared the old way. Use Retry (or Start over) to cut them into pieces agy shows at full size.')
    if (!(await fs.stat(state.pieces[0]?.file ?? '').then(() => true, () => false))) throw new Error('This attempt\'s pieces are gone; use Retry instead.')
    const input = await this.narrationDeps().input(job.chapterId)
    if ('reason' in input) throw new Error(`Not ready: ${input.reason}`)
    if (input.revision !== manifest.revision) throw new Error('The chapter\'s pages, script or the previous chapter\'s summary changed since this attempt; use Retry.')
    const run = await this.prisma.antigravityRun.findUniqueOrThrow({ where: { id: job.runId } })
    const settings = await this.deps.settings(engineOf(attempt.engine))
    const account = attempt.codexAccount && this.deps.codexAccounts ? await this.deps.codexAccounts.get(attempt.codexAccount) : null
    if (attempt.codexAccount && this.deps.codexAccounts && !account) throw new Error('The ChatGPT account this attempt ran on was removed; use Retry instead.')
    const runId = await this.enterProcess(job, engineOf(attempt.engine))
    const token = await this.grantCapability(attempt.workspace, engineOf(attempt.engine))
    const stage = state.stage === 'notes' ? 'analyzing' : state.stage === 'draft' ? 'planning' : 'reviewing'
    await this.prisma.antigravityAttempt.update({ where: { id: attempt.id }, data: { status: 'active', stage, capabilityHash: tokenHash(token), submissions: 0, error: null, finishedAt: null } })
    await this.setStage(jobId, stage, { lastError: null })
    await this.event('review', `${await this.narrationLabel(job)}: continue from ${state.stage === 'notes' ? `notes (${Object.keys(state.notes).length} of ${state.pieces.length} pieces done)` : `the ${state.stage}`}`, { runId, jobId, attemptId: attempt.id })
    const controller = new AbortController()
    this.live.set(jobId, { controller, runId, kind: 'ai' })
    const ctx: TurnContext = { jobId, attemptId: attempt.id, workspace: attempt.workspace, signal: controller.signal, model: attempt.requestedModel, deadline: Date.now() + settings.pageTimeoutMinutes * 60_000, codexHome: account?.home ?? null, watchStalls: true }
    void this.runNarration(ctx, settings, run.effort)
      .catch(async error => {
        const now = await this.prisma.antigravityPageJob.findUnique({ where: { id: jobId } })
        if (now && !TERMINAL_STAGES.has(now.stage)) await this.setStage(jobId, 'failed', { lastError: error instanceof Error ? error.message : String(error) })
        await this.prisma.antigravityAttempt.updateMany({ where: { id: attempt.id, status: 'active' }, data: { status: 'failed', error: error instanceof Error ? error.message : String(error), finishedAt: new Date() } })
      })
      .finally(() => this.live.delete(jobId))
    void this.schedule(runId, false)
    return this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
  }

  /** MCP tools of a Narration attempt: get_job_context, fetch_piece and the current stage's submit tool. */
  private async callNarration(attempt: AttemptRow, job: JobRow, input: { tool: string; arguments: Record<string, unknown> }) {
    const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError && { isError: true }) })
    const state = narrationFlow.parseState(attempt.stepsStateJson)
    if (!state) return text('This job has no narration state. Stop working on it.', true)
    const chapter = await this.narrationDeps().input(job.chapterId)
    if ('reason' in chapter) return text(`${chapter.reason} Stop working on this chapter.`, true)
    const save = (next: Partial<narrationFlow.NarrationState>, extra: Record<string, unknown> = {}) =>
      this.prisma.antigravityAttempt.update({ where: { id: attempt.id }, data: { stepsStateJson: narrationFlow.stateJson({ ...state, ...next }), ...extra } })
    const refuse = async (message: string) => {
      await save({ issues: [message] }, { submissions: { increment: 1 } })
      return text(`Not accepted: ${message}\nFix it and submit again.`, true)
    }
    const raw = (name: 'json' | 'text', field?: string) => narrationFlow.submittedText(input.arguments, name, field)
    const submit = async (expected: narrationFlow.Stage, accept: () => Promise<ReturnType<typeof text>>) => {
      if (state.stage !== expected) return text(`This is the ${state.stage} stage; ${expected === 'notes' ? 'notes' : `the ${expected}`} cannot be submitted now.`, true)
      if (attempt.submissions >= narrationFlow.MAX_SUBMISSIONS) return text('Too many invalid submissions for this stage. Stop and reply with one word: SUBMITTED.', true)
      try { return await accept() } catch (error) {
        if (error instanceof narrationFlow.InvalidReply) return refuse(error.message)
        throw error
      }
    }
    const notes = narrationFlow.orderedNotes(state)
    const requireAbout = chapter.requireAbout
    switch (input.tool) {
      case 'get_job_context':
        return text(narrationFlow.contextText(job.id, chapter, state))
      case 'fetch_piece': {
        const id = String(input.arguments.piece_id ?? '').trim()
        const piece = state.pieces.find(p => p.id === id)
        if (!piece) return text(`Unknown piece_id "${id}". This chapter's pieces run from ${state.pieces[0].id} to ${state.pieces.at(-1)!.id}.`, true)
        const data = await fs.readFile(piece.file).catch(() => null)
        if (!data) return text('This attempt\'s pieces are gone. Stop working on this chapter.', true)
        const delivered = new Set<string>(JSON.parse(attempt.deliveredJson))
        delivered.add(`piece:${id}`)
        await this.prisma.antigravityAttempt.update({ where: { id: attempt.id }, data: { deliveredJson: JSON.stringify([...delivered]) } })
        return {
          content: [
            { type: 'text', text: `${id}: page ${piece.page}, part ${piece.part} of ${piece.parts} (${piece.width}×${piece.height} px). Read the CHECK code in the band on top.\n${engine.OPEN_IMAGE_HINT}` },
            { type: 'image', data: data.toString('base64'), mimeType: 'image/jpeg' }
          ]
        }
      }
      case 'submit_notes':
        return submit('notes', async () => {
          const batch = narrationFlow.nextBatch(state)
          if (!batch) return text('Every piece already has notes. Reply with one word: SUBMITTED.')
          const delivered = new Set<string>(JSON.parse(attempt.deliveredJson))
          const missing = batch.pieces.filter(p => !delivered.has(`piece:${p.id}`)).map(p => p.id)
          if (missing.length) return refuse(`Fetch and look at every piece of this batch first (fetch_piece). Not fetched yet: ${missing.join(', ')}.`)
          // agy saves MCP images to files the model only sees by opening them.
          if (attempt.engine === 'antigravity' && attempt.conversationId) {
            const viewed = await readImagesViewed(attempt.conversationId, this.deps.cliHome)
            const unopened = viewed ? unopenedImages(viewed, batch.pieces.map(p => p.id)) : []
            if (unopened.length) return refuse([`You have not looked at ${unopened.map(u => u.id).join(', ')}. Call read_file on each path, look at the image, then submit again:`, ...unopened.map(u => `- ${u.id}: ${u.file}`)].join('\n'))
          }
          const accepted = narrationFlow.readNotes(raw('json', 'pieces'), batch.pieces)
          const next = { ...state.notes, ...Object.fromEntries(accepted.map(n => [n.id, n])) }
          const done = state.pieces.every(p => next[p.id])
          await save({ notes: next, issues: [], ...(done && { stage: 'draft' as const }) }, { submissions: 0 })
          await this.event('checkpoint', `${await this.narrationLabel(job)}: notes accepted for ${accepted.map(n => n.id).join(', ')} (${Object.keys(next).length} of ${state.pieces.length})`, { runId: job.runId, jobId: job.id, attemptId: attempt.id })
          return text('Notes accepted. Reply with one word: SUBMITTED.')
        })
      case 'submit_draft':
        return submit('draft', async () => {
          const draft = narrationFlow.checkDraft(raw('text'), requireAbout)
          await save({ draft, stage: 'review', issues: [], maxScriptWords: undefined }, { submissions: 0 })
          await this.event('checkpoint', `${await this.narrationLabel(job)}: draft accepted (${narrationWords(draft.script)} words)`, { runId: job.runId, jobId: job.id, attemptId: attempt.id })
          return text('Draft accepted. Reply with one word: SUBMITTED; the review follows in this conversation.')
        })
      case 'submit_review':
        return submit('review', async () => {
          const reviewed = narrationFlow.readReview(raw('json', 'paragraphs'), notes, requireAbout, narrationFlow.background(chapter))
          await save({ review: reviewed.review, stage: 'check', issues: [] }, { submissions: 0 })
          await this.event('checkpoint', `${await this.narrationLabel(job)}: image review accepted`, { runId: job.runId, jobId: job.id, attemptId: attempt.id })
          return text('Review accepted. Reply with one word: SUBMITTED; the final check follows in this conversation.')
        })
      case 'submit_check':
        return submit('check', async () => {
          const checked = narrationFlow.readCheck(raw('json', 'paragraphs'), notes, requireAbout, state.review as Record<string, unknown>, narrationFlow.background(chapter))
          await save({ final: checked, stage: 'done', issues: [] }, { submissions: 0 })
          await this.event('checkpoint', `${await this.narrationLabel(job)}: final check accepted`, { runId: job.runId, jobId: job.id, attemptId: attempt.id })
          return text('Script accepted. Reply with one word: SUBMITTED.')
        })
      default:
        return text(`Unknown tool ${input.tool}. This chapter's tools are get_job_context, fetch_piece, submit_notes, submit_draft, submit_review and submit_check.`, true)
    }
  }

  // ─── Narration, Hinglish (a chapter's Hinglish script written from its saved English one; narrationHinglish.ts) ───

  /** One chapter's Hinglish: its current English is re-read, then one attempt writes it in one text-only conversation. */
  private async processHinglish(jobId: string, signal: AbortSignal, settings: RunSettings) {
    let job = await this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
    const manifest = narrationFlow.parseManifest(job.manifestJson)!
    const input = await this.hinglishDeps().input(job.chapterId)
    if ('reason' in input) return void (await this.setStage(jobId, 'needs_attention', { lastError: input.reason }))
    if (!manifest.rewrite && input.scriptSha256) return void (await this.setStage(jobId, 'skipped_existing', { lastError: 'The chapter got a Hinglish script meanwhile (from a phone or by hand); it was kept.' }))
    if (manifest.rewrite && input.scriptSha256 !== manifest.scriptSha256) return void (await this.setStage(jobId, 'needs_attention', { lastError: 'The chapter\'s Hinglish script changed since this job was queued. Tick the chapter again to rewrite the current one.' }))
    // The English may have been saved again since this job was queued: always work from the current one.
    if (input.revision !== manifest.revision) {
      const next: narrationFlow.NarrationManifest = { ...manifest, revision: input.revision }
      job = await this.prisma.antigravityPageJob.update({ where: { id: jobId }, data: { manifestJson: JSON.stringify(next), manifestSha256: input.revision, sourceSha256: input.revision } })
    }
    if (!NARRATION_ENGINES.includes(settings.engine)) return void (await this.setStage(jobId, 'needs_attention', { lastError: narrationEngineError(settings.engine) }))
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
    // Retry, Stop + Start and a new run keep the stages already accepted for this exact English (Start over doesn't).
    const fresh = this.narrationFresh.delete(jobId)
    const earlier = fresh ? null : await this.hinglishEarlierWork(job.chapterId, input.revision)
    const state = hinglishFlow.startHinglishState(input.revision, earlier)
    const token = await this.grantCapability(workspace, settings.engine)
    await this.prisma.antigravityAttempt.create({
      data: {
        id: attemptId, jobId, number, status: 'active', stage: 'planning', capabilityHash: tokenHash(token), workspace, cliVersion: settings.cliVersion, engine: settings.engine, codexAccount: account?.id ?? null, requestedModel: settings.model,
        flow: 'narration-hi', stepsStateJson: hinglishFlow.hinglishStateJson(state)
      }
    })
    job = await this.setStage(jobId, 'planning', { currentAttemptId: attemptId, lastError: null })
    const name = await this.narrationLabel(job)
    if (account) await this.event('account', `${name}: running on ChatGPT account "${account.label}"`, { runId: job.runId, jobId, attemptId })
    await this.event('flow', `${name}: written from the chapter's English script (${narrationWords(input.source.script)} words) in one conversation — scene notes, narration, final check — on ${settings.modelLabel ?? settings.model}${input.scriptSha256 ? ' (the current Hinglish is backed up when the new one is saved)' : ''}`, { runId: job.runId, jobId, attemptId })
    if (earlier) await this.event('flow', `${name}: kept ${hinglishFlow.hinglishProgressText(state)} from the previous attempt (same English script)`, { runId: job.runId, jobId, attemptId })
    const ctx: TurnContext = { jobId, attemptId, workspace, signal, model: settings.model, deadline: Date.now() + settings.pageTimeoutMinutes * 60_000, codexHome: account?.home ?? null, watchStalls: true }
    return this.runHinglish(ctx, settings)
  }

  /** The newest earlier unfinished Hinglish attempt's accepted stages for this exact English, or null. */
  private async hinglishEarlierWork(chapterId: string, revision: string) {
    const jobIds = (await this.prisma.antigravityPageJob.findMany({ where: { chapterId, kind: 'narration', filename: hinglishFlow.FILENAME_HI }, select: { id: true } })).map(j => j.id)
    if (!jobIds.length) return null
    const attempts = await this.prisma.antigravityAttempt.findMany({ where: { jobId: { in: jobIds }, flow: 'narration-hi' }, orderBy: { startedAt: 'desc' }, take: 10, select: { stepsStateJson: true } })
    for (const attempt of attempts) {
      const state = hinglishFlow.parseHinglishState(attempt.stepsStateJson)
      if (state && state.revision === revision && !state.progress.final && state.progress.scenes) return state.progress
    }
    return null
  }

  /** Scene notes, narration and final check, each in the attempt's one conversation, then the save. */
  private async runHinglish(ctx: TurnContext, settings: RunSettings, effort = settings.effort) {
    const { jobId, attemptId, signal } = ctx
    const turn = this.turnRunner(ctx, settings, effort)
    const finish = this.finisher(jobId, attemptId)
    const job = await this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
    const manifest = narrationFlow.parseManifest(job.manifestJson)!
    const name = await this.narrationLabel(job)
    const input = await this.hinglishDeps().input(job.chapterId)
    if ('reason' in input) return finish('needs_attention', 'needs_attention', input.reason)
    if (input.revision !== manifest.revision) return finish('needs_attention', 'needs_attention', 'The chapter\'s English script changed since this attempt began. Retry to write the Hinglish from the current one.')
    const load = () => this.prisma.antigravityAttempt.findUniqueOrThrow({ where: { id: attemptId } })
    const stateOf = (a: { stepsStateJson: string | null }) => hinglishFlow.parseHinglishState(a.stepsStateJson)!
    for (;;) {
      let attempt = await load()
      const state = stateOf(attempt)
      const current = hinglishFlow.hinglishStage(state.progress)
      if (current === 'done') break
      const label = hinglishFlow.STAGE_LABELS[current]
      await this.setStage(jobId, current === 'hi_check' ? 'reviewing' : 'planning')
      await this.event('step', `${name}: ${label}`, { runId: job.runId, jobId, attemptId })
      await this.prisma.antigravityAttempt.update({ where: { id: attemptId }, data: { submissions: 0 } })
      ctx.deadline = Date.now() + settings.pageTimeoutMinutes * 60_000
      const conversation = attempt.conversationId
      const prompt = conversation && state.issues.length ? hinglishFlow.hinglishContinuationPrompt(state, []) : hinglishFlow.hinglishStagePrompt(input, state)
      let result = await turn(prompt, conversation)
      attempt = await load()
      const advanced = (a: { stepsStateJson: string | null }) => hinglishFlow.hinglishStage(stateOf(a).progress) !== current
      let stallRetried = false
      for (let nudge = 0; !advanced(attempt) && nudge < CONTINUATION_BUDGET; nudge++) {
        // A stalled turn (no activity) gets one more turn in its conversation; a second stall stops for Continue.
        const afterStall = !!result.stalled && !stallRetried
        if (signal.aborted || (!this.continuable(result) && !afterStall) || !attempt.conversationId) break
        if (afterStall) stallRetried = true
        await this.event('continue', afterStall
          ? `${name}: the ${label} turn stopped responding; continuing the same conversation once`
          : `${name}: ${label} not accepted; continuing the same conversation (${nudge + 1}/${CONTINUATION_BUDGET})`, { runId: job.runId, jobId, attemptId })
        await this.prisma.antigravityAttempt.update({ where: { id: attemptId }, data: { submissions: 0 } })
        ctx.deadline = Date.now() + settings.pageTimeoutMinutes * 60_000
        result = await turn(hinglishFlow.hinglishContinuationPrompt(stateOf(attempt), this.deniedNames(result)), attempt.conversationId)
        attempt = await load()
      }
      if (signal.aborted) return finish('cancelled', 'cancelled', 'Stopped by the operator.')
      if (result.envelope?.conversation_id && attempt.conversationId && result.envelope.conversation_id !== attempt.conversationId) return finish('failed', 'failed', 'A Hinglish turn answered from a different conversation.')
      if (advanced(attempt)) continue
      const stop = await this.providerStop(job.runId, result, attemptId)
      if (stop) return finish('interrupted', stop === 'switched' ? 'queued' : 'interrupted', this.turnFailure(result, `No ${label} accepted.`))
      const issues = stateOf(attempt).issues
      // A stall or timeout leaves the conversation usable: Needs attention, so Continue picks it up there.
      const status = attempt.conversationId && (issues.length || result.envelope?.denied_actions?.length || result.stalled || result.timedOut) ? 'needs_attention' : 'failed'
      return finish(status, status, this.turnFailure(result, issues.length ? `The ${label} still has problems: ${issues.slice(0, 3).join(' ')}` : `No ${label} was submitted through Studio's tool.`))
    }
    return this.commitHinglish(ctx)
  }

  /** Commit boundary: only the current, active attempt's checked Hinglish for an unchanged English is saved. */
  private async commitHinglish(ctx: TurnContext) {
    const { jobId, attemptId, signal } = ctx
    const job = await this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
    const attempt = await this.prisma.antigravityAttempt.findUniqueOrThrow({ where: { id: attemptId } })
    const name = await this.narrationLabel(job)
    if (signal.aborted || attempt.status !== 'active' || job.currentAttemptId !== attemptId) return void (await this.event('stage', `${name}: script discarded (attempt stopped or superseded)`, { runId: job.runId, jobId, attemptId }))
    const finish = this.finisher(jobId, attemptId)
    await this.setStage(jobId, 'validating')
    const manifest = narrationFlow.parseManifest(job.manifestJson)!
    const state = hinglishFlow.parseHinglishState(attempt.stepsStateJson)
    if (!state?.progress.final) return finish('needs_attention', 'needs_attention', 'No checked Hinglish script to save.')
    const input = await this.hinglishDeps().input(job.chapterId)
    if ('reason' in input) return finish('needs_attention', 'needs_attention', input.reason)
    if (input.revision !== manifest.revision) return finish('needs_attention', 'needs_attention', 'The chapter\'s English script changed while the Hinglish was written. Retry to write it again.')
    const json = JSON.stringify({ text: state.progress.final, sourceSha256: input.sourceSha256 } satisfies hinglishFlow.HinglishResult)
    await this.prisma.antigravityPageJob.update({ where: { id: jobId }, data: { resultJson: json, resultSha256: sha256(json) } })
    await this.prisma.antigravityAttempt.update({ where: { id: attemptId }, data: { stage: 'done', status: 'completed', finishedAt: new Date() } })
    this.lastToolCall.delete(attemptId)
    await this.recordToolUse(attemptId)
    await this.deliverNarration(jobId)
  }

  /**
   * After a chapter's English script is saved, its Hinglish is written next in the same process (from that English),
   * unless a Hinglish written from this exact English is already there.
   */
  private async queueHinglishAfter(englishJob: { runId: string; chapterId: string }) {
    if (!this.deps.narration?.hinglish) return
    const name = await this.narrationLabel({ chapterId: englishJob.chapterId, filename: hinglishFlow.FILENAME_HI })
    try {
      const input = await this.hinglishDeps().input(englishJob.chapterId)
      if ('reason' in input) return void (await this.event('run', `${name}: not started — ${input.reason}`, { runId: englishJob.runId }))
      if (input.scriptSha256 && input.madeFromSha256 === input.sourceSha256) return void (await this.event('run', `${name}: already written from this English script; kept`, { runId: englishJob.runId }))
      const run = await this.prisma.antigravityRun.findUnique({ where: { id: englishJob.runId } })
      if (!run) return
      if (run.control === 'stop_requested' || run.control === 'stopped') return void (await this.event('run', `${name}: not started because the process is stopping. Start process (or tick the chapter) writes it later.`, { runId: run.id }))
      const chapter = await this.chapterOf(englishJob.chapterId)
      // The Hinglish on disk (if any) was written from another English: it is rewritten (backed up on save).
      const checked = await this.inspectNarration(chapter, true, 'hi')
      if ('reason' in checked) return void (await this.event('run', `${name}: not started — ${checked.reason}`, { runId: run.id }))
      const out = await this.admit(run.id, run.seriesId, checked, profileOf(run, JSON.parse(run.promptJson).hashes), false, 'narration')
      if (!out.inRun) return void (await this.event('run', `${name}: another process is writing it`, { runId: run.id, jobId: out.id }))
      await this.event('run', `Next script: ${name} (from the English just saved)`, { runId: run.id, jobId: out.id })
      if (!LIVE_CONTROLS.has(run.control)) await this.enterProcess({ id: out.id, runId: run.id, filename: hinglishFlow.FILENAME_HI, kind: 'narration' })
      void this.schedule(run.id, false)
    } catch (error) {
      await this.event('run', `${name}: not queued — ${error instanceof Error ? error.message : String(error)}`, { runId: englishJob.runId })
    }
  }

  /** Continue a Hinglish attempt left in Needs attention / Interrupted in its own conversation. */
  private async hinglishAgain(job: JobRow, attempt: AttemptRow) {
    const jobId = job.id
    const manifest = narrationFlow.parseManifest(job.manifestJson)
    const state = hinglishFlow.parseHinglishState(attempt.stepsStateJson)
    if (!manifest || !state) throw new Error('This chapter has no Hinglish attempt to continue; use Retry instead.')
    if (!NARRATION_ENGINES.includes(engineOf(attempt.engine))) throw new Error(`${narrationEngineError(engineOf(attempt.engine))} Retry keeps the stages already accepted.`)
    const input = await this.hinglishDeps().input(job.chapterId)
    if ('reason' in input) throw new Error(`Not ready: ${input.reason}`)
    if (input.revision !== manifest.revision) throw new Error('The chapter\'s English script changed since this attempt; use Retry.')
    const run = await this.prisma.antigravityRun.findUniqueOrThrow({ where: { id: job.runId } })
    const settings = await this.deps.settings(engineOf(attempt.engine))
    const account = attempt.codexAccount && this.deps.codexAccounts ? await this.deps.codexAccounts.get(attempt.codexAccount) : null
    if (attempt.codexAccount && this.deps.codexAccounts && !account) throw new Error('The ChatGPT account this attempt ran on was removed; use Retry instead.')
    const runId = await this.enterProcess(job, engineOf(attempt.engine))
    const token = await this.grantCapability(attempt.workspace, engineOf(attempt.engine))
    const stage = hinglishFlow.hinglishStage(state.progress) === 'hi_check' ? 'reviewing' : 'planning'
    await this.prisma.antigravityAttempt.update({ where: { id: attempt.id }, data: { status: 'active', stage, capabilityHash: tokenHash(token), submissions: 0, error: null, finishedAt: null } })
    await this.setStage(jobId, stage, { lastError: null })
    await this.event('review', `${await this.narrationLabel(job)}: continue (accepted so far: ${hinglishFlow.hinglishProgressText(state)})`, { runId, jobId, attemptId: attempt.id })
    const controller = new AbortController()
    this.live.set(jobId, { controller, runId, kind: 'ai' })
    const ctx: TurnContext = { jobId, attemptId: attempt.id, workspace: attempt.workspace, signal: controller.signal, model: attempt.requestedModel, deadline: Date.now() + settings.pageTimeoutMinutes * 60_000, codexHome: account?.home ?? null, watchStalls: true }
    void this.runHinglish(ctx, settings, run.effort)
      .catch(async error => {
        const now = await this.prisma.antigravityPageJob.findUnique({ where: { id: jobId } })
        if (now && !TERMINAL_STAGES.has(now.stage)) await this.setStage(jobId, 'failed', { lastError: error instanceof Error ? error.message : String(error) })
        await this.prisma.antigravityAttempt.updateMany({ where: { id: attempt.id, status: 'active' }, data: { status: 'failed', error: error instanceof Error ? error.message : String(error), finishedAt: new Date() } })
      })
      .finally(() => this.live.delete(jobId))
    void this.schedule(runId, false)
    return this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
  }

  /** MCP tools of a Hinglish attempt: get_job_context, get_reference and submit_hinglish. */
  private async callHinglish(attempt: AttemptRow, job: JobRow, input: { tool: string; arguments: Record<string, unknown> }) {
    const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError && { isError: true }) })
    const state = hinglishFlow.parseHinglishState(attempt.stepsStateJson)
    if (!state) return text('This job has no Hinglish state. Stop working on it.', true)
    const chapter = await this.hinglishDeps().input(job.chapterId)
    if ('reason' in chapter) return text(`${chapter.reason} Stop working on this chapter.`, true)
    if (chapter.revision !== state.revision) return text('The chapter\'s English script changed. Stop working on this chapter.', true)
    const save = (next: hinglishFlow.HinglishState, extra: Record<string, unknown> = {}) =>
      this.prisma.antigravityAttempt.update({ where: { id: attempt.id }, data: { stepsStateJson: hinglishFlow.hinglishStateJson(next), ...extra } })
    switch (input.tool) {
      case 'get_job_context':
        return text(hinglishFlow.hinglishContextText(job.id, chapter, state))
      case 'get_reference': {
        const args = input.arguments
        const name = String(args.name ?? args.reference ?? Object.values(args).find(v => typeof v === 'string') ?? '')
        return text(hinglishFlow.hinglishReferenceText(name, chapter, state))
      }
      case 'submit_hinglish': {
        const expected = hinglishFlow.hinglishStage(state.progress)
        if (expected === 'done') return text('Every stage is accepted. Reply with one word: SUBMITTED.')
        if (attempt.submissions >= hinglishFlow.MAX_SUBMISSIONS_HI) return text('Too many invalid submissions for this stage. Stop and reply with one word: SUBMITTED.', true)
        const stage = hinglishFlow.submittedStage(input.arguments, expected)
        try {
          const { stage: _stage, ...rest } = input.arguments
          const next = hinglishFlow.acceptHinglishSubmission(state, stage, narrationFlow.submittedText(rest, 'text'), chapter)
          await save(next, { submissions: 0 })
          const after = hinglishFlow.hinglishStage(next.progress)
          await this.event('checkpoint', `${await this.narrationLabel(job)}: ${hinglishFlow.STAGE_LABELS[stage]} accepted`, { runId: job.runId, jobId: job.id, attemptId: attempt.id })
          return text(after === 'done'
            ? 'Hinglish script accepted. Reply with one word: SUBMITTED.'
            : `Accepted. Reply with one word: SUBMITTED; the next stage (${hinglishFlow.STAGE_LABELS[after]}) follows in this conversation.`)
        } catch (error) {
          if (!(error instanceof narrationFlow.InvalidReply)) throw error
          await save({ ...state, issues: [error.message] }, { submissions: { increment: 1 } })
          return text(`Not accepted: ${error.message}\nFix it and submit again.`, true)
        }
      }
      default:
        return text(`Unknown tool ${input.tool}. This chapter's tools are get_job_context, get_reference and submit_hinglish.`, true)
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

  /**
   * stop: no new page starts and the pages (chapters) in progress finish and save, then the run stops.
   * stop-now: in-progress pages are cancelled at once and cannot commit late results.
   * resume also takes back a stop that is still waiting for its page.
   */
  async control(runId: string, action: 'pause' | 'resume' | 'stop' | 'stop-now') {
    const run = await this.prisma.antigravityRun.findUniqueOrThrow({ where: { id: runId } })
    if (action === 'pause') {
      if (['running', 'preparing'].includes(run.control)) await this.prisma.antigravityRun.update({ where: { id: runId }, data: { control: 'pause_requested' } })
    } else if (action === 'stop' && [...this.live.values()].some(l => l.runId === runId) && !['stopped', 'completed', 'completed_with_errors', 'interrupted'].includes(run.control)) {
      if (run.control !== 'stop_requested') {
        await this.prisma.antigravityRun.update({ where: { id: runId }, data: { control: 'stop_requested' } })
        await this.event('run', 'Stopping: no new pages start; the page in progress finishes first.', { runId })
      }
      // The scheduler may have left already (a provider pause): it waits for the page, then stops the run.
      void this.schedule(runId, false)
    } else if (action === 'resume') {
      if (['paused', 'pause_requested', 'interrupted', 'stop_requested'].includes(run.control)) {
        const live = await this.liveRun()
        if (live && live.id !== runId) throw new Error('Another process is running. One process at a time: let it finish or stop it first.')
        const scan = this.scans.get(runId)
        if (scan) scan.emptyAt = 0
        await this.prisma.antigravityRun.update({ where: { id: runId }, data: { control: 'running', finishedAt: null } })
        void this.schedule(runId, false)
      }
    } else {
      await this.prisma.antigravityRun.update({ where: { id: runId }, data: { control: 'stop_requested' } })
      await this.finishStop(runId)
    }
    return this.prisma.antigravityRun.findUniqueOrThrow({ where: { id: runId } })
  }

  /** Ends a stopping run: anything still in progress is cancelled (none after a graceful stop), queued pages too. */
  private async finishStop(runId: string) {
    // Revoke capabilities first so a late tool call cannot commit.
    const jobs = await this.prisma.antigravityPageJob.findMany({ where: { runId } })
    for (const job of jobs) {
      if (job.currentAttemptId) await this.prisma.antigravityAttempt.updateMany({ where: { id: job.currentAttemptId, status: 'active' }, data: { status: 'cancelled', finishedAt: new Date() } })
      this.live.get(job.id)?.controller.abort()
      if (!TERMINAL_STAGES.has(job.stage) && job.stage !== 'prepared') await this.setStage(job.id, 'cancelled', { lastError: 'Stopped by the operator.' })
    }
    // The scheduler and Stop now can both get here; only the first one reports the stop.
    const { count } = await this.prisma.antigravityRun.updateMany({ where: { id: runId, control: 'stop_requested' }, data: { control: 'stopped', finishedAt: new Date() } })
    if (count === 0) return
    if (this.publishedRuns.delete(runId)) {
      const run = await this.prisma.antigravityRun.findUnique({ where: { id: runId }, select: { seriesId: true } })
      if (run) await this.notify(run.seriesId, runId)
    }
    this.scans.delete(runId)
    this.pickOff.delete(runId)
    await this.event('run', 'Run stopped.', { runId })
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
    if (kindOf(job.kind) === 'narration') throw new Error('Scripts are not rejected here; tick the chapter on the Narration page and start it again to rewrite it.')
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
  /** [options.fresh] (Narration): start over instead of taking over the previous attempt's accepted work. */
  async retry(jobId: string, options: { fresh?: boolean } = {}) {
    const job = await this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
    if (!RETRYABLE_STAGES.has(job.stage)) throw new Error('Only failed, interrupted, stopped or rejected pages can be retried.')
    if (this.live.has(jobId)) throw new Error('This page is still running.')
    if (job.stage === 'rejected') return this.runAgain(jobId)
    if (job.stage === 'publish_failed' && job.importState === 'imported') return this.publishAgain(jobId)
    if (job.resultJson && job.importState !== 'imported') {
      // Delivery-only retry: no new AI request.
      await (kindOf(job.kind) === 'metadata' ? this.deliverMetadata(jobId) : kindOf(job.kind) === 'editor' ? this.deliverEditor(jobId) : kindOf(job.kind) === 'narration' ? this.deliverNarration(jobId) : this.deliver(jobId))
      return this.prisma.antigravityPageJob.findUniqueOrThrow({ where: { id: jobId } })
    }
    if (kindOf(job.kind) === 'narration') {
      if (options.fresh) this.narrationFresh.add(jobId)
      else this.narrationFresh.delete(jobId)
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
    const attempts = await this.prisma.antigravityAttempt.findMany({ where: { jobId: { in: jobs.map(j => j.id) }, flow: { not: 'narration-notes' } }, orderBy: { number: 'asc' } })
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
