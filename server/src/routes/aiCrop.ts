/**
 * AI Auto-Crop API Routes — Module 3 AI
 *
 * Endpoints:
 *   GET    /status                  model/dataset/sidecar status (cold-start aware)
 *   POST   /suggest                 run Stage A (+B) for a session; streams over Socket.io
 *   POST   /cancel                  cancel a running job for a session
 *   GET    /suggestions             pending suggestions for a session
 *   PATCH  /suggestions/:id         record accept / adjust / reject / blind rating
 *
 * (train / evaluate / model-version endpoints are added in later steps.)
 */

import { Router, Request, Response } from 'express'
import { Server } from 'socket.io'
import { prisma } from '../index.js'
import {
  getStatus,
  suggestForSession,
  trainModel,
  cancelTraining,
  evaluateModel,
  cancelEvaluation,
  listModels,
  listEvaluations,
  getEvaluatableChapters,
  setActiveModelVersion,
  setEngine,
  GUIDELINES_MODEL_VERSION,
  cancelJobs
} from '../services/ai/aiCropService.js'
import { readGuidelines, writeGuidelines, getGuidelinesMeta } from '../services/ai/guidelineCropService.js'

export function initAiCropRoutes(io: Server): Router {
  const router = Router()

  // Single in-flight training / evaluation run per server process.
  let isTraining = false
  let isEvaluating = false

  // ============ Status ============

  router.get('/status', async (_req: Request, res: Response) => {
    try {
      res.json(await getStatus())
    } catch (error) {
      console.error('Error fetching AI crop status:', error)
      res.status(500).json({ error: 'Failed to fetch status' })
    }
  })

  // ============ Suggest ============

  /**
   * POST /suggest { cropSessionId }
   * Kicks off suggestion generation asynchronously; results stream via
   * ai-crop:suggest-progress / ai-crop:suggest-complete.
   */
  router.post('/suggest', async (req: Request, res: Response) => {
    try {
      const { cropSessionId } = req.body
      if (!cropSessionId) {
        return res.status(400).json({ error: 'cropSessionId is required' })
      }

      const session = await prisma.cropSession.findUnique({ where: { id: cropSessionId } })
      if (!session) {
        return res.status(404).json({ error: 'Session not found' })
      }

      // Fire and forget; progress + results are streamed over Socket.io.
      suggestForSession(cropSessionId, io).catch(err => {
        console.error('Suggest run error:', err)
        io.emit('ai-crop:suggest-complete', { cropSessionId, error: err.message })
      })

      res.json({ started: true })
    } catch (error) {
      console.error('Error starting suggestion run:', error)
      res.status(500).json({ error: 'Failed to start suggestion run' })
    }
  })

  router.post('/cancel', async (req: Request, res: Response) => {
    try {
      const { cropSessionId, scope } = req.body
      let killed = 0
      if (scope === 'train') killed = cancelTraining()
      else if (scope === 'evaluate') killed = cancelEvaluation()
      else if (cropSessionId) killed = cancelJobs({ sessionId: cropSessionId })
      else return res.status(400).json({ error: 'cropSessionId or scope is required' })
      res.json({ cancelled: killed })
    } catch (error) {
      console.error('Error cancelling job:', error)
      res.status(500).json({ error: 'Failed to cancel job' })
    }
  })

  // ============ Training ============

  /**
   * POST /train
   * Exports the dataset and trains a new model version asynchronously;
   * progress streams via ai-crop:training-progress / ai-crop:training-complete.
   */
  router.post('/train', async (_req: Request, res: Response) => {
    try {
      if (isTraining) {
        return res.status(409).json({ error: 'Training already in progress' })
      }
      isTraining = true
      trainModel(io)
        .catch(err => {
          console.error('Training run error:', err)
          io.emit('ai-crop:training-complete', { error: err.message })
        })
        .finally(() => { isTraining = false })

      res.json({ started: true })
    } catch (error) {
      isTraining = false
      console.error('Error starting training:', error)
      res.status(500).json({ error: 'Failed to start training' })
    }
  })

  // ============ Suggestions (feedback loop) ============

  /** POST /suggestions/clear { cropSessionId } */
  router.post('/suggestions/clear', async (req: Request, res: Response) => {
    try {
      const { cropSessionId } = req.body
      if (!cropSessionId) {
        return res.status(400).json({ error: 'cropSessionId is required' })
      }
      await prisma.aISuggestion.deleteMany({ where: { cropSessionId } })
      res.json({ cleared: true })
    } catch (error) {
      console.error('Error clearing suggestions:', error)
      res.status(500).json({ error: 'Failed to clear suggestions' })
    }
  })

  /** GET /suggestions?cropSessionId=...&status=pending */
  router.get('/suggestions', async (req: Request, res: Response) => {
    try {
      const cropSessionId = req.query.cropSessionId as string | undefined
      const status = req.query.status as string | undefined
      if (!cropSessionId) {
        return res.status(400).json({ error: 'cropSessionId query param is required' })
      }

      const rows = await prisma.aISuggestion.findMany({
        where: { cropSessionId, ...(status ? { status } : {}) },
        orderBy: { createdAt: 'asc' }
      })

      res.json(rows.map(r => ({
        id: r.id,
        modelId: r.modelId,
        cropSessionId: r.cropSessionId,
        chapterId: r.chapterId,
        ...JSON.parse(r.rectJson),
        aspectPreset: r.aspectPreset,
        confidence: r.confidence,
        status: r.status,
        rating: r.rating
      })))
    } catch (error) {
      console.error('Error fetching suggestions:', error)
      res.status(500).json({ error: 'Failed to fetch suggestions' })
    }
  })

  /**
   * PATCH /suggestions/:id { status?, finalRect?, rating? }
   * Records the feedback loop: accepted / adjusted / rejected, or a blind 👍/👎.
   */
  router.patch('/suggestions/:id', async (req: Request, res: Response) => {
    try {
      const { status, finalRect, rating } = req.body

      const existing = await prisma.aISuggestion.findUnique({ where: { id: req.params.id } })
      if (!existing) {
        return res.status(404).json({ error: 'Suggestion not found' })
      }

      const data: Record<string, unknown> = {}
      if (status) {
        if (!['pending', 'accepted', 'adjusted', 'rejected'].includes(status)) {
          return res.status(400).json({ error: 'Invalid status' })
        }
        data.status = status
      }
      if (finalRect) data.finalRectJson = JSON.stringify(finalRect)
      if (rating !== undefined) {
        if (rating !== null && !['up', 'down'].includes(rating)) {
          return res.status(400).json({ error: 'Invalid rating' })
        }
        data.rating = rating
      }

      const updated = await prisma.aISuggestion.update({
        where: { id: req.params.id },
        data
      })

      res.json({
        id: updated.id,
        status: updated.status,
        rating: updated.rating,
        finalRect: updated.finalRectJson ? JSON.parse(updated.finalRectJson) : null
      })
    } catch (error) {
      console.error('Error updating suggestion:', error)
      res.status(500).json({ error: 'Failed to update suggestion' })
    }
  })

  // ============ Models / version history ============

  router.get('/models', async (_req: Request, res: Response) => {
    try {
      res.json(await listModels())
    } catch (error) {
      console.error('Error listing models:', error)
      res.status(500).json({ error: 'Failed to list models' })
    }
  })

  /**
   * POST /model/active { version } — choose the model used for inference.
   * version 0 selects the built-in guideline (Gemini) cropper; version ≥1
   * selects a trained model.
   */
  router.post('/model/active', async (req: Request, res: Response) => {
    try {
      const { version } = req.body
      if (typeof version !== 'number') {
        return res.status(400).json({ error: 'version (number) is required' })
      }
      if (version === GUIDELINES_MODEL_VERSION) {
        await setEngine('guidelines')
        return res.json({ engine: 'guidelines', activeModelVersion: null })
      }
      const model = await prisma.aIModel.findUnique({ where: { version } })
      if (!model) return res.status(404).json({ error: 'Model version not found' })
      if (model.status !== 'ready') return res.status(400).json({ error: 'Model is not ready' })
      await setEngine('trained')
      await setActiveModelVersion(version)
      res.json({ engine: 'trained', activeModelVersion: version })
    } catch (error) {
      console.error('Error setting active model:', error)
      res.status(500).json({ error: 'Failed to set active model' })
    }
  })

  // ============ Crop guidelines (the default model's immutable spec) ============

  /** GET /guidelines — the canonical cropping guidelines + metadata. */
  router.get('/guidelines', async (_req: Request, res: Response) => {
    try {
      const [content, meta] = await Promise.all([readGuidelines(), getGuidelinesMeta()])
      res.json({ content, updatedAt: meta.updatedAt, readOnly: meta.readOnly, present: meta.present })
    } catch (error) {
      console.error('Error reading guidelines:', error)
      res.status(500).json({ error: 'Failed to read guidelines' })
    }
  })

  /**
   * PUT /guidelines { content } — the ONLY write path for the guidelines file.
   * Reached exclusively from the user-initiated Settings editor; the file is
   * otherwise read-only (0444) so no automated/AI path can change it.
   */
  router.put('/guidelines', async (req: Request, res: Response) => {
    try {
      const { content } = req.body
      if (typeof content !== 'string' || content.trim().length === 0) {
        return res.status(400).json({ error: 'content (non-empty string) is required' })
      }
      const meta = await writeGuidelines(content, new Date().toISOString())
      res.json({ updatedAt: meta.updatedAt, readOnly: meta.readOnly, present: meta.present })
    } catch (error) {
      console.error('Error writing guidelines:', error)
      res.status(500).json({ error: 'Failed to write guidelines' })
    }
  })

  // ============ Evaluation ============

  router.get('/eval-chapters', async (_req: Request, res: Response) => {
    try {
      res.json(await getEvaluatableChapters())
    } catch (error) {
      console.error('Error fetching evaluatable chapters:', error)
      res.status(500).json({ error: 'Failed to fetch chapters' })
    }
  })

  router.get('/evaluations', async (_req: Request, res: Response) => {
    try {
      res.json(await listEvaluations())
    } catch (error) {
      console.error('Error listing evaluations:', error)
      res.status(500).json({ error: 'Failed to list evaluations' })
    }
  })

  /**
   * POST /evaluate { chapterIds }
   * Hold-out evaluation; streams ai-crop:evaluate-progress / ai-crop:evaluate-complete.
   */
  router.post('/evaluate', async (req: Request, res: Response) => {
    try {
      const { chapterIds } = req.body
      if (!Array.isArray(chapterIds) || chapterIds.length === 0) {
        return res.status(400).json({ error: 'chapterIds (non-empty array) is required' })
      }
      if (isEvaluating) {
        return res.status(409).json({ error: 'Evaluation already in progress' })
      }
      isEvaluating = true
      evaluateModel(io, chapterIds)
        .catch(err => {
          console.error('Evaluation run error:', err)
          io.emit('ai-crop:evaluate-complete', { error: err.message })
        })
        .finally(() => { isEvaluating = false })

      res.json({ started: true })
    } catch (error) {
      isEvaluating = false
      console.error('Error starting evaluation:', error)
      res.status(500).json({ error: 'Failed to start evaluation' })
    }
  })

  return router
}
