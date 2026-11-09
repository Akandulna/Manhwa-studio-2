import { Router } from 'express'
import { getMetadataLibrary, syncMetadataLibrary } from '../services/metadataLibrary.js'

export function metadataRoutes(): Router {
  const router = Router()
  router.get('/library', async (_req, res) => {
    try { res.json(await getMetadataLibrary()) }
    catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : 'Could not load Metadata' }) }
  })
  router.post('/sync', async (_req, res) => {
    try { res.json(await syncMetadataLibrary()) }
    catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : 'Could not fetch Metadata' }) }
  })
  return router
}
