/**
 * Image Clipper 2.0 — the Node ↔ Gemini bridge.
 *
 * Windows a chapter's pages into vision-model calls and asks Gemini to place FOUR
 * CROP POINTERS (P1..P4) per section, reading the Crop Detection Guidelines
 * (server/ml/CROP_POINT_GUIDELINES.md) as the prompt. This file knows nothing about
 * the `four-point-crop` artifact shape or canvas coordinates — it hands back
 * page-local points exactly as the model reported them. pointerDetector.ts owns
 * lifting those onto the combined canvas, de-duplicating and composing the file.
 *
 * The model is shown discrete page images, never a stitched canvas, so it reports
 * P1/P2 against `startPage` and P3/P4 against `endPage` — each point a fraction of
 * THAT page's own width/height. pointerDetector.ts's lift resolves x against each
 * point's own page, not the widest page in the chapter, which is what keeps a
 * mixed-width chapter from having every crop widened to the widest page.
 */

import path from 'path'
import sharp from 'sharp'
import { GoogleGenAI } from '@google/genai'
import type { ImageManifest } from '../clipperService.js'
import type { CropPoint, DetectedPointerCrop, PointId } from './fourPointTypes.js'
import { POINT_IDS } from './fourPointTypes.js'

// ============ Config ============

// Pages per call. Kept small: a wide window risks truncating the JSON at
// maxOutputTokens before every section is emitted (the salvage parser below
// covers the rest, but tighter windows keep responses complete and faster).
const MAX_PAGES_PER_CALL = 6
const WINDOW_OVERLAP = 1 // pages shared between adjacent windows, so a section
                          // straddling a window boundary is still seen whole
const PAGE_IMAGE_WIDTH = 1536 // sent at 2x v1's thumbnail — this module needs
                               // sharper edges than a rectangle-only cropper did
// Gemini 2.5's "thinking" is billed against the SAME budget as the answer
// (see fourPointTypes.ts's DetectedPointerCrop doc), so both must have headroom
// for a long chapter's worth of crops, not just the reply text.
const MAX_OUTPUT_TOKENS = 32_768
const THINKING_BUDGET = 8_192
const GEMINI_CALL_TIMEOUT_MS = 120_000
const MAX_RATE_LIMIT_RETRIES = 2
const CANCELLED = 'cancelled'

type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } }

// ============ Availability ============

export function isGeminiPointerDetectorEnabled(): boolean {
  return !!process.env.GEMINI_API_KEY
}

/** CLIPPER2_MODEL is independent of v1's AI_CROP_MODEL so the two engines can be tuned separately. */
export function getGeminiPointerModel(): string {
  return process.env.CLIPPER2_MODEL || 'gemini-3.5-flash'
}

export interface GeminiDetectorStatus {
  available: boolean
  error?: string
}

/** Presence-only check — there is no local process to probe, unlike the offline sidecar this replaced. */
export async function checkGeminiPointerDetector(): Promise<GeminiDetectorStatus> {
  if (!process.env.GEMINI_API_KEY) {
    return { available: false, error: 'GEMINI_API_KEY is not configured' }
  }
  return { available: true }
}

// ============ Small helpers ============

function clamp01(n: unknown): number {
  return Math.max(0, Math.min(1, Number(n)))
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isCancellation(err: unknown): boolean {
  return err instanceof Error && err.message === CANCELLED
}

async function pageImage(filePath: string): Promise<string> {
  const buf = await sharp(filePath)
    .resize({ width: PAGE_IMAGE_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer()
  return buf.toString('base64')
}

// ============ Prompt ============

const COORD_PROTOCOL = `
You will receive the pages of one manhwa chapter, in reading order, each labeled
"Page N" with its pixel width and height. Apply the guidelines above and return
every qualifying section as STRICT JSON, no prose, no markdown fences:

{"crops":[
  {"reason":"snake_case_description","startPage":N,"endPage":N,
   "points":[{"id":"P1","x":0.0,"y":0.0},{"id":"P2","x":1.0,"y":0.0},
             {"id":"P3","x":1.0,"y":1.0},{"id":"P4","x":0.0,"y":1.0}],
   "confidence":0.0,"notes":""}
]}

Point rules:
- Exactly four points per crop, in this fixed order: P1 top-left, P2 top-right,
  P3 bottom-right, P4 bottom-left.
- P1 and P2 are fractions (0..1) of startPage: x across its width, y down its height.
- P3 and P4 are fractions (0..1) of endPage: x across its width, y down its height.
- A crop usually lies within ONE page (startPage == endPage). For a section that
  spans a page break, set endPage to the later page so the crop covers it as ONE
  beat — a page boundary is never itself a crop boundary.
- P1.x should equal P4.x and P2.x should equal P3.x (a rectangle) unless the two
  pages genuinely differ in width, in which case report each point against its own
  page and the system will resolve the outer rectangle.
- confidence is 0..1: how sure you are this is a correct, guideline-compliant crop.
- notes is optional: one short phrase for anything you inferred behind an overlay
  or are otherwise unsure about. Omit or leave "" when there is nothing to flag.
- Output crops in story order, top to bottom. Skip intro/outro, text-only and
  purely abstract sections per the guidelines. One story beat per crop; no
  bleed-in; no region-overlap duplicates.
`.trim()

function buildGuidelinesPrompt(guidelines: string): string {
  const doc = guidelines.trim()
    ? `# Crop Detection Guidelines\n\n${guidelines}`
    : '# Crop Detection Guidelines\n\n(No guidelines document is configured — use general manhwa panel-cropping judgement: one story beat per crop, skip covers/credits/pure-text pages.)'
  return `${doc}\n\n${COORD_PROTOCOL}`
}

// ============ Response parsing (tolerant of truncation) ============

interface RawCrop {
  reason?: unknown
  startPage?: unknown
  endPage?: unknown
  points?: unknown
  confidence?: unknown
  notes?: unknown
}

/**
 * The model returns {"crops":[ {…}, {…}, … ]}; a long window can exceed
 * maxOutputTokens and cut the JSON off mid-array. Rather than fail the whole
 * window, salvage every COMPLETE crop object and drop any truncated trailing one.
 */
function parseRawCrops(text: string): RawCrop[] {
  const fenced = text.replace(/```json|```/g, '')

  const whole = fenced.match(/\{[\s\S]*\}/)
  if (whole) {
    try {
      const obj = JSON.parse(whole[0])
      if (Array.isArray(obj.crops)) return obj.crops
    } catch {
      /* fall through to salvage */
    }
  }

  // Salvage: a crop object nests one array of point objects, so match one level
  // of nesting rather than only flat objects.
  const crops: RawCrop[] = []
  for (const m of fenced.matchAll(/\{(?:[^{}]|\{[^{}]*\})*\}/g)) {
    try {
      const o = JSON.parse(m[0])
      if (typeof o.startPage === 'number' && typeof o.endPage === 'number' && Array.isArray(o.points)) {
        crops.push(o)
      }
    } catch {
      /* skip malformed / truncated object */
    }
  }
  return crops
}

function toPoints(raw: unknown): CropPoint[] | null {
  if (!Array.isArray(raw)) return null
  const byId = new Map<string, { x: number; y: number }>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const id = (item as Record<string, unknown>).id
    if (typeof id !== 'string' || !POINT_IDS.includes(id as PointId)) continue
    byId.set(id, { x: clamp01((item as Record<string, unknown>).x), y: clamp01((item as Record<string, unknown>).y) })
  }
  if (byId.size !== POINT_IDS.length) return null
  return POINT_IDS.map(id => ({ id, ...byId.get(id)! }))
}

function toDetectedCrop(raw: RawCrop, pageCount: number): DetectedPointerCrop | null {
  const points = toPoints(raw.points)
  if (!points) return null
  const startPage = Math.max(1, Math.min(pageCount, Math.round(Number(raw.startPage))))
  const endPage = Math.max(1, Math.min(pageCount, Math.round(Number(raw.endPage))))
  if (!Number.isFinite(startPage) || !Number.isFinite(endPage)) return null
  return {
    reason: typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim() : 'unlabeled_section',
    startPage,
    endPage,
    points,
    confidence: typeof raw.confidence === 'number' ? clamp01(raw.confidence) : undefined,
    notes: typeof raw.notes === 'string' && raw.notes.trim() ? raw.notes.trim() : undefined
  }
}

// ============ Gemini call (rate-limit retry, same shape as v1's guideline cropper) ============

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Pull the server-suggested retry delay (seconds) out of a 429 ApiError. */
function retryDelayMs(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err)
  if (!/429|RESOURCE_EXHAUSTED/.test(msg)) return null
  const m = msg.match(/"retryDelay"\s*:\s*"(\d+)s"/) || msg.match(/retry in ([\d.]+)s/)
  const secs = m ? parseFloat(m[1]) : 5
  return Math.min(30_000, Math.max(1_000, secs * 1000 + 500)) // cap at 30s
}

async function callGeminiOnce(parts: GeminiPart[], signal?: AbortSignal): Promise<string> {
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! })
  const model = getGeminiPointerModel()
  const ac = new AbortController()
  const onAbort = () => ac.abort()
  signal?.addEventListener('abort', onAbort)
  const timer = setTimeout(() => ac.abort(), GEMINI_CALL_TIMEOUT_MS)
  try {
    const result = await client.models.generateContent({
      model,
      contents: [{ role: 'user', parts }],
      config: {
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        thinkingConfig: { thinkingBudget: THINKING_BUDGET },
        abortSignal: ac.signal
      }
    })
    return result.text || ''
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

async function callGemini(parts: GeminiPart[], signal?: AbortSignal): Promise<string> {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not configured — Image Clipper 2.0 pointer detection is unavailable')
  }
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new Error(CANCELLED)
    try {
      return await callGeminiOnce(parts, signal)
    } catch (err) {
      if (signal?.aborted) throw new Error(CANCELLED)
      const delay = retryDelayMs(err)
      if (delay == null || attempt >= MAX_RATE_LIMIT_RETRIES) throw err
      console.warn(`[clipper2] rate limited; retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES})`)
      await sleep(delay)
    }
  }
}

// ============ Detection ============

export interface GeminiDetectionResult {
  /** Page-local crops exactly as reported — pointerDetector.ts lifts these to canvas pixels. */
  crops: DetectedPointerCrop[]
  /** Per-window failures that did not stop the whole run. */
  warnings: string[]
}

export interface GeminiDetectionOptions {
  onProgress?: (p: { phase: string; percent: number; message?: string }) => void
  signal?: AbortSignal
}

/**
 * Run pointer detection over one chapter's pages. Never throws for a partial
 * failure — a window that errors contributes a warning and is skipped, unless
 * every window fails, in which case the first error propagates.
 */
export async function runGeminiPointerDetection(
  imageDir: string,
  manifest: ImageManifest,
  guidelines: string,
  opts: GeminiDetectionOptions = {}
): Promise<GeminiDetectionResult> {
  if (!isGeminiPointerDetectorEnabled()) {
    throw new Error('GEMINI_API_KEY not configured — Image Clipper 2.0 pointer detection is unavailable')
  }

  const pages = manifest.images
  const crops: DetectedPointerCrop[] = []
  const warnings: string[] = []
  if (pages.length === 0) return { crops, warnings }

  const guidelinesPrompt = buildGuidelinesPrompt(guidelines)
  const step = Math.max(1, MAX_PAGES_PER_CALL - WINDOW_OVERLAP)
  const totalWindows = Math.ceil(pages.length / step)
  let windowIndex = 0

  for (let start = 0; start < pages.length; start += step, windowIndex++) {
    if (opts.signal?.aborted) throw new Error(CANCELLED)

    const window = pages.slice(start, start + MAX_PAGES_PER_CALL)
    if (window.length === 0) break

    opts.onProgress?.({
      phase: 'detect',
      percent: Math.round((windowIndex / totalWindows) * 100),
      message: `pages ${start + 1}-${start + window.length} of ${pages.length}`
    })

    const parts: GeminiPart[] = [{ text: guidelinesPrompt }]
    for (let i = 0; i < window.length; i++) {
      const page = window[i]
      const globalIdx = start + i + 1 // 1-based, global page number — matches startPage/endPage
      parts.push({ text: `Page ${globalIdx} (width ${Math.round(page.width)}px, height ${Math.round(page.height)}px):` })
      parts.push({
        inlineData: {
          mimeType: 'image/jpeg',
          data: await pageImage(path.join(imageDir, page.filename))
        }
      })
    }
    parts.push({ text: 'Return ONLY the JSON object described above for these pages.' })

    let raw: RawCrop[] = []
    try {
      raw = parseRawCrops(await callGemini(parts, opts.signal))
    } catch (err) {
      if (isCancellation(err)) throw err
      const message = `pages ${start + 1}-${start + window.length}: ${errorText(err)}`
      console.error(`[clipper2] gemini detection window failed (${message})`)
      warnings.push(message)
      // Only a total failure (nothing at all, first window) is fatal — a later
      // window's failure just means that stretch of the chapter got no crops.
      if (crops.length === 0 && start === 0 && start + MAX_PAGES_PER_CALL >= pages.length) throw err
      continue
    }

    for (const r of raw) {
      const crop = toDetectedCrop(r, pages.length)
      if (crop) crops.push(crop)
    }
  }

  opts.onProgress?.({ phase: 'detect', percent: 100, message: `${crops.length} crop(s) found` })
  return { crops, warnings }
}
