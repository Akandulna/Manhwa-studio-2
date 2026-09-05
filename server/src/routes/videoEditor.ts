/**
 * Video Editor API Routes — Module 4: Video Editor
 *
 * Projects, part-image editing, render/export (with Socket.io progress + cancel),
 * the global Music Library, and file serving for crops / music / rendered videos.
 */

import { Router, Request, Response } from 'express'
import { Server } from 'socket.io'
import { exec } from 'child_process'
import { createReadStream, existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import multer from 'multer'
import { prisma } from '../index.js'
import {
  initProject,
  getProjectTree,
  listSeriesProjects,
  deleteProject,
  getEditableChapters,
  getChapterCrops,
  updateProject,
  setPartImages,
  startProjectRender,
  cancelRender,
  renderProxyPreview,
  getVideoCapabilities,
  RESOLUTIONS
} from '../services/videoEditorService.js'
import {
  suggestImagesForPart,
  suggestDurationsForPart,
  suggestAnchorForImage,
  isAiAssistAvailable
} from '../services/videoAiAssist.js'

// Latest proxy-preview file per project (ephemeral, served back to the client).
const latestPreview = new Map<string, string>()

function getMusicDir(): string {
  return path.join(process.env.DOWNLOAD_ROOT || './downloads', '_music')
}

const VIDEO_MIME: Record<string, string> = { mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska' }
const AUDIO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac'
}
const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }

/** Stream a file with HTTP range support (for <video>/<audio>/<img> in the client). */
async function streamFile(res: Response, filePath: string, mimeMap: Record<string, string>, range?: string) {
  if (!existsSync(filePath)) {
    res.status(404).json({ error: 'File not found on disk' })
    return
  }
  const stat = await fs.stat(filePath)
  const ext = path.extname(filePath).slice(1).toLowerCase()
  const contentType = mimeMap[ext] || 'application/octet-stream'

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-')
    const start = parseInt(parts[0], 10)
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': contentType
    })
    createReadStream(filePath, { start, end }).pipe(res)
  } else {
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': contentType, 'Accept-Ranges': 'bytes' })
    createReadStream(filePath).pipe(res)
  }
}

// Multer storage for music uploads → DOWNLOAD_ROOT/_music.
const musicStorage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    const dir = getMusicDir()
    await fs.mkdir(dir, { recursive: true })
    cb(null, dir)
  },
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.\-]+/g, '_')
    cb(null, `${Date.now()}_${safe}`)
  }
})
const MUSIC_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a', '.opus', '.weba']
const musicUpload = multer({
  storage: musicStorage,
  fileFilter: (_req, file, cb) => {
    // MIME types for the same extension vary across browsers/OSes (e.g. .wav is
    // reported as audio/wav, audio/x-wav, audio/wave, or application/octet-stream),
    // so accept anything that looks like audio by MIME OR by file extension.
    const ext = path.extname(file.originalname).toLowerCase()
    const ok = file.mimetype.startsWith('audio/') || MUSIC_EXTENSIONS.includes(ext)
    if (ok) cb(null, true)
    else cb(new Error('Unsupported audio file type'))
  },
  limits: { fileSize: 100 * 1024 * 1024 }
})

export function initVideoEditorRoutes(io: Server): Router {
  const router = Router()

  // ============ Capabilities ============

  router.get('/capabilities', (_req: Request, res: Response) => {
    res.json({ ...getVideoCapabilities(), resolutions: Object.keys(RESOLUTIONS), aiAssist: isAiAssistAvailable() })
  })

  // ============ Projects ============

  router.post('/projects/init', async (req: Request, res: Response) => {
    try {
      const { seriesId, chapterIds, name } = req.body
      if (!seriesId || !Array.isArray(chapterIds) || chapterIds.length === 0) {
        return res.status(400).json({ error: 'seriesId and a non-empty chapterIds array are required' })
      }
      const projectId = await initProject(seriesId, chapterIds, name)
      res.json(await getProjectTree(projectId))
    } catch (error) {
      console.error('Error initializing video project:', error)
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to initialize project' })
    }
  })

  router.get('/projects/:id', async (req: Request, res: Response) => {
    try {
      const tree = await getProjectTree(req.params.id)
      if (!tree) return res.status(404).json({ error: 'Project not found' })
      res.json(tree)
    } catch (error) {
      console.error('Error fetching video project:', error)
      res.status(500).json({ error: 'Failed to fetch project' })
    }
  })

  router.put('/projects/:id', async (req: Request, res: Response) => {
    try {
      const tree = await updateProject(req.params.id, req.body || {})
      res.json(tree)
    } catch (error) {
      console.error('Error updating video project:', error)
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to update project' })
    }
  })

  router.delete('/projects/:id', async (req: Request, res: Response) => {
    try {
      await deleteProject(req.params.id)
      latestPreview.delete(req.params.id)
      res.json({ deleted: true })
    } catch (error) {
      console.error('Error deleting video project:', error)
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to delete project' })
    }
  })

  // Per-series video status for library badges: 'exported' | 'draft' | (absent).
  router.get('/series-status', async (_req: Request, res: Response) => {
    try {
      const projects = await prisma.videoProject.findMany({
        select: { seriesId: true, exports: { where: { status: 'done' }, select: { id: true } } }
      })
      const map: Record<string, 'draft' | 'exported'> = {}
      for (const p of projects) {
        const status = p.exports.length > 0 ? 'exported' : 'draft'
        if (map[p.seriesId] !== 'exported') map[p.seriesId] = status
      }
      res.json(map)
    } catch (error) {
      console.error('Error fetching series video status:', error)
      res.status(500).json({ error: 'Failed to fetch status' })
    }
  })

  // Existing video projects ("parts") for a series, with editing progress, so the
  // editor can list them as resumable accordions.
  router.get('/series/:seriesId/projects', async (req: Request, res: Response) => {
    try {
      res.json(await listSeriesProjects(req.params.seriesId))
    } catch (error) {
      console.error('Error listing series video projects:', error)
      res.status(500).json({ error: 'Failed to list projects' })
    }
  })

  // ============ Editable chapters & crop pool ============

  router.get('/series/:seriesId/editable-chapters', async (req: Request, res: Response) => {
    try {
      res.json(await getEditableChapters(req.params.seriesId))
    } catch (error) {
      console.error('Error fetching editable chapters:', error)
      res.status(500).json({ error: 'Failed to fetch editable chapters' })
    }
  })

  router.get('/chapters/:chapterId/crops', async (req: Request, res: Response) => {
    try {
      res.json(await getChapterCrops(req.params.chapterId))
    } catch (error) {
      console.error('Error fetching chapter crops:', error)
      res.status(500).json({ error: 'Failed to fetch chapter crops' })
    }
  })

  // ============ Part image editing ============

  router.put('/parts/:partId/images', async (req: Request, res: Response) => {
    try {
      const { images, event } = req.body
      if (!Array.isArray(images)) {
        return res.status(400).json({ error: 'images array is required' })
      }
      const updated = await setPartImages(req.params.partId, images, event)
      res.json(updated)
    } catch (error) {
      console.error('Error setting part images:', error)
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to set part images' })
    }
  })

  // Log a VideoEditEvent not tied to an image-list change (e.g. suggestion_rejected).
  router.post('/parts/:partId/event', async (req: Request, res: Response) => {
    try {
      const { eventType, payload } = req.body || {}
      if (!eventType) return res.status(400).json({ error: 'eventType is required' })
      const part = await prisma.videoPartEdit.findUnique({ where: { id: req.params.partId } })
      if (!part) return res.status(404).json({ error: 'Part not found' })
      await prisma.videoEditEvent.create({
        data: { projectId: part.projectId, partEditId: part.id, eventType, payloadJson: JSON.stringify(payload ?? {}) }
      })
      res.json({ logged: true })
    } catch (error) {
      console.error('Error logging event:', error)
      res.status(500).json({ error: 'Failed to log event' })
    }
  })

  // ============ AI assist (Part 6) ============

  router.post('/parts/:partId/suggest-images', async (req: Request, res: Response) => {
    try {
      const minSequence = Number(req.body?.minSequence) || 0
      const result = await suggestImagesForPart(req.params.partId, minSequence)
      res.json(result)
    } catch (error) {
      console.error('Error suggesting images:', error)
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to suggest images' })
    }
  })

  router.post('/parts/:partId/suggest-durations', async (req: Request, res: Response) => {
    try {
      const result = await suggestDurationsForPart(req.params.partId)
      res.json(result)
    } catch (error) {
      console.error('Error suggesting durations:', error)
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to suggest durations' })
    }
  })

  router.post('/images/:imageId/suggest-anchor', async (req: Request, res: Response) => {
    try {
      const result = await suggestAnchorForImage(req.params.imageId)
      res.json(result)
    } catch (error) {
      console.error('Error suggesting anchor:', error)
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to suggest anchor' })
    }
  })

  // ============ Render / export ============

  router.post('/projects/:id/render', async (req: Request, res: Response) => {
    try {
      const { resolution = '1920x1080', preset = 'medium', fps } = req.body || {}
      const exportId = await startProjectRender(req.params.id, { resolution, preset, fps: Number(fps) || undefined }, io)
      res.json({ exportId })
    } catch (error) {
      console.error('Error starting render:', error)
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to start render' })
    }
  })

  router.post('/exports/:exportId/cancel', (req: Request, res: Response) => {
    const ok = cancelRender(req.params.exportId)
    res.json({ cancelled: ok })
  })

  // ============ Proxy preview ============

  // Render a low-res draft for a scope. Streams progress via Socket.io and stores
  // the result so the client can fetch it from /projects/:id/preview/file.
  router.post('/projects/:id/preview', async (req: Request, res: Response) => {
    const projectId = req.params.id
    const scope = req.body?.scope // 'project' | { partId } | { chapterId }
    res.json({ started: true })

    try {
      const { outputPath } = await renderProxyPreview(projectId, scope, {
        onProgress: (percent) => io.emit('video:preview-progress', { projectId, percent: Math.round(percent) })
      })
      latestPreview.set(projectId, outputPath)
      io.emit('video:preview-complete', { projectId, success: true })
    } catch (error) {
      io.emit('video:preview-complete', {
        projectId,
        success: false,
        error: error instanceof Error ? error.message : 'Preview failed'
      })
    }
  })

  router.get('/projects/:id/preview/file', async (req: Request, res: Response) => {
    const filePath = latestPreview.get(req.params.id)
    if (!filePath) return res.status(404).json({ error: 'No preview available' })
    await streamFile(res, filePath, VIDEO_MIME, req.headers.range)
  })

  router.get('/exports/:exportId', async (req: Request, res: Response) => {
    try {
      const exp = await prisma.videoExport.findUnique({ where: { id: req.params.exportId } })
      if (!exp) return res.status(404).json({ error: 'Export not found' })
      res.json(exp)
    } catch (error) {
      console.error('Error fetching export:', error)
      res.status(500).json({ error: 'Failed to fetch export' })
    }
  })

  // Open the output folder in the OS file explorer (mirrors /api/downloads/open-folder).
  router.get('/exports/:exportId/open', async (req: Request, res: Response) => {
    try {
      const exp = await prisma.videoExport.findUnique({ where: { id: req.params.exportId } })
      if (!exp || !exp.outputPath) return res.status(404).json({ error: 'Export not found' })
      const dir = path.dirname(path.resolve(exp.outputPath))
      const command =
        process.platform === 'darwin' ? `open "${dir}"`
          : process.platform === 'win32' ? `explorer "${dir}"`
            : `xdg-open "${dir}"`
      exec(command, err => { if (err) console.error('Open folder failed:', err) })
      res.json({ success: true, path: dir })
    } catch (error) {
      console.error('Error opening export folder:', error)
      res.status(500).json({ error: 'Failed to open folder' })
    }
  })

  // Stream the rendered MP4 (for in-app playback).
  router.get('/exports/:exportId/file', async (req: Request, res: Response) => {
    try {
      const exp = await prisma.videoExport.findUnique({ where: { id: req.params.exportId } })
      if (!exp || !exp.outputPath) return res.status(404).json({ error: 'Export not found' })
      await streamFile(res, exp.outputPath, VIDEO_MIME, req.headers.range)
    } catch (error) {
      console.error('Error streaming export:', error)
      res.status(500).json({ error: 'Failed to stream export' })
    }
  })

  // Stream a part's master-clock audio (for the client-side live preview).
  router.get('/parts/:partId/audio', async (req: Request, res: Response) => {
    try {
      const part = await prisma.videoPartEdit.findUnique({ where: { id: req.params.partId } })
      if (!part?.audioSectionId) return res.status(404).json({ error: 'Part has no audio' })
      const audioFile = await prisma.audioFile.findFirst({
        where: { sectionId: part.audioSectionId, status: 'done' }
      })
      if (!audioFile) return res.status(404).json({ error: 'Audio file not found' })
      await streamFile(res, audioFile.filePath, AUDIO_MIME, req.headers.range)
    } catch (error) {
      console.error('Error streaming part audio:', error)
      res.status(500).json({ error: 'Failed to stream part audio' })
    }
  })

  // ============ Crop image serving (selection panel + live preview) ============

  router.get('/crops/:cropId/image', async (req: Request, res: Response) => {
    try {
      const crop = await prisma.crop.findUnique({ where: { id: req.params.cropId } })
      if (!crop?.exportPath) return res.status(404).json({ error: 'Crop image not found' })
      res.setHeader('Cache-Control', 'public, max-age=86400')
      await streamFile(res, crop.exportPath, IMAGE_MIME, req.headers.range)
    } catch (error) {
      console.error('Error serving crop image:', error)
      res.status(500).json({ error: 'Failed to serve crop image' })
    }
  })

  // ============ Music Library (global) ============

  router.get('/music', async (_req: Request, res: Response) => {
    try {
      const tracks = await prisma.musicTrack.findMany({ orderBy: { createdAt: 'desc' } })
      res.json(tracks)
    } catch (error) {
      console.error('Error listing music:', error)
      res.status(500).json({ error: 'Failed to list music' })
    }
  })

  router.post('/music', musicUpload.single('track'), async (req: Request, res: Response) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No track uploaded (field name: track)' })
      const track = await prisma.musicTrack.create({
        data: { filename: req.file.originalname, filePath: req.file.path }
      })
      res.json(track)
    } catch (error) {
      console.error('Error uploading music:', error)
      res.status(500).json({ error: 'Failed to upload music' })
    }
  })

  router.delete('/music/:id', async (req: Request, res: Response) => {
    try {
      const track = await prisma.musicTrack.findUnique({ where: { id: req.params.id } })
      if (!track) return res.status(404).json({ error: 'Track not found' })
      await fs.rm(track.filePath, { force: true }).catch(() => {})
      // FK is SetNull, so projects referencing it are left without music.
      await prisma.musicTrack.delete({ where: { id: req.params.id } })
      res.json({ message: 'Track deleted' })
    } catch (error) {
      console.error('Error deleting music:', error)
      res.status(500).json({ error: 'Failed to delete music' })
    }
  })

  router.get('/music/:id/file', async (req: Request, res: Response) => {
    try {
      const track = await prisma.musicTrack.findUnique({ where: { id: req.params.id } })
      if (!track) return res.status(404).json({ error: 'Track not found' })
      await streamFile(res, track.filePath, AUDIO_MIME, req.headers.range)
    } catch (error) {
      console.error('Error streaming music:', error)
      res.status(500).json({ error: 'Failed to stream music' })
    }
  })

  return router
}
