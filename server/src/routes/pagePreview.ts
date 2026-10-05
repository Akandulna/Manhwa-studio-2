/**
 * Chapter page preview — look through a downloaded chapter's pages and delete
 * the ones that should not be in it (see services/pageBin.ts). Live pages are
 * served by the stitch routes' thumb/image endpoints.
 *
 *   GET    /chapters/:id                       pages (measured), the bin, blockers, prev/next chapter
 *   POST   /chapters/:id/delete                body { filenames: string[] } → bin
 *   POST   /chapters/:id/restore               body { filenames: string[] } ← bin
 *   DELETE /chapters/:id/bin                   empty the bin for good
 *   GET    /chapters/:id/bin/:filename/thumb   a small preview of a deleted page
 */

import { Router, Request, Response } from 'express'
import fs from 'fs/promises'
import sharp from 'sharp'
import { prisma } from '../index.js'
import { PageBinError, binFile, deletePages, emptyBin, getChapterPages, restorePages } from '../services/pageBin.js'
import { doneNeighbours } from '../services/pageStitch.js'

const THUMB_WIDTH = 320

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
  if (error instanceof PageBinError) return res.status(error.status).json({ error: error.message })
  console.error(`[pagePreview] ${what} failed:`, error)
  res.status(500).json({ error: error instanceof Error ? error.message : `Failed to ${what}` })
}

export function initPagePreviewRoutes(): Router {
  const router = Router()

  router.get('/chapters/:id', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })
      res.json({
        chapterId: chapter.id,
        number: chapter.number,
        title: chapter.title,
        seriesId: chapter.seriesId,
        seriesTitle: chapter.series.title,
        ...(await getChapterPages(chapter)),
        neighbours: await doneNeighbours(chapter.seriesId, chapter.number)
      })
    } catch (error) {
      sendError(res, error, 'read chapter pages')
    }
  })

  router.post('/chapters/:id/delete', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })
      res.json({ deleted: await deletePages(chapter, req.body?.filenames) })
    } catch (error) {
      sendError(res, error, 'delete pages')
    }
  })

  router.post('/chapters/:id/restore', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })
      res.json({ restored: await restorePages(chapter, req.body?.filenames) })
    } catch (error) {
      sendError(res, error, 'restore pages')
    }
  })

  router.delete('/chapters/:id/bin', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })
      res.json({ removed: await emptyBin(chapter) })
    } catch (error) {
      sendError(res, error, 'empty the bin')
    }
  })

  router.get('/chapters/:id/bin/:filename/thumb', async (req: Request, res: Response) => {
    try {
      const chapter = await findChapter(req.params.id)
      if (!chapter) return res.status(404).json({ error: 'Chapter not found' })
      const input = await fs.readFile(binFile(chapter.folderPath, req.params.filename)).catch(() => null)
      if (!input) return res.status(404).json({ error: 'Image not found' })

      const thumb = await sharp(input)
        .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 72 })
        .toBuffer()
      res.setHeader('Content-Type', 'image/jpeg')
      res.setHeader('Cache-Control', 'private, max-age=3600')
      res.send(thumb)
    } catch (error) {
      res.setHeader('Cache-Control', 'no-store')
      sendError(res, error, 'make a thumbnail')
    }
  })

  return router
}
