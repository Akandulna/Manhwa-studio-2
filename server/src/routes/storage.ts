/**
 * Storage API — disk usage per series/chapter, and reclaiming it.
 *
 *   GET    /overview                what the disk holds, broken down
 *   GET    /categories              the category catalogue + what is reclaimable
 *   GET    /published                chapter id → has a rendered video (cheap)
 *   GET    /series/:id/videos       rendered MP4s of one series
 *   POST   /chapters/:id/delete     clean one chapter's reclaimable data
 *   POST   /series/:id/delete       clean every exported chapter of a series
 *   DELETE /series/:id/videos/:dir/:file   remove one rendered MP4
 *
 * Deleting is POST rather than DELETE for the chapter/series cleanups because
 * the categories to remove and the `allowUnexported` acknowledgement travel in
 * the body; a bare DELETE has nowhere honest to put them.
 */

import { Router, Request, Response } from 'express'
import {
  CATEGORIES,
  getPublishedChapters,
  deleteChapterData,
  deleteSeriesExportedData,
  deleteSeriesVideo,
  listSeriesVideos,
  scanStorage,
  type CategoryKey
} from '../services/storageService.js'

/** Validate the requested categories against the catalogue. */
function parseCategories(raw: unknown): CategoryKey[] {
  if (!Array.isArray(raw)) throw new Error('categories must be an array')
  const known = new Set(CATEGORIES.map(c => c.key))
  const out: CategoryKey[] = []
  for (const value of raw) {
    if (typeof value !== 'string' || !known.has(value as CategoryKey)) {
      throw new Error(`Unknown category: ${String(value)}`)
    }
    out.push(value as CategoryKey)
  }
  if (out.length === 0) throw new Error('No categories selected')
  return out
}

function fail(res: Response, error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback
  console.error(fallback, error)
  res.status(400).json({ error: message })
}

export function initStorageRoutes(): Router {
  const router = Router()

  router.get('/categories', (_req: Request, res: Response) => {
    res.json(CATEGORIES)
  })

  // A full scan walks every chapter folder, so this can take seconds on a large
  // library. It is deliberately not cached: the page's whole purpose is to show
  // what is on disk right now, including what a delete just removed.
  router.get('/overview', async (_req: Request, res: Response) => {
    try {
      res.json(await scanStorage())
    } catch (error) {
      console.error('Error scanning storage:', error)
      res.status(500).json({ error: 'Failed to scan storage' })
    }
  })

  // Cheap enough for every module's chapter list to call on mount — it reads
  // only the two video folders per series, never the chapter folders.
  router.get('/published', async (req: Request, res: Response) => {
    try {
      const seriesId = typeof req.query.seriesId === 'string' ? req.query.seriesId : undefined
      res.json(await getPublishedChapters(seriesId))
    } catch (error) {
      console.error('Error resolving published chapters:', error)
      res.status(500).json({ error: 'Failed to resolve published chapters' })
    }
  })

  router.get('/series/:id/videos', async (req: Request, res: Response) => {
    try {
      res.json(await listSeriesVideos(req.params.id))
    } catch (error) {
      fail(res, error, 'Failed to list videos')
    }
  })

  router.post('/chapters/:id/delete', async (req: Request, res: Response) => {
    try {
      const categories = parseCategories(req.body?.categories)
      const result = await deleteChapterData(req.params.id, categories, {
        allowUnexported: req.body?.allowUnexported === true
      })
      res.json(result)
    } catch (error) {
      fail(res, error, 'Failed to delete chapter data')
    }
  })

  router.post('/series/:id/delete', async (req: Request, res: Response) => {
    try {
      const categories = parseCategories(req.body?.categories)
      const result = await deleteSeriesExportedData(req.params.id, categories, {
        allowUnexported: req.body?.allowUnexported === true
      })
      res.json(result)
    } catch (error) {
      fail(res, error, 'Failed to delete series data')
    }
  })

  router.delete('/series/:id/videos/:dir/:file', async (req: Request, res: Response) => {
    try {
      const result = await deleteSeriesVideo(
        req.params.id,
        req.params.dir,
        decodeURIComponent(req.params.file)
      )
      res.json(result)
    } catch (error) {
      fail(res, error, 'Failed to delete video')
    }
  })

  return router
}
