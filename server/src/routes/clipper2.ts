/**
 * Image Clipper 2.0 API Routes — Module 3 v2
 *
 * The HTTP surface of the two-stage pointer technique. Stage 1 (detect) asks a
 * vision model for four crop pointers per section and writes them to a JSON
 * artifact on disk; Stage 2 (apply) reads that artifact and cuts the images
 * deterministically. Both stages run as fire-and-forget jobs and stream over
 * Socket.io, exactly as Module 3 AI's /suggest does.
 *
 * Endpoints:
 *   GET    /status                              Gemini availability + guidelines + format identity
 *   GET    /guidelines                          the active Crop Detection Guidelines
 *   PUT    /guidelines                          the ONLY write path (Settings editor)
 *   POST   /guidelines/reset                    restore the shipped default
 *   GET    /prompt                              the text to paste into an external AI
 *   GET    /chapters                            croppable chapters + pointer-set status
 *   POST   /chapters/:id/detect                 Stage 1, async (clipper2:detect-*)
 *   POST   /chapters/:id/cancel                 abort an in-flight detection
 *   GET    /chapters/:id/points                 the artifact + validation + provenance
 *   PUT    /chapters/:id/points                 hand-edit the artifact (strict)
 *   POST   /chapters/:id/points/import          import an external AI's JSON (repairs)
 *   DELETE /chapters/:id/points                 drop the artifact (keeps exports)
 *   GET    /chapters/:id/points/download        the artifact as a file download
 *   POST   /chapters/:id/apply                  Stage 2, async (clipper2:apply-*)
 *   POST   /chapters/:id/preview/:cropId        data-URI thumbnail for one pointer set
 *   GET    /chapters/:id/outputs                the exported PNGs
 *   GET    /chapters/:id/output/:filename       one exported PNG
 *
 * The JSON file is the source of truth for geometry; the CropPointSet row is only
 * an index for listing and status. So every handler that answers a question about
 * the artifact reads the disk, and no handler ever reconstructs pointers from the
 * database.
 */

import { Router, Request, Response } from 'express'
import path from 'path'
import fs from 'fs/promises'
import { Server } from 'socket.io'
import { prisma } from '../index.js'
import { getChapterManifest } from '../services/clipperService.js'
import { FOUR_POINT_FORMAT, FOUR_POINT_VERSION } from '../services/clipper2/fourPointTypes.js'
import type {
  CropPointsSidecar,
  FourPointCropFile,
  ValidationIssue,
  ValidationReport
} from '../services/clipper2/fourPointTypes.js'
import { normalizeCropFile, parseCropFile, validateCropFile } from '../services/clipper2/fourPointSchema.js'
import {
  deletePointSet,
  getOutputDir,
  getPointsFilePath,
  getSourceFolderPath,
  listOutputs,
  pointsFileExists,
  readPointsFile,
  readPointsText,
  readSidecar,
  writePointsFile,
  writeSidecar
} from '../services/clipper2/pointerStore.js'
import {
  checkGeminiPointerDetector,
  detectCropPoints,
  getDetectionModel
} from '../services/clipper2/pointerDetector.js'
import {
  checkOfflineDetector,
  detectCropPointsOffline,
  OFFLINE_MODEL,
  type OfflineDetectConfig
} from '../services/clipper2/offlineDetector.js'
import { applyCropPoints, previewCropEntry } from '../services/clipper2/pointerApply.js'
import {
  buildPointerPrompt,
  ensurePointerGuidelines,
  getPointerGuidelinesMeta,
  readPointerGuidelines,
  resetPointerGuidelines,
  writePointerGuidelines
} from '../services/clipper2/pointerGuidelines.js'

/**
 * Which Stage 1 engine a detect request wants.
 *
 * `gemini` uploads downscaled pages to a vision model and needs a key and quota;
 * `offline` runs classical CV on this machine against the source pixels. They
 * produce the same artifact, so the choice is per run rather than a mode the
 * chapter is left in.
 */
export type DetectEngine = 'gemini' | 'offline'

function parseEngine(value: unknown): DetectEngine {
  return value === 'offline' ? 'offline' : 'gemini'
}

/**
 * Pull the offline tunables out of a request body, ignoring anything else.
 *
 * Bounds are enforced here rather than in the script: a negative area or a
 * 10,000px breakout margin is a bad request, and the sidecar should not have to
 * be defensive about arguments this side generated.
 */
function parseOfflineConfig(body: Record<string, unknown>): OfflineDetectConfig {
  const cfg: OfflineDetectConfig = {}
  const mode = body.gutterMode
  if (mode === 'auto' || mode === 'dark' || mode === 'light') cfg.gutterMode = mode

  const area = Number(body.minPanelArea)
  if (Number.isFinite(area)) cfg.minPanelArea = Math.min(2_000_000, Math.max(1_000, Math.round(area)))

  const margin = Number(body.breakoutMargin)
  if (Number.isFinite(margin)) cfg.breakoutMargin = Math.min(200, Math.max(0, Math.round(margin)))

  if (typeof body.filterOverlays === 'boolean') cfg.filterOverlays = body.filterOverlays
  return cfg
}

// ============ In-flight jobs ============

/**
 * Module-level, not per-router: "already detecting this chapter" is a property of
 * the server process, and initClipper2Routes must not be able to hand out a
 * second, independent set of locks if it is ever called twice.
 *
 * The map's keys ARE the in-flight set — one structure so a controller can never
 * outlive its lock or vice versa.
 */
const detecting = new Map<string, AbortController>()

/**
 * Apply has no controller: it is deterministic, bounded by the crop count, and
 * has no long-running network call to interrupt, so it is only guarded against
 * two concurrent runs writing the same output filenames.
 */
const applying = new Set<string>()

// ============ Shapes ============

/**
 * The sidecar plus the per-crop confidence map.
 *
 * fourPointTypes fixes CropPointsSidecar's shape and §14 fixes the artifact's, so
 * confidence — which the inspector wants to show but the canonical file must not
 * carry — rides along as an extra key on the deliberately non-canonical sidecar.
 * readSidecar's plain JSON.parse preserves it, and a sidecar written before this
 * key existed degrades to an empty map rather than an error.
 */
interface SidecarWithConfidence extends CropPointsSidecar {
  confidenceById?: Record<string, number>
}

/** A chapter with no artifact is not an invalid chapter, so "nothing" reads as valid. */
function emptyValidation(): ValidationReport {
  return { valid: true, errors: [], warnings: [] }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ============ Manual import helpers ============

/**
 * Pull the JSON object out of whatever the user pasted or dropped.
 *
 * The hand-edit PUT can demand clean bytes because the user typed them into our own
 * editor. An imported file came out of a chat window, so it routinely arrives wrapped
 * in ```json fences or with a sentence of commentary on either side. Stripping that is
 * not leniency about the FORMAT — the object still has to validate — it is leniency
 * about the transport.
 */
function extractJsonObject(text: string): { value: unknown } | { error: string } {
  const unfenced = text.replace(/```[a-zA-Z]*/g, '').trim()

  const attempt = (candidate: string): unknown | undefined => {
    try {
      return JSON.parse(candidate)
    } catch {
      return undefined
    }
  }

  const direct = attempt(unfenced)
  if (direct !== undefined) return { value: direct }

  // Fall back to the outermost {...}, which drops any prose around it.
  const first = unfenced.indexOf('{')
  const last = unfenced.lastIndexOf('}')
  if (first !== -1 && last > first) {
    const sliced = attempt(unfenced.slice(first, last + 1))
    if (sliced !== undefined) return { value: sliced }
  }

  return { error: 'The pasted content is not valid JSON' }
}

/** Tolerance on the imported canvas's aspect ratio before it reads as a different canvas. */
const ASPECT_TOLERANCE = 0.02

/**
 * The failure mode this manual loop actually has.
 *
 * Coordinates are normalized, so a file whose `image` describes a DIFFERENT canvas
 * than the chapter — one page instead of the whole stitched chapter, most often — is
 * not merely mislabelled: every ratio in it is measured against the wrong denominator
 * and every crop will land in the wrong place. Absolute pixel sizes are a poor test
 * (the AI sees downscaled pages), but the aspect ratio survives any downscale, so a
 * mismatch there is strong evidence the wrong canvas was measured (`ST-09`, `OUT-14`).
 *
 * Reported as a warning, not an error: the user can see the overlay and judge, and a
 * chapter genuinely can be one page tall.
 */
function canvasMismatchWarning(
  file: FourPointCropFile,
  canvasWidth: number,
  canvasHeight: number
): ValidationIssue | null {
  const declaredW = Number(file.image?.width)
  const declaredH = Number(file.image?.height)
  if (!Number.isFinite(declaredW) || !Number.isFinite(declaredH)) return null
  if (declaredW <= 0 || declaredH <= 0 || canvasWidth <= 0 || canvasHeight <= 0) return null

  const declared = declaredW / declaredH
  const actual = canvasWidth / canvasHeight
  if (Math.abs(declared - actual) <= ASPECT_TOLERANCE * actual) return null

  return {
    code: 'canvas_aspect_mismatch',
    rule: 'ST-09',
    severity: 'warning',
    message:
      `The imported file measures a ${declaredW}x${declaredH} page, but this chapter's ` +
      `combined page is ${Math.round(canvasWidth)}x${Math.round(canvasHeight)}. If the AI ` +
      'measured one image instead of the whole stitched chapter, every coordinate is ' +
      'normalized against the wrong height — check the overlay before applying.'
  }
}

async function findChapter(chapterId: string) {
  return prisma.chapter.findUnique({
    where: { id: chapterId },
    select: {
      id: true,
      number: true,
      title: true,
      folderPath: true,
      seriesId: true,
      pageCount: true,
      series: { select: { title: true } }
    }
  })
}

/**
 * The Clipper2PointSet payload: artifact bytes, its validation report, provenance
 * and the index row's status, assembled in one place so GET and PUT can never
 * describe the same chapter differently.
 *
 * `content` is always the bytes as they sit on disk — the editor round-trips them,
 * so a reserialization here would silently rewrite what the user is looking at.
 */
async function readPointSet(chapterId: string, folderPath: string) {
  const [artifact, sidecar, row] = await Promise.all([
    readPointsFile(folderPath),
    readSidecar(folderPath) as Promise<SidecarWithConfidence | null>,
    prisma.cropPointSet.findUnique({ where: { chapterId } })
  ])

  return {
    chapterId,
    content: artifact?.text ?? '',
    file: artifact?.file ?? null,
    sidecar,
    validation: artifact ? artifact.report : emptyValidation(),
    status: row?.status ?? null,
    appliedAt: row?.appliedAt ? row.appliedAt.toISOString() : null,
    exportDir: row?.exportDir ?? null,
    // Prefer the live path: an artifact that exists is at the path this process
    // resolves right now, even if the row was written under a different DOWNLOAD_ROOT.
    jsonPath: artifact ? path.resolve(getPointsFilePath(folderPath)) : row?.jsonPath ?? null,
    confidenceById: sidecar?.confidenceById ?? {}
  }
}

/**
 * Disk facts for the chapter listing. A listing must not fail because one
 * chapter's folder became unreadable, so a probe error degrades to "no pointers"
 * with a log line rather than a 500 for every other chapter in the list.
 */
async function probePointSet(folderPath: string): Promise<{ hasPoints: boolean; detectedAt: string | null }> {
  try {
    const [hasPoints, sidecar] = await Promise.all([pointsFileExists(folderPath), readSidecar(folderPath)])
    return { hasPoints, detectedAt: sidecar?.detectedAt ?? null }
  } catch (err) {
    console.error(`[clipper2] could not inspect crop points under ${folderPath}:`, err)
    return { hasPoints: false, detectedAt: null }
  }
}

// ============ Stage 1 job ============

/**
 * One detection run. Never rejects: every outcome is reported to the client over
 * clipper2:detect-complete and recorded on the row, because the HTTP response was
 * already sent when this started.
 */
async function runDetect(
  io: Server,
  chapter: { id: string; folderPath: string },
  controller: AbortController,
  engine: DetectEngine = 'gemini',
  config?: OfflineDetectConfig
): Promise<void> {
  const chapterId = chapter.id
  const folderPath = chapter.folderPath
  const source = engine === 'offline' ? 'cv' : 'ai'

  try {
    // Row first, before the model call: detection takes minutes, and the listing
    // has to be able to say "detecting" for the whole of it.
    await prisma.cropPointSet.upsert({
      where: { chapterId },
      update: { status: 'detecting', source, error: null },
      create: {
        chapterId,
        jsonPath: path.resolve(getPointsFilePath(folderPath)),
        status: 'detecting',
        source
      }
    })

    io.emit('clipper2:detect-progress', {
      chapterId,
      phase: 'manifest',
      percent: 0,
      message: 'Measuring chapter pages…'
    })

    const manifest = await getChapterManifest(folderPath)

    const onProgress = (p: { phase: string; percent: number; message?: string }) =>
      io.emit('clipper2:detect-progress', {
        chapterId,
        phase: p.phase,
        percent: p.percent,
        message: p.message
      })

    // Both engines return a DetectionResult, so everything downstream — the
    // artifact bytes, the sidecar, the row, the socket payload — is identical.
    const result = engine === 'offline'
      ? await detectCropPointsOffline(getSourceFolderPath(folderPath), folderPath, manifest, {
          config,
          onProgress,
          signal: controller.signal
        })
      : await detectCropPoints(getSourceFolderPath(folderPath), folderPath, manifest, {
          onProgress,
          signal: controller.signal
        })

    io.emit('clipper2:detect-progress', {
      chapterId,
      phase: 'write',
      percent: 100,
      message: 'Writing crop_points.json…'
    })

    // writePointsFile is the only canonical serializer (`OUT-15`); the confidence
    // map goes to the sidecar because it must not appear in the artifact.
    const jsonPath = await writePointsFile(folderPath, result.file)
    const sidecar: SidecarWithConfidence = { ...result.sidecar, confidenceById: result.confidenceById }
    await writeSidecar(folderPath, sidecar)

    const data = {
      jsonPath,
      status: 'detected',
      source: result.sidecar.source,
      format: result.file.format,
      formatVersion: result.file.version,
      cropCount: result.file.crops.length,
      model: result.sidecar.model,
      guidelinesSha: result.sidecar.guidelinesSha,
      imageLabel: result.file.image.filename,
      imageWidth: result.file.image.width,
      imageHeight: result.file.image.height,
      // The pages actually measured, which is what the pointers are normalized
      // against (`ST-09`) — not the chapter's recorded pageCount.
      pageCount: manifest.images.length,
      warningsJson: result.warnings.length > 0 ? JSON.stringify(result.warnings) : null,
      error: null
    }
    // Upsert rather than update: the user may have deleted the point set while the
    // model was still thinking, and the artifact now on disk needs an index row.
    await prisma.cropPointSet.upsert({
      where: { chapterId },
      update: data,
      create: { chapterId, ...data }
    })

    io.emit('clipper2:detect-complete', {
      chapterId,
      cropCount: result.file.crops.length,
      warnings: result.warnings
    })
  } catch (err) {
    const message = errorText(err)
    console.error(`[clipper2] detection failed for chapter ${chapterId}:`, err)
    // updateMany, not update: it no-ops when the row is gone instead of throwing a
    // second error out of the failure path.
    await prisma.cropPointSet
      .updateMany({ where: { chapterId }, data: { status: 'failed', error: message } })
      .catch((e: unknown) => console.error('[clipper2] could not record the detection failure:', e))
    io.emit('clipper2:detect-complete', { chapterId, error: message })
  }
}

// ============ Stage 2 job ============

/** One apply run. Never rejects, for the same reason runDetect does not. */
async function runApply(
  io: Server,
  chapter: { id: string; folderPath: string; seriesTitle: string },
  file: FourPointCropFile,
  opts: { register: boolean; replaceExisting: boolean }
): Promise<void> {
  const chapterId = chapter.id
  const folderPath = chapter.folderPath

  try {
    const manifest = await getChapterManifest(folderPath)

    const result = await applyCropPoints({
      chapterId,
      folderPath,
      seriesTitle: chapter.seriesTitle,
      file,
      manifest,
      register: opts.register,
      replaceExisting: opts.replaceExisting,
      onProgress: p => io.emit('clipper2:apply-progress', { chapterId, current: p.current, total: p.total })
    })

    const data = {
      status: 'applied',
      appliedAt: new Date(),
      exportDir: result.exportDir,
      exportedCount: result.exported,
      error: null
    }
    await prisma.cropPointSet.upsert({
      where: { chapterId },
      update: data,
      // No row means the artifact was placed on disk by hand rather than detected.
      create: {
        chapterId,
        jsonPath: path.resolve(getPointsFilePath(folderPath)),
        source: 'manual',
        cropCount: file.crops.length,
        imageLabel: file.image.filename,
        imageWidth: file.image.width,
        imageHeight: file.image.height,
        ...data
      }
    })

    io.emit('clipper2:apply-complete', {
      chapterId,
      exported: result.exported,
      failed: result.failed,
      exportDir: result.exportDir,
      registered: result.registered,
      warnings: result.warnings
    })
  } catch (err) {
    const message = errorText(err)
    console.error(`[clipper2] apply failed for chapter ${chapterId}:`, err)
    await prisma.cropPointSet
      .updateMany({ where: { chapterId }, data: { status: 'failed', error: message } })
      .catch((e: unknown) => console.error('[clipper2] could not record the apply failure:', e))
    io.emit('clipper2:apply-complete', { chapterId, error: message })
  }
}

// ============ Routes ============

export function initClipper2Routes(io: Server): Router {
  const router = Router()

  // ============ Status ============

  router.get('/status', async (_req: Request, res: Response) => {
    try {
      // Idempotent seed + re-lock, best-effort on every poll (mirrors the v1
      // engine's ensureLocked): the active document appears on first use, and a
      // status poll is never allowed to fail because of a chmod.
      await ensurePointerGuidelines().catch(() => {})

      const [meta, detector, offline] = await Promise.all([
        getPointerGuidelinesMeta(),
        checkGeminiPointerDetector(),
        checkOfflineDetector()
      ])
      res.json({
        // Detection calls Gemini, so availability is just whether an API key is
        // configured — there is no local model or process to probe.
        geminiAvailable: detector.available,
        geminiError: detector.error,
        // The offline engine is the opposite: no key, but it does need the Python
        // venv, so this one really is a process probe.
        offlineAvailable: offline.available,
        offlineError: offline.error,
        offlineModel: OFFLINE_MODEL,
        guidelinesPresent: meta.present,
        guidelinesUpdatedAt: meta.updatedAt,
        guidelinesIsDefault: meta.isDefault,
        model: getDetectionModel(),
        format: FOUR_POINT_FORMAT,
        formatVersion: FOUR_POINT_VERSION
      })
    } catch (error) {
      console.error('Error fetching clipper2 status:', error)
      res.status(500).json({ error: 'Failed to fetch status' })
    }
  })

  // ============ Guidelines (the technique's spec, user-upgradable) ============

  /** GET /guidelines — the active document the detector is handed verbatim. */
  router.get('/guidelines', async (_req: Request, res: Response) => {
    try {
      // Seeded here too so the Settings editor shows the shipped rules even when
      // it is opened before any detection has ever run.
      await ensurePointerGuidelines().catch(() => {})

      const [content, meta] = await Promise.all([readPointerGuidelines(), getPointerGuidelinesMeta()])
      res.json({
        content,
        updatedAt: meta.updatedAt,
        readOnly: meta.readOnly,
        present: meta.present,
        isDefault: meta.isDefault
      })
    } catch (error) {
      console.error('Error reading crop point guidelines:', error)
      res.status(500).json({ error: 'Failed to read guidelines' })
    }
  })

  /**
   * PUT /guidelines { content } — the ONLY write path for the guidelines file.
   * Reached exclusively from the user-initiated Settings editor; the file is
   * otherwise 0444 so no detect/apply path can mutate the rules it is judged by.
   */
  router.put('/guidelines', async (req: Request, res: Response) => {
    try {
      const { content } = req.body
      if (typeof content !== 'string' || content.trim().length === 0) {
        return res.status(400).json({ error: 'content (non-empty string) is required' })
      }
      const meta = await writePointerGuidelines(content, new Date().toISOString())
      res.json({
        content,
        updatedAt: meta.updatedAt,
        readOnly: meta.readOnly,
        present: meta.present,
        isDefault: meta.isDefault
      })
    } catch (error) {
      console.error('Error writing crop point guidelines:', error)
      res.status(500).json({ error: 'Failed to write guidelines' })
    }
  })

  /** POST /guidelines/reset — back to the version that shipped. */
  router.post('/guidelines/reset', async (_req: Request, res: Response) => {
    try {
      const meta = await resetPointerGuidelines()
      res.json({
        content: await readPointerGuidelines(),
        updatedAt: meta.updatedAt,
        readOnly: meta.readOnly,
        present: meta.present,
        isDefault: meta.isDefault
      })
    } catch (error) {
      console.error('Error resetting crop point guidelines:', error)
      res.status(500).json({ error: errorText(error) })
    }
  })

  /**
   * GET /prompt
   * The exact text to paste into an external AI, composed server-side so the
   * Narration Studio's Step 3 and the Clipper 2.0 workspace hand out identical bytes.
   * Chapter-independent: the prompt refers to whatever chapter is already open in
   * the user's chat, and carries no per-chapter data itself.
   */
  router.get('/prompt', async (_req: Request, res: Response) => {
    try {
      await ensurePointerGuidelines().catch(() => {})
      const [prompt, meta] = await Promise.all([buildPointerPrompt(), getPointerGuidelinesMeta()])
      res.json({
        prompt,
        guidelinesPresent: meta.present,
        guidelinesUpdatedAt: meta.updatedAt,
        guidelinesIsDefault: meta.isDefault
      })
    } catch (error) {
      console.error('Error building the crop pointer prompt:', error)
      res.status(500).json({ error: 'Failed to build the crop pointer prompt' })
    }
  })

  // ============ Chapter listing ============

  /**
   * GET /chapters
   * Every downloaded chapter, with its pointer-set status. Downloaded is the only
   * requirement: Clipper 2.0 measures the artwork, so it does not care whether the
   * chapter has a script or a voiceover yet.
   */
  router.get('/chapters', async (_req: Request, res: Response) => {
    try {
      const chapters = await prisma.chapter.findMany({
        where: { status: 'done' },
        select: {
          id: true,
          number: true,
          title: true,
          seriesId: true,
          folderPath: true,
          pageCount: true,
          series: { select: { title: true } },
          cropPointSet: true
        },
        orderBy: [{ series: { title: 'asc' } }, { number: 'asc' }]
      })

      const summaries = await Promise.all(
        chapters.map(async chapter => {
          // hasPoints is a question about the disk, not about this row: the
          // artifact is user-deletable, so a row can outlive its file. The probe
          // is skipped for chapters that were never touched, which is most of them.
          // detectedAt likewise comes from the sidecar — the only place the real
          // detection timestamp is recorded.
          const probe = chapter.cropPointSet
            ? await probePointSet(chapter.folderPath)
            : { hasPoints: false, detectedAt: null }

          return {
            id: chapter.id,
            number: chapter.number,
            title: chapter.title,
            seriesId: chapter.seriesId,
            seriesTitle: chapter.series.title,
            pageCount: chapter.pageCount ?? 0,
            hasPoints: probe.hasPoints,
            cropCount: chapter.cropPointSet?.cropCount ?? 0,
            status: chapter.cropPointSet?.status ?? null,
            detectedAt: probe.detectedAt,
            appliedAt: chapter.cropPointSet?.appliedAt?.toISOString() ?? null,
            exportedCount: chapter.cropPointSet?.exportedCount ?? 0
          }
        })
      )

      res.json(summaries)
    } catch (error) {
      console.error('Error fetching clipper2 chapters:', error)
      res.status(500).json({ error: 'Failed to fetch chapters' })
    }
  })

  // ============ Stage 1: detect ============

  /**
   * POST /chapters/:id/detect { engine?, gutterMode?, minPanelArea?, breakoutMargin?, filterOverlays? }
   * Kicks off pointer detection asynchronously; progress and the result stream via
   * clipper2:detect-progress / clipper2:detect-complete.
   *
   * `engine` defaults to `gemini`, so an existing caller that posts an empty body
   * keeps its behaviour. The remaining fields apply to `offline` only.
   */
  router.post('/chapters/:id/detect', async (req: Request, res: Response) => {
    try {
      const chapterId = req.params.id
      const chapter = await findChapter(chapterId)
      if (!chapter) {
        return res.status(400).json({ error: 'Chapter not found' })
      }
      if (detecting.has(chapterId)) {
        return res.status(409).json({ error: 'Pointer detection is already running for this chapter' })
      }

      const body = (req.body ?? {}) as Record<string, unknown>
      const engine = parseEngine(body.engine)

      // Fail here rather than inside the job: "the detector is not installed" is
      // an answer to this request, not an event to wait for.
      if (engine === 'offline') {
        const probe = await checkOfflineDetector()
        if (!probe.available) {
          return res.status(400).json({ error: probe.error ?? 'Offline crop detection is unavailable' })
        }
      }

      // Registered before the job starts so a second POST that lands in the same
      // tick is rejected rather than starting a duplicate run.
      const controller = new AbortController()
      detecting.set(chapterId, controller)

      runDetect(
        io,
        { id: chapter.id, folderPath: chapter.folderPath },
        controller,
        engine,
        engine === 'offline' ? parseOfflineConfig(body) : undefined
      )
        .catch(err => console.error('[clipper2] detection job crashed:', err))
        .finally(() => { detecting.delete(chapterId) })

      res.json({ started: true, engine })
    } catch (error) {
      console.error('Error starting pointer detection:', error)
      res.status(500).json({ error: 'Failed to start pointer detection' })
    }
  })

  /**
   * POST /chapters/:id/cancel
   * Signals an in-flight detection to stop. The run's own finally is what releases
   * the lock, so this only aborts — it never removes the entry itself.
   */
  router.post('/chapters/:id/cancel', async (req: Request, res: Response) => {
    try {
      const controller = detecting.get(req.params.id)
      if (!controller) {
        return res.json({ cancelled: 0 })
      }
      controller.abort()
      res.json({ cancelled: 1 })
    } catch (error) {
      console.error('Error cancelling pointer detection:', error)
      res.status(500).json({ error: 'Failed to cancel pointer detection' })
    }
  })

  // ============ The artifact ============

  /** GET /chapters/:id/points — bytes, validation, provenance and status. */
  router.get('/chapters/:id/points', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) {
        return res.status(404).json({ error: 'Chapter not found' })
      }
      res.json(await readPointSet(chapter.id, chapter.folderPath))
    } catch (error) {
      console.error('Error reading crop points:', error)
      res.status(500).json({ error: 'Failed to read crop points' })
    }
  })

  /**
   * PUT /chapters/:id/points { content }
   * The hand-edit path. Invalid JSON is reported with its full validation report
   * and NOT written: the file on disk is what Stage 2 cuts from, so it must never
   * be left in a state the apply stage would refuse.
   */
  router.put('/chapters/:id/points', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) {
        return res.status(404).json({ error: 'Chapter not found' })
      }

      const { content } = req.body
      if (typeof content !== 'string' || content.trim().length === 0) {
        return res.status(400).json({ error: 'content (non-empty string) is required' })
      }

      const { file, report } = parseCropFile(content)
      if (!file) {
        // The editor renders `validation` inline, so the message stays short.
        return res.status(400).json({ error: 'Crop points file is invalid and was not saved', validation: report })
      }

      const folderPath = chapter.folderPath
      // Written through writePointsFile, not writePointsText: a save is a commit,
      // and canonical bytes (`OUT-15`) are what keep hand-edited files diffable
      // against detected ones.
      const jsonPath = await writePointsFile(folderPath, file)

      const existing = (await readSidecar(folderPath)) as SidecarWithConfidence | null
      // Confidence is the model's opinion of crops that may no longer exist, so
      // only ids still present in the saved file keep theirs.
      const survivingIds = new Set(file.crops.map(entry => entry.id))
      const confidenceById = Object.fromEntries(
        Object.entries(existing?.confidenceById ?? {}).filter(([cropId]) => survivingIds.has(cropId))
      )

      const sidecar: SidecarWithConfidence = {
        // source becomes manual whatever it was: these pointers are now the user's.
        source: 'manual',
        // Detection provenance is kept: it still describes where the set started.
        model: existing?.model ?? null,
        guidelinesSha: existing?.guidelinesSha ?? null,
        detectedAt: existing?.detectedAt ?? new Date().toISOString(),
        // Informational only — pointerApply rebuilds the real segment map from the
        // chapter folder, so a hand-authored set may legitimately carry none.
        segments: existing?.segments ?? [],
        warnings: existing?.warnings ?? [],
        confidenceById
      }
      await writeSidecar(folderPath, sidecar)

      const data = {
        jsonPath,
        status: 'edited',
        source: 'manual',
        format: file.format,
        formatVersion: file.version,
        cropCount: file.crops.length,
        imageLabel: file.image.filename,
        imageWidth: file.image.width,
        imageHeight: file.image.height,
        error: null
      }
      await prisma.cropPointSet.upsert({
        where: { chapterId: chapter.id },
        update: data,
        // A hand-written sidecar may be missing keys entirely, hence the guarded read.
        create: { chapterId: chapter.id, ...data, pageCount: existing?.segments?.length ?? 0 }
      })

      res.json(await readPointSet(chapter.id, folderPath))
    } catch (error) {
      console.error('Error saving crop points:', error)
      res.status(500).json({ error: 'Failed to save crop points' })
    }
  })

  /**
   * POST /chapters/:id/points/import { content, source? }
   *
   * The manual loop's landing point: the user copied `GET /prompt` into an external
   * AI, and this is the JSON that came back. It REPLACES the chapter's pointer file.
   *
   * Why this is not just `PUT /points`. That route is a hand-edit — the user typed
   * those bytes into our own editor, so it validates strictly and refuses to
   * second-guess them. An imported file is a foreign artifact, and a real model's
   * output essentially never satisfies §13.1's EXACT edge equality: a right edge
   * reported as 0.72751 against a 0.7275 left edge is a rounding artifact, not a
   * skewed quad, and rejecting the whole chapter over it would make the loop
   * unusable. So the import runs the same repair pass detection uses
   * (`normalizeCropFile` — snap near-equal edges, re-sort into page order, renumber
   * to `OUT-08`, snake_case the reasons) and only then validates. Anything the
   * repair cannot rescue is still a 400.
   *
   * Every repair is reported back, so "we changed your file" is never silent.
   */
  router.post('/chapters/:id/points/import', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) {
        return res.status(404).json({ error: 'Chapter not found' })
      }

      const { content } = req.body
      if (typeof content !== 'string' || content.trim().length === 0) {
        return res.status(400).json({ error: 'content (non-empty string) is required' })
      }

      const extracted = extractJsonObject(content)
      if ('error' in extracted) {
        return res.status(400).json({
          error: extracted.error,
          validation: {
            valid: false,
            errors: [{ code: 'invalid_json', rule: '', severity: 'error', message: extracted.error }],
            warnings: []
          } satisfies ValidationReport
        })
      }
      if (!extracted.value || typeof extracted.value !== 'object' || Array.isArray(extracted.value)) {
        return res.status(400).json({ error: 'The imported JSON must be a four-point-crop object' })
      }

      const { file, repairs } = normalizeCropFile(extracted.value as FourPointCropFile)
      const report = validateCropFile(file)
      if (!report.valid) {
        // Not written: the file on disk is what Stage 2 cuts from.
        return res.status(400).json({
          error: 'The imported crop points file is invalid and was not saved',
          validation: report
        })
      }

      const folderPath = chapter.folderPath
      const warnings: ValidationIssue[] = [...repairs, ...report.warnings]

      // Best-effort: reading the manifest costs a metadata probe per page, and a
      // chapter whose images cannot be read is a problem for apply to report, not a
      // reason to refuse a file that is otherwise valid.
      try {
        const manifest = await getChapterManifest(folderPath)
        const mismatch = canvasMismatchWarning(file, manifest.canvasWidth, manifest.canvasHeight)
        if (mismatch) warnings.push(mismatch)
      } catch (err) {
        console.warn(`[clipper2] could not measure ${folderPath} to check the imported canvas:`, err)
      }

      const jsonPath = await writePointsFile(folderPath, file)

      const existing = (await readSidecar(folderPath)) as SidecarWithConfidence | null
      const sidecar: SidecarWithConfidence = {
        // An external model produced these, so provenance is 'ai' — but the model id
        // records that it came in by hand, since we cannot know what actually ran.
        source: 'ai',
        model: 'external-ai (manual import)',
        // The prompt the user copied carried the guidelines as they stand now, so
        // this is the revision the import was produced under.
        guidelinesSha: (await getPointerGuidelinesMeta()).sha256,
        detectedAt: new Date().toISOString(),
        // Informational only — pointerApply rebuilds the real segment map from the
        // chapter folder, so an imported set may legitimately carry none.
        segments: existing?.segments ?? [],
        warnings,
        // The previous set's confidences describe crops that no longer exist.
        confidenceById: {}
      }
      await writeSidecar(folderPath, sidecar)

      const data = {
        jsonPath,
        status: 'imported',
        source: 'ai',
        format: file.format,
        formatVersion: file.version,
        cropCount: file.crops.length,
        imageLabel: file.image.filename,
        imageWidth: file.image.width,
        imageHeight: file.image.height,
        error: null
      }
      await prisma.cropPointSet.upsert({
        where: { chapterId: chapter.id },
        update: data,
        create: { chapterId: chapter.id, ...data, pageCount: existing?.segments?.length ?? 0 }
      })

      console.log(
        `[clipper2] imported ${file.crops.length} crop(s) for chapter ${chapter.id} ` +
        `(${repairs.length} repair(s), ${warnings.length} warning(s))`
      )

      res.json({ ...(await readPointSet(chapter.id, folderPath)), repairs: warnings })
    } catch (error) {
      console.error('Error importing crop points:', error)
      res.status(500).json({ error: 'Failed to import crop points' })
    }
  })

  /**
   * DELETE /chapters/:id/points
   * Drops the artifact, its sidecar and the index row. The exported images under
   * crops2/ are left alone on purpose — Module 4 may already be using them.
   */
  router.delete('/chapters/:id/points', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) {
        return res.status(404).json({ error: 'Chapter not found' })
      }

      const existed = await pointsFileExists(chapter.folderPath)
      await deletePointSet(chapter.folderPath)
      const { count } = await prisma.cropPointSet.deleteMany({ where: { chapterId: chapter.id } })

      res.json({ deleted: existed || count > 0 })
    } catch (error) {
      console.error('Error deleting crop points:', error)
      res.status(500).json({ error: 'Failed to delete crop points' })
    }
  })

  /**
   * GET /chapters/:id/points/download
   * The artifact's exact bytes, so what the user edits offline and what Stage 2
   * reads are the same file.
   */
  router.get('/chapters/:id/points/download', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) {
        return res.status(404).json({ error: 'Chapter not found' })
      }

      const text = await readPointsText(chapter.folderPath)
      if (text === null) {
        return res.status(404).json({ error: 'No crop points file for this chapter' })
      }

      const filename = `ch${chapter.number}_crop_points.json`
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      res.send(text)
    } catch (error) {
      console.error('Error downloading crop points:', error)
      res.status(500).json({ error: 'Failed to download crop points' })
    }
  })

  // ============ Stage 2: apply ============

  /**
   * POST /chapters/:id/apply { register?, replaceExisting? }
   * Cuts the images asynchronously; progress and the result stream via
   * clipper2:apply-progress / clipper2:apply-complete.
   */
  router.post('/chapters/:id/apply', async (req: Request, res: Response) => {
    try {
      const chapterId = req.params.id
      const chapter = await findChapter(chapterId)
      if (!chapter) {
        return res.status(400).json({ error: 'Chapter not found' })
      }
      if (applying.has(chapterId)) {
        return res.status(409).json({ error: 'Crops are already being applied for this chapter' })
      }

      // The artifact is read and checked before the response, not inside the job:
      // "there are no pointers" and "your edit does not parse" are answers to this
      // request, not events the user should have to wait for.
      const artifact = await readPointsFile(chapter.folderPath)
      if (!artifact) {
        return res.status(400).json({ error: 'No crop points file for this chapter — run detection first' })
      }
      if (!artifact.file) {
        return res.status(400).json({
          error: 'Crop points file is invalid and cannot be applied',
          validation: artifact.report
        })
      }

      const register = req.body?.register !== false
      const replaceExisting = req.body?.replaceExisting === true

      applying.add(chapterId)
      runApply(
        io,
        { id: chapter.id, folderPath: chapter.folderPath, seriesTitle: chapter.series.title },
        artifact.file,
        { register, replaceExisting }
      )
        .catch(err => console.error('[clipper2] apply job crashed:', err))
        .finally(() => { applying.delete(chapterId) })

      res.json({ started: true })
    } catch (error) {
      console.error('Error starting crop apply:', error)
      res.status(500).json({ error: 'Failed to start crop apply' })
    }
  })

  /**
   * POST /chapters/:id/preview/:cropId
   * Resolved through the same path apply uses, so the preview is exactly the
   * region apply would cut.
   */
  router.post('/chapters/:id/preview/:cropId', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) {
        return res.status(404).json({ error: 'Chapter not found' })
      }

      const artifact = await readPointsFile(chapter.folderPath)
      if (!artifact) {
        return res.status(404).json({ error: 'No crop points file for this chapter' })
      }
      if (!artifact.file) {
        return res.status(400).json({ error: 'Crop points file is invalid', validation: artifact.report })
      }

      const entry = artifact.file.crops.find(crop => crop.id === req.params.cropId)
      if (!entry) {
        return res.status(404).json({ error: `Crop ${req.params.cropId} is not in this chapter's crop points file` })
      }

      const manifest = await getChapterManifest(chapter.folderPath)
      res.json({ preview: await previewCropEntry(entry, manifest, chapter.folderPath) })
    } catch (error) {
      console.error('Error generating pointer crop preview:', error)
      res.status(500).json({ error: errorText(error) })
    }
  })

  // ============ Exported images ============

  /** GET /chapters/:id/outputs — what Stage 2 last wrote under crops2/. */
  router.get('/chapters/:id/outputs', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) {
        return res.status(404).json({ error: 'Chapter not found' })
      }

      const files = await listOutputs(chapter.folderPath)
      // crops2/ is created by apply, so no files means this chapter was never
      // applied and there is no directory worth naming.
      const exportDir = files.length > 0 ? path.resolve(getOutputDir(chapter.folderPath)) : null

      res.json({
        exportDir,
        files: files.map(file => ({
          filename: file.filename,
          bytes: file.bytes,
          url: `/api/clipper2/chapters/${chapter.id}/output/${encodeURIComponent(file.filename)}`
        }))
      })
    } catch (error) {
      console.error('Error listing pointer crop outputs:', error)
      res.status(500).json({ error: 'Failed to list outputs' })
    }
  })

  /**
   * GET /chapters/:id/output/:filename
   * Scoped to this chapter's crops2/ directory only.
   */
  router.get('/chapters/:id/output/:filename', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) {
        return res.status(404).json({ error: 'Chapter not found' })
      }

      const filename = path.basename(req.params.filename)
      const exportDir = path.resolve(getOutputDir(chapter.folderPath))
      const fullPath = path.resolve(exportDir, filename)
      // basename() already strips traversal; the containment check is what makes
      // that a guarantee rather than a property of one string function.
      if (!fullPath.startsWith(exportDir + path.sep)) {
        return res.status(404).json({ error: 'Output not found' })
      }

      try {
        await fs.access(fullPath)
      } catch {
        return res.status(404).json({ error: 'Output not found' })
      }

      res.setHeader('Content-Type', 'image/png')
      // No explicit Cache-Control: sendFile's max-age=0 + ETag revalidation is what
      // we want here, since re-applying a chapter overwrites these same filenames.
      res.sendFile(fullPath)
    } catch (error) {
      console.error('Error serving pointer crop output:', error)
      res.status(500).json({ error: 'Failed to serve output' })
    }
  })

  return router
}
