/**
 * Page Stitcher API — preview a chapter's pages and join many short pages into
 * a few tall ones (see services/pageStitch.ts).
 *
 *   GET    /chapters                       downloaded chapters with page counts + stitch state
 *   GET    /chapters/:id                   the chapter's pages (measured), backup record, blockers, prev/next chapter
 *   GET    /chapters/:id/thumb/:filename   a small preview of one page
 *   GET    /chapters/:id/image/:filename   one page at full size
 *   POST   /chapters/:id                   stitch, body { groups: string[][] }
 *   POST   /chapters/:id/undo              restore the originals from the backup
 *   DELETE /chapters/:id/backup            keep the stitch, delete the originals
 */

import { Router, Request, Response } from 'express'
import path from 'path'
import fs from 'fs/promises'
import sharp from 'sharp'
import { prisma } from '../index.js'
import { reconcileQuietly } from '../services/diskReconcile.js'
import {
  STITCH_MAX_HEIGHT,
  StitchError,
  discardBackup,
  doneNeighbours,
  getStitchState,
  readRecord,
  stitchChapter,
  undoStitch
} from '../services/pageStitch.js'

const THUMB_WIDTH = 320

const IMAGE_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

function chapterFile(folderPath: string, filename: string): string {
  return path.join(process.env.DOWNLOAD_ROOT || './downloads', folderPath, path.basename(filename))
}

async function findChapter(id: string) {
  return prisma.chapter.findUnique({
    where: { id },
    select: {
      id: true,
      number: true,
      title: true,
      status: true,
      folderPath: true,
      seriesId: true,
      series: { select: { title: true } }
    }
  })
}

function sendError(res: Response, error: unknown, what: string) {
  if (error instanceof StitchError) return res.status(error.status).json({ error: error.message })
  console.error(`[stitch] ${what} failed:`, error)
  res.status(500).json({ error: error instanceof Error ? error.message : `Failed to ${what}` })
}

export function initStitchRoutes(): Router {
  const router = Router()

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
          folderPath: true,
          series: { select: { title: true } }
        },
        orderBy: [{ series: { title: 'asc' } }, { number: 'asc' }]
      })

      const rows = await Promise.all(
        chapters.map(async c => {
          const record = await readRecord(c.folderPath)
          return {
            id: c.id,
            number: c.number,
            title: c.title,
            seriesId: c.seriesId,
            seriesTitle: c.series.title,
            pageCount: c.pageCount ?? 0,
            stitched: record
              ? { originalPages: record.originals.length, stitchedAt: record.stitchedAt }
              : null
          }
        })
      )
      res.json(rows)
    } catch (error) {
      sendError(res, error, 'list chapters')
    }
  })

  router.get('/chapters/:id', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })
      const state = await getStitchState(chapter)
      res.json({
        chapterId: chapter.id,
        number: chapter.number,
        title: chapter.title,
        seriesId: chapter.seriesId,
        seriesTitle: chapter.series.title,
        maxHeight: STITCH_MAX_HEIGHT,
        ...state,
        neighbours: await doneNeighbours(chapter.seriesId, chapter.number)
      })
    } catch (error) {
      sendError(res, error, 'read chapter pages')
    }
  })

  router.get('/chapters/:id/thumb/:filename', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })
      const file = chapterFile(chapter.folderPath, req.params.filename)
      // Read into memory: libvips caches by filename, and stitching reuses names.
      const input = await fs.readFile(file).catch(() => null)
      if (!input) return res.status(404).json({ error: 'Image not found' })

      const thumb = await sharp(input)
        .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 72 })
        .toBuffer()
      res.setHeader('Content-Type', 'image/jpeg')
      // Names are reused across a stitch/undo, so the client adds a version query.
      res.setHeader('Cache-Control', 'private, max-age=3600')
      res.send(thumb)
    } catch (error) {
      res.setHeader('Cache-Control', 'no-store')
      sendError(res, error, 'make a thumbnail')
    }
  })

  router.get('/chapters/:id/image/:filename', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })
      const file = path.resolve(chapterFile(chapter.folderPath, req.params.filename))
      if (!(await fs.access(file).then(() => true, () => false))) {
        return res.status(404).json({ error: 'Image not found' })
      }
      res.setHeader('Content-Type', IMAGE_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream')
      res.setHeader('Cache-Control', 'private, max-age=3600')
      res.sendFile(file)
    } catch (error) {
      sendError(res, error, 'serve the image')
    }
  })

  router.post('/chapters/:id', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })
      const record = await stitchChapter(chapter, req.body?.groups)
      res.json({
        originalPages: record.originals.length,
        stitchedPages: record.outputs.length,
        excluded: record.excluded.length
      })
    } catch (error) {
      sendError(res, error, 'stitch the chapter')
    }
  })

  router.post('/chapters/:id/undo', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })
      await undoStitch(chapter)
      res.json({ ok: true })
    } catch (error) {
      sendError(res, error, 'undo the stitch')
    }
  })

  router.delete('/chapters/:id/backup', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })
      await discardBackup(chapter)
      res.json({ ok: true })
    } catch (error) {
      sendError(res, error, 'delete the backup')
    }
  })

  return router
}
