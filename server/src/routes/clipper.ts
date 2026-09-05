/**
 * Clipper API Routes — Module 3: Image Clipper
 * 
 * Endpoints for:
 * - Listing eligible series/chapters
 * - Serving chapter images to the browser
 * - Managing crop sessions and individual crops
 * - Generating previews
 * - Finalizing (exporting crops to disk)
 */

import { Router, Request, Response } from 'express'
import path from 'path'
import fs from 'fs/promises'
import { Server } from 'socket.io'
import { prisma } from '../index.js'
import {
  getChapterManifest,
  computeCropFromCanvas,
  normalizeCoordinates,
  generateCropPreview,
  finalizeSession
} from '../services/clipperService.js'

export function initClipperRoutes(io: Server): Router {
  const router = Router()

  // Helper to get full folder path
  function getFullFolderPath(relativePath: string): string {
    const downloadRoot = process.env.DOWNLOAD_ROOT || './downloads'
    return path.join(downloadRoot, relativePath)
  }

  // Compute prev/next eligible (download-complete) chapters within the same
  // series so the workspace can jump straight to the adjacent chapter.
  async function getChapterNavigation(chapter: { id: string; seriesId: string }) {
    const siblings = await prisma.chapter.findMany({
      where: { seriesId: chapter.seriesId, status: 'done' },
      orderBy: { number: 'asc' },
      select: { id: true, number: true }
    })
    const idx = siblings.findIndex(c => c.id === chapter.id)
    const prev = idx > 0 ? siblings[idx - 1] : null
    const next = idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1] : null
    return {
      seriesId: chapter.seriesId,
      prevChapterId: prev?.id ?? null,
      prevChapterNumber: prev?.number ?? null,
      nextChapterId: next?.id ?? null,
      nextChapterNumber: next?.number ?? null
    }
  }

  // ============ Series & Chapter Listing ============

  /**
   * GET /series
   * List series that have at least one voiceover-complete chapter.
   * A chapter is eligible if it has download status = 'done' and a joined audio file.
   */
  router.get('/series', async (_req: Request, res: Response) => {
    try {
      const series = await prisma.series.findMany({
        include: {
          chapters: {
            where: { status: 'done' },
            include: {
              cropSession: true
            }
          }
        },
        orderBy: { title: 'asc' }
      })

      // Filter to series that have at least one downloaded chapter
      const result = series
        .map(s => {
          const eligibleChapters = s.chapters
          return {
            id: s.id,
            title: s.title,
            sourceSite: s.sourceSite,
            coverPath: s.coverPath,
            rootFolder: s.rootFolder,
            createdAt: s.createdAt.toISOString(),
            eligibleChapterCount: eligibleChapters.length,
            croppedChapterCount: eligibleChapters.filter(
              ch => ch.cropSession?.status === 'finalized'
            ).length
          }
        })
        .filter(s => s.eligibleChapterCount > 0)

      res.json(result)
    } catch (error) {
      console.error('Error fetching clipper series:', error)
      res.status(500).json({ error: 'Failed to fetch series' })
    }
  })

  /**
   * GET /series/:id
   * Series detail with chapters and their crop status.
   */
  router.get('/series/:id', async (req: Request, res: Response) => {
    try {
      const series = await prisma.series.findUnique({
        where: { id: req.params.id },
        include: {
          chapters: {
            where: { status: 'done' },
            include: {
              cropSession: {
                include: { _count: { select: { crops: true } } }
              }
            },
            orderBy: { number: 'asc' }
          }
        }
      })

      if (!series) {
        return res.status(404).json({ error: 'Series not found' })
      }

      // Shape response
      const chapters = series.chapters
        .map(ch => ({
          id: ch.id,
          number: ch.number,
          title: ch.title,
          folderPath: ch.folderPath,
          pageCount: ch.pageCount,
          hasSession: !!ch.cropSession,
          sessionId: ch.cropSession?.id || null,
          sessionStatus: ch.cropSession?.status || null,
          cropCount: ch.cropSession?._count?.crops || 0
        }))

      res.json({
        id: series.id,
        title: series.title,
        sourceSite: series.sourceSite,
        coverPath: series.coverPath,
        rootFolder: series.rootFolder,
        createdAt: series.createdAt.toISOString(),
        chapters
      })
    } catch (error) {
      console.error('Error fetching clipper series detail:', error)
      res.status(500).json({ error: 'Failed to fetch series detail' })
    }
  })

  // ============ Chapter Manifest & Image Serving ============

  /**
   * GET /chapters/:id/manifest
   * Returns the image manifest: list of images with dimensions and canvas offsets.
   */
  router.get('/chapters/:id/manifest', async (req: Request, res: Response) => {
    try {
      const chapter = await prisma.chapter.findUnique({
        where: { id: req.params.id }
      })

      if (!chapter) {
        return res.status(404).json({ error: 'Chapter not found' })
      }

      const manifest = await getChapterManifest(chapter.folderPath)
      res.json(manifest)
    } catch (error) {
      console.error('Error building manifest:', error)
      res.status(500).json({ error: 'Failed to build image manifest' })
    }
  })

  /**
   * GET /chapters/:id/image/:filename
   * Serve a single chapter image file to the browser.
   * Scoped to the chapter's folder only.
   */
  router.get('/chapters/:id/image/:filename', async (req: Request, res: Response) => {
    try {
      const chapter = await prisma.chapter.findUnique({
        where: { id: req.params.id }
      })

      if (!chapter) {
        return res.status(404).json({ error: 'Chapter not found' })
      }

      const filename = path.basename(req.params.filename) // Sanitize
      const fullPath = path.resolve(getFullFolderPath(chapter.folderPath), filename)

      // Verify file exists
      try {
        await fs.access(fullPath)
      } catch {
        return res.status(404).json({ error: 'Image not found' })
      }

      // Determine MIME type
      const ext = path.extname(filename).toLowerCase()
      const mimeTypes: Record<string, string> = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.webp': 'image/webp',
        '.gif': 'image/gif'
      }

      res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream')
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable') // Cache for 24h
      res.sendFile(fullPath)
    } catch (error) {
      console.error('Error serving image:', error)
      // Don't cache error responses
      res.setHeader('Cache-Control', 'no-store')
      res.status(500).json({ error: 'Failed to serve image' })
    }
  })

  // ============ Session Management ============

  /**
   * POST /chapters/:id/session
   * Create or return existing CropSession for a chapter.
   */
  router.post('/chapters/:id/session', async (req: Request, res: Response) => {
    try {
      const chapterId = req.params.id

      // Verify chapter exists and is eligible
      const chapter = await prisma.chapter.findUnique({
        where: { id: chapterId }
      })

      if (!chapter) {
        return res.status(404).json({ error: 'Chapter not found' })
      }

      if (chapter.status !== 'done') {
        return res.status(400).json({ error: 'Chapter download not complete' })
      }

      // Find or create session atomically to handle concurrent requests (e.g., React Strict Mode)
      const session = await prisma.cropSession.upsert({
        where: { chapterId },
        update: {}, // do nothing if it already exists
        create: { chapterId },
        include: {
          crops: { orderBy: { sequence: 'asc' } },
          chapter: { select: { id: true, number: true, folderPath: true, seriesId: true } }
        }
      })

      const navigation = await getChapterNavigation({
        id: session.chapter.id,
        seriesId: session.chapter.seriesId
      })

      res.json({ ...session, navigation })
    } catch (error) {
      console.error('Error creating/getting session:', error)
      res.status(500).json({ error: 'Failed to create session' })
    }
  })

  /**
   * GET /sessions/:id
   * Get session with all crops.
   */
  router.get('/sessions/:id', async (req: Request, res: Response) => {
    try {
      const session = await prisma.cropSession.findUnique({
        where: { id: req.params.id },
        include: {
          crops: { orderBy: { sequence: 'asc' } },
          chapter: { select: { id: true, number: true, folderPath: true, seriesId: true } }
        }
      })

      if (!session) {
        return res.status(404).json({ error: 'Session not found' })
      }

      const navigation = await getChapterNavigation({
        id: session.chapter.id,
        seriesId: session.chapter.seriesId
      })

      res.json({ ...session, navigation })
    } catch (error) {
      console.error('Error fetching session:', error)
      res.status(500).json({ error: 'Failed to fetch session' })
    }
  })

  // ============ Crop CRUD ============

  /**
   * POST /sessions/:id/crops
   * Create a new crop.
   */
  router.post('/sessions/:id/crops', async (req: Request, res: Response) => {
    try {
      const session = await prisma.cropSession.findUnique({
        where: { id: req.params.id },
        include: {
          chapter: true,
          _count: { select: { crops: true } }
        }
      })

      if (!session) {
        return res.status(404).json({ error: 'Session not found' })
      }

      const { canvasX, canvasY, canvasW, canvasH, aspectRatio } = req.body

      if (canvasX == null || canvasY == null || canvasW == null || canvasH == null) {
        return res.status(400).json({ error: 'canvasX, canvasY, canvasW, canvasH are required' })
      }

      // Build manifest to compute normalized coordinates and source files
      const manifest = await getChapterManifest(session.chapter.folderPath)
      const norm = normalizeCoordinates(
        { canvasX, canvasY, canvasW, canvasH },
        manifest
      )
      const sourceRegions = computeCropFromCanvas(
        { canvasX, canvasY, canvasW, canvasH },
        manifest
      )

      const nextSequence = (session._count?.crops || 0) + 1

      const crop = await prisma.crop.create({
        data: {
          sessionId: session.id,
          sequence: nextSequence,
          canvasX,
          canvasY,
          canvasW,
          canvasH,
          normX: norm.normX,
          normY: norm.normY,
          normW: norm.normW,
          normH: norm.normH,
          sourceFiles: JSON.stringify(sourceRegions),
          aspectRatio: aspectRatio || 'free'
        }
      })

      // Update crop count
      await prisma.cropSession.update({
        where: { id: session.id },
        data: { cropCount: nextSequence }
      })

      // Log event
      await prisma.cropEvent.create({
        data: {
          sessionId: session.id,
          cropId: crop.id,
          action: 'created',
          payload: JSON.stringify({ canvasX, canvasY, canvasW, canvasH, aspectRatio })
        }
      })

      res.json(crop)
    } catch (error) {
      console.error('Error creating crop:', error)
      res.status(500).json({ error: 'Failed to create crop' })
    }
  })

  /**
   * PATCH /crops/:id
   * Update crop geometry (resize/move).
   */
  router.patch('/crops/:id', async (req: Request, res: Response) => {
    try {
      const crop = await prisma.crop.findUnique({
        where: { id: req.params.id },
        include: { session: { include: { chapter: true } } }
      })

      if (!crop) {
        return res.status(404).json({ error: 'Crop not found' })
      }

      const { canvasX, canvasY, canvasW, canvasH, aspectRatio } = req.body

      // Rebuild manifest for normalization
      const manifest = await getChapterManifest(crop.session.chapter.folderPath)

      const newX = canvasX ?? crop.canvasX
      const newY = canvasY ?? crop.canvasY
      const newW = canvasW ?? crop.canvasW
      const newH = canvasH ?? crop.canvasH

      const norm = normalizeCoordinates(
        { canvasX: newX, canvasY: newY, canvasW: newW, canvasH: newH },
        manifest
      )
      const sourceRegions = computeCropFromCanvas(
        { canvasX: newX, canvasY: newY, canvasW: newW, canvasH: newH },
        manifest
      )

      const updated = await prisma.crop.update({
        where: { id: req.params.id },
        data: {
          canvasX: newX,
          canvasY: newY,
          canvasW: newW,
          canvasH: newH,
          normX: norm.normX,
          normY: norm.normY,
          normW: norm.normW,
          normH: norm.normH,
          sourceFiles: JSON.stringify(sourceRegions),
          aspectRatio: aspectRatio !== undefined ? aspectRatio : crop.aspectRatio
        }
      })

      // Log event
      await prisma.cropEvent.create({
        data: {
          sessionId: crop.sessionId,
          cropId: crop.id,
          action: canvasX !== undefined || canvasY !== undefined ? 'moved' : 'resized',
          payload: JSON.stringify({ canvasX: newX, canvasY: newY, canvasW: newW, canvasH: newH })
        }
      })

      res.json(updated)
    } catch (error) {
      console.error('Error updating crop:', error)
      res.status(500).json({ error: 'Failed to update crop' })
    }
  })

  /**
   * DELETE /crops/:id
   * Delete a crop.
   */
  router.delete('/crops/:id', async (req: Request, res: Response) => {
    try {
      const crop = await prisma.crop.findUnique({
        where: { id: req.params.id }
      })

      if (!crop) {
        return res.status(404).json({ error: 'Crop not found' })
      }

      // Log deletion event before deleting
      await prisma.cropEvent.create({
        data: {
          sessionId: crop.sessionId,
          cropId: null, // Will be null after delete
          action: 'deleted',
          payload: JSON.stringify({
            deletedCropId: crop.id,
            sequence: crop.sequence,
            canvasX: crop.canvasX,
            canvasY: crop.canvasY,
            canvasW: crop.canvasW,
            canvasH: crop.canvasH
          })
        }
      })

      await prisma.crop.delete({ where: { id: req.params.id } })

      // Resequence remaining crops
      const remainingCrops = await prisma.crop.findMany({
        where: { sessionId: crop.sessionId },
        orderBy: { sequence: 'asc' }
      })

      for (let i = 0; i < remainingCrops.length; i++) {
        if (remainingCrops[i].sequence !== i + 1) {
          await prisma.crop.update({
            where: { id: remainingCrops[i].id },
            data: { sequence: i + 1 }
          })
        }
      }

      // Update crop count
      await prisma.cropSession.update({
        where: { id: crop.sessionId },
        data: { cropCount: remainingCrops.length }
      })

      res.json({ message: 'Crop deleted' })
    } catch (error) {
      console.error('Error deleting crop:', error)
      res.status(500).json({ error: 'Failed to delete crop' })
    }
  })

  /**
   * POST /crops/:id/preview
   * Generate a preview thumbnail for a crop.
   */
  router.post('/crops/:id/preview', async (req: Request, res: Response) => {
    try {
      const crop = await prisma.crop.findUnique({
        where: { id: req.params.id },
        include: { session: { include: { chapter: true } } }
      })

      if (!crop) {
        return res.status(404).json({ error: 'Crop not found' })
      }

      const manifest = await getChapterManifest(crop.session.chapter.folderPath)

      const preview = await generateCropPreview(
        {
          canvasX: crop.canvasX,
          canvasY: crop.canvasY,
          canvasW: crop.canvasW,
          canvasH: crop.canvasH
        },
        manifest,
        crop.session.chapter.folderPath
      )

      res.json({ preview })
    } catch (error) {
      console.error('Error generating preview:', error)
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to generate preview' })
    }
  })

  /**
   * PUT /sessions/:id/reorder
   * Reorder crop sequences.
   */
  router.put('/sessions/:id/reorder', async (req: Request, res: Response) => {
    try {
      const { cropIds } = req.body // Ordered array of crop IDs

      if (!Array.isArray(cropIds)) {
        return res.status(400).json({ error: 'cropIds array required' })
      }

      for (let i = 0; i < cropIds.length; i++) {
        await prisma.crop.update({
          where: { id: cropIds[i] },
          data: { sequence: i + 1 }
        })
      }

      res.json({ message: 'Crops reordered' })
    } catch (error) {
      console.error('Error reordering crops:', error)
      res.status(500).json({ error: 'Failed to reorder crops' })
    }
  })

  /**
   * POST /sessions/:id/finalize
   * Execute all crops and export to disk.
   */
  router.post('/sessions/:id/finalize', async (req: Request, res: Response) => {
    try {
      const session = await prisma.cropSession.findUnique({
        where: { id: req.params.id }
      })

      if (!session) {
        return res.status(404).json({ error: 'Session not found' })
      }

      // Run finalization asynchronously
      finalizeSession(req.params.id, io).catch(err => {
        console.error('Finalization error:', err)
        io.emit('clipper:finalize-complete', {
          sessionId: req.params.id,
          success: false,
          error: err.message
        })
      })

      res.json({ started: true, message: 'Finalization started' })
    } catch (error) {
      console.error('Error starting finalization:', error)
      res.status(500).json({ error: 'Failed to start finalization' })
    }
  })

  return router
}
