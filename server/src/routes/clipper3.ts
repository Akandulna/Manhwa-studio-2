/**
 * Image Clipper 3.0 — per-image crop artifacts and cutting.
 *
 * A chapter is NOT one stitched canvas here. Each source image is independent —
 *
 *   GET    /status                                 crop rules document state
 *   GET    /guidelines                             the crop rules document (Settings)
 *   PUT    /guidelines                             the ONLY write path (Settings editor)
 *   POST   /guidelines/reset                       restore the shipped default
 *   GET    /series                                 series with downloaded chapters
 *   GET    /chapters                               every downloaded chapter
 *   GET    /chapters/:id/image/:filename           one source page image
 *   GET    /chapters/:id/images                    every image + its own status
 *   GET    /chapters/:id/images/:filename/points   that image's crop artifact
 *   PUT    /chapters/:id/images/:filename/points   store that image's crop artifact
 *   DELETE /chapters/:id/images/:filename/points   drop it
 *   GET    /chapters/:id/images/:filename/metadata that image's metadata document
 *   PUT    /chapters/:id/images/:filename/metadata store that image's metadata
 *   DELETE /chapters/:id/images/:filename/metadata drop it
 *   POST   /chapters/:id/crop                      cut every done image
 *   GET    /chapters/:id/outputs                   what was cut
 *   GET    /chapters/:id/output/:filename          one cut image
 *   POST   /chapters/:id/images/:filename/slices      cut that page into parts
 *   POST   /chapters/:id/images/:filename/slices/open reveal the slice folder
 *   POST   /series/:seriesId/slices                   slice every page of every chapter
 *   GET    /chapters/:id/images/:filename/source      that page's identity (hash, true size, issues)
 *   GET    /chapters/:id/images/:filename/handoff     its ChatGPT package, and whether it is stale
 *   POST   /chapters/:id/images/:filename/handoff     build + verify that package
 *   GET    /chapters/:id/images/:filename/analysis    the last imported ChatGPT reply (as page-pixel candidates)
 *   POST   /chapters/:id/images/:filename/analysis    validate + import a pasted ChatGPT reply
 *   GET    /chapters/:id/images/:filename/review      review state + audit findings + export readiness
 *   POST   /chapters/:id/images/:filename/review      start a review (from the import or existing pointers)
 *   PUT    /chapters/:id/images/:filename/review      save a review edit against its revision
 *   GET    /chapters/:id/images/:filename/review/chatgpt-prompt  a review-round prompt for the same ChatGPT chat
 *   POST   /chapters/:id/images/:filename/review/chatgpt         apply ChatGPT's review reply
 *   GET    /chapters/:id/images/:filename/export      the last export's report, and whether it is current
 *   POST   /chapters/:id/images/:filename/export      export a finished review (PNGs + both JSONs)
 *   POST   /chapters/:id/images/:filename/export/open reveal the exported crops folder
 *   GET    /openai                                    OpenAI (ChatGPT API) settings — never the key
 *   PUT    /openai                                    save those settings (key goes to .env)
 *   POST   /openai/test                               check the key + model
 *   GET    /chapters/:id/auto                         the chapter's ChatGPT-API run, if any
 *   POST   /chapters/:id/auto                         run package → analysis → review → export via the API
 *   POST   /chapters/:id/auto/cancel                  stop that run
 *   POST   /series/:seriesId/fetch-phone-crops        unpack the phone's chapter zips from R2 into Processed/
 *   POST   /series/:seriesId/sync-processed           import hand-made JSON from Processed/
 *   POST   /series/:seriesId/sync-processed/preview    what that import would attach
 *   POST   /series/:seriesId/unsync-processed          remove attached JSON from the store
 *   POST   /series/:seriesId/unsync-processed/preview  what that removal would clear
 *
 * "Done" is a fact about the filesystem — this image has BOTH a parseable crop
 * artifact and a metadata document of its own — never an inference from another
 * image's coordinates. Coordinates stay normalized against their own image.
 */

import { Router, Request, Response } from 'express'
import path from 'path'
import fs from 'fs/promises'
import { exec } from 'child_process'
import { Server } from 'socket.io'
import { prisma } from '../index.js'
import { getChapterManifest } from '../services/chapterManifest.js'
import {
  deleteImageMetadata,
  deleteImagePoints,
  extractCrops,
  getOutputDir,
  getSourceFolderPath,
  listMetadataImageStems,
  listOutputs,
  listPointedImageStems,
  readImageMetadata,
  readImagePoints,
  stemOf,
  validateMetadata,
  expectedExportedFilenames,
  canonicalizeExportedFilenames,
  findUnresolvedMetadataNames,
  writeImageMetadata,
  writeImagePoints,
  type Clipper3CropEntry,
  type Clipper3ImageCropFile
} from '../services/clipper3/perImageStore.js'
import { cutImageCrops } from '../services/clipper3/perImageCrop.js'
import {
  ensurePointerGuidelines,
  getPointerGuidelinesMeta,
  readPointerGuidelines,
  resetPointerGuidelines,
  writePointerGuidelines,
  type PointerGuidelinesMeta
} from '../services/clipper3/pointerGuidelines.js'
import { sliceImage, getSliceDir } from '../services/clipper3/perImageSlice.js'
import { buildHandoff, getHandoffStatus, HandoffError } from '../services/clipper3/handoff.js'
import { inspectOriginal } from '../services/clipper3/pageIdentity.js'
import { getAnalysisStatus, importAnalysis } from '../services/clipper3/analysisImport.js'
import { getReview, saveReview, startReview, ReviewError } from '../services/clipper3/reviewState.js'
import { exportPage, getExportStatus, ExportError } from '../services/clipper3/exportPage.js'
import { applyChatGptReview, getReviewPrompt } from '../services/clipper3/chatgptReview.js'
import {
  AutoJobError,
  cancelAutoJob,
  getAutoJob,
  isPageInAutoRun,
  publicOpenAiConfig,
  startAutoJob,
  testOpenAiConnection,
  updateOpenAiConfig
} from '../services/clipper3/openaiAuto.js'
import { fetchPhoneCrops } from '../services/phoneCropImport.js'
import { reconcileQuietly } from '../services/diskReconcile.js'
import {
  syncChapterProcessed,
  unsyncChapterProcessed,
  type ChapterSyncResult,
  type ChapterUnsyncResult
} from '../services/clipper3/processedSync.js'

const FORMAT = 'four-point-crop'
const VERSION = '1.0'

/** Chapters currently being cut, so two runs cannot interleave their writes. */
const cropping = new Set<string>()

/** Series currently being bulk-sliced, so two runs cannot overwrite each other. */
const slicingSeries = new Set<string>()

/** Pages whose ChatGPT package is being built, keyed `<chapterId>/<filename>`. */
const buildingHandoffs = new Set<string>()

/** Pages being exported, keyed `<chapterId>/<filename>`. */
const exportingPages = new Set<string>()

/** Series currently importing from Processed/, so two runs cannot race the same writes. */
const syncingSeries = new Set<string>()

/**
 * Series currently having their attached JSON removed.
 *
 * Kept separate from `syncingSeries` but checked against it both ways below: a
 * sync and an unsync of the same series would be two runs deleting and writing
 * the same files, and whichever finished last would decide the result.
 */
const unsyncingSeries = new Set<string>()


async function findChapter(chapterId: string) {
  return prisma.chapter.findUnique({
    where: { id: chapterId },
    select: {
      id: true,
      number: true,
      title: true,
      folderPath: true,
      seriesId: true,
      series: { select: { title: true } }
    }
  })
}

function seriesSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'series'
}

const IMAGE_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

function guidelinesBody(content: string, meta: PointerGuidelinesMeta) {
  return {
    content,
    updatedAt: meta.updatedAt,
    readOnly: meta.readOnly,
    present: meta.present,
    isDefault: meta.isDefault
  }
}

export function initClipper3Routes(io: Server): Router {
  const router = Router()

  // ============ Crop rules document ============

  /** GET /status — whether the crop rules document is present, and how current. */
  router.get('/status', async (_req: Request, res: Response) => {
    try {
      // Idempotent seed + re-lock, best-effort: a status poll never fails on a chmod.
      await ensurePointerGuidelines().catch(() => {})
      const meta = await getPointerGuidelinesMeta()
      res.json({
        guidelinesPresent: meta.present,
        guidelinesUpdatedAt: meta.updatedAt,
        guidelinesIsDefault: meta.isDefault
      })
    } catch (error) {
      console.error('[clipper3] status failed:', error)
      res.status(500).json({ error: 'Failed to fetch status' })
    }
  })

  /** GET /guidelines — the active document the auto run is handed verbatim. */
  router.get('/guidelines', async (_req: Request, res: Response) => {
    try {
      // Seeded here too so the Settings editor shows the shipped rules on first open.
      await ensurePointerGuidelines().catch(() => {})
      const [content, meta] = await Promise.all([readPointerGuidelines(), getPointerGuidelinesMeta()])
      res.json(guidelinesBody(content, meta))
    } catch (error) {
      console.error('[clipper3] reading crop rules failed:', error)
      res.status(500).json({ error: 'Failed to read guidelines' })
    }
  })

  /**
   * PUT /guidelines { content } — the ONLY write path for the guidelines file.
   * Reached exclusively from the user-initiated Settings editor; the file is
   * otherwise 0444 so no crop path can mutate the rules it is judged by.
   */
  router.put('/guidelines', async (req: Request, res: Response) => {
    try {
      const { content } = req.body
      if (typeof content !== 'string' || content.trim().length === 0) {
        return res.status(400).json({ error: 'content (non-empty string) is required' })
      }
      const meta = await writePointerGuidelines(content, new Date().toISOString())
      res.json(guidelinesBody(content, meta))
    } catch (error) {
      console.error('[clipper3] writing crop rules failed:', error)
      res.status(500).json({ error: 'Failed to write guidelines' })
    }
  })

  /** POST /guidelines/reset — back to the version that shipped. */
  router.post('/guidelines/reset', async (_req: Request, res: Response) => {
    try {
      const meta = await resetPointerGuidelines()
      res.json(guidelinesBody(await readPointerGuidelines(), meta))
    } catch (error) {
      console.error('[clipper3] resetting crop rules failed:', error)
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to reset guidelines' })
    }
  })

  // ============ Series & chapter listing ============

  /** GET /series — every series with at least one downloaded chapter. */
  router.get('/series', async (_req: Request, res: Response) => {
    try {
      await reconcileQuietly()
      const series = await prisma.series.findMany({
        select: {
          id: true,
          title: true,
          sourceSite: true,
          coverPath: true,
          _count: { select: { chapters: { where: { status: 'done' } } } }
        },
        orderBy: { title: 'asc' }
      })
      res.json(
        series
          .filter(s => s._count.chapters > 0)
          .map(s => ({
            id: s.id,
            title: s.title,
            sourceSite: s.sourceSite,
            coverPath: s.coverPath,
            chapterCount: s._count.chapters
          }))
      )
    } catch (error) {
      console.error('[clipper3] listing series failed:', error)
      res.status(500).json({ error: 'Failed to fetch series' })
    }
  })

  /** GET /chapters — every downloaded chapter; downloaded is the only requirement. */
  router.get('/chapters', async (_req: Request, res: Response) => {
    try {
      await reconcileQuietly()
      const chapters = await prisma.chapter.findMany({
        where: { status: 'done' },
        select: {
          id: true,
          number: true,
          title: true,
          seriesId: true,
          pageCount: true,
          series: { select: { title: true } }
        },
        orderBy: [{ series: { title: 'asc' } }, { number: 'asc' }]
      })
      res.json(
        chapters.map(c => ({
          id: c.id,
          number: c.number,
          title: c.title,
          seriesId: c.seriesId,
          seriesTitle: c.series.title,
          pageCount: c.pageCount ?? 0
        }))
      )
    } catch (error) {
      console.error('[clipper3] listing chapters failed:', error)
      res.status(500).json({ error: 'Failed to fetch chapters' })
    }
  })

  /** GET /chapters/:id/image/:filename — one source page, scoped to the chapter folder. */
  router.get('/chapters/:id/image/:filename', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })

      const filename = path.basename(req.params.filename)
      const fullPath = path.resolve(getSourceFolderPath(chapter.folderPath), filename)
      try {
        await fs.access(fullPath)
      } catch {
        return res.status(404).json({ error: 'Image not found' })
      }

      res.setHeader('Content-Type', IMAGE_MIME[path.extname(filename).toLowerCase()] || 'application/octet-stream')
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable')
      res.sendFile(fullPath)
    } catch (error) {
      console.error('[clipper3] serving image failed:', error)
      // Don't cache error responses
      res.setHeader('Cache-Control', 'no-store')
      res.status(500).json({ error: 'Failed to serve image' })
    }
  })

  // ============ Per-image crop artifacts ============

  /**
   * GET /chapters/:id/images
   *
   * The chapter's images with each one's own status. `width`/`height` are the
   * image's real pixel size — the coordinate space its own JSON is normalized
   * against — and deliberately not canvas figures.
   *
   * Metadata already on disk is re-validated on every listing, not just at
   * paste time: a file written before validateMetadata existed, or a crop
   * removed from the points file since, can leave the stored metadata
   * describing ids that no longer match. `hasMetadata` stays true (the file is
   * still there), but `metadataValid` goes false and the image's overall
   * status drops back to pending — the row is expected to show this as
   * needing attention rather than silently staying marked Done.
   */
  router.get('/chapters/:id/images', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })

      const manifest = await getChapterManifest(chapter.folderPath)
      const pointed = await listPointedImageStems(chapter.folderPath)
      const described = await listMetadataImageStems(chapter.folderPath)

      const images = await Promise.all(
        manifest.images.map(async img => {
          const stem = stemOf(img.filename)
          const hasArtifact = pointed.has(stem)
          const hasMetadata = described.has(stem)
          let cropCount = 0
          let parseable = false
          let metadataValid = false
          let metadataErrors: string[] = []

          if (hasArtifact) {
            const stored = await readImagePoints(chapter.folderPath, img.filename)
            const crops = extractCrops(stored?.file ?? null)
            cropCount = crops.length
            // An artifact that exists but does not parse (or carries no usable
            // crop) is not done — it cannot be cut.
            parseable = crops.length > 0

            if (parseable && hasMetadata) {
              const metadataText = await readImageMetadata(chapter.folderPath, img.filename)
              if (metadataText != null) {
                const validation = validateMetadata(
                  metadataText,
                  crops.map(c => c.id),
                  expectedExportedFilenames(seriesSlug(chapter.series.title), img.filename, crops),
                  seriesSlug(chapter.series.title)
                )
                metadataValid = validation.isValid
                metadataErrors = validation.errors
              }
            }
          }

          return {
            filename: img.filename,
            width: img.width,
            height: img.height,
            hasPoints: hasArtifact,
            hasMetadata,
            metadataValid,
            // Empty whenever metadataValid, or when there's no metadata to
            // check yet — populated only for the "looked done but isn't" case
            // this whole check exists to surface.
            metadataErrors,
            cropCount,
            // Both halves required: crops say where to cut, metadata describes
            // the result, and an image is only finished once it has both AND
            // the metadata actually still matches those crops.
            status: parseable && hasMetadata && metadataValid ? 'done' : 'pending'
          }
        })
      )

      res.json({
        chapterId: chapter.id,
        number: chapter.number,
        title: chapter.title,
        seriesId: chapter.seriesId,
        seriesTitle: chapter.series.title,
        images
      })
    } catch (error) {
      console.error('[clipper3] listing images failed:', error)
      res.status(500).json({ error: 'Failed to list chapter images' })
    }
  })

  /**
   * GET /chapters/:id/images/:filename/points
   *
   * `status` is the IMAGE's status, which needs the metadata document too — an
   * image with crops but no metadata (or metadata that no longer validates
   * against these crops) is still pending, so this cannot answer from the
   * crop artifact alone.
   */
  router.get('/chapters/:id/images/:filename/points', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })

      const stored = await readImagePoints(chapter.folderPath, req.params.filename)
      const metadataText = await readImageMetadata(chapter.folderPath, req.params.filename)
      const hasMetadata = metadataText != null

      if (!stored) {
        return res.json({
          filename: req.params.filename,
          content: '',
          file: null,
          cropCount: 0,
          hasMetadata,
          metadataValid: false,
          status: 'pending'
        })
      }

      const crops = extractCrops(stored.file)
      const metadataValid = hasMetadata && crops.length > 0
        && validateMetadata(
          metadataText!,
          crops.map(c => c.id),
          expectedExportedFilenames(seriesSlug(chapter.series.title), req.params.filename, crops),
          seriesSlug(chapter.series.title)
        ).isValid
      res.json({
        filename: req.params.filename,
        content: stored.text,
        file: stored.file,
        cropCount: crops.length,
        hasMetadata,
        metadataValid,
        status: crops.length > 0 && hasMetadata && metadataValid ? 'done' : 'pending'
      })
    } catch (error) {
      console.error('[clipper3] reading image points failed:', error)
      res.status(500).json({ error: 'Failed to read crop points' })
    }
  })

  /**
   * PUT /chapters/:id/images/:filename/points { content }
   *
   * Stores one image's artifact. `content` is the raw text the user pasted, so
   * what they see and what is cut are the same bytes. It must parse and contain
   * at least one four-point crop — an image is only "done" when it has
   * something cuttable — but coordinates are NOT rewritten: they are normalized
   * against this image and stay that way.
   */
  router.put('/chapters/:id/images/:filename/points', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })

      const { content } = req.body
      if (typeof content !== 'string' || content.trim().length === 0) {
        return res.status(400).json({ error: 'content (non-empty string) is required' })
      }

      let parsed: any
      try {
        parsed = JSON.parse(content)
      } catch (err) {
        return res.status(400).json({
          error: `Invalid JSON: ${err instanceof Error ? err.message : 'could not parse'}`
        })
      }

      const manifest = await getChapterManifest(chapter.folderPath)
      const image = manifest.images.find(
        img => path.basename(img.filename) === path.basename(req.params.filename)
      )
      if (!image) {
        return res.status(404).json({ error: `No image named ${req.params.filename} in this chapter` })
      }

      const file: Clipper3ImageCropFile = {
        format: typeof parsed?.format === 'string' ? parsed.format : FORMAT,
        version: typeof parsed?.version === 'string' ? parsed.version : VERSION,
        image: {
          filename: image.filename,
          width: image.width,
          height: image.height
        },
        coordinateSystem:
          typeof parsed?.coordinateSystem === 'string' ? parsed.coordinateSystem : 'normalized',
        crops: Array.isArray(parsed?.crops)
          ? parsed.crops
          : parsed?.crop
            ? [{ id: parsed.id ?? 'c1', reason: parsed.reason ?? '', crop: parsed.crop }]
            : [],
        receivedAt: new Date().toISOString()
      }

      const crops = extractCrops(file)
      if (crops.length === 0) {
        return res.status(400).json({
          error: 'No usable four-point crop found — each crop needs exactly 4 numeric points'
        })
      }
      file.crops = crops

      const jsonPath = await writeImagePoints(chapter.folderPath, image.filename, file)

      // Storing crops does not by itself finish the image — the metadata
      // document is the other half of "done".
      const hasMetadata = (await readImageMetadata(chapter.folderPath, image.filename)) != null

      res.json({
        filename: image.filename,
        content: JSON.stringify(file, null, 2),
        file,
        cropCount: crops.length,
        hasMetadata,
        status: hasMetadata ? 'done' : 'pending',
        jsonPath
      })
    } catch (error) {
      console.error('[clipper3] storing image points failed:', error)
      res.status(500).json({ error: 'Failed to store crop points' })
    }
  })

  /** DELETE /chapters/:id/images/:filename/points — back to pending. */
  router.delete('/chapters/:id/images/:filename/points', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })

      const deleted = await deleteImagePoints(chapter.folderPath, req.params.filename)
      res.json({ deleted })
    } catch (error) {
      console.error('[clipper3] deleting image points failed:', error)
      res.status(500).json({ error: 'Failed to delete crop points' })
    }
  })

  /**
   * GET /chapters/:id/images/:filename/metadata
   *
   * Includes validation against this image's own crop points, so a row that
   * looks attached but was written before validateMetadata existed (or before
   * a crop was removed since) can tell the user exactly why it no longer
   * counts as Done, rather than just reporting `hasMetadata: true`.
   */
  router.get('/chapters/:id/images/:filename/metadata', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })

      const content = await readImageMetadata(chapter.folderPath, req.params.filename)
      const stored = await readImagePoints(chapter.folderPath, req.params.filename)
      const crops = extractCrops(stored?.file ?? null)

      const validation = content != null && crops.length > 0
        ? validateMetadata(
            content,
            crops.map(c => c.id),
            expectedExportedFilenames(seriesSlug(chapter.series.title), req.params.filename, crops),
            seriesSlug(chapter.series.title)
          )
        : { isValid: false, errors: crops.length === 0 ? ['This image has no crop pointers yet.'] : [] }

      res.json({
        filename: req.params.filename,
        content: content ?? '',
        hasMetadata: content != null,
        metadataValid: content != null && validation.isValid,
        metadataErrors: content != null ? validation.errors : []
      })
    } catch (error) {
      console.error('[clipper3] reading image metadata failed:', error)
      res.status(500).json({ error: 'Failed to read metadata' })
    }
  })

  /**
   * PUT /chapters/:id/images/:filename/metadata { content }
   *
   * Unlike before, this is no longer stored verbatim on faith: the document
   * must parse as JSON with a `crops[]` array whose ids match this image's own
   * crop points exactly (see validateMetadata) — that pairing is what
   * removeCropFromMetadata's renumbering, and anything else that keys off
   * crop id, depends on. An image needs its crop JSON attached FIRST, since
   * validation has nothing to check the ids against otherwise.
   */
  router.put('/chapters/:id/images/:filename/metadata', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })

      const { content } = req.body
      if (typeof content !== 'string' || content.trim().length === 0) {
        return res.status(400).json({ error: 'content (non-empty string) is required' })
      }

      const manifest = await getChapterManifest(chapter.folderPath)
      const image = manifest.images.find(
        img => path.basename(img.filename) === path.basename(req.params.filename)
      )
      if (!image) {
        return res.status(404).json({ error: `No image named ${req.params.filename} in this chapter` })
      }

      const storedPoints = await readImagePoints(chapter.folderPath, image.filename)
      const crops = extractCrops(storedPoints?.file ?? null)
      if (crops.length === 0) {
        return res.status(400).json({
          error: 'This image has no crop pointers yet — attach the crop JSON before its metadata.'
        })
      }

      const slug = seriesSlug(chapter.series.title)

      // Every `exportedFilename` is rebuilt from the crop JSON before anything
      // else looks at it. The describing AI is asked to copy these verbatim and
      // does not reliably do so, and a drifted name resolves nowhere — it only
      // shows up in Editor 2.0, long after the paste. The name carries no
      // information the crop JSON does not already hold, so the pasted copy is
      // overwritten rather than trusted or rejected.
      const canonical = canonicalizeExportedFilenames(content, slug, image.filename, crops)
      const stored = canonical ? canonical.text : content
      if (canonical && canonical.corrected.length > 0) {
        console.warn(
          `[clipper3] ${image.filename}: corrected ${canonical.corrected.length} exportedFilename(s) to match the cutter — ` +
            canonical.corrected.map(c => `${c.id}: "${c.was}" -> "${c.now}"`).join('; ')
        )
      }

      const validation = validateMetadata(
        stored,
        crops.map(c => c.id),
        expectedExportedFilenames(slug, image.filename, crops),
        slug
      )
      if (!validation.isValid) {
        return res.status(400).json({ error: validation.errors.join(' ') })
      }

      const metadataPath = await writeImageMetadata(chapter.folderPath, image.filename, stored)

      res.json({
        filename: image.filename,
        // The canonical text, not what was pasted — the client caches this as
        // the document's contents, and handing back the pasted copy would
        // leave the UI showing names that are no longer what is on disk.
        content: stored,
        correctedFilenames: canonical?.corrected ?? [],
        hasMetadata: true,
        // Reaching here means validation above already passed — explicit
        // rather than left for the client to assume, so a row updated from
        // this response can't end up with metadataValid stuck at undefined.
        metadataValid: true,
        metadataErrors: [],
        cropCount: crops.length,
        status: 'done',
        metadataPath
      })
    } catch (error) {
      console.error('[clipper3] storing image metadata failed:', error)
      res.status(500).json({ error: 'Failed to store metadata' })
    }
  })

  /** DELETE /chapters/:id/images/:filename/metadata */
  router.delete('/chapters/:id/images/:filename/metadata', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })

      const deleted = await deleteImageMetadata(chapter.folderPath, req.params.filename)
      res.json({ deleted })
    } catch (error) {
      console.error('[clipper3] deleting image metadata failed:', error)
      res.status(500).json({ error: 'Failed to delete metadata' })
    }
  })

  /**
   * POST /chapters/:id/crop
   *
   * Cuts every image that has its own artifact — that is exactly the set the UI
   * shows as Done, because both answer the same question of the filesystem.
   * Runs in the background; progress arrives over `clipper3:crop-*`.
   */
  router.post('/chapters/:id/crop', async (req: Request, res: Response) => {
    try {
      const chapterId = req.params.id
      const chapter = await findChapter(chapterId)
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })
      if (cropping.has(chapterId)) {
        return res.status(409).json({ error: 'This chapter is already being cropped' })
      }

      const manifest = await getChapterManifest(chapter.folderPath)
      const pointed = await listPointedImageStems(chapter.folderPath)
      const described = await listMetadataImageStems(chapter.folderPath)

      // Resolved before responding: "nothing is ready to cut" is an answer to
      // this request, not an event to wait for. Only images that are actually
      // done — crops AND metadata — are cut, matching what the list shows.
      const targets: { filename: string; crops: Clipper3CropEntry[] }[] = []
      for (const img of manifest.images) {
        const stem = stemOf(img.filename)
        if (!pointed.has(stem) || !described.has(stem)) continue
        const stored = await readImagePoints(chapter.folderPath, img.filename)
        const crops = extractCrops(stored?.file ?? null)
        if (crops.length === 0) continue

        // Matches the Done definition the list uses: metadata that no longer
        // validates against these crops must not be cut as if it still did.
        const metadataText = await readImageMetadata(chapter.folderPath, img.filename)
        if (
          metadataText == null ||
          !validateMetadata(
            metadataText,
            crops.map(c => c.id),
            expectedExportedFilenames(seriesSlug(chapter.series.title), img.filename, crops),
            seriesSlug(chapter.series.title)
          ).isValid
        ) continue

        targets.push({ filename: img.filename, crops })
      }

      if (targets.length === 0) {
        return res.status(400).json({
          error: 'No image is ready to cut — each needs its crop JSON and metadata that still matches it'
        })
      }

      cropping.add(chapterId)
      const slug = seriesSlug(chapter.series.title)

      void (async () => {
        const allFiles = []
        let failed = 0
        const warnings: string[] = []

        try {
          for (let i = 0; i < targets.length; i++) {
            const target = targets[i]
            io.emit('clipper3:crop-progress', {
              chapterId,
              current: i + 1,
              total: targets.length,
              filename: target.filename
            })

            try {
              const result = await cutImageCrops({
                folderPath: chapter.folderPath,
                imageFilename: target.filename,
                crops: target.crops,
                slug
              })
              allFiles.push(...result.files)
              failed += result.failed
              warnings.push(...result.warnings)
            } catch (err) {
              // One unreadable image must not abandon the rest of the chapter.
              failed += target.crops.length
              const message = err instanceof Error ? err.message : String(err)
              warnings.push(`${target.filename}: ${message}`)
              console.error(`[clipper3] cutting ${target.filename} failed:`, message)
            }
          }

          // The whole chapter has now been cut, so crops3/ is complete and a
          // metadata name with no file behind it can only be a real mismatch.
          // Checked here rather than in the image listing because only a
          // finished run can tell a bad name from a page not cut yet.
          const unresolved = await findUnresolvedMetadataNames(chapter.folderPath)
          if (unresolved.length > 0) {
            console.warn(
              `[clipper3] ${chapter.folderPath}: ${unresolved.length} page(s) name crops that are not in crops3/ — ` +
                unresolved.map(u => `${u.imageFilename} (${u.missing.length}/${u.total})`).join(', ')
            )
          }

          io.emit('clipper3:crop-complete', {
            chapterId,
            images: targets.length,
            exported: allFiles.length,
            failed,
            warnings,
            unresolved,
            exportDir: path.resolve(getOutputDir(chapter.folderPath))
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          console.error('[clipper3] crop job crashed:', message)
          io.emit('clipper3:crop-complete', { chapterId, error: message })
        } finally {
          cropping.delete(chapterId)
        }
      })()

      res.json({ started: true, images: targets.length })
    } catch (error) {
      console.error('[clipper3] starting crop failed:', error)
      res.status(500).json({ error: 'Failed to start cropping' })
    }
  })

  /**
   * GET /series/:seriesId/summary
   *
   * One row per chapter in the series, for the chapter-list chips: whether
   * every image already has BOTH its crop JSON and its metadata ("fully
   * attached"), and whether the chapter has cut output on disk ("chopped").
   * Chopped is read from crops3/ directly rather than inferred from the
   * attached count, because a chapter can be re-detected or re-pasted after
   * cropping — outputs existing is the only fact that answers "was this cut".
   */
  router.get('/series/:seriesId/summary', async (req: Request, res: Response) => {
    try {
      const chapters = await prisma.chapter.findMany({
        where: { seriesId: req.params.seriesId },
        // `series.title` is needed to rebuild the exported filenames the
        // metadata check compares against, so this summary keeps using the
        // same Done definition as GET /chapters/:id/images.
        select: { id: true, folderPath: true, series: { select: { title: true } } }
      })

      const summaries = await Promise.all(
        chapters.map(async chapter => {
          // A chapter not yet downloaded (or whose folder is otherwise
          // unreadable) has no manifest to build — it is simply not ready for
          // pointer detection yet, same as it is left out of GET /chapters,
          // so it is omitted here rather than failing the
          // whole series summary.
          let manifest
          try {
            manifest = await getChapterManifest(chapter.folderPath)
          } catch {
            return null
          }

          const pointed = await listPointedImageStems(chapter.folderPath)
          const described = await listMetadataImageStems(chapter.folderPath)
          const outputs = await listOutputs(chapter.folderPath)

          const totalImages = manifest.images.length
          let attachedImages = 0
          for (const img of manifest.images) {
            const stem = stemOf(img.filename)
            if (!pointed.has(stem) || !described.has(stem)) continue
            // Matches /images' `parseable` + `metadataValid` checks: an
            // artifact with no usable crop, or metadata that no longer
            // validates against those crops, does not count as attached.
            const stored = await readImagePoints(chapter.folderPath, img.filename)
            const crops = extractCrops(stored?.file ?? null)
            if (crops.length === 0) continue
            const metadataText = await readImageMetadata(chapter.folderPath, img.filename)
            if (
              metadataText != null &&
              validateMetadata(
                metadataText,
                crops.map(c => c.id),
                expectedExportedFilenames(seriesSlug(chapter.series.title), img.filename, crops),
                seriesSlug(chapter.series.title)
              ).isValid
            ) {
              attachedImages++
            }
          }

          return {
            chapterId: chapter.id,
            totalImages,
            attachedImages,
            fullyAttached: totalImages > 0 && attachedImages === totalImages,
            chopped: outputs.length > 0
          }
        })
      )

      res.json({ chapters: summaries.filter((s): s is NonNullable<typeof s> => s !== null) })
    } catch (error) {
      console.error('[clipper3] listing series summary failed:', error)
      res.status(500).json({ error: 'Failed to load series summary' })
    }
  })

  /** GET /chapters/:id/outputs */
  router.get('/chapters/:id/outputs', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })

      const files = await listOutputs(chapter.folderPath)
      res.json({
        exportDir: files.length > 0 ? path.resolve(getOutputDir(chapter.folderPath)) : null,
        files: files.map(f => ({
          ...f,
          url: `/api/clipper3/chapters/${chapter.id}/output/${encodeURIComponent(f.filename)}`
        }))
      })
    } catch (error) {
      console.error('[clipper3] listing outputs failed:', error)
      res.status(500).json({ error: 'Failed to list outputs' })
    }
  })

  /** GET /chapters/:id/output/:filename */
  router.get('/chapters/:id/output/:filename', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })

      // basename only: the filename comes from the client.
      const filename = path.basename(req.params.filename)
      const target = path.join(getOutputDir(chapter.folderPath), filename)

      try {
        await fs.access(target)
      } catch {
        return res.status(404).json({ error: 'Output not found' })
      }

      res.sendFile(path.resolve(target))
    } catch (error) {
      console.error('[clipper3] serving output failed:', error)
      res.status(500).json({ error: 'Failed to serve output' })
    }
  })

  /**
   * POST /chapters/:id/images/:filename/slices
   *
   * Cuts one page into vertical parts on disk and reports the folder. The
   * browser cannot put many images on the clipboard at once, so the slices are
   * written somewhere the user can select them all in the file explorer.
   */
  router.post('/chapters/:id/images/:filename/slices', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })

      const result = await sliceImage({
        folderPath: chapter.folderPath,
        imageFilename: req.params.filename
      })

      res.json(result)
    } catch (error) {
      console.error('[clipper3] slicing failed:', error)
      const message = error instanceof Error ? error.message : 'Failed to slice the image'
      res.status(500).json({ error: message })
    }
  })

  /**
   * POST /series/:seriesId/slices
   *
   * Slices every page of the chapters named in `chapterIds`, or of every
   * chapter in the series when that list is omitted. Even a few chapters run
   * to dozens of pages, so this works in the background and reports progress
   * over `clipper3:slice-*` rather than holding the request open.
   *
   * One unreadable page never abandons the rest: failures are counted and
   * reported at the end alongside whatever did get written.
   */
  router.post('/series/:seriesId/slices', async (req: Request, res: Response) => {
    try {
      const seriesId = req.params.seriesId
      if (slicingSeries.has(seriesId)) {
        return res.status(409).json({ error: 'This series is already being sliced' })
      }

      // Absent means the whole series, so the endpoint keeps working for a
      // caller that does not select anything. An explicit empty list is a
      // different thing — a selection of nothing — and is refused below.
      const requested: unknown = req.body?.chapterIds
      if (requested !== undefined && !Array.isArray(requested)) {
        return res.status(400).json({ error: 'chapterIds must be an array of chapter ids' })
      }
      const wanted = Array.isArray(requested)
        ? new Set(requested.filter((v): v is string => typeof v === 'string'))
        : null
      if (wanted && wanted.size === 0) {
        return res.status(400).json({ error: 'Select at least one chapter to slice' })
      }

      const chapters = await prisma.chapter.findMany({
        // Scoped to this series as well as the id list, so an id belonging to
        // another series can never be sliced through this route.
        where: wanted ? { seriesId, id: { in: [...wanted] } } : { seriesId },
        select: { id: true, number: true, folderPath: true },
        orderBy: { number: 'asc' }
      })
      if (chapters.length === 0) {
        return res.status(404).json({
          error: wanted
            ? 'None of the selected chapters belong to this series'
            : 'No chapters found for this series'
        })
      }

      // Resolved before responding: "nothing to slice" is an answer to this
      // request, not an event to wait for. A chapter with no readable manifest
      // is simply not downloaded yet, and is skipped rather than failing.
      const targets: { chapterId: string; folderPath: string; filename: string }[] = []
      for (const chapter of chapters) {
        let manifest
        try {
          manifest = await getChapterManifest(chapter.folderPath)
        } catch {
          continue
        }
        for (const img of manifest.images) {
          targets.push({
            chapterId: chapter.id,
            folderPath: chapter.folderPath,
            filename: img.filename
          })
        }
      }

      if (targets.length === 0) {
        return res.status(400).json({ error: 'No downloaded pages found to slice' })
      }

      slicingSeries.add(seriesId)

      void (async () => {
        let sliced = 0
        let failed = 0
        let parts = 0
        const warnings: string[] = []

        try {
          for (let i = 0; i < targets.length; i++) {
            const target = targets[i]
            io.emit('clipper3:slice-progress', {
              seriesId,
              current: i + 1,
              total: targets.length,
              filename: target.filename
            })

            try {
              const result = await sliceImage({
                folderPath: target.folderPath,
                imageFilename: target.filename
              })
              sliced++
              parts += result.files.length
            } catch (err) {
              failed++
              const message = err instanceof Error ? err.message : String(err)
              warnings.push(`${target.filename}: ${message}`)
              console.error(`[clipper3] slicing ${target.filename} failed:`, message)
            }
          }

          io.emit('clipper3:slice-complete', {
            seriesId,
            chapters: chapters.length,
            images: targets.length,
            sliced,
            parts,
            failed,
            warnings
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          console.error('[clipper3] slice job crashed:', message)
          io.emit('clipper3:slice-complete', { seriesId, error: message })
        } finally {
          slicingSeries.delete(seriesId)
        }
      })()

      res.json({ started: true, chapters: chapters.length, images: targets.length })
    } catch (error) {
      console.error('[clipper3] starting series slice failed:', error)
      res.status(500).json({ error: 'Failed to start slicing' })
    }
  })

  /** GET /chapters/:id/images/:filename/slices/:sliceName — one slice file. */
  router.get(
    '/chapters/:id/images/:filename/slices/:sliceName',
    async (req: Request, res: Response) => {
      try {
        const chapter = await findChapter(req.params.id)
        if (!chapter) return res.status(404).json({ error: 'Chapter not found' })

        // basename only: both names come from the client.
        const dir = getSliceDir(chapter.folderPath, req.params.filename)
        const target = path.join(dir, path.basename(req.params.sliceName))

        try {
          await fs.access(target)
        } catch {
          return res.status(404).json({ error: 'Slice not found' })
        }

        res.sendFile(path.resolve(target))
      } catch (error) {
        console.error('[clipper3] serving slice failed:', error)
        res.status(500).json({ error: 'Failed to serve the slice' })
      }
    }
  )

  /** POST /chapters/:id/images/:filename/slices/open — reveal the slice folder. */
  router.post('/chapters/:id/images/:filename/slices/open', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })

      const dir = getSliceDir(chapter.folderPath, req.params.filename)
      try {
        await fs.access(dir)
      } catch {
        return res.status(404).json({ error: 'This image has not been sliced yet' })
      }

      const resolved = path.resolve(dir)
      const command =
        process.platform === 'darwin' ? `open "${resolved}"`
          : process.platform === 'win32' ? `explorer "${resolved}"`
            : `xdg-open "${resolved}"`
      exec(command, err => { if (err) console.error('[clipper3] open slice folder failed:', err) })

      res.json({ success: true, path: resolved })
    } catch (error) {
      console.error('[clipper3] opening slice folder failed:', error)
      res.status(500).json({ error: 'Failed to open the folder' })
    }
  })


  /**
   * GET /chapters/:id/images/:filename/source
   *
   * The original page's identity: SHA-256, true pixel size, format, frames,
   * EXIF orientation, plus any issue that blocks it from being packaged.
   * Reads and fully decodes the file, so it answers "is this page usable?"
   * rather than trusting the header alone.
   */
  router.get('/chapters/:id/images/:filename/source', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })

      const sourcePath = path.join(getSourceFolderPath(chapter.folderPath), path.basename(req.params.filename))
      res.json(await inspectOriginal(sourcePath))
    } catch (error) {
      console.error('[clipper3] inspecting source failed:', error)
      res.status(500).json({ error: 'Failed to inspect the page' })
    }
  })

  /**
   * GET /chapters/:id/images/:filename/handoff
   *
   * The stored ChatGPT package for this page, and whether it still describes
   * the files on disk (`none` | `ready` | `stale`). File hashes only — cheap
   * enough to call whenever the page opens.
   */
  router.get('/chapters/:id/images/:filename/handoff', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })

      res.json(await getHandoffStatus(chapter.folderPath, req.params.filename))
    } catch (error) {
      console.error('[clipper3] reading handoff failed:', error)
      res.status(500).json({ error: 'Failed to read the ChatGPT package' })
    }
  })

  /**
   * POST /chapters/:id/images/:filename/handoff
   *
   * Slices the page, verifies every slice pixel-for-pixel against the
   * fingerprinted original, and writes the manifest + prompt. A blocked page
   * or a failed verification answers 422 with every issue and writes nothing.
   */
  router.post('/chapters/:id/images/:filename/handoff', async (req: Request, res: Response) => {
    const key = `${req.params.id}/${path.basename(req.params.filename)}`
    if (isPageInAutoRun(req.params.id, req.params.filename)) {
      return res.status(409).json({ error: 'The ChatGPT API run is working on this page right now' })
    }
    if (buildingHandoffs.has(key)) {
      return res.status(409).json({ error: 'This page\'s ChatGPT package is already being built' })
    }
    buildingHandoffs.add(key)
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })

      const result = await buildHandoff({
        folderPath: chapter.folderPath,
        imageFilename: req.params.filename,
        seriesTitle: chapter.series.title,
        seriesSlug: seriesSlug(chapter.series.title),
        chapterNumber: chapter.number
      })
      res.json({ status: 'ready', ...result })
    } catch (error) {
      if (error instanceof HandoffError) {
        return res.status(422).json({ error: error.message, issues: error.issues, inspection: error.inspection ?? null })
      }
      console.error('[clipper3] building handoff failed:', error)
      const message = error instanceof Error ? error.message : 'Failed to build the ChatGPT package'
      res.status(500).json({ error: message })
    } finally {
      buildingHandoffs.delete(key)
    }
  })


  /**
   * GET /chapters/:id/images/:filename/analysis
   *
   * The page's last accepted ChatGPT reply, converted to candidates in page
   * pixels, and whether it still applies (`stale` once the original changes).
   */
  router.get('/chapters/:id/images/:filename/analysis', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })

      res.json(await getAnalysisStatus(chapter.folderPath, req.params.filename))
    } catch (error) {
      console.error('[clipper3] reading analysis failed:', error)
      res.status(500).json({ error: 'Failed to read the imported reply' })
    }
  })

  /**
   * POST /chapters/:id/images/:filename/analysis   body: { content }
   *
   * Validates a pasted `chatgpt-analysis/1.0` reply against the page's current
   * package. 422 with field-level `errors` when it is rejected — nothing is
   * written then, so the previous import survives. On success the reply text
   * is kept verbatim as provenance next to the converted candidates.
   */
  router.post('/chapters/:id/images/:filename/analysis', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })

      const content: unknown = req.body?.content
      if (typeof content !== 'string' || !content.trim()) {
        return res.status(400).json({ error: 'Paste the ChatGPT reply as `content`' })
      }

      const outcome = await importAnalysis(chapter.folderPath, req.params.filename, content)
      if (!outcome.imported) {
        const count = outcome.errors.length
        return res.status(422).json({
          error: `The reply was rejected: ${count} problem${count === 1 ? '' : 's'} — ${outcome.errors[0]?.message ?? 'see errors'}`,
          ...outcome
        })
      }
      res.json(outcome)
    } catch (error) {
      console.error('[clipper3] importing analysis failed:', error)
      const message = error instanceof Error ? error.message : 'Failed to import the reply'
      res.status(500).json({ error: message })
    }
  })


  /** ReviewError carries its own status; anything else is a 500. */
  function sendReviewError(res: Response, error: unknown, action: string) {
    if (error instanceof ReviewError) {
      return res.status(error.status).json({ error: error.message, details: error.details, current: error.current ?? null })
    }
    console.error(`[clipper3] ${action} failed:`, error)
    res.status(500).json({ error: error instanceof Error ? error.message : `Failed to ${action}` })
  }

  /**
   * GET /chapters/:id/images/:filename/review
   *
   * The page's review with everything derived from it: audit findings and
   * uncovered stretches, the items each crop still needs looked at, and the
   * export blockers. `state: null` when no review has been started.
   */
  router.get('/chapters/:id/images/:filename/review', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })
      res.json(await getReview(chapter.folderPath, req.params.filename))
    } catch (error) {
      sendReviewError(res, error, 'read the review')
    }
  })

  /**
   * POST /chapters/:id/images/:filename/review   body: { from: 'import' | 'pointers', replace? }
   *
   * Seeds a review from the latest ChatGPT import or from the page's existing
   * Clipper 3.0 pointers. 409 when one exists and `replace` is not set.
   */
  router.post('/chapters/:id/images/:filename/review', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })
      const from = req.body?.from
      if (from !== 'import' && from !== 'pointers') {
        return res.status(400).json({ error: 'from must be "import" or "pointers"' })
      }
      res.json(await startReview(chapter.folderPath, req.params.filename, from, req.body?.replace === true))
    } catch (error) {
      sendReviewError(res, error, 'start the review')
    }
  })

  /**
   * PUT /chapters/:id/images/:filename/review   body: { state, expectedRevision }
   *
   * Saves an edit. 409 (with the current review) when the revision moved on
   * since the client loaded it; 400 with every problem when the edit is invalid.
   */
  router.put('/chapters/:id/images/:filename/review', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })
      res.json(await saveReview(chapter.folderPath, req.params.filename, req.body?.state, req.body?.expectedRevision))
    } catch (error) {
      sendReviewError(res, error, 'save the review')
    }
  })


  /**
   * GET /chapters/:id/images/:filename/review/chatgpt-prompt
   *
   * A prompt that has ChatGPT (in the chat holding this page's slices) do the
   * review round: every crop, its open checks and the uncovered stretches.
   */
  router.get('/chapters/:id/images/:filename/review/chatgpt-prompt', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })
      res.json(await getReviewPrompt(chapter.folderPath, req.params.filename))
    } catch (error) {
      sendReviewError(res, error, 'build the review prompt')
    }
  })

  /**
   * POST /chapters/:id/images/:filename/review/chatgpt   body: { content }
   *
   * Applies ChatGPT's `chatgpt-review/1.0` reply as one review save. 422 with
   * field-level `errors` when it is refused; nothing is written then.
   */
  router.post('/chapters/:id/images/:filename/review/chatgpt', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })
      const content: unknown = req.body?.content
      if (typeof content !== 'string' || !content.trim()) {
        return res.status(400).json({ error: 'Paste the ChatGPT review reply as `content`' })
      }
      const outcome = await applyChatGptReview(chapter.folderPath, req.params.filename, content)
      if (!outcome.applied) {
        return res.status(422).json({ error: `The review reply was rejected: ${outcome.errors[0]?.message ?? 'see errors'}`, ...outcome })
      }
      res.json(outcome)
    } catch (error) {
      sendReviewError(res, error, 'apply the ChatGPT review')
    }
  })

  /** GET /chapters/:id/images/:filename/export — the last export and whether it still matches the review. */
  router.get('/chapters/:id/images/:filename/export', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })
      res.json(await getExportStatus(chapter.folderPath, req.params.filename))
    } catch (error) {
      console.error('[clipper3] reading export status failed:', error)
      res.status(500).json({ error: 'Failed to read the export status' })
    }
  })

  /**
   * POST /chapters/:id/images/:filename/export
   *
   * Exports a finished review: PNGs cut from the original into
   * `<Series>/Crops/<Chapter>/page_###/`, the pointer and metadata JSON into
   * `<Series>/Processed/<Chapter>/page_###/`, and the page's Clipper 3.0 store
   * entry. 422 with the review's blockers when it is not finished.
   */
  router.post('/chapters/:id/images/:filename/export', async (req: Request, res: Response) => {
    const key = `${req.params.id}/${path.basename(req.params.filename)}`
    if (exportingPages.has(key)) return res.status(409).json({ error: 'This page is already being exported' })
    if (isPageInAutoRun(req.params.id, req.params.filename)) {
      return res.status(409).json({ error: 'The ChatGPT API run is working on this page right now' })
    }
    exportingPages.add(key)
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })
      const report = await exportPage({
        folderPath: chapter.folderPath,
        imageFilename: req.params.filename,
        seriesSlug: seriesSlug(chapter.series.title),
        chapterNumber: chapter.number
      })
      res.json(report)
    } catch (error) {
      if (error instanceof ExportError) {
        return res.status(error.status).json({ error: error.message, details: error.details, blockers: error.blockers })
      }
      console.error('[clipper3] export failed:', error)
      res.status(500).json({ error: error instanceof Error ? error.message : 'Export failed' })
    } finally {
      exportingPages.delete(key)
    }
  })

  /** POST /chapters/:id/images/:filename/export/open — reveal the exported crops folder. */
  router.post('/chapters/:id/images/:filename/export/open', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })
      const { report } = await getExportStatus(chapter.folderPath, req.params.filename)
      if (!report) return res.status(404).json({ error: 'This page has not been exported yet' })

      // The report stores the folder relative to the series folder.
      const seriesDir = path.dirname(getSourceFolderPath(chapter.folderPath))
      const resolved = path.resolve(seriesDir, report.destinations.crops)
      if (!resolved.startsWith(path.resolve(seriesDir) + path.sep)) {
        return res.status(400).json({ error: 'The export report points outside the series folder' })
      }
      const command =
        process.platform === 'darwin' ? `open "${resolved}"`
          : process.platform === 'win32' ? `explorer "${resolved}"`
            : `xdg-open "${resolved}"`
      exec(command, err => { if (err) console.error('[clipper3] open export folder failed:', err) })
      res.json({ success: true, path: resolved })
    } catch (error) {
      console.error('[clipper3] opening export folder failed:', error)
      res.status(500).json({ error: 'Failed to open the folder' })
    }
  })


  /** GET /openai — the ChatGPT-API settings, with only a hint of the key. */
  router.get('/openai', (_req: Request, res: Response) => {
    res.json(publicOpenAiConfig())
  })

  /**
   * PUT /openai   body: { apiKey?, clearKey?, model?, baseUrl?, reasoningEffort?, reviewRounds?, includeRules?, concurrency? }
   *
   * Stored in the server's .env (like the Gemini key) and applied at once.
   */
  router.put('/openai', async (req: Request, res: Response) => {
    try {
      const body = req.body ?? {}
      await updateOpenAiConfig({
        apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
        clearKey: body.clearKey === true,
        model: typeof body.model === 'string' ? body.model : undefined,
        baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : undefined,
        reasoningEffort: typeof body.reasoningEffort === 'string' ? body.reasoningEffort : undefined,
        reviewRounds: typeof body.reviewRounds === 'number' ? body.reviewRounds : undefined,
        includeRules: typeof body.includeRules === 'boolean' ? body.includeRules : undefined,
        concurrency: typeof body.concurrency === 'number' ? body.concurrency : undefined
      })
      res.json(publicOpenAiConfig())
    } catch (error) {
      console.error('[clipper3] saving OpenAI settings failed:', error)
      res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to save the settings' })
    }
  })

  /** POST /openai/test — is the key accepted, and can it use the configured model? */
  router.post('/openai/test', async (_req: Request, res: Response) => {
    res.json(await testOpenAiConnection())
  })

  /** GET /chapters/:id/auto — the chapter's current or last ChatGPT-API run (`null` if none). */
  router.get('/chapters/:id/auto', (req: Request, res: Response) => {
    res.json({ job: getAutoJob(req.params.id) })
  })

  /**
   * POST /chapters/:id/auto   body: { filenames: string[], export?: boolean }
   *
   * Runs the hybrid ChatGPT loop for each page through the OpenAI API, in the
   * background: package → analysis → import → review rounds → export. Poll
   * GET /chapters/:id/auto for progress.
   */
  router.post('/chapters/:id/auto', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })

      const requested: unknown = req.body?.filenames
      if (!Array.isArray(requested) || requested.some(f => typeof f !== 'string')) {
        return res.status(400).json({ error: 'filenames must be a list of page file names' })
      }
      const manifest = await getChapterManifest(chapter.folderPath)
      const known = new Set(manifest.images.map(img => img.filename))
      const filenames = [...new Set((requested as string[]).map(f => path.basename(f)))]
      const unknown = filenames.filter(f => !known.has(f))
      if (unknown.length > 0) {
        return res.status(400).json({ error: `Not pages of this chapter: ${unknown.slice(0, 3).join(', ')}` })
      }

      const job = await startAutoJob(
        chapter.id,
        {
          folderPath: chapter.folderPath,
          seriesTitle: chapter.series.title,
          seriesSlug: seriesSlug(chapter.series.title),
          chapterNumber: chapter.number
        },
        filenames,
        { export: req.body?.export !== false }
      )
      res.json({ job })
    } catch (error) {
      if (error instanceof AutoJobError) return res.status(error.status).json({ error: error.message })
      console.error('[clipper3] starting the API run failed:', error)
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to start the run' })
    }
  })

  /** POST /chapters/:id/auto/cancel — stop the run; pages mid-request end as cancelled. */
  router.post('/chapters/:id/auto/cancel', (req: Request, res: Response) => {
    res.json({ cancelled: cancelAutoJob(req.params.id), job: getAutoJob(req.params.id) })
  })


  /**
   * POST /series/:seriesId/fetch-phone-crops
   *
   * Sync json's first step: downloads the chapter zips the Sleeper-Cell phone
   * uploaded to R2 (`crops/<Series>/<Chapter>.zip`, one per finished chapter)
   * and unpacks them into `<Series>/Processed/<Chapter>/`, where the scan below
   * finds them. Only new or re-uploaded zips are downloaded; nothing is
   * attached here. Answers `configured: false` without touching R2 when it is
   * not set up, so Sync json still works on local drop-offs alone.
   */
  router.post('/series/:seriesId/fetch-phone-crops', async (req: Request, res: Response) => {
    try {
      const seriesId = req.params.seriesId
      if (syncingSeries.has(seriesId)) {
        return res.status(409).json({ error: 'This series is already being synced' })
      }
      if (unsyncingSeries.has(seriesId)) {
        return res.status(409).json({ error: 'This series is being unsynced right now' })
      }
      const requested: unknown = req.body?.chapterIds
      if (requested !== undefined && !Array.isArray(requested)) {
        return res.status(400).json({ error: 'chapterIds must be an array of chapter ids' })
      }
      const chapterIds = Array.isArray(requested)
        ? requested.filter((v): v is string => typeof v === 'string')
        : undefined
      res.json(await fetchPhoneCrops(seriesId, chapterIds))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[clipper3] fetching phone crops failed:', message)
      res.status(500).json({ error: message })
    }
  })


  /**
   * POST /series/:seriesId/sync-processed
   *
   * Walks every chapter of the series looking for a `Processed/` folder, and
   * attaches each page folder's two JSON files to the page they name — the
   * crop pointers and the metadata document that describes them. A page whose
   * files both validate flips to Done exactly as if they had been pasted in
   * the workspace; every other page is left untouched and reported.
   *
   * Runs in the background and reports over `clipper3:sync-*`: a series runs
   * to hundreds of pages, each of which is two file reads plus validation, and
   * holding the request open for that would simply time out.
   *
   * `chapterIds` narrows it to a selection; omitting it syncs the whole series
   * (see the slices route for why absent and empty mean different things).
   *
   * The preview route below answers the same question without writing, so the
   * confirmation dialog can list what is about to be attached.
   */
  router.post('/series/:seriesId/sync-processed', async (req: Request, res: Response) => {
    try {
      const seriesId = req.params.seriesId
      if (syncingSeries.has(seriesId)) {
        return res.status(409).json({ error: 'This series is already being synced' })
      }
      if (unsyncingSeries.has(seriesId)) {
        return res.status(409).json({ error: 'This series is being unsynced right now' })
      }

      const requested: unknown = req.body?.chapterIds
      if (requested !== undefined && !Array.isArray(requested)) {
        return res.status(400).json({ error: 'chapterIds must be an array of chapter ids' })
      }
      const wanted = Array.isArray(requested)
        ? new Set(requested.filter((v): v is string => typeof v === 'string'))
        : null
      if (wanted && wanted.size === 0) {
        return res.status(400).json({ error: 'Select at least one chapter to sync' })
      }

      const chapters = await prisma.chapter.findMany({
        // Scoped to this series as well as the id list, so an id belonging to
        // another series can never be written through this route.
        where: wanted ? { seriesId, id: { in: [...wanted] } } : { seriesId },
        select: {
          id: true,
          number: true,
          folderPath: true,
          series: { select: { title: true } }
        },
        orderBy: { number: 'asc' }
      })
      if (chapters.length === 0) {
        return res.status(404).json({
          error: wanted
            ? 'None of the selected chapters belong to this series'
            : 'No chapters found for this series'
        })
      }

      syncingSeries.add(seriesId)

      void (async () => {
        const results: ChapterSyncResult[] = []
        let imported = 0
        let skipped = 0
        let failed = 0

        try {
          for (let i = 0; i < chapters.length; i++) {
            const chapter = chapters[i]
            io.emit('clipper3:sync-progress', {
              seriesId,
              current: i + 1,
              total: chapters.length,
              chapterNumber: chapter.number
            })

            // A chapter with no readable manifest simply isn't downloaded
            // yet — there is no page for a Processed folder to attach to, so
            // it is passed over rather than counted as a failure.
            let manifest
            try {
              manifest = await getChapterManifest(chapter.folderPath)
            } catch {
              continue
            }

            try {
              const result = await syncChapterProcessed({
                chapterId: chapter.id,
                chapterNumber: chapter.number,
                folderPath: chapter.folderPath,
                seriesSlug: seriesSlug(chapter.series.title),
                images: manifest.images.map(img => ({
                  filename: img.filename,
                  width: img.width,
                  height: img.height
                }))
              })

              imported += result.imported
              skipped += result.skipped
              failed += result.failed
              // Only chapters that actually had something in Processed/ are
              // reported: a series is mostly chapters nobody has produced
              // files for yet, and listing every one of them buries the few
              // that matter.
              if (result.pages.length > 0) results.push(result)
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err)
              console.error(`[clipper3] syncing chapter ${chapter.number} failed:`, message)
              failed++
              results.push({
                chapterId: chapter.id,
                chapterNumber: chapter.number,
                imported: 0,
                ready: 0,
                skipped: 0,
                failed: 1,
                pages: [{
                  folder: '—',
                  filename: null,
                  status: 'failed',
                  reason: message,
                  cropCount: 0
                }]
              })
            }
          }

          io.emit('clipper3:sync-complete', {
            seriesId,
            chapters: chapters.length,
            imported,
            skipped,
            failed,
            results
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          console.error('[clipper3] sync job crashed:', message)
          io.emit('clipper3:sync-complete', { seriesId, error: message })
        } finally {
          syncingSeries.delete(seriesId)
        }
      })()

      res.json({ started: true, chapters: chapters.length })
    } catch (error) {
      console.error('[clipper3] starting sync failed:', error)
      res.status(500).json({ error: 'Failed to start syncing' })
    }
  })


  /**
   * POST /series/:seriesId/sync-processed/preview
   *
   * What a sync WOULD attach, so the user can see the pages before agreeing to
   * them. Runs the identical pass with `dryRun`, which stops at the write and
   * nowhere earlier — a preview that checked less would list pages the import
   * then rejects.
   *
   * Answers in one request rather than over the socket: this only reads files
   * the sync would read anyway, and a confirmation dialog that has to wait for
   * a background job to report is just the job with extra steps.
   */
  router.post('/series/:seriesId/sync-processed/preview', async (req: Request, res: Response) => {
    try {
      const seriesId = req.params.seriesId

      const requested: unknown = req.body?.chapterIds
      if (requested !== undefined && !Array.isArray(requested)) {
        return res.status(400).json({ error: 'chapterIds must be an array of chapter ids' })
      }
      const wanted = Array.isArray(requested)
        ? new Set(requested.filter((v): v is string => typeof v === 'string'))
        : null
      if (wanted && wanted.size === 0) {
        return res.status(400).json({ error: 'Select at least one chapter to sync' })
      }

      const chapters = await prisma.chapter.findMany({
        where: wanted ? { seriesId, id: { in: [...wanted] } } : { seriesId },
        select: {
          id: true,
          number: true,
          folderPath: true,
          series: { select: { title: true } }
        },
        orderBy: { number: 'asc' }
      })
      if (chapters.length === 0) {
        return res.status(404).json({
          error: wanted
            ? 'None of the selected chapters belong to this series'
            : 'No chapters found for this series'
        })
      }

      const results: ChapterSyncResult[] = []
      let ready = 0
      let skipped = 0
      let failed = 0

      for (const chapter of chapters) {
        let manifest
        try {
          manifest = await getChapterManifest(chapter.folderPath)
        } catch {
          continue
        }

        try {
          const result = await syncChapterProcessed({
            chapterId: chapter.id,
            chapterNumber: chapter.number,
            folderPath: chapter.folderPath,
            seriesSlug: seriesSlug(chapter.series.title),
            images: manifest.images.map(img => ({
              filename: img.filename,
              width: img.width,
              height: img.height
            })),
            dryRun: true
          })

          ready += result.ready
          skipped += result.skipped
          failed += result.failed
          if (result.pages.length > 0) results.push(result)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          console.error(`[clipper3] previewing chapter ${chapter.number} failed:`, message)
          failed++
          results.push({
            chapterId: chapter.id,
            chapterNumber: chapter.number,
            imported: 0,
            ready: 0,
            skipped: 0,
            failed: 1,
            pages: [{
              folder: '—',
              filename: null,
              status: 'failed',
              reason: message,
              cropCount: 0
            }]
          })
        }
      }

      res.json({ chapters: chapters.length, ready, skipped, failed, results })
    } catch (error) {
      console.error('[clipper3] previewing sync failed:', error)
      res.status(500).json({ error: 'Failed to preview the sync' })
    }
  })


  /**
   * POST /series/:seriesId/unsync-processed
   *
   * The inverse of Sync json: removes the attached crop pointers and metadata
   * from the selected chapters' store, so every page that had them goes back
   * to pending.
   *
   * ONLY the store is touched. The hand-made files under `Processed/` stay
   * exactly where they are, which makes this reversible by running Sync json
   * again — the reason it can sit next to sync as an ordinary button rather
   * than a destructive one.
   *
   * `chapterIds` is REQUIRED here, unlike on sync. Syncing the whole series by
   * default costs nothing on chapters with no drop-off; unsyncing it by
   * default would clear every attached page in the series, hand-pasted ones
   * included, from a request that simply forgot the field.
   *
   * Runs in the background and reports over `clipper3:unsync-*`, for the same
   * reason sync does: a series runs to hundreds of pages.
   */
  router.post('/series/:seriesId/unsync-processed', async (req: Request, res: Response) => {
    try {
      const seriesId = req.params.seriesId
      if (unsyncingSeries.has(seriesId)) {
        return res.status(409).json({ error: 'This series is already being unsynced' })
      }
      if (syncingSeries.has(seriesId)) {
        return res.status(409).json({ error: 'This series is being synced right now' })
      }

      const requested: unknown = req.body?.chapterIds
      if (!Array.isArray(requested)) {
        return res.status(400).json({ error: 'chapterIds must be an array of chapter ids' })
      }
      const wanted = new Set(requested.filter((v): v is string => typeof v === 'string'))
      if (wanted.size === 0) {
        return res.status(400).json({ error: 'Select at least one chapter to unsync' })
      }

      const chapters = await prisma.chapter.findMany({
        // Scoped to this series as well as the id list, so an id belonging to
        // another series can never be cleared through this route.
        where: { seriesId, id: { in: [...wanted] } },
        select: { id: true, number: true, folderPath: true },
        orderBy: { number: 'asc' }
      })
      if (chapters.length === 0) {
        return res.status(404).json({ error: 'None of the selected chapters belong to this series' })
      }

      unsyncingSeries.add(seriesId)

      void (async () => {
        const results: ChapterUnsyncResult[] = []
        let detached = 0
        let failed = 0

        try {
          for (let i = 0; i < chapters.length; i++) {
            const chapter = chapters[i]
            io.emit('clipper3:unsync-progress', {
              seriesId,
              current: i + 1,
              total: chapters.length,
              chapterNumber: chapter.number
            })

            let manifest
            try {
              manifest = await getChapterManifest(chapter.folderPath)
            } catch {
              continue
            }

            try {
              const result = await unsyncChapterProcessed({
                chapterId: chapter.id,
                chapterNumber: chapter.number,
                folderPath: chapter.folderPath,
                images: manifest.images.map(img => ({ filename: img.filename }))
              })

              detached += result.detached
              failed += result.failed
              if (result.pages.length > 0) results.push(result)
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err)
              console.error(`[clipper3] unsyncing chapter ${chapter.number} failed:`, message)
              failed++
              results.push({
                chapterId: chapter.id,
                chapterNumber: chapter.number,
                detached: 0,
                attached: 0,
                failed: 1,
                pages: [{
                  filename: '\u2014',
                  status: 'failed',
                  reason: message,
                  hadPoints: false,
                  hadMetadata: false
                }]
              })
            }
          }

          io.emit('clipper3:unsync-complete', {
            seriesId,
            chapters: chapters.length,
            detached,
            failed,
            results
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          console.error('[clipper3] unsync job crashed:', message)
          io.emit('clipper3:unsync-complete', { seriesId, error: message })
        } finally {
          unsyncingSeries.delete(seriesId)
        }
      })()

      res.json({ started: true, chapters: chapters.length })
    } catch (error) {
      console.error('[clipper3] starting unsync failed:', error)
      res.status(500).json({ error: 'Failed to start unsyncing' })
    }
  })


  /**
   * POST /series/:seriesId/unsync-processed/preview
   *
   * How many attached pages each selected chapter is carrying, so the
   * confirmation dialog names a real number before anything is deleted. Reads
   * the store and nothing else, so it answers in one request.
   */
  router.post('/series/:seriesId/unsync-processed/preview', async (req: Request, res: Response) => {
    try {
      const seriesId = req.params.seriesId

      const requested: unknown = req.body?.chapterIds
      if (!Array.isArray(requested)) {
        return res.status(400).json({ error: 'chapterIds must be an array of chapter ids' })
      }
      const wanted = new Set(requested.filter((v): v is string => typeof v === 'string'))
      if (wanted.size === 0) {
        return res.status(400).json({ error: 'Select at least one chapter to unsync' })
      }

      const chapters = await prisma.chapter.findMany({
        where: { seriesId, id: { in: [...wanted] } },
        select: { id: true, number: true, folderPath: true },
        orderBy: { number: 'asc' }
      })
      if (chapters.length === 0) {
        return res.status(404).json({ error: 'None of the selected chapters belong to this series' })
      }

      const results: ChapterUnsyncResult[] = []
      let attached = 0
      let failed = 0

      for (const chapter of chapters) {
        let manifest
        try {
          manifest = await getChapterManifest(chapter.folderPath)
        } catch {
          continue
        }

        try {
          const result = await unsyncChapterProcessed({
            chapterId: chapter.id,
            chapterNumber: chapter.number,
            folderPath: chapter.folderPath,
            images: manifest.images.map(img => ({ filename: img.filename })),
            dryRun: true
          })

          attached += result.attached
          failed += result.failed
          if (result.pages.length > 0) results.push(result)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          console.error(`[clipper3] previewing unsync of chapter ${chapter.number} failed:`, message)
          failed++
        }
      }

      res.json({ chapters: chapters.length, attached, failed, results })
    } catch (error) {
      console.error('[clipper3] previewing unsync failed:', error)
      res.status(500).json({ error: 'Failed to preview the unsync' })
    }
  })

  return router
}
