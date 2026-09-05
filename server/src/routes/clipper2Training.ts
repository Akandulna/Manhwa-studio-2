/**
 * Image Clipper 2.0 Training API Routes.
 *
 * A manual-crop tool (same interaction model as Module 3 v1: click to drop a
 * full-width crop, drag edges/corners to resize) that exports real PNGs for
 * training data — entirely separate from the production Clipper 2.0 surface
 * (routes/clipper2.ts):
 *  - Reads chapters + manifests the same way the rest of the app does, but
 *  - Writes only to crops_training/ — never crop_points.json, crops2/,
 *    CropPointSet, Crop, or CropSession. Cutting reuses clipperService's
 *    executeCrop, the same function Module 3 v1 exports with, so output is
 *    pixel-identical; only the destination folder differs.
 * No Socket.io: exporting a handful of manually-drawn crops is fast enough to
 * answer synchronously, unlike detect/apply's per-chapter vision-model calls.
 *
 * Endpoints:
 *   GET    /chapters                     croppable chapters + exported-count
 *   POST   /chapters/:id/export          cut the given rects to crops_training/
 *   GET    /chapters/:id/outputs         list this chapter's exported training PNGs
 *   GET    /chapters/:id/output/:file    one exported PNG
 *   DELETE /chapters/:id                 clear this chapter's training exports
 *
 * Plus an "uploads" surface so a user can test the crop tool against images
 * that were never downloaded as a chapter at all — no Chapter/Series row is
 * created for these; they live purely as a folder on disk keyed by a UUID:
 *   POST   /uploads                      multipart 'images', in submission order
 *   GET    /uploads/:id/image/:file      one uploaded source image
 *   POST   /uploads/:id/export           same as /chapters/:id/export
 *   GET    /uploads/:id/outputs          same as /chapters/:id/outputs
 *   GET    /uploads/:id/output/:file     same as /chapters/:id/output/:file
 *   DELETE /uploads/:id/outputs          clear exports only (same as /chapters/:id) — keep the uploaded images
 *   DELETE /uploads/:id                  delete the whole upload (images + exports) — the "start over" case
 */

import { Router, Request, Response, NextFunction } from 'express'
import fs from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'
import multer from 'multer'
import { prisma } from '../index.js'
import { executeCrop, getChapterManifest, type CropRect } from '../services/clipperService.js'
import {
  clearTrainingOutputs,
  getTrainingExportDir,
  listTrainingOutputs
} from '../services/clipper2/pointerTrainingStore.js'

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

function outputUrl(chapterId: string, filename: string): string {
  return `/api/clipper2/training/chapters/${chapterId}/output/${encodeURIComponent(filename)}`
}

// ============ Uploads (no chapter/series involved at all) ============

function getDownloadRoot(): string {
  return process.env.DOWNLOAD_ROOT || './downloads'
}

/** Sibling of the app's other top-level DOWNLOAD_ROOT folders (_music, _watermarks) — never a series. */
const UPLOADS_ROOT = '_clipper2_training_uploads'

function isValidUploadId(id: string): boolean {
  // We only ever generate these ourselves (randomUUID), so a strict format
  // check is both sufficient and load-bearing: uploadId is joined straight
  // into a filesystem path below, and this is what stops a crafted id like
  // "../../etc" from escaping DOWNLOAD_ROOT.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
}

function uploadFolderPath(uploadId: string): string {
  return path.posix.join(UPLOADS_ROOT, uploadId)
}

function uploadOutputUrl(uploadId: string, filename: string): string {
  return `/api/clipper2/training/uploads/${uploadId}/output/${encodeURIComponent(filename)}`
}

const uploadStorage = multer.diskStorage({
  destination: async (req: Request, _file, cb) => {
    try {
      const uploadId = (req as Request & { clipper2UploadId: string }).clipper2UploadId
      const dir = path.join(getDownloadRoot(), uploadFolderPath(uploadId))
      await fs.mkdir(dir, { recursive: true })
      cb(null, dir)
    } catch (err) {
      cb(err as Error, '')
    }
  },
  // Named by arrival order, not original filename: getChapterManifest stitches
  // in natural-sort-of-filename order, and the whole point of this feature is
  // that the sequence the user picked/arranged the files in is what stitches,
  // regardless of what their source files happened to be called.
  filename: (req: Request, file, cb) => {
    const withCounter = req as Request & { _clipper2UploadCounter?: number }
    const seq = (withCounter._clipper2UploadCounter ?? 0) + 1
    withCounter._clipper2UploadCounter = seq
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg'
    cb(null, `page_${String(seq).padStart(3, '0')}${ext}`)
  }
})

const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 20 * 1024 * 1024, files: 60 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
    if (allowed.includes(file.mimetype)) cb(null, true)
    else cb(new Error(`Invalid file type: ${file.mimetype}. Only JPEG, PNG, WebP, and GIF are allowed.`))
  }
})

export function initClipper2TrainingRoutes(): Router {
  const router = Router()

  /** GET /chapters — every downloaded chapter + how many training crops it already has. */
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
          series: { select: { title: true } }
        },
        orderBy: [{ series: { title: 'asc' } }, { number: 'asc' }]
      })

      const summaries = await Promise.all(
        chapters.map(async chapter => {
          const outputs = await listTrainingOutputs(chapter.folderPath)
          return {
            id: chapter.id,
            number: chapter.number,
            title: chapter.title,
            seriesId: chapter.seriesId,
            seriesTitle: chapter.series.title,
            pageCount: chapter.pageCount ?? 0,
            exportedCount: outputs.length
          }
        })
      )

      res.json(summaries)
    } catch (error) {
      console.error('Error fetching training chapters:', error)
      res.status(500).json({ error: 'Failed to fetch chapters' })
    }
  })

  /**
   * POST /chapters/:id/export { crops: [{ canvasX, canvasY, canvasW, canvasH }] }
   * Cuts each rect with the same clipperService v1 uses, into crops_training/.
   * Replaces whatever was exported for this chapter before, so re-exporting
   * after deleting a crop doesn't leave its old PNG behind.
   */
  router.post('/chapters/:id/export', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) {
        return res.status(404).json({ error: 'Chapter not found' })
      }

      const { crops } = req.body as {
        crops?: Array<{ canvasX: number; canvasY: number; canvasW: number; canvasH: number }>
      }
      if (!Array.isArray(crops) || crops.length === 0) {
        return res.status(400).json({ error: 'crops (non-empty array) is required' })
      }
      for (const c of crops) {
        if (![c.canvasX, c.canvasY, c.canvasW, c.canvasH].every(n => typeof n === 'number' && Number.isFinite(n))) {
          return res.status(400).json({ error: 'Each crop needs finite canvasX/canvasY/canvasW/canvasH' })
        }
      }

      const manifest = await getChapterManifest(chapter.folderPath)
      await clearTrainingOutputs(chapter.folderPath)
      const exportDir = getTrainingExportDir(chapter.folderPath)

      const files: { filename: string; width: number; height: number; bytes: number; url: string }[] = []
      let failed = 0

      for (let i = 0; i < crops.length; i++) {
        const c = crops[i]
        const rect: CropRect = { canvasX: c.canvasX, canvasY: c.canvasY, canvasW: c.canvasW, canvasH: c.canvasH }
        const filename = `train_${String(i + 1).padStart(3, '0')}.png`
        try {
          const result = await executeCrop(rect, manifest, chapter.folderPath, path.join(exportDir, filename))
          files.push({ filename, width: result.width, height: result.height, bytes: result.bytes, url: outputUrl(chapter.id, filename) })
        } catch (err) {
          console.error(`[clipper2-training] failed to export crop ${i + 1} for chapter ${chapter.id}:`, err)
          failed++
        }
      }

      res.json({ exported: files.length, failed, exportDir: path.resolve(exportDir), files })
    } catch (error) {
      console.error('Error exporting training crops:', error)
      res.status(500).json({ error: 'Failed to export crops' })
    }
  })

  /** GET /chapters/:id/outputs — this chapter's already-exported training PNGs. */
  router.get('/chapters/:id/outputs', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) {
        return res.status(404).json({ error: 'Chapter not found' })
      }
      const outputs = await listTrainingOutputs(chapter.folderPath)
      res.json({
        exportDir: outputs.length > 0 ? path.resolve(getTrainingExportDir(chapter.folderPath)) : null,
        files: outputs.map(o => ({ filename: o.filename, bytes: o.bytes, url: outputUrl(chapter.id, o.filename) }))
      })
    } catch (error) {
      console.error('Error listing training outputs:', error)
      res.status(500).json({ error: 'Failed to list outputs' })
    }
  })

  /** GET /chapters/:id/output/:filename — scoped to this chapter's crops_training/ only. */
  router.get('/chapters/:id/output/:filename', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) {
        return res.status(404).json({ error: 'Chapter not found' })
      }

      const filename = path.basename(req.params.filename)
      const exportDir = path.resolve(getTrainingExportDir(chapter.folderPath))
      const fullPath = path.resolve(exportDir, filename)
      if (!fullPath.startsWith(exportDir + path.sep)) {
        return res.status(404).json({ error: 'Output not found' })
      }

      try {
        await fs.access(fullPath)
      } catch {
        return res.status(404).json({ error: 'Output not found' })
      }

      res.setHeader('Content-Type', 'image/png')
      res.sendFile(fullPath)
    } catch (error) {
      console.error('Error serving training output:', error)
      res.status(500).json({ error: 'Failed to serve output' })
    }
  })

  /** DELETE /chapters/:id — clear this chapter's training exports (a fresh start). */
  router.delete('/chapters/:id', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) {
        return res.status(404).json({ error: 'Chapter not found' })
      }
      await clearTrainingOutputs(chapter.folderPath)
      res.json({ deleted: true })
    } catch (error) {
      console.error('Error clearing training outputs:', error)
      res.status(500).json({ error: 'Failed to clear outputs' })
    }
  })

  // ============ Uploads ============

  /**
   * POST /uploads — multipart 'images', 1-60 files, saved in submission order.
   * No Chapter/Series row: the folder itself (keyed by a fresh UUID) is the
   * only record of this upload, so it can never be mistaken for real library
   * content and needs no cleanup beyond DELETE /uploads/:id.
   */
  router.post(
    '/uploads',
    (req: Request, _res: Response, next: NextFunction) => {
      (req as Request & { clipper2UploadId: string }).clipper2UploadId = randomUUID()
      next()
    },
    upload.array('images', 60),
    async (req: Request, res: Response) => {
      try {
        const files = req.files as Express.Multer.File[] | undefined
        if (!files || files.length === 0) {
          return res.status(400).json({ error: 'No images uploaded' })
        }
        const uploadId = (req as Request & { clipper2UploadId: string }).clipper2UploadId
        const manifest = await getChapterManifest(uploadFolderPath(uploadId))
        res.json({ uploadId, manifest, pageCount: files.length })
      } catch (error) {
        console.error('Error uploading training images:', error)
        res.status(500).json({ error: 'Failed to upload images' })
      }
    },
    // Multer (fileFilter/limits) reports failures via next(err); this is what
    // turns that into a JSON 400 instead of Express's default HTML error page.
    (err: Error, _req: Request, res: Response, _next: NextFunction) => {
      res.status(400).json({ error: err.message || 'Upload failed' })
    }
  )

  /** GET /uploads/:id/image/:filename — one source image from an upload. */
  router.get('/uploads/:id/image/:filename', async (req: Request, res: Response) => {
    try {
      const { id } = req.params
      if (!isValidUploadId(id)) return res.status(400).json({ error: 'Invalid upload id' })

      const filename = path.basename(req.params.filename)
      const dir = path.resolve(getDownloadRoot(), uploadFolderPath(id))
      const fullPath = path.resolve(dir, filename)
      if (!fullPath.startsWith(dir + path.sep)) {
        return res.status(404).json({ error: 'Image not found' })
      }

      await fs.access(fullPath)
      res.sendFile(fullPath)
    } catch {
      res.status(404).json({ error: 'Image not found' })
    }
  })

  /** POST /uploads/:id/export — identical to /chapters/:id/export, folder resolved from the id directly. */
  router.post('/uploads/:id/export', async (req: Request, res: Response) => {
    try {
      const { id } = req.params
      if (!isValidUploadId(id)) return res.status(400).json({ error: 'Invalid upload id' })

      const { crops } = req.body as {
        crops?: Array<{ canvasX: number; canvasY: number; canvasW: number; canvasH: number }>
      }
      if (!Array.isArray(crops) || crops.length === 0) {
        return res.status(400).json({ error: 'crops (non-empty array) is required' })
      }
      for (const c of crops) {
        if (![c.canvasX, c.canvasY, c.canvasW, c.canvasH].every(n => typeof n === 'number' && Number.isFinite(n))) {
          return res.status(400).json({ error: 'Each crop needs finite canvasX/canvasY/canvasW/canvasH' })
        }
      }

      const folderPath = uploadFolderPath(id)
      const manifest = await getChapterManifest(folderPath)
      await clearTrainingOutputs(folderPath)
      const exportDir = getTrainingExportDir(folderPath)

      const files: { filename: string; width: number; height: number; bytes: number; url: string }[] = []
      let failed = 0

      for (let i = 0; i < crops.length; i++) {
        const c = crops[i]
        const rect: CropRect = { canvasX: c.canvasX, canvasY: c.canvasY, canvasW: c.canvasW, canvasH: c.canvasH }
        const filename = `train_${String(i + 1).padStart(3, '0')}.png`
        try {
          const result = await executeCrop(rect, manifest, folderPath, path.join(exportDir, filename))
          files.push({ filename, width: result.width, height: result.height, bytes: result.bytes, url: uploadOutputUrl(id, filename) })
        } catch (err) {
          console.error(`[clipper2-training] failed to export crop ${i + 1} for upload ${id}:`, err)
          failed++
        }
      }

      res.json({ exported: files.length, failed, exportDir: path.resolve(exportDir), files })
    } catch (error) {
      console.error('Error exporting upload training crops:', error)
      res.status(500).json({ error: 'Failed to export crops' })
    }
  })

  /** GET /uploads/:id/outputs — identical to /chapters/:id/outputs. */
  router.get('/uploads/:id/outputs', async (req: Request, res: Response) => {
    try {
      const { id } = req.params
      if (!isValidUploadId(id)) return res.status(400).json({ error: 'Invalid upload id' })

      const folderPath = uploadFolderPath(id)
      const outputs = await listTrainingOutputs(folderPath)
      res.json({
        exportDir: outputs.length > 0 ? path.resolve(getTrainingExportDir(folderPath)) : null,
        files: outputs.map(o => ({ filename: o.filename, bytes: o.bytes, url: uploadOutputUrl(id, o.filename) }))
      })
    } catch (error) {
      console.error('Error listing upload training outputs:', error)
      res.status(500).json({ error: 'Failed to list outputs' })
    }
  })

  /** GET /uploads/:id/output/:filename — identical to /chapters/:id/output/:filename. */
  router.get('/uploads/:id/output/:filename', async (req: Request, res: Response) => {
    try {
      const { id } = req.params
      if (!isValidUploadId(id)) return res.status(400).json({ error: 'Invalid upload id' })

      const filename = path.basename(req.params.filename)
      const exportDir = path.resolve(getTrainingExportDir(uploadFolderPath(id)))
      const fullPath = path.resolve(exportDir, filename)
      if (!fullPath.startsWith(exportDir + path.sep)) {
        return res.status(404).json({ error: 'Output not found' })
      }

      try {
        await fs.access(fullPath)
      } catch {
        return res.status(404).json({ error: 'Output not found' })
      }

      res.setHeader('Content-Type', 'image/png')
      res.sendFile(fullPath)
    } catch (error) {
      console.error('Error serving upload training output:', error)
      res.status(500).json({ error: 'Failed to serve output' })
    }
  })

  /** DELETE /uploads/:id/outputs — clear exports only, keep the uploaded source images. */
  router.delete('/uploads/:id/outputs', async (req: Request, res: Response) => {
    try {
      const { id } = req.params
      if (!isValidUploadId(id)) return res.status(400).json({ error: 'Invalid upload id' })
      await clearTrainingOutputs(uploadFolderPath(id))
      res.json({ deleted: true })
    } catch (error) {
      console.error('Error clearing upload training outputs:', error)
      res.status(500).json({ error: 'Failed to clear outputs' })
    }
  })

  /** DELETE /uploads/:id — remove the whole upload (source images + any exports). */
  router.delete('/uploads/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params
      if (!isValidUploadId(id)) return res.status(400).json({ error: 'Invalid upload id' })

      const dir = path.resolve(getDownloadRoot(), uploadFolderPath(id))
      await fs.rm(dir, { recursive: true, force: true })
      res.json({ deleted: true })
    } catch (error) {
      console.error('Error deleting upload:', error)
      res.status(500).json({ error: 'Failed to delete upload' })
    }
  })

  return router
}
