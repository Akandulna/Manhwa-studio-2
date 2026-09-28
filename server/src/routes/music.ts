/**
 * Music Library API — global background tracks.
 *
 * Tracks are uploaded to DOWNLOAD_ROOT/_music and indexed by the MusicTrack
 * table.
 */

import { Router, Request, Response } from 'express'
import { createReadStream, existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import multer from 'multer'
import { prisma } from '../index.js'

function getMusicDir(): string {
  return path.join(process.env.DOWNLOAD_ROOT || './downloads', '_music')
}

const AUDIO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac'
}

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

export function initMusicRoutes(): Router {
  const router = Router()

  router.get('/', async (_req: Request, res: Response) => {
    try {
      const tracks = await prisma.musicTrack.findMany({ orderBy: { createdAt: 'desc' } })
      res.json(tracks)
    } catch (error) {
      console.error('Error listing music:', error)
      res.status(500).json({ error: 'Failed to list music' })
    }
  })

  router.post('/', musicUpload.single('track'), async (req: Request, res: Response) => {
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

  router.delete('/:id', async (req: Request, res: Response) => {
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

  router.get('/:id/file', async (req: Request, res: Response) => {
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
