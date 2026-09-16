/**
 * Vision provider status + selection.
 *
 *   GET  /vision/providers        what exists, and which is selected
 *   POST /vision/providers/:name/test   is this one actually reachable/authorized
 *
 * The selected provider is stored in the Setting table under `visionProvider`,
 * the same place the TTS choice lives, so it survives restarts and is shared by
 * every client rather than living in one browser's localStorage.
 */

import { Router, Request, Response } from 'express'
import { prisma } from '../index.js'
import { visionProviderFactory, VisionProviderName } from '../services/vision/index.js'

const SETTING_KEY = 'visionProvider'

export function initVisionRoutes(): Router {
  const router = Router()

  router.get('/providers', async (_req: Request, res: Response) => {
    try {
      const setting = await prisma.setting.findUnique({ where: { key: SETTING_KEY } })
      const selected = setting?.value ?? process.env.VISION_PROVIDER ?? 'qwen'

      res.json({
        selected,
        providers: visionProviderFactory.describe()
      })
    } catch (error) {
      console.error('[vision] listing providers failed:', error)
      res.status(500).json({ error: 'Failed to list vision providers' })
    }
  })

  router.put('/providers/selected', async (req: Request, res: Response) => {
    try {
      const { provider } = req.body ?? {}
      if (typeof provider !== 'string' || !visionProviderFactory.getProvider(provider as VisionProviderName)) {
        return res.status(400).json({ error: `Unknown vision provider: ${provider}` })
      }

      await prisma.setting.upsert({
        where: { key: SETTING_KEY },
        create: { key: SETTING_KEY, value: provider },
        update: { value: provider }
      })

      res.json({ selected: provider })
    } catch (error) {
      console.error('[vision] selecting provider failed:', error)
      res.status(500).json({ error: 'Failed to select vision provider' })
    }
  })

  /**
   * Live check. Separate from the listing because it costs a network round trip
   * (and for cloud providers, a token or two) — the list must stay cheap enough
   * to render the settings page on every visit.
   */
  router.post('/providers/:name/test', async (req: Request, res: Response) => {
    try {
      const provider = visionProviderFactory.getProvider(req.params.name as VisionProviderName)
      if (!provider) {
        return res.status(404).json({ error: `Unknown vision provider: ${req.params.name}` })
      }

      const result = await provider.testConnection()
      res.json({ ...result, provider: provider.name, model: provider.model })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Test failed'
      res.status(500).json({ success: false, error: message })
    }
  })

  return router
}
