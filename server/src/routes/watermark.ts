/**
 * Watermark API Routes — Module 3: Image Clipper
 *
 * Lets the user identify a series' watermark (by selecting a region on a page),
 * manage templates, and preview auto-detection. The actual white-fill happens
 * inside the crop export pipeline (clipperService.finalizeSession).
 *
 *   GET    /status                          sidecar availability
 *   GET    /series/:seriesId/templates      list templates for a series
 *   POST   /series/:seriesId/templates      create a template from a canvas region
 *   PATCH  /templates/:id                   update label / threshold / enabled
 *   DELETE /templates/:id                   delete a template (+ its image)
 *   GET    /templates/:id/file              serve the template PNG
 *   POST   /chapters/:chapterId/detect      preview detection (canvas-space rects)
 */

import { Router, Request, Response } from 'express'
import fs from 'fs/promises'
import {
  checkWatermarkSidecarAvailable,
  createTemplateFromRegion,
  listTemplates,
  updateTemplate,
  deleteTemplate,
  getTemplateFilePath,
  detectChapterWatermarksPreview
} from '../services/watermarkService.js'

export function initWatermarkRoutes(): Router {
  const router = Router()

  router.get('/status', async (_req: Request, res: Response) => {
    try {
      res.json(await checkWatermarkSidecarAvailable())
    } catch (error) {
      console.error('Error checking watermark sidecar:', error)
      res.status(500).json({ error: 'Failed to check sidecar' })
    }
  })

  router.get('/series/:seriesId/templates', async (req: Request, res: Response) => {
    try {
      res.json(await listTemplates(req.params.seriesId))
    } catch (error) {
      console.error('Error listing watermark templates:', error)
      res.status(500).json({ error: 'Failed to list templates' })
    }
  })

  /** POST /series/:seriesId/templates { chapterId, canvasX, canvasY, canvasW, canvasH, label? } */
  router.post('/series/:seriesId/templates', async (req: Request, res: Response) => {
    try {
      const { chapterId, canvasX, canvasY, canvasW, canvasH, label } = req.body
      if (!chapterId || canvasX == null || canvasY == null || canvasW == null || canvasH == null) {
        return res.status(400).json({ error: 'chapterId and canvasX/Y/W/H are required' })
      }
      if (canvasW < 4 || canvasH < 4) {
        return res.status(400).json({ error: 'Selected region is too small' })
      }
      const created = await createTemplateFromRegion({
        seriesId: req.params.seriesId,
        chapterId,
        rect: { canvasX, canvasY, canvasW, canvasH },
        label
      })
      res.json(created)
    } catch (error) {
      console.error('Error creating watermark template:', error)
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to create template' })
    }
  })

  router.patch('/templates/:id', async (req: Request, res: Response) => {
    try {
      const { label, threshold, enabled } = req.body
      const updated = await updateTemplate(req.params.id, { label, threshold, enabled })
      res.json({
        id: updated.id,
        label: updated.label,
        threshold: updated.threshold,
        enabled: updated.enabled
      })
    } catch (error) {
      console.error('Error updating watermark template:', error)
      res.status(500).json({ error: 'Failed to update template' })
    }
  })

  router.delete('/templates/:id', async (req: Request, res: Response) => {
    try {
      await deleteTemplate(req.params.id)
      res.json({ deleted: true })
    } catch (error) {
      console.error('Error deleting watermark template:', error)
      res.status(500).json({ error: 'Failed to delete template' })
    }
  })

  router.get('/templates/:id/file', async (req: Request, res: Response) => {
    try {
      const filePath = await getTemplateFilePath(req.params.id)
      if (!filePath) return res.status(404).json({ error: 'Template not found' })
      try {
        await fs.access(filePath)
      } catch {
        return res.status(404).json({ error: 'Template image missing' })
      }
      res.setHeader('Content-Type', 'image/png')
      res.setHeader('Cache-Control', 'no-store')
      res.sendFile(filePath)
    } catch (error) {
      console.error('Error serving watermark template:', error)
      res.status(500).json({ error: 'Failed to serve template' })
    }
  })

  /** POST /chapters/:chapterId/detect — run detection and return canvas-space rects + manifest. */
  router.post('/chapters/:chapterId/detect', async (req: Request, res: Response) => {
    try {
      const result = await detectChapterWatermarksPreview(req.params.chapterId)
      res.json(result)
    } catch (error) {
      console.error('Error detecting watermarks:', error)
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to detect watermarks' })
    }
  })

  return router
}
