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
 *
 * "Done" is a fact about the filesystem — this image has BOTH a parseable crop
 * artifact and a metadata document of its own — never an inference from another
 * image's coordinates. Coordinates stay normalized against their own image.
 */

import { Router, Request, Response } from 'express'
import path from 'path'
import fs from 'fs/promises'
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
  writeImageMetadata,
  writeImagePoints,
  type Clipper3CropEntry,
  type Clipper3ImageCropFile
} from '../services/clipper3/perImageStore.js'
import { cutImageCrops } from '../services/clipper3/perImageCrop.js'

const FORMAT = 'four-point-crop'
const VERSION = '1.0'

/** Chapters currently being cut, so two runs cannot interleave their writes. */
const cropping = new Set<string>()


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
                  expectedExportedFilenames(seriesSlug(chapter.series.title), img.filename, crops)
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
          expectedExportedFilenames(seriesSlug(chapter.series.title), req.params.filename, crops)
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
            expectedExportedFilenames(seriesSlug(chapter.series.title), req.params.filename, crops)
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

      const validation = validateMetadata(
        content,
        crops.map(c => c.id),
        expectedExportedFilenames(seriesSlug(chapter.series.title), image.filename, crops)
      )
      if (!validation.isValid) {
        return res.status(400).json({ error: validation.errors.join(' ') })
      }

      const metadataPath = await writeImageMetadata(chapter.folderPath, image.filename, content)

      res.json({
        filename: image.filename,
        content,
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
            expectedExportedFilenames(seriesSlug(chapter.series.title), img.filename, crops)
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

          io.emit('clipper3:crop-complete', {
            chapterId,
            images: targets.length,
            exported: allFiles.length,
            failed,
            warnings,
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
                expectedExportedFilenames(seriesSlug(chapter.series.title), img.filename, crops)
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

  return router
}
