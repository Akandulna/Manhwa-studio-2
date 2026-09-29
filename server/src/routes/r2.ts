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
 *   GET  /phone/crops?seriesId=…&chapterId=…   which pages have crop JSON on the phone, and the page Auto-run is on
 *   GET  /phone/scripts/zip?seriesId=…   the phone's uploaded script zip for a series, and the last import
 *   POST /phone/scripts/preview   { seriesId } — download + parse that zip, say what each chapter would get
 *   POST /phone/scripts/import    { seriesId, etag, chapterIds } — attach the previewed scripts
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
  getPhoneCrops,
  getPhoneScripts,
  getPhoneSync,
  getR2Config,
  missingR2Env,
  publicR2Config,
  startUpload,
  testR2Connection,
  updateR2Config
} from '../services/r2Service.js'
import { getPhoneScriptsZip, importPhoneScripts, previewPhoneScripts } from '../services/phoneScriptImport.js'

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

  router.get('/phone/crops', async (req: Request, res: Response) => {
    try {
      const seriesId = typeof req.query.seriesId === 'string' ? req.query.seriesId : undefined
      const chapterId = typeof req.query.chapterId === 'string' ? req.query.chapterId : undefined
      res.json(await getPhoneCrops(seriesId, chapterId))
    } catch (error) {
      console.error('R2 phone crops lookup failed:', error)
      res.status(400).json({ error: message(error, 'Could not read the phone crop status') })
    }
  })

  router.get('/phone/scripts/zip', async (req: Request, res: Response) => {
    try {
      const seriesId = typeof req.query.seriesId === 'string' ? req.query.seriesId : ''
      if (!seriesId) throw new Error('seriesId is required')
      res.json(await getPhoneScriptsZip(seriesId))
    } catch (error) {
      console.error('R2 phone script zip lookup failed:', error)
      res.status(400).json({ error: message(error, 'Could not look for the phone script zip') })
    }
  })

  router.post('/phone/scripts/preview', async (req: Request, res: Response) => {
    try {
      const seriesId = req.body?.seriesId
      if (typeof seriesId !== 'string' || !seriesId) throw new Error('seriesId is required')
      res.json(await previewPhoneScripts(seriesId))
    } catch (error) {
      console.error('Phone script preview failed:', error)
      res.status(400).json({ error: message(error, 'Could not read the phone script zip') })
    }
  })

  router.post('/phone/scripts/import', async (req: Request, res: Response) => {
    try {
      const { seriesId, etag, chapterIds } = req.body ?? {}
      if (typeof seriesId !== 'string' || !seriesId) throw new Error('seriesId is required')
      if (typeof etag !== 'string' || !etag) throw new Error('etag is required')
      if (!Array.isArray(chapterIds) || !chapterIds.every(id => typeof id === 'string')) {
        throw new Error('chapterIds must be an array of strings')
      }
      res.json(await importPhoneScripts(seriesId, etag, chapterIds))
    } catch (error) {
      console.error('Phone script import failed:', error)
      res.status(400).json({ error: message(error, 'Could not import the phone scripts') })
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
