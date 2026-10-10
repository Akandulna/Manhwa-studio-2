/**
 * Cloudflare R2 API: settings, sending chapters to the Sleeper-Cell phone, and its status.
 *
 *   GET  /status   is R2 configured, and the current/last send
 *   GET  /config   saved settings for Settings → Cloudflare (no secret)
 *   PUT  /config   save settings; blank key fields keep the saved keys
 *   POST /test     check the credentials can reach the bucket
 *   GET  /usage    free-plan meters: bucket storage + this month's requests
 *   GET  /phone?fresh=1   what the Sleeper-Cell phone app has of the chapters sent to it, per series
 *   GET  /phone/scripts?seriesId=…&fresh=1   which chapters have a narration script on the phone
 *   GET  /phone/crops?seriesId=…&chapterId=…&fresh=1   which pages have crop JSON on the phone, and the page Auto-run is on
 *   GET  /phone/overview?fresh=1   all three receipts across every series, for the Sleeper Cells page
 *   POST /phone/request   ask the phone to write both receipts again ("Refresh from phone")
 *   POST /phone/automation { command: start|stop, kind?, seriesId?, tabs?, ai?, flow?, language?, device?, split? } — start a run
 *                         (Image Clipper, narration, Editor 2.0, voiceover) on the phone through the relay, or stop it
 *   GET  /phone/screens   each phone's screen state and last screenshot (relay only)
 *   GET  /phone/screens/:device/:index   one screenshot image (JPEG, never cached)
 *   DELETE /phone/screens/:device/screenshot   forget that phone's screenshot (its viewer closed)
 *   POST /phone/screen    { command: on|off|shot, device } — Wake, Screen off or Screenshot on one phone
 *   GET  /relay          the phone relay's settings (no token) and connection state
 *   PUT  /relay          { url, token, clearToken } — save; a blank token keeps the saved one
 *   POST /relay/test     ask the relay what it holds, to check the URL and token
 *     (the GETs answer from the server's last copy; fresh=1 re-reads R2)
 *   GET  /phone/scripts/zip?seriesId=…   the phone's uploaded script zip for a series, and the last import
 *   POST /phone/scripts/preview   { seriesId } — download + parse that zip, say what each chapter would get
 *   POST /phone/scripts/import    { seriesId, etag, chapterIds } — attach the previewed scripts
 *   DELETE /objects?key=…   delete one object (free) to make room
 *   GET  /phone-send/plan?fresh=1   per series: chapters to send, on the phone, cleared there
 *   POST /phone-send   { series: [{ seriesId, chapterIds? }] } — send new/changed chapters, or exactly those
 *   PUT  /phone-send/auto   { seriesId, enabled } — send new chapters by itself after downloads
 *   POST /phone-send/index   { seriesId? } — write the phone's chapter index where it is behind
 *   POST /cancel   stop the running send
 *
 * Progress is pushed as `phone-send:progress` on the socket; /status is there
 * for a page that mounts mid-send or after it finished.
 */

import { Router, Request, Response } from 'express'
import type { Server } from 'socket.io'
import {
  deleteR2Object,
  getR2Usage,
  getPhoneCrops,
  getPhoneOverview,
  getPhoneScripts,
  getR2Config,
  missingR2Env,
  requestPhoneUpdate,
  publicR2Config,
  PHONE_RUN_KINDS,
  sendAutomationCommand,
  testR2Connection,
  updateR2Config
} from '../services/r2Service.js'
import {
  cancelPhoneSend,
  getPhoneSync,
  getSendJob,
  getSendPlan,
  setAutoSend,
  startPhoneSend,
  updatePhoneIndexes,
  type PhoneSendRequest
} from '../services/phoneSend.js'
import { getPhoneScriptsZip, importPhoneScripts, previewPhoneScripts } from '../services/phoneScriptImport.js'
import { requestLanguage } from '../services/narrationLanguage.js'
import { forgetPhone, relayStatus, testRelay, updateRelayConfig } from '../services/phoneRelay.js'
import { dropPhoneScreenshot, getPhoneScreens, phoneScreenshotImage, sendScreenCommand } from '../services/phoneScreen.js'

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
      job: getSendJob()
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
        clearKeys: body.clearKeys === true,
        analyticsToken: str(body.analyticsToken),
        clearAnalyticsToken: body.clearAnalyticsToken === true
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
      res.json(await getPhoneScripts(seriesId, req.query.fresh === '1'))
    } catch (error) {
      console.error('R2 phone scripts lookup failed:', error)
      res.status(400).json({ error: message(error, 'Could not read the phone scripts status') })
    }
  })

  router.get('/phone/crops', async (req: Request, res: Response) => {
    try {
      const seriesId = typeof req.query.seriesId === 'string' ? req.query.seriesId : undefined
      const chapterId = typeof req.query.chapterId === 'string' ? req.query.chapterId : undefined
      res.json(await getPhoneCrops(seriesId, chapterId, req.query.fresh === '1'))
    } catch (error) {
      console.error('R2 phone crops lookup failed:', error)
      res.status(400).json({ error: message(error, 'Could not read the phone crop status') })
    }
  })

  router.get('/phone/overview', async (req: Request, res: Response) => {
    try {
      const fresh = req.query.fresh === '1'
      const sync = await getPhoneSync(fresh).catch(() => null)
      res.json(await getPhoneOverview(sync, fresh))
    } catch (error) {
      console.error('Phone overview lookup failed:', error)
      res.status(400).json({ error: message(error, 'Could not read the phone status') })
    }
  })

  router.post('/phone/request', async (_req: Request, res: Response) => {
    try {
      res.json(await requestPhoneUpdate())
    } catch (error) {
      console.error('R2 phone update request failed:', error)
      res.status(400).json({ error: message(error, 'Could not ask the phone for an update') })
    }
  })

  router.post('/phone/automation', async (req: Request, res: Response) => {
    try {
      const { command, kind, seriesId, tabs, ai, flow, language, device, split } = req.body ?? {}
      if (command !== 'start' && command !== 'stop') throw new Error('command must be start or stop')
      if (kind !== undefined && !PHONE_RUN_KINDS.includes(kind)) throw new Error(`kind must be one of ${PHONE_RUN_KINDS.join(', ')}`)
      if (ai !== undefined && ai !== 'chatgpt' && ai !== 'aistudio') throw new Error('ai must be chatgpt or aistudio')
      if (flow !== undefined && flow !== 'classic' && flow !== 'steps') throw new Error('flow must be classic or steps')
      if (language !== undefined && language !== 'en' && language !== 'hi') throw new Error('language must be en or hi')
      if (seriesId !== undefined && (typeof seriesId !== 'string' || !seriesId)) throw new Error('seriesId must be a series id')
      if (tabs !== undefined && typeof tabs !== 'number') throw new Error('tabs must be a number')
      if (device !== undefined && (typeof device !== 'string' || !device)) throw new Error('device must be a phone id')
      if (split !== undefined && typeof split !== 'boolean') throw new Error('split must be true or false')
      if (device !== undefined && split) throw new Error('Pick one phone or split, not both')
      res.json(await sendAutomationCommand(command, { kind, seriesId, tabs, ai, flow, language, device, split }))
    } catch (error) {
      console.error('Phone automation command failed:', error)
      res.status(400).json({ error: message(error, 'Could not reach the phone') })
    }
  })

  router.get('/phone/screens', (_req: Request, res: Response) => {
    res.json({ phones: getPhoneScreens() })
  })

  router.get('/phone/screens/:device/:index', (req: Request, res: Response) => {
    const image = phoneScreenshotImage(String(req.params.device), Number(req.params.index))
    if (!image) {
      res.status(404).json({ error: 'No such screenshot' })
      return
    }
    // Kept nowhere, the browser's cache included.
    res.set('Cache-Control', 'no-store').type('image/jpeg').send(image)
  })

  router.delete('/phone/screens/:device/screenshot', (req: Request, res: Response) => {
    res.json({ ok: true, dropped: dropPhoneScreenshot(String(req.params.device)) })
  })

  router.post('/phone/screen', async (req: Request, res: Response) => {
    try {
      const { command, device } = req.body ?? {}
      if (command !== 'on' && command !== 'off' && command !== 'shot') throw new Error('command must be on, off or shot')
      if (typeof device !== 'string' || !device) throw new Error('device must be a phone id')
      res.json(await sendScreenCommand(command, device))
    } catch (error) {
      console.error('Phone screen command failed:', error)
      res.status(400).json({ error: message(error, 'Could not reach the phone') })
    }
  })

  // Drops a phone's receipts from the relay: one no longer used, or the old app's copies.
  router.post('/phone/forget', async (req: Request, res: Response) => {
    try {
      const { device } = req.body ?? {}
      if (typeof device !== 'string') throw new Error('device must be a phone id')
      await forgetPhone(device)
      res.json({ ok: true })
    } catch (error) {
      console.error('Forgetting the phone failed:', error)
      res.status(400).json({ error: message(error, 'Could not forget the phone') })
    }
  })

  router.get('/relay', (_req: Request, res: Response) => {
    res.json(relayStatus())
  })

  router.put('/relay', async (req: Request, res: Response) => {
    try {
      const body = req.body ?? {}
      await updateRelayConfig({
        url: typeof body.url === 'string' ? body.url : undefined,
        token: typeof body.token === 'string' ? body.token : undefined,
        clearToken: body.clearToken === true
      })
      res.json(relayStatus())
    } catch (error) {
      res.status(400).json({ error: message(error, 'Failed to save the relay settings') })
    }
  })

  router.post('/relay/test', async (_req: Request, res: Response) => {
    try {
      res.json({ ok: true, ...(await testRelay()) })
    } catch (error) {
      res.status(400).json({ ok: false, error: message(error, 'Could not reach the relay') })
    }
  })

  router.get('/phone/scripts/zip', async (req: Request, res: Response) => {
    try {
      const seriesId = typeof req.query.seriesId === 'string' ? req.query.seriesId : ''
      if (!seriesId) throw new Error('seriesId is required')
      res.json(await getPhoneScriptsZip(seriesId, requestLanguage(req)))
    } catch (error) {
      console.error('R2 phone script zip lookup failed:', error)
      res.status(400).json({ error: message(error, 'Could not look for the phone script zip') })
    }
  })

  router.post('/phone/scripts/preview', async (req: Request, res: Response) => {
    try {
      const seriesId = req.body?.seriesId
      if (typeof seriesId !== 'string' || !seriesId) throw new Error('seriesId is required')
      res.json(await previewPhoneScripts(seriesId, requestLanguage(req)))
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
      res.json(await importPhoneScripts(seriesId, etag, chapterIds, requestLanguage(req)))
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

  router.get('/phone-send/plan', async (req: Request, res: Response) => {
    try {
      res.json(await getSendPlan(req.query.fresh === '1'))
    } catch (error) {
      console.error('Phone send plan failed:', error)
      res.status(400).json({ error: message(error, 'Could not work out what to send') })
    }
  })

  router.post('/phone-send', async (req: Request, res: Response) => {
    try {
      const raw = req.body?.series
      if (!Array.isArray(raw)) throw new Error('series must be an array')
      const requests: PhoneSendRequest[] = raw.map(item => {
        if (typeof item?.seriesId !== 'string' || !item.seriesId) throw new Error('Each series needs a seriesId')
        if (item.chapterIds !== undefined && (!Array.isArray(item.chapterIds) || !item.chapterIds.every((id: unknown) => typeof id === 'string'))) {
          throw new Error('chapterIds must be an array of strings')
        }
        return { seriesId: item.seriesId, chapterIds: item.chapterIds }
      })
      res.json(await startPhoneSend(requests, io))
    } catch (error) {
      res.status(400).json({ error: message(error, 'Failed to start sending') })
    }
  })

  router.put('/phone-send/auto', async (req: Request, res: Response) => {
    try {
      const { seriesId, enabled } = req.body ?? {}
      if (typeof seriesId !== 'string' || !seriesId) throw new Error('seriesId is required')
      await setAutoSend(seriesId, enabled === true)
      res.json({ ok: true })
    } catch (error) {
      res.status(400).json({ error: message(error, 'Could not save auto-send') })
    }
  })

  router.post('/phone-send/index', async (req: Request, res: Response) => {
    try {
      const seriesId = typeof req.body?.seriesId === 'string' ? req.body.seriesId : undefined
      res.json(await updatePhoneIndexes(seriesId))
    } catch (error) {
      console.error('Updating the phone index failed:', error)
      res.status(400).json({ error: message(error, 'Could not update the phone') })
    }
  })

  router.post('/cancel', async (_req: Request, res: Response) => {
    await cancelPhoneSend()
    res.json({ job: getSendJob() })
  })

  return router
}
