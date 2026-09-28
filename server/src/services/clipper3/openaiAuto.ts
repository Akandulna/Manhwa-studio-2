/**
 * Crop Studio — the hybrid ChatGPT loop run through the OpenAI API instead of
 * by hand.
 *
 * It drives exactly the steps the operator does in the page dialog, through
 * the same services, so every guarantee they give still holds:
 *
 *   1. build (or reuse) the verified handoff package        handoff.ts
 *   2. send prompt + slices, import the reply               analysisImport.ts
 *   3. start the review from that import                    reviewState.ts
 *   4. review rounds in the same conversation until ready   chatgptReview.ts
 *   5. export the finished page (optional)                  exportPage.ts
 *
 * A reply the validators refuse is sent back with the validator's errors and
 * asked for again (a couple of times) — nothing is clamped or repaired here.
 * A page that is still not export-ready after the configured review rounds
 * stops at `needs_review` for the operator, exactly like a manual round would.
 *
 * The conversation (minus the image bytes) is written next to the page's
 * other studio state under `api-runs/`, so a run can be audited afterwards.
 *
 * Configuration lives in the server's .env (like the Gemini key), set from
 * Settings → Crop 3.0: OPENAI_API_KEY, OPENAI_CROP_MODEL, OPENAI_BASE_URL,
 * OPENAI_CROP_REASONING_EFFORT, OPENAI_CROP_REVIEW_ROUNDS, OPENAI_CROP_INCLUDE_RULES,
 * OPENAI_CROP_CONCURRENCY.
 */

import fs from 'fs/promises'
import path from 'path'
import { buildHandoff, getHandoffStatus, getStudioDir, type HandoffContext } from './handoff.js'
import { importAnalysis, type ImportIssue } from './analysisImport.js'
import { getReview, startReview } from './reviewState.js'
import { applyChatGptReview, getReviewPrompt } from './chatgptReview.js'
import { exportPage } from './exportPage.js'
import { getSliceDir } from './perImageSlice.js'
import { readPointerGuidelines } from './pointerGuidelines.js'
import { writeEnvVars } from '../../utils/envFile.js'

export const DEFAULT_OPENAI_CROP_MODEL = 'gpt-5.6-sol'
/** Sent as `reasoning_effort`; '' leaves it to the model (needed for non-reasoning models like gpt-4o). */
export const REASONING_EFFORTS = ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
export type ReasoningEffort = typeof REASONING_EFFORTS[number]
const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'high'
const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const API_RUNS_DIR = 'api-runs'

/** Attempts per step when the app's validator refuses a reply. */
const MAX_REPLY_ATTEMPTS = 3
/** Transport retries for 429 / 5xx / timeouts. */
const MAX_HTTP_ATTEMPTS = 4
/** Reasoning models looking at a dozen 2048 px slices can take a while. */
const REQUEST_TIMEOUT_MS = 15 * 60_000
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504])

// ============ Configuration ============

export interface OpenAiCropConfig {
  apiKey: string
  model: string
  baseUrl: string
  reasoningEffort: ReasoningEffort
  reviewRounds: number
  includeRules: boolean
  concurrency: number
}

function readEffort(value: string | undefined): ReasoningEffort {
  if (value === undefined) return DEFAULT_REASONING_EFFORT
  const v = value.trim().toLowerCase()
  return (REASONING_EFFORTS as readonly string[]).includes(v) ? (v as ReasoningEffort) : DEFAULT_REASONING_EFFORT
}

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(value ?? '', 10)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

export function getOpenAiCropConfig(): OpenAiCropConfig {
  return {
    apiKey: (process.env.OPENAI_API_KEY || '').trim(),
    model: (process.env.OPENAI_CROP_MODEL || '').trim() || DEFAULT_OPENAI_CROP_MODEL,
    baseUrl: ((process.env.OPENAI_BASE_URL || '').trim() || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    reasoningEffort: readEffort(process.env.OPENAI_CROP_REASONING_EFFORT),
    reviewRounds: clampInt(process.env.OPENAI_CROP_REVIEW_ROUNDS, 3, 0, 6),
    includeRules: process.env.OPENAI_CROP_INCLUDE_RULES !== 'false',
    concurrency: clampInt(process.env.OPENAI_CROP_CONCURRENCY, 2, 1, 4)
  }
}

/** What the client may see: never the key itself. */
export function publicOpenAiConfig() {
  const { apiKey, ...rest } = getOpenAiCropConfig()
  return { ...rest, hasKey: !!apiKey, keyHint: apiKey ? `…${apiKey.slice(-4)}` : null }
}

export interface OpenAiConfigUpdate {
  apiKey?: string
  clearKey?: boolean
  model?: string
  baseUrl?: string
  reasoningEffort?: string
  reviewRounds?: number
  includeRules?: boolean
  concurrency?: number
}

/**
 * Writes the given values into the server's .env and process.env, so they
 * take effect immediately and survive a restart — the same way the Gemini key
 * is stored. Values are single-line; anything with a newline is refused.
 */
export async function updateOpenAiConfig(update: OpenAiConfigUpdate): Promise<void> {
  const vars: Record<string, string> = {}
  if (update.clearKey) vars.OPENAI_API_KEY = ''
  else if (typeof update.apiKey === 'string' && update.apiKey.trim()) vars.OPENAI_API_KEY = update.apiKey.trim()
  if (typeof update.model === 'string') vars.OPENAI_CROP_MODEL = update.model.trim()
  if (typeof update.baseUrl === 'string') vars.OPENAI_BASE_URL = update.baseUrl.trim()
  if (typeof update.reasoningEffort === 'string') {
    const effort = update.reasoningEffort.trim().toLowerCase()
    if (!(REASONING_EFFORTS as readonly string[]).includes(effort)) {
      throw new Error(`Reasoning effort must be one of: ${REASONING_EFFORTS.filter(Boolean).join(', ')} (or empty for the model default)`)
    }
    vars.OPENAI_CROP_REASONING_EFFORT = effort
  }
  if (typeof update.reviewRounds === 'number') vars.OPENAI_CROP_REVIEW_ROUNDS = String(Math.round(update.reviewRounds))
  if (typeof update.includeRules === 'boolean') vars.OPENAI_CROP_INCLUDE_RULES = String(update.includeRules)
  if (typeof update.concurrency === 'number') vars.OPENAI_CROP_CONCURRENCY = String(Math.round(update.concurrency))

  await writeEnvVars(vars)
}

/** Checks the key AND that the configured model exists for it. */
export async function testOpenAiConnection(): Promise<{ success: boolean; model: string; error?: string }> {
  const config = getOpenAiCropConfig()
  if (!config.apiKey) return { success: false, model: config.model, error: 'No OpenAI API key saved' }
  try {
    const response = await fetch(`${config.baseUrl}/models/${encodeURIComponent(config.model)}`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(15_000)
    })
    if (response.ok) return { success: true, model: config.model }
    const detail = await response.text().catch(() => '')
    if (response.status === 404) {
      const similar = await similarModels(config)
      return {
        success: false,
        model: config.model,
        error: `Model "${config.model}" is not available to this key (404)` +
          (similar.length > 0 ? `. Did you mean: ${similar.join(', ')}?` : '')
      }
    }
    const message =
      response.status === 401 ? 'The API key was rejected (401)'
        : `OpenAI responded ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`
    return { success: false, model: config.model, error: message }
  } catch (error) {
    return { success: false, model: config.model, error: error instanceof Error ? error.message : 'Connection failed' }
  }
}

/** Model ids this key can use that look like the configured one (shared version number or name parts). */
async function similarModels(config: OpenAiCropConfig): Promise<string[]> {
  try {
    const response = await fetch(`${config.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(15_000)
    })
    if (!response.ok) return []
    const ids: string[] = ((await response.json() as any)?.data ?? []).map((m: any) => String(m.id))
    const parts = config.model.toLowerCase().split(/[^a-z0-9.]+/).filter(p => p && p !== 'gpt')
    return ids
      .filter(id => parts.some(p => id.toLowerCase().includes(p)))
      .sort()
      .slice(0, 8)
  } catch {
    return []
  }
}

// ============ Chat ============

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail: 'high' }; _file?: string }

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentPart[]
}

interface ChatResult {
  text: string
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null
}

class OpenAiHttpError extends Error {
  constructor(message: string, public readonly status: number, public readonly retryAfterMs: number | null) {
    super(message)
    this.name = 'OpenAiHttpError'
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new CancelledError())
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(timer); reject(new CancelledError()) }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

class CancelledError extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'CancelledError'
  }
}

/** The request body sent to OpenAI: our private `_file` markers stripped. */
function wireMessages(messages: ChatMessage[]) {
  return messages.map(m => ({
    role: m.role,
    content: typeof m.content === 'string'
      ? m.content
      : m.content.map(part => (part.type === 'image_url' ? { type: part.type, image_url: part.image_url } : part))
  }))
}

async function chatOnce(config: OpenAiCropConfig, messages: ChatMessage[], signal: AbortSignal): Promise<ChatResult> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      messages: wireMessages(messages),
      ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
      // Every prompt in this loop asks for ONE JSON object and names it as such.
      response_format: { type: 'json_object' }
    }),
    signal: AbortSignal.any([signal, timeout])
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    let message = detail
    try { message = JSON.parse(detail)?.error?.message || detail } catch { /* not JSON */ }
    const retryAfter = Number(response.headers.get('retry-after'))
    throw new OpenAiHttpError(
      `OpenAI ${response.status}${message ? `: ${String(message).slice(0, 300)}` : ''}`,
      response.status,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null
    )
  }
  const json = await response.json() as any
  const choice = json?.choices?.[0]
  const text: string = choice?.message?.content ?? ''
  if (!text.trim()) {
    const reason = choice?.finish_reason ? ` (finish_reason: ${choice.finish_reason})` : ''
    const refusal = choice?.message?.refusal ? ` — ${choice.message.refusal}` : ''
    throw new Error(`OpenAI returned no text${reason}${refusal}`)
  }
  return { text, usage: json?.usage ?? null }
}

async function chat(config: OpenAiCropConfig, messages: ChatMessage[], signal: AbortSignal): Promise<ChatResult> {
  let lastError: unknown
  for (let attempt = 0; attempt < MAX_HTTP_ATTEMPTS; attempt++) {
    if (signal.aborted) throw new CancelledError()
    try {
      return await chatOnce(config, messages, signal)
    } catch (error) {
      if (signal.aborted) throw new CancelledError()
      lastError = error
      const retryable =
        (error instanceof OpenAiHttpError && RETRYABLE_STATUS.has(error.status)) ||
        (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'TypeError'))
      if (!retryable || attempt === MAX_HTTP_ATTEMPTS - 1) throw error
      const delay = (error instanceof OpenAiHttpError && error.retryAfterMs) || 5_000 * 2 ** attempt
      console.log(`[clipper3/openai] ${error instanceof Error ? error.message.slice(0, 80) : 'error'} — retry ${attempt + 1} in ${delay}ms`)
      await sleep(delay, signal)
    }
  }
  throw lastError
}

// ============ One page ============

export type AutoStep =
  | 'queued'
  | 'packaging'
  | 'analyzing'
  | 'reviewing'
  | 'exporting'
  | 'done'
  | 'ready'
  | 'needs_review'
  | 'failed'
  | 'cancelled'

export interface AutoPageStatus {
  filename: string
  step: AutoStep
  message: string
  round: number
  crops: number | null
  blockers: string[]
  tokens: number
  startedAt: string | null
  finishedAt: string | null
}

export interface AutoPageContext extends HandoffContext {
  chapterNumber: number
}

const SYSTEM_PROMPT =
  'You are a meticulous manhwa crop analyst working for an app that validates every reply by code. ' +
  'You are given the slices of ONE page as images. Measure carefully in each slice\'s own pixel grid ' +
  '(the images may be shown to you downscaled — always answer in the pixel sizes the prompt states). ' +
  'Every reply must be exactly one JSON object in the schema the latest user message asks for.'

function rulesBlock(rules: string): string {
  return [
    '',
    'CROP RULES — use these to decide WHAT to crop and where each edge goes.',
    'Ignore any output format, file naming or normalized-coordinate instructions inside them:',
    'the JSON contract in the user messages always wins.',
    '',
    '=== BEGIN CROP RULES ===',
    rules.trim(),
    '=== END CROP RULES ==='
  ].join('\n')
}

function describeIssues(issues: ImportIssue[], limit = 25): string {
  const lines = issues.slice(0, limit).map(i => `- ${i.field ? `${i.field}: ` : ''}${i.message}`)
  if (issues.length > limit) lines.push(`- …and ${issues.length - limit} more`)
  return lines.join('\n')
}

function correctionPrompt(issues: ImportIssue[]): string {
  return [
    'The app\'s validator REJECTED that reply. Problems:',
    describeIssues(issues),
    '',
    'Fix every problem and return the COMPLETE corrected JSON object (not a diff), with no prose.'
  ].join('\n')
}

function mimeFor(filename: string): string {
  const ext = path.extname(filename).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  return 'image/webp'
}

async function writeTranscript(ctx: AutoPageContext, config: OpenAiCropConfig, messages: ChatMessage[], status: AutoPageStatus) {
  try {
    const dir = path.join(getStudioDir(ctx.folderPath, ctx.imageFilename), API_RUNS_DIR)
    await fs.mkdir(dir, { recursive: true })
    const stamp = (status.startedAt ?? new Date().toISOString()).replace(/[:.]/g, '-')
    const transcript = {
      model: config.model,
      reasoning_effort: config.reasoningEffort || null,
      include_rules: config.includeRules,
      status,
      messages: messages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string'
          ? m.content
          : m.content.map(p => (p.type === 'image_url' ? { type: 'image', file: p._file } : p))
      }))
    }
    await fs.writeFile(path.join(dir, `${stamp}.json`), JSON.stringify(transcript, null, 2) + '\n', 'utf-8')
  } catch (error) {
    console.error('[clipper3/openai] writing transcript failed:', error)
  }
}

/**
 * Runs the whole loop for one page, reporting progress through `update`.
 * Never throws for page-level problems — they end in `failed` / `needs_review`.
 */
export async function runPageViaApi(
  ctx: AutoPageContext,
  options: { export: boolean },
  config: OpenAiCropConfig,
  rules: string,
  update: (patch: Partial<AutoPageStatus>) => void,
  current: () => AutoPageStatus,
  signal: AbortSignal
): Promise<void> {
  const messages: ChatMessage[] = []
  let tokens = 0
  const ask = async (): Promise<string> => {
    const result = await chat(config, messages, signal)
    tokens += result.usage?.total_tokens ?? 0
    update({ tokens })
    messages.push({ role: 'assistant', content: result.text })
    return result.text
  }

  update({ step: 'packaging', message: 'Building the ChatGPT package', startedAt: new Date().toISOString() })
  try {
    // 1. Package — reused when it still matches the files on disk.
    let handoff = await getHandoffStatus(ctx.folderPath, ctx.imageFilename)
    if (handoff.status !== 'ready' || !handoff.manifest || !handoff.prompt) {
      const built = await buildHandoff(ctx)
      handoff = { status: 'ready', staleReasons: [], manifest: built.manifest, prompt: built.prompt }
    }
    const manifest = handoff.manifest!
    const sliceDir = getSliceDir(ctx.folderPath, ctx.imageFilename)
    const images: ContentPart[] = []
    for (const slice of manifest.slices) {
      const bytes = await fs.readFile(path.join(sliceDir, path.basename(slice.file)))
      images.push({
        type: 'image_url',
        image_url: { url: `data:${mimeFor(slice.file)};base64,${bytes.toString('base64')}`, detail: 'high' },
        _file: slice.file
      })
    }

    messages.push({ role: 'system', content: SYSTEM_PROMPT + (config.includeRules && rules.trim() ? '\n' + rulesBlock(rules) : '') })
    messages.push({ role: 'user', content: [{ type: 'text', text: handoff.prompt! }, ...images] })

    // 2. Analysis → import, with the validator's errors fed back on refusal.
    update({ step: 'analyzing', message: `Sending ${images.length} slice${images.length === 1 ? '' : 's'} to ${config.model}` })
    let imported = false
    let lastErrors: ImportIssue[] = []
    for (let attempt = 1; attempt <= MAX_REPLY_ATTEMPTS && !imported; attempt++) {
      if (attempt > 1) {
        messages.push({ role: 'user', content: correctionPrompt(lastErrors) })
        update({ message: `Reply rejected — asking again (${attempt}/${MAX_REPLY_ATTEMPTS})` })
      }
      const outcome = await importAnalysis(ctx.folderPath, ctx.imageFilename, await ask())
      imported = outcome.imported
      lastErrors = outcome.errors
      if (imported) update({ crops: outcome.analysis?.candidates.length ?? 0 })
    }
    if (!imported) {
      update({ step: 'failed', message: `ChatGPT's analysis was rejected ${MAX_REPLY_ATTEMPTS}×: ${lastErrors[0]?.message ?? 'invalid reply'}`, blockers: lastErrors.slice(0, 10).map(e => e.message) })
      return
    }

    // 3. Review, seeded from that import (an older review goes to review-history/).
    let view = await startReview(ctx.folderPath, ctx.imageFilename, 'import', true)

    // 4. Review rounds in the same conversation, until ready or out of rounds.
    for (let round = 1; round <= config.reviewRounds && !view.readiness.ready; round++) {
      update({ step: 'reviewing', round, message: `Review round ${round}/${config.reviewRounds}` })
      const { prompt } = await getReviewPrompt(ctx.folderPath, ctx.imageFilename)
      messages.push({ role: 'user', content: prompt })
      let applied = false
      for (let attempt = 1; attempt <= MAX_REPLY_ATTEMPTS && !applied; attempt++) {
        if (attempt > 1) {
          messages.push({ role: 'user', content: correctionPrompt(lastErrors) })
          update({ message: `Review round ${round}: reply rejected — asking again (${attempt}/${MAX_REPLY_ATTEMPTS})` })
        }
        const outcome = await applyChatGptReview(ctx.folderPath, ctx.imageFilename, await ask())
        applied = outcome.applied
        lastErrors = outcome.errors
        if (outcome.view) view = outcome.view
      }
      if (!applied) {
        update({ message: `Review round ${round} was rejected ${MAX_REPLY_ATTEMPTS}×: ${lastErrors[0]?.message ?? 'invalid reply'}` })
        break
      }
      update({ crops: view.state?.crops.length ?? null })
    }

    view = await getReview(ctx.folderPath, ctx.imageFilename)
    const crops = view.state?.crops.length ?? 0
    if (!view.readiness.ready) {
      const blockers = view.readiness.blockers.map(b => b.message)
      update({ step: 'needs_review', crops, blockers, message: `Needs a manual look: ${blockers.length} open item${blockers.length === 1 ? '' : 's'}` })
      return
    }
    if (!options.export) {
      update({ step: 'ready', crops, blockers: [], message: `Review finished — ${crops} crop${crops === 1 ? '' : 's'}, ready to export` })
      return
    }

    // 5. Export.
    update({ step: 'exporting', crops, message: 'Exporting crops' })
    const report = await exportPage({
      folderPath: ctx.folderPath,
      imageFilename: ctx.imageFilename,
      seriesSlug: ctx.seriesSlug,
      chapterNumber: ctx.chapterNumber
    })
    update({ step: 'done', crops: report.crop_count, blockers: [], message: `Exported ${report.crop_count} crop${report.crop_count === 1 ? '' : 's'}` })
  } catch (error) {
    if (error instanceof CancelledError || signal.aborted) {
      update({ step: 'cancelled', message: 'Stopped' })
    } else {
      console.error(`[clipper3/openai] ${ctx.imageFilename} failed:`, error)
      update({ step: 'failed', message: error instanceof Error ? error.message : 'Failed' })
    }
  } finally {
    update({ finishedAt: new Date().toISOString() })
    if (messages.length > 0) await writeTranscript(ctx, config, messages, current())
  }
}

// ============ Chapter jobs ============

export interface AutoJob {
  chapterId: string
  running: boolean
  cancelled: boolean
  model: string
  reasoningEffort: ReasoningEffort
  export: boolean
  startedAt: string
  finishedAt: string | null
  pages: AutoPageStatus[]
}

const jobs = new Map<string, AutoJob & { controller: AbortController }>()

function snapshot(job: AutoJob & { controller: AbortController }): AutoJob {
  const { controller: _controller, ...rest } = job
  return { ...rest, pages: rest.pages.map(p => ({ ...p, blockers: [...p.blockers] })) }
}

export function getAutoJob(chapterId: string): AutoJob | null {
  const job = jobs.get(chapterId)
  return job ? snapshot(job) : null
}

/** Whether a page is being worked on by a running API job (manual edits should wait). */
export function isPageInAutoRun(chapterId: string, filename: string): boolean {
  const job = jobs.get(chapterId)
  if (!job?.running) return false
  const page = job.pages.find(p => p.filename === path.basename(filename))
  return !!page && !['queued', 'done', 'ready', 'needs_review', 'failed', 'cancelled'].includes(page.step)
}

export function cancelAutoJob(chapterId: string): boolean {
  const job = jobs.get(chapterId)
  if (!job?.running) return false
  job.cancelled = true
  job.controller.abort()
  return true
}

export class AutoJobError extends Error {
  constructor(public readonly status: 400 | 409, message: string) {
    super(message)
    this.name = 'AutoJobError'
  }
}

/**
 * Starts a background run over `filenames` (in that order) and returns
 * immediately; progress is read back with getAutoJob.
 */
export async function startAutoJob(
  chapterId: string,
  base: Omit<AutoPageContext, 'imageFilename'>,
  filenames: string[],
  options: { export: boolean }
): Promise<AutoJob> {
  if (jobs.get(chapterId)?.running) throw new AutoJobError(409, 'An API run is already going for this chapter')
  const config = getOpenAiCropConfig()
  if (!config.apiKey) throw new AutoJobError(400, 'Add your OpenAI API key in Settings → Crop 3.0 first')
  if (filenames.length === 0) throw new AutoJobError(400, 'No pages to run')

  const rules = config.includeRules ? await readPointerGuidelines() : ''
  const job: AutoJob & { controller: AbortController } = {
    chapterId,
    running: true,
    cancelled: false,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    export: options.export,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    controller: new AbortController(),
    pages: filenames.map(filename => ({
      filename,
      step: 'queued',
      message: 'Waiting',
      round: 0,
      crops: null,
      blockers: [],
      tokens: 0,
      startedAt: null,
      finishedAt: null
    }))
  }
  jobs.set(chapterId, job)

  let next = 0
  const worker = async () => {
    while (next < job.pages.length) {
      const page = job.pages[next++]
      if (job.controller.signal.aborted) {
        Object.assign(page, { step: 'cancelled', message: 'Not started' })
        continue
      }
      await runPageViaApi(
        { ...base, imageFilename: page.filename },
        options,
        config,
        rules,
        patch => Object.assign(page, patch),
        () => ({ ...page }),
        job.controller.signal
      )
    }
  }

  void Promise.all(Array.from({ length: Math.min(config.concurrency, job.pages.length) }, worker))
    .catch(error => console.error('[clipper3/openai] run failed:', error))
    .finally(() => {
      job.running = false
      job.finishedAt = new Date().toISOString()
    })

  return snapshot(job)
}
