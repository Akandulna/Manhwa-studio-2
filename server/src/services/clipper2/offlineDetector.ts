/**
 * Image Clipper 2.0 — Stage 1, offline.
 *
 * A third way to get pointers, alongside the manual loop and Gemini: a classical
 * computer-vision pass that runs entirely on this machine. No API key, no quota,
 * no upload, and it measures the source pixels rather than a 1536px thumbnail —
 * so it is not subject to the precision limit in IMAGE_CLIPPER_2.md §8.1.
 *
 * It is not a replacement for the model paths. It reads geometry, not meaning:
 * it finds where the artwork is, but "is this section worth keeping?" (SR-05) is
 * a judgement it can only flag for review. Where Gemini names a section
 * `framed_hand_scene`, this names it `inset_wide_scene`.
 *
 * WHERE THE WORK HAPPENS
 * ----------------------
 * The pixels are Python's (`server/ml/crop_detect.py`, via the same spawn/JSON
 * envelope bridge as v1's sidecar). The *contract* is this file's: the sidecar
 * returns canvas rects and everything after that — P1..P4, normalization,
 * validation, the canonical bytes — goes through `fourPointSchema`, exactly as
 * `pointerDetector` does for Gemini. Two implementations of the emission format
 * is how they drift apart, so there is only ever one.
 */

import { spawn } from 'child_process'
import crypto from 'crypto'
import path from 'path'
import type {
  CanvasRect,
  CropEntry,
  CropImageInfo,
  CropPointsSegment,
  CropPointsSidecar,
  DetectionResult,
  FourPointCropFile,
  ValidationIssue
} from './fourPointTypes.js'
import {
  boundsOf,
  dedupeEntriesByRegion,
  emptyCropFile,
  entryFromCanvasRect,
  normalizeCropFile,
  validateCropFile
} from './fourPointSchema.js'
import { readPointerGuidelines } from './pointerGuidelines.js'
import { logicalPageName } from './pointerDetector.js'
import type { ImageManifest } from '../clipperService.js'

// ============ Constants ============

const SCRIPT = 'crop_detect.py'

/** Identifies the engine in the sidecar and the UI, in place of a model id. */
export const OFFLINE_MODEL = 'offline-cv (crop_detect v1)'

/** Below this the crop is a sliver, not a section (matches pointerDetector). */
const MIN_CROP_PX = 4

/** Exact message the caller contracts on for an aborted run. */
const CANCELLED = 'cancelled'

/** Generous: a full chapter is ~20s, but a cold venv on a slow disk is not. */
const TIMEOUT_MS = 10 * 60 * 1000

// ============ Tunables exposed to the UI ============

/**
 * The knobs the detect request may set. Everything else in the Python `Config`
 * is an implementation detail — allowing arbitrary keys through would make the
 * script's internals part of the HTTP contract.
 */
export interface OfflineDetectConfig {
  /** 'auto' samples each page's margins; 'dark'/'light' force the polarity. */
  gutterMode?: 'auto' | 'dark' | 'light'
  /** Minimum area, in canvas px, for a region to be a section (SR-01). */
  minPanelArea?: number
  /** NC-05 breathing room added to every edge, in canvas px. */
  breakoutMargin?: number
  /** Exclude speech bubbles, narration boxes and watermarks (OV-01..OV-09). */
  filterOverlays?: boolean
}

/** Maps the HTTP-facing names onto the script's snake_case `Config` fields. */
function toScriptConfig(cfg: OfflineDetectConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (cfg.gutterMode) out.gutter_mode = cfg.gutterMode
  if (typeof cfg.minPanelArea === 'number') out.min_panel_area = cfg.minPanelArea
  if (typeof cfg.breakoutMargin === 'number') out.breakout_margin = cfg.breakoutMargin
  if (typeof cfg.filterOverlays === 'boolean') out.filter_overlays = cfg.filterOverlays
  return out
}

// ============ Sidecar plumbing ============

function getPythonPath(): string {
  return process.env.PYTHON_PATH || path.join(process.cwd(), 'ml', 'venv', 'bin', 'python3')
}

function getScriptPath(): string {
  return path.join(process.cwd(), 'ml', SCRIPT)
}

interface DetectedRect {
  canvasX: number
  canvasY: number
  canvasW: number
  canvasH: number
  reason: string
  verdict: string
  lineDensity: number
  monoFrac: number
}

interface SidecarResult {
  crops: DetectedRect[]
  skipped: DetectedRect[]
  warnings: string[]
  gutterMode: string
  detectWidth: number
  detectHeight: number
}

/** Is the offline detector runnable on this machine? */
export async function checkOfflineDetector(): Promise<{ available: boolean; error?: string }> {
  return new Promise(resolve => {
    let proc
    try {
      proc = spawn(getPythonPath(), [getScriptPath(), '--check'])
    } catch {
      return resolve({ available: false, error: 'Python not found. Run `npm run ml:setup`.' })
    }
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', d => { stdout += d.toString() })
    proc.stderr.on('data', d => { stderr += d.toString() })
    proc.on('close', code => {
      if (code === 0 && stdout.includes('ok')) resolve({ available: true })
      else resolve({
        available: false,
        error: stderr.trim() || 'Offline crop detection is unavailable. Run `npm run ml:setup`.'
      })
    })
    proc.on('error', () => resolve({
      available: false,
      error: 'Python not found. Install Python 3.10+ and run `npm run ml:setup`.'
    }))
    setTimeout(() => {
      proc.kill()
      resolve({ available: false, error: 'Offline detector check timed out' })
    }, 15000)
  })
}

/**
 * Spawn the detector and stream its progress. Resolves with the `result`
 * envelope; rejects on an `error` envelope, a non-zero exit, or cancellation.
 */
function runSidecar(
  request: unknown,
  opts: {
    onProgress?: (p: { phase: string; percent: number; message?: string }) => void
    signal?: AbortSignal
  }
): Promise<SidecarResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new Error(CANCELLED))

    const proc = spawn(getPythonPath(), [getScriptPath()])
    let stdout = ''
    let stderr = ''
    let result: SidecarResult | null = null
    let failure: string | null = null
    let aborted = false

    const onAbort = () => {
      aborted = true
      proc.kill('SIGTERM')
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    const timeout = setTimeout(() => {
      proc.kill('SIGTERM')
      failure = 'Offline crop detection timed out'
    }, TIMEOUT_MS)

    const done = () => {
      clearTimeout(timeout)
      opts.signal?.removeEventListener('abort', onAbort)
    }

    proc.stdin.write(JSON.stringify(request))
    proc.stdin.end()

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      let nl: number
      while ((nl = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, nl).trim()
        stdout = stdout.slice(nl + 1)
        if (!line) continue
        let env: Record<string, unknown>
        try {
          env = JSON.parse(line)
        } catch {
          continue // ignore non-JSON noise
        }
        if (env.event === 'progress') {
          opts.onProgress?.({
            phase: String(env.phase ?? 'detect'),
            percent: Number(env.percent ?? 0),
            message: env.message ? String(env.message) : undefined
          })
        } else if (env.event === 'result') {
          result = env as unknown as SidecarResult
        } else if (env.event === 'error') {
          failure = String(env.message ?? 'Offline crop detection failed')
        }
      }
    })

    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    proc.on('error', err => {
      done()
      reject(new Error(`Failed to start the offline detector: ${err.message}`))
    })

    proc.on('close', code => {
      done()
      if (aborted) return reject(new Error(CANCELLED))
      if (failure) return reject(new Error(failure))
      if (code !== 0) return reject(new Error(stderr.trim() || `Offline detector exited with code ${code}`))
      if (!result) return reject(new Error('Offline detector produced no result'))
      resolve(result)
    })
  })
}

// ============ Small helpers ============

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex')
}

function warning(code: string, rule: string, message: string, cropId?: string): ValidationIssue {
  return { code, rule, message, severity: 'warning', ...(cropId ? { cropId } : {}) }
}

function provisionalCropId(n: number): string {
  return `crop-${String(n).padStart(2, '0')}`
}

function buildFile(folderPath: string, manifest: ImageManifest, crops: CropEntry[]): FourPointCropFile {
  const image: CropImageInfo = {
    filename: logicalPageName(folderPath, manifest),
    width: manifest.canvasWidth,
    height: manifest.canvasHeight
  }
  return { ...emptyCropFile(image), crops }
}

// ============ Detection ============

/**
 * Run offline detection over one chapter and compose the canonical artifact.
 *
 * Mirrors `detectCropPoints`: same return shape, same guarantee that an invalid
 * artifact is never returned, so the route and the apply stage cannot tell which
 * engine produced a point set apart from the sidecar's `model` field.
 */
export async function detectCropPointsOffline(
  imageDir: string,
  folderPath: string,
  manifest: ImageManifest,
  opts: {
    config?: OfflineDetectConfig
    onProgress?: (p: { phase: string; percent: number; message?: string }) => void
    signal?: AbortSignal
  } = {}
): Promise<DetectionResult> {
  const segments: CropPointsSegment[] = manifest.images.map(page => ({
    filename: page.filename,
    width: page.width,
    height: page.height,
    canvasY: page.canvasY
  }))
  const warnings: ValidationIssue[] = []

  // Recorded for provenance parity with the model paths, though nothing here
  // reads the document: this detector measures geometry rather than following
  // written rules, so its output traces to a *code* version, not a rules
  // revision. The sha still says which rules were in force at the time.
  let guidelinesSha: string | null = null
  const guidelines = await readPointerGuidelines()
  if (guidelines.trim()) guidelinesSha = sha256(guidelines)

  const buildSidecar = (): CropPointsSidecar => ({
    source: 'cv',
    model: OFFLINE_MODEL,
    guidelinesSha,
    detectedAt: new Date().toISOString(),
    segments,
    warnings
  })

  if (manifest.images.length === 0) {
    warnings.push(warning('no_pages', '', 'The chapter manifest contains no images, so no crops were detected'))
    return { file: buildFile(folderPath, manifest, []), sidecar: buildSidecar(), confidenceById: {}, warnings }
  }

  console.log(
    `[clipper2] offline detection: ${manifest.images.length} page(s), ` +
    `canvas ${manifest.canvasWidth}x${manifest.canvasHeight}`
  )

  const detection = await runSidecar(
    {
      imageDir,
      manifest: {
        canvasWidth: manifest.canvasWidth,
        canvasHeight: manifest.canvasHeight,
        images: manifest.images.map(p => ({
          filename: p.filename,
          width: p.width,
          height: p.height,
          canvasY: p.canvasY,
          canvasHeight: p.canvasHeight
        }))
      },
      config: toScriptConfig(opts.config ?? {})
    },
    { onProgress: opts.onProgress, signal: opts.signal }
  )

  for (const message of detection.warnings) {
    warnings.push(warning('detector_page_unreadable', 'ST-02', message))
  }

  const entries: CropEntry[] = []
  const reviewIds = new Set<string>()
  let provisional = 0

  for (const crop of detection.crops) {
    const rect: CanvasRect = {
      canvasX: crop.canvasX,
      canvasY: crop.canvasY,
      canvasW: crop.canvasW,
      canvasH: crop.canvasH
    }
    if (!Number.isFinite(rect.canvasW) || !Number.isFinite(rect.canvasH)) continue
    if (rect.canvasW < MIN_CROP_PX || rect.canvasH < MIN_CROP_PX) continue

    // §14 has no status field, so a section the gate could not judge carries its
    // uncertainty in the reason — the same convention the guidelines' own
    // reference detector uses — and the detail goes into the sidecar warnings
    // below, which the workspace already renders.
    const flagged = crop.verdict.startsWith('review')
    const reason = flagged ? `${crop.reason}__review` : crop.reason

    const id = provisionalCropId(++provisional)
    entries.push(entryFromCanvasRect(rect, manifest.canvasWidth, manifest.canvasHeight, id, reason))
    if (flagged) reviewIds.add(id)
  }

  entries.sort((a, b) => {
    const ab = boundsOf(a)
    const bb = boundsOf(b)
    return ab.top - bb.top || ab.left - bb.left
  })

  const { kept: deduped, dropped } = dedupeEntriesByRegion(entries)
  if (dropped.length > 0) {
    console.log(`[clipper2] offline: dropped ${dropped.length} duplicate region(s)`)
  }

  const normalized = normalizeCropFile(buildFile(folderPath, manifest, deduped))
  warnings.push(...normalized.repairs)

  const report = validateCropFile(normalized.file)
  warnings.push(...report.warnings)
  if (!report.valid) {
    const detail = report.errors
      .map(e => `${e.rule || e.code}${e.cropId ? ` (${e.cropId})` : ''}: ${e.message}`)
      .join('; ')
    throw new Error(`Offline detection produced an invalid four-point-crop file and was not saved: ${detail}`)
  }

  // Renumbering (`OUT-08`) means provisional ids do not survive, but the review
  // marker rides along inside `reason`, so it can be recovered by suffix.
  const reviewCount = normalized.file.crops.filter(c => c.reason.endsWith('__review')).length
  if (reviewCount > 0) {
    warnings.push(warning(
      'sections_need_review',
      'SR-05',
      `${reviewCount} section(s) have little line detail and may be background only — ` +
      'they are marked "__review" in their reason. Check them before applying.'
    ))
  }
  if (detection.skipped.length > 0) {
    warnings.push(warning(
      'sections_skipped',
      'SR-04',
      `${detection.skipped.length} region(s) were dropped as text or branding rather than artwork.`
    ))
  }
  warnings.push(warning(
    'offline_engine',
    '',
    `Detected offline from the ${detection.gutterMode}-gutter page structure. This engine ` +
    'measures where the artwork is; it does not read the sections, so the reasons are ' +
    'shape descriptions rather than descriptions of content.'
  ))

  console.log(
    `[clipper2] offline detection complete: ${normalized.file.crops.length} crop(s), ` +
    `${detection.skipped.length} skipped, ${warnings.length} warning(s)`
  )

  return {
    file: normalized.file,
    sidecar: buildSidecar(),
    // No per-crop confidence: this detector has no calibrated score to report,
    // and a synthetic one would be indistinguishable from a real model's (§8.7).
    confidenceById: {},
    warnings
  }
}
