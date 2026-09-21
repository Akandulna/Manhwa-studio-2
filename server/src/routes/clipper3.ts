/**
 * Image Clipper 3.0 — per-image crop artifacts and cutting.
 *
 * The defining difference from 2.0: a chapter is NOT one stitched canvas here.
 * Each source image is independent —
 *
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
import { getChapterManifest } from '../services/clipperService.js'
import {
  deleteImageMetadata,
  deleteImagePoints,
  extractCrops,
  getOutputDir,
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
import { sliceImage, getSliceDir } from '../services/clipper3/perImageSlice.js'
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

export function initClipper3Routes(io: Server): Router {
  const router = Router()

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
          // pointer detection yet, same as it is left out of clipper2Api's own
          // chapter listing, so it is omitted here rather than failing the
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
