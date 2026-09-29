/**
 * Cloudflare R2 backup API.
 *
 *   GET  /status   is R2 configured, and the current/last upload job
 *   GET  /config   saved settings for Settings → Cloudflare (no secret)
 *   PUT  /config   save settings; blank key fields keep the saved keys
 *   POST /test     check the credentials can reach the bucket
 *   GET  /usage    free-plan meters: bucket storage + this month's requests
 *   GET  /phone?fresh=1   which series' zips the Sleeper-Cell phone app has downloaded
 *   GET  /phone/scripts?seriesId=…   which chapters have a narration script on the phone
 *   DELETE /objects?key=…   delete one object (free) to make room
 *   POST /upload   { seriesIds } — start uploading those series' folders
 *   POST /cancel   stop the running upload
 *
 * Progress is pushed as `r2:progress` on the socket; /status is there for a
 * page that mounts mid-upload or after it finished.
 */

import { Router, Request, Response } from 'express'
import type { Server } from 'socket.io'
import {
  cancelUpload,
  deleteR2Object,
  getJob,
  getR2Usage,
  getPhoneScripts,
  getPhoneSync,
  getR2Config,
  missingR2Env,
  publicR2Config,
  startUpload,
  testR2Connection,
  updateR2Config
} from '../services/r2Service.js'

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

export function initR2Routes(io: Server): Router {
  const router = Router()

  router.get('/status', (_req: Request, res: Response) => {
    const config = getR2Config()
    res.json({
      configured: config !== null,
      missing: missingR2Env(),
      bucket: config?.bucket ?? null,
      prefix: config?.prefix ?? '',
      job: getJob()
    })
  })

  router.get('/config', (_req: Request, res: Response) => {
    res.json(publicR2Config())
  })

  router.put('/config', async (req: Request, res: Response) => {
    try {
      const body = req.body ?? {}
      const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
      await updateR2Config({
        accountId: str(body.accountId),
        bucket: str(body.bucket),
        prefix: str(body.prefix),
        concurrency: typeof body.concurrency === 'number' ? body.concurrency : undefined,
        accessKeyId: str(body.accessKeyId),
        secretAccessKey: str(body.secretAccessKey),
        clearKeys: body.clearKeys === true
      })
      res.json(publicR2Config())
    } catch (error) {
      res.status(400).json({ error: message(error, 'Failed to save R2 settings') })
    }
  })

  router.post('/test', async (_req: Request, res: Response) => {
    try {
      res.json({ ok: true, ...(await testR2Connection()) })
    } catch (error) {
      console.error('R2 connection test failed:', error)
      res.status(400).json({ ok: false, error: message(error, 'Could not reach the R2 bucket') })
    }
  })

  router.get('/usage', async (_req: Request, res: Response) => {
    try {
      res.json(await getR2Usage())
    } catch (error) {
      console.error('R2 usage lookup failed:', error)
      res.status(400).json({ error: message(error, 'Could not read R2 usage') })
    }
  })

  router.get('/phone', async (req: Request, res: Response) => {
    try {
      res.json(await getPhoneSync(req.query.fresh === '1'))
    } catch (error) {
      console.error('R2 phone sync lookup failed:', error)
      res.status(400).json({ error: message(error, 'Could not read the phone sync status') })
    }
  })

  router.get('/phone/scripts', async (req: Request, res: Response) => {
    try {
      const seriesId = typeof req.query.seriesId === 'string' ? req.query.seriesId : undefined
      res.json(await getPhoneScripts(seriesId))
    } catch (error) {
      console.error('R2 phone scripts lookup failed:', error)
      res.status(400).json({ error: message(error, 'Could not read the phone scripts status') })
    }
  })

  router.delete('/objects', async (req: Request, res: Response) => {
    try {
      const key = typeof req.query.key === 'string' ? req.query.key : ''
      if (!key) throw new Error('key is required')
      await deleteR2Object(key)
      res.json({ ok: true })
    } catch (error) {
      res.status(400).json({ error: message(error, 'Could not delete the object') })
    }
  })

  router.post('/upload', async (req: Request, res: Response) => {
    try {
      const raw = req.body?.seriesIds
      if (!Array.isArray(raw) || !raw.every(id => typeof id === 'string')) {
        throw new Error('seriesIds must be an array of strings')
      }
      res.json(await startUpload(raw, io))
    } catch (error) {
      res.status(400).json({ error: message(error, 'Failed to start upload') })
    }
  })

  router.post('/cancel', async (_req: Request, res: Response) => {
    await cancelUpload()
    res.json({ job: getJob() })
  })

  return router
}
