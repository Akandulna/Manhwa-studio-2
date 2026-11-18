import { Router } from 'express'
import { shortsService, type ShortsService } from '../services/shorts.js'

export function createShortsRouter(service: ShortsService = shortsService) {
  const router = Router()
  // Local filesystem access is restricted to the Studio on this computer.
  router.use((req, res, next) => {
    const address = req.socket.remoteAddress || ''
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) return res.status(403).json({ error: 'Shorts folders are available on the computer running Studio.' })
    const origin = req.get('origin')
    if (origin) {
      try { if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)) throw new Error() }
      catch { return res.status(403).json({ error: 'Request origin not allowed.' }) }
    }
    if (req.method !== 'GET' && req.get('x-studio-client') !== '1') return res.status(403).json({ error: 'Missing Studio client header.' })
    res.set('Cache-Control', 'no-store')
    next()
  })
  router.get('/folders', async (_req, res) => {
    try { res.json(await service.discover()) } catch (e) { res.status(400).json({ error: (e as Error).message }) }
  })
  router.post('/load', async (req, res) => {
    try { res.json(await service.load(req.body?.folder)) } catch (e) { res.status(400).json({ error: (e as Error).message }) }
  })
  router.get('/projects/:id/images/:filename', async (req, res) => {
    try { res.sendFile(await service.image(req.params.id, req.params.filename)) } catch (e) { res.status(404).json({ error: (e as Error).message }) }
  })
  router.post('/projects/:id/preview', async (req, res) => {
    try { res.json(await service.start(req.params.id, req.body?.revision)) } catch (e) { res.status(400).json({ error: (e as Error).message }) }
  })
  router.get('/projects/:id/preview', async (req, res) => {
    try { res.json(await service.latest(req.params.id)) } catch (e) { res.status(404).json({ error: (e as Error).message }) }
  })
  router.get('/previews/:id', (req, res) => {
    try { res.json(service.getJob(req.params.id).view) } catch (e) { res.status(404).json({ error: (e as Error).message }) }
  })
  router.post('/previews/:id/cancel', (req, res) => {
    try { res.json(service.cancel(req.params.id)) } catch (e) { res.status(404).json({ error: (e as Error).message }) }
  })
  router.get('/previews/:id/video', (req, res) => {
    try {
      const job = service.getJob(req.params.id)
      if (job.view.state !== 'complete') return res.status(409).json({ error: 'Preview is not ready.' })
      res.type('mp4').sendFile(job.output)
    } catch (e) { res.status(404).json({ error: (e as Error).message }) }
  })
  return router
}
