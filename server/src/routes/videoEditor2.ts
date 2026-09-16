/**
 * Video Editor 2.0 routes — Module 4v2
 *
 * Phase 1: series → chapter readiness only. The compile/timeline/render
 * workspace lands in a later phase.
 */

import { Router, Request, Response } from 'express'
import { createReadStream, existsSync, statSync } from 'fs'
import path from 'path'
import { Server } from 'socket.io'
import { prisma } from '../index.js'
import {
  getChapterCropMetadataBundle,
  getChapterTimelineBundle,
  getEditableChapters2
} from '../services/videoEditor2Service.js'
import { processTimelineJson } from '../services/editor2Timeline.js'
import {
  cancelExport2Job,
  getExport2Job,
  getExportedChapterIds,
  startBatchExport,
  type Export2Input
} from '../services/editor2Export.js'

export function initVideoEditor2Routes(io: Server): Router {
  const router = Router()

  /** GET /series/:seriesId/editable-chapters */
  router.get('/series/:seriesId/editable-chapters', async (req: Request, res: Response) => {
    try {
      const chapters = await getEditableChapters2(req.params.seriesId)
      res.json(chapters)
    } catch (error) {
      console.error('[videoEditor2] listing editable chapters failed:', error)
      res.status(500).json({ error: 'Failed to list editable chapters' })
    }
  })

  /**
   * GET /chapters/:id/timeline-bundle
   *
   * Every section's "script with timeline" for one chapter, joined in reading
   * order, so the user copies a whole chapter in one action.
   */
  router.get('/chapters/:id/timeline-bundle', async (req: Request, res: Response) => {
    try {
      const bundle = await getChapterTimelineBundle(req.params.id)
      if (!bundle) return res.status(404).json({ error: 'Chapter not found' })
      res.json(bundle)
    } catch (error) {
      console.error('[videoEditor2] building timeline bundle failed:', error)
      res.status(500).json({ error: 'Failed to collect the script with timeline' })
    }
  })

  /**
   * GET /chapters/:id/crop-metadata-bundle
   *
   * Every image's Image Clipper 3.0 metadata document for one chapter, joined
   * in image order.
   */
  router.get('/chapters/:id/crop-metadata-bundle', async (req: Request, res: Response) => {
    try {
      const bundle = await getChapterCropMetadataBundle(req.params.id)
      if (!bundle) return res.status(404).json({ error: 'Chapter not found' })
      res.json(bundle)
    } catch (error) {
      console.error('[videoEditor2] building crop metadata bundle failed:', error)
      res.status(500).json({ error: 'Failed to collect the crop metadata' })
    }
  })

  /**
   * POST /chapters/:id/process-timeline { json }
   *
   * Turns pasted timeline JSON into a playable plan. Read-only: nothing is
   * written, so the same paste can be processed as often as needed while the
   * JSON is being corrected.
   */
  router.post('/chapters/:id/process-timeline', async (req: Request, res: Response) => {
    try {
      const { json } = req.body
      if (typeof json !== 'string' || json.trim().length === 0) {
        return res.status(400).json({ error: 'json (non-empty string) is required' })
      }
      const plan = await processTimelineJson(req.params.id, json)
      res.json(plan)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to process the timeline'
      console.error('[videoEditor2] processing timeline failed:', message)
      // A bad paste is the user's to fix, so it reports as a 400 with the
      // reason rather than an opaque server error.
      const status = /not found/i.test(message) ? 404 : 400
      res.status(status).json({ error: message })
    }
  })

  /**
   * GET /chapters/:id/sections/:sectionId/audio
   *
   * Streams one voice section's audio for the preview player, with range
   * support so seeking works.
   */
  router.get('/chapters/:id/sections/:sectionId/audio', async (req: Request, res: Response) => {
    try {
      const section = await prisma.audioSection.findFirst({
        where: { id: req.params.sectionId, chapterId: req.params.id },
        include: { audioFile: true }
      })
      if (!section?.audioFile) {
        return res.status(404).json({ error: 'No audio for this section' })
      }

      const filePath = path.isAbsolute(section.audioFile.filePath)
        ? section.audioFile.filePath
        : path.resolve(section.audioFile.filePath)
      if (!existsSync(filePath)) {
        return res.status(404).json({ error: 'Audio file is missing on disk' })
      }

      const { size } = statSync(filePath)
      const contentType = /\.mp3$/i.test(filePath) ? 'audio/mpeg' : 'audio/wav'
      const range = req.headers.range

      if (range) {
        const match = /bytes=(\d*)-(\d*)/.exec(range)
        const start = match?.[1] ? Number(match[1]) : 0
        const end = match?.[2] ? Number(match[2]) : size - 1
        if (start >= size || end >= size || start > end) {
          res.status(416).set('Content-Range', `bytes */${size}`).end()
          return
        }
        res.status(206).set({
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(end - start + 1),
          'Content-Type': contentType
        })
        createReadStream(filePath, { start, end }).pipe(res)
        return
      }

      res.set({
        'Content-Length': String(size),
        'Accept-Ranges': 'bytes',
        'Content-Type': contentType
      })
      createReadStream(filePath).pipe(res)
    } catch (error) {
      console.error('[videoEditor2] streaming section audio failed:', error)
      res.status(500).json({ error: 'Failed to stream section audio' })
    }
  })

  // ============ Batch export ============

  /**
   * GET /series/:seriesId/exports
   *
   * Which chapters of this series already have a rendered MP4. Editor 2.0 has
   * no project rows, so the `_video2` folder is the record — scanning it here
   * is what lets the list mark chapters "Exported" across reloads and machines,
   * and what stops Export All from re-rendering finished work.
   */
  router.get('/series/:seriesId/exports', async (req: Request, res: Response) => {
    try {
      const exported = await getExportedChapterIds(req.params.seriesId)
      res.json(exported)
    } catch (error) {
      console.error('[videoEditor2] listing exports failed:', error)
      res.status(500).json({ error: 'Failed to list exported chapters' })
    }
  })

  /**
   * POST /series/:seriesId/export-all { chapters: [{ chapterId, json }], resolution, preset, fps, force }
   *
   * Renders one MP4 per chapter in a single background job and returns its id
   * straight away. The pasted JSON travels with the request because Editor 2.0
   * keeps it in the browser rather than the database — re-processing it here is
   * what makes the export match what was previewed.
   *
   * Chapters that already have an MP4 in `_video2` are reported as skipped
   * rather than rendered again; pass `force: true` to re-render them anyway.
   */
  router.post('/series/:seriesId/export-all', async (req: Request, res: Response) => {
    try {
      const { chapters, resolution = '1920x1080', preset = 'medium', fps, force } = req.body

      if (!Array.isArray(chapters) || chapters.length === 0) {
        return res.status(400).json({ error: 'chapters (non-empty array) is required' })
      }
      const inputs: Export2Input[] = []
      for (const entry of chapters) {
        const chapterId = entry?.chapterId
        const json = entry?.json
        if (typeof chapterId !== 'string' || !chapterId.trim()) {
          return res.status(400).json({ error: 'Every chapter needs a chapterId' })
        }
        if (typeof json !== 'string' || !json.trim()) {
          return res.status(400).json({ error: `Chapter ${chapterId} has no timeline JSON to export` })
        }
        inputs.push({ chapterId, json })
      }

      const jobId = await startBatchExport(
        req.params.seriesId,
        inputs,
        { resolution, preset, fps: Number(fps) || undefined, force: force === true },
        io
      )
      res.json({ jobId })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start the export'
      console.error('[videoEditor2] starting batch export failed:', message)
      res.status(500).json({ error: message })
    }
  })

  /** GET /exports/:jobId — batch export progress. */
  router.get('/exports/:jobId', (req: Request, res: Response) => {
    const job = getExport2Job(req.params.jobId)
    if (!job) return res.status(404).json({ error: 'Export job not found' })
    res.json(job)
  })

  /** POST /exports/:jobId/cancel — stop a running batch export. */
  router.post('/exports/:jobId/cancel', (req: Request, res: Response) => {
    const ok = cancelExport2Job(req.params.jobId)
    if (!ok) return res.status(404).json({ error: 'No running export with that id' })
    res.json({ cancelled: true })
  })

  return router
}
