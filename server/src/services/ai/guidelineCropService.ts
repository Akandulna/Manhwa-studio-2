/**
 * Guideline Crop Service — Module 3 AI: the "default model".
 *
 * Unlike the trained sklearn/ONNX model (which consumes numeric features), this
 * engine *reads the user's written cropping guidelines* and applies them with a
 * vision LLM (Gemini, same client as videoAiAssist). It needs no training data,
 * so it is the default, active crop engine out of the box.
 *
 * Immutability contract for the guidelines file:
 *  - server/ml/CROP_GUIDELINES.md is stored read-only (0444).
 *  - Every inference path here ONLY calls readGuidelines() — nothing automated
 *    ever writes the file.
 *  - The single writer is writeGuidelines(), invoked exclusively by the
 *    user-triggered Settings route (PUT /api/ai-crop/guidelines). It briefly
 *    unlocks the file (0644), writes, and re-locks it (0444).
 */

import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import sharp from 'sharp'
import { GoogleGenAI } from '@google/genai'
import type { ImageManifest } from '../clipperService.js'
import type { SuggestionRect } from './aiCropTypes.js'

// ============ Paths ============

/** process.cwd() is the server/ dir at runtime (mirrors cropDatasetService). */
function getMlDir(): string {
  return path.join(process.cwd(), 'ml')
}

export function getGuidelinesPath(): string {
  return path.join(getMlDir(), 'CROP_GUIDELINES.md')
}

function getGuidelinesMetaPath(): string {
  return path.join(getMlDir(), 'guidelines.meta.json')
}

const READ_ONLY_MODE = 0o444
const WRITABLE_MODE = 0o644

// ============ Guidelines file I/O ============

export interface GuidelinesMeta {
  updatedAt: string | null
  sha256: string | null
  present: boolean
  readOnly: boolean
}

/** Best-effort: lock the file to 0444 if it exists and is currently writable. */
async function lockFile(): Promise<void> {
  try {
    await fs.chmod(getGuidelinesPath(), READ_ONLY_MODE)
  } catch {
    /* file missing or chmod unsupported — non-fatal */
  }
}

/**
 * Ensure the canonical file is locked read-only. The file ships in the repo, so
 * we don't synthesize content here; we only enforce its permissions. If it is
 * genuinely missing, callers (readGuidelines / the cropper) surface a clear
 * error and the user can recreate it via Settings.
 */
export async function ensureLocked(): Promise<void> {
  await lockFile()
}

/** Read the guidelines text. Returns '' if the file is missing. */
export async function readGuidelines(): Promise<string> {
  try {
    return await fs.readFile(getGuidelinesPath(), 'utf-8')
  } catch {
    return ''
  }
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex')
}

/** Current file metadata for status / the Settings editor. */
export async function getGuidelinesMeta(): Promise<GuidelinesMeta> {
  const content = await readGuidelines()
  const present = content.length > 0
  let updatedAt: string | null = null
  try {
    const raw = await fs.readFile(getGuidelinesMetaPath(), 'utf-8')
    updatedAt = JSON.parse(raw).updatedAt ?? null
  } catch {
    // Fall back to the file's mtime when no meta sidecar exists yet.
    try {
      const stat = await fs.stat(getGuidelinesPath())
      updatedAt = stat.mtime.toISOString()
    } catch { /* missing */ }
  }
  let readOnly = false
  try {
    const stat = await fs.stat(getGuidelinesPath())
    // No owner-write bit set → read-only.
    readOnly = (stat.mode & 0o200) === 0
  } catch { /* missing */ }
  return { updatedAt, sha256: present ? sha256(content) : null, present, readOnly }
}

/**
 * The ONLY writer. Intentionally unlocks (0644), writes, and re-locks (0444).
 * Must be reached only from the user-initiated Settings route.
 */
export async function writeGuidelines(content: string, updatedAtIso: string): Promise<GuidelinesMeta> {
  const filePath = getGuidelinesPath()
  await fs.mkdir(getMlDir(), { recursive: true })
  // Unlock if it already exists (chmod fails harmlessly if it doesn't).
  try { await fs.chmod(filePath, WRITABLE_MODE) } catch { /* may not exist yet */ }
  await fs.writeFile(filePath, content, 'utf-8')
  await fs.writeFile(
    getGuidelinesMetaPath(),
    JSON.stringify({ updatedAt: updatedAtIso, sha256: sha256(content) }, null, 2)
  )
  await lockFile()
  return { updatedAt: updatedAtIso, sha256: sha256(content), present: content.length > 0, readOnly: true }
}

// ============ Gemini availability ============

export function isGeminiAvailable(): boolean {
  return !!process.env.GEMINI_API_KEY
}

// ============ Gemini guideline cropper ============

// Page-relative coordinate protocol: the model sees discrete page images, so it
// is far more reliable to reference (page index, fraction down that page) than a
// single stitched mega-canvas it never actually sees.
interface GeminiCrop {
  startPage: number   // 1-based page index (as labeled in the prompt)
  startYNorm: number  // 0..1 fraction down startPage where the crop top sits
  endPage: number     // 1-based page index
  endYNorm: number    // 0..1 fraction down endPage where the crop bottom sits
  xLeftNorm?: number  // 0..1 across canvas width (default 0)
  xRightNorm?: number // 0..1 across canvas width (default 1)
  aspectPreset?: string
  confidence?: number
}

// Pages per Gemini call. Kept small: the model emits several crops per page, so
// a wide window risks truncating the JSON at maxOutputTokens (the salvage parser
// covers the rest, but tighter windows keep responses complete and faster).
const MAX_PAGES_PER_CALL = 6
const WINDOW_OVERLAP = 1            // pages shared between adjacent windows
const PAGE_THUMB_WIDTH = 768        // downscale pages sent to Gemini
const MAX_OUTPUT_TOKENS = 8192      // headroom for ~6 pages of crops
const DEDUP_IOU = 0.6              // vertical-overlap threshold for boundary dups
const GEMINI_CALL_TIMEOUT_MS = 120_000 // fail loudly instead of hanging forever

async function pageThumb(filePath: string): Promise<string> {
  const buf = await sharp(filePath)
    .resize({ width: PAGE_THUMB_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: 72 })
    .toBuffer()
  return buf.toString('base64')
}

/**
 * Parse the crop list, tolerant of truncation. The model returns
 * {"crops":[ {…}, {…}, … ]}; a long chapter can exceed maxOutputTokens and cut
 * the JSON off mid-array. Rather than fail the whole window, we salvage every
 * COMPLETE flat crop object (they contain no nested braces) and drop any
 * incomplete trailing one.
 */
function parseCrops(text: string): GeminiCrop[] {
  const fenced = text.replace(/```json|```/g, '')

  // Fast path: a well-formed full object.
  const whole = fenced.match(/\{[\s\S]*\}/)
  if (whole) {
    try {
      const obj = JSON.parse(whole[0])
      if (Array.isArray(obj.crops)) return obj.crops
    } catch {
      /* fall through to salvage */
    }
  }

  // Salvage: extract each complete flat object that looks like a crop.
  const crops: GeminiCrop[] = []
  for (const m of fenced.matchAll(/\{[^{}]*\}/g)) {
    try {
      const o = JSON.parse(m[0])
      if (typeof o.startPage === 'number' && typeof o.endPage === 'number') crops.push(o)
    } catch {
      /* skip malformed / truncated object */
    }
  }
  return crops
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number(n)))
}

/** Vertical IoU between two canvas rects (crops are effectively full-width bands). */
function verticalIoU(a: SuggestionRect, b: SuggestionRect): number {
  const aTop = a.canvasY, aBot = a.canvasY + a.canvasH
  const bTop = b.canvasY, bBot = b.canvasY + b.canvasH
  const inter = Math.max(0, Math.min(aBot, bBot) - Math.max(aTop, bTop))
  const union = (aBot - aTop) + (bBot - bTop) - inter
  return union <= 0 ? 0 : inter / union
}

const MAX_RATE_LIMIT_RETRIES = 2

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Pull the server-suggested retry delay (seconds) out of a 429 ApiError. */
function retryDelayMs(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err)
  if (!/429|RESOURCE_EXHAUSTED/.test(msg)) return null
  const m = msg.match(/"retryDelay"\s*:\s*"(\d+)s"/) || msg.match(/retry in ([\d.]+)s/)
  const secs = m ? parseFloat(m[1]) : 5
  return Math.min(30_000, Math.max(1_000, secs * 1000 + 500)) // cap at 30s
}

async function callGeminiOnce(
  parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }>
): Promise<string> {
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! })
  // AI_CROP_MODEL lets the auto-crop engine use a model independent of the
  // narration model (AI_MODEL) — useful to dodge a per-model daily quota.
  const model = process.env.AI_CROP_MODEL || process.env.AI_MODEL || 'gemini-3.5-flash'
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), GEMINI_CALL_TIMEOUT_MS)
  try {
    const result = await client.models.generateContent({
      model,
      contents: [{ role: 'user', parts }],
      config: { maxOutputTokens: MAX_OUTPUT_TOKENS, abortSignal: ac.signal }
    })
    return result.text || ''
  } finally {
    clearTimeout(timer)
  }
}

async function callGemini(
  parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }>
): Promise<string> {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not configured — the Guidelines (Gemini) model is unavailable')
  }
  for (let attempt = 0; ; attempt++) {
    try {
      return await callGeminiOnce(parts)
    } catch (err) {
      const delay = retryDelayMs(err)
      // Retry only transient rate limits, and only a bounded number of times.
      if (delay == null || attempt >= MAX_RATE_LIMIT_RETRIES) throw err
      console.warn(`[ai-crop] rate limited; retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES})`)
      await sleep(delay)
    }
  }
}

const COORD_PROTOCOL = `
You will receive the pages of one manhwa chapter, in reading order, each labeled
"Page N" with its pixel height. Apply the cropping guidelines above and return the
ordered list of crops as STRICT JSON, no prose:

{"crops":[
  {"startPage":N,"startYNorm":0.0,"endPage":N,"endYNorm":0.0,
   "xLeftNorm":0.0,"xRightNorm":1.0,"aspectPreset":"free","confidence":0.0}
]}

Coordinate rules:
- startYNorm / endYNorm are fractions (0..1) DOWN the named page (0 = top of that page, 1 = bottom).
- A crop usually lies within ONE page (startPage == endPage). For a tall illustration
  split across files, set endPage to the later page so the crop spans them as a SINGLE beat.
- xLeftNorm/xRightNorm are fractions across the page width; default to 0 and 1 (full width)
  unless the guidelines call for a narrower horizontal crop.
- aspectPreset is one of "free","9:16","16:9","1:1","4:5","3:4" — pick what suits the content.
- confidence is 0..1: how sure you are this is a correct, guideline-compliant crop.
- Output crops in story order, top-to-bottom. SKIP intro/outro, text-only, and pure-abstract
  sections per the guidelines. One story beat per crop; no bleed-in; no region-overlap duplicates.
`.trim()

/**
 * Run the guideline cropper over a chapter. Pages are processed in overlapping
 * windows (Gemini call size is bounded); per-window crops are mapped to global
 * canvas coordinates and de-duplicated across window seams.
 */
export async function suggestWithGuidelines(
  imageDir: string,
  manifest: ImageManifest
): Promise<SuggestionRect[]> {
  if (!isGeminiAvailable()) {
    throw new Error('GEMINI_API_KEY not configured — the Guidelines (Gemini) model is unavailable')
  }
  const guidelines = await readGuidelines()
  if (!guidelines.trim()) {
    throw new Error('Crop guidelines are missing — restore server/ml/CROP_GUIDELINES.md or set them in Settings')
  }

  const pages = manifest.images
  if (pages.length === 0) return []

  const out: SuggestionRect[] = []
  const step = Math.max(1, MAX_PAGES_PER_CALL - WINDOW_OVERLAP)
  console.log(`[ai-crop] guideline cropper: ${pages.length} pages, ${Math.ceil(pages.length / step)} window(s)`)

  for (let start = 0; start < pages.length; start += step) {
    const window = pages.slice(start, start + MAX_PAGES_PER_CALL)
    if (window.length === 0) break
    console.log(`[ai-crop] window pages ${start + 1}-${start + window.length} → calling Gemini…`)

    const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = []
    parts.push({ text: `# Image Cropping Guidelines\n\n${guidelines}\n\n${COORD_PROTOCOL}` })

    for (let i = 0; i < window.length; i++) {
      const page = window[i]
      const globalIdx = start + i + 1 // 1-based, global page number
      parts.push({ text: `Page ${globalIdx} (height ${Math.round(page.height)}px):` })
      parts.push({
        inlineData: {
          mimeType: 'image/jpeg',
          data: await pageThumb(path.join(imageDir, page.filename))
        }
      })
    }
    parts.push({ text: 'Return ONLY the JSON object described above for these pages.' })

    let crops: GeminiCrop[] = []
    try {
      crops = parseCrops(await callGemini(parts))
      console.log(`[ai-crop] window pages ${start + 1}-${start + window.length}: ${crops.length} crops`)
    } catch (err) {
      console.error('[ai-crop] guideline cropper window failed:', err)
      // Surface a hard failure only if we have produced nothing at all.
      if (out.length === 0 && start === 0) throw err
      continue
    }

    for (const c of crops) {
      const sp = pages[Math.max(0, Math.min(pages.length - 1, Math.round(c.startPage) - 1))]
      const ep = pages[Math.max(0, Math.min(pages.length - 1, Math.round(c.endPage) - 1))]
      if (!sp || !ep) continue

      // Canvas extents, not source pixels: a slice narrower than the chapter's
      // reference width is scaled up onto the canvas, so its own height is not the
      // height it occupies (see clipperService.ManifestImage).
      const top = sp.canvasY + clamp01(c.startYNorm) * sp.canvasHeight
      const bottom = ep.canvasY + clamp01(c.endYNorm) * ep.canvasHeight
      const canvasY = Math.min(top, bottom)
      const canvasH = Math.abs(bottom - top)
      if (canvasH < 4) continue // discard degenerate slivers

      const xL = clamp01(c.xLeftNorm ?? 0) * manifest.canvasWidth
      const xR = clamp01(c.xRightNorm ?? 1) * manifest.canvasWidth
      const canvasX = Math.min(xL, xR)
      const canvasW = Math.max(1, Math.abs(xR - xL))

      out.push({
        canvasX,
        canvasY,
        canvasW,
        canvasH,
        aspectPreset: typeof c.aspectPreset === 'string' ? c.aspectPreset : 'free',
        confidence: typeof c.confidence === 'number' ? clamp01(c.confidence) : 0.5
      })
    }
  }

  // Sort story-order and drop near-duplicate bands created at window seams.
  out.sort((a, b) => a.canvasY - b.canvasY)
  const deduped: SuggestionRect[] = []
  for (const c of out) {
    const dup = deduped.find(d => verticalIoU(d, c) >= DEDUP_IOU)
    if (dup) {
      if (c.confidence > dup.confidence) Object.assign(dup, c) // keep the better-framed one
      continue
    }
    deduped.push(c)
  }
  return deduped
}
