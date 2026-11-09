import {hiddenLibrarySeriesIds} from '../services/libraryControls.js'
/**
 * Cloudflare R2 API: settings, sending chapters to the Sleeper-Cell phones, their status, and getting their chapters.
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
 *   POST /phone/automation { command: start|stop, kind?, seriesId?, tabs?, ai?, flow?, chatGpt?, language?, device?, split?, assignments?, devices?, after? }
 *                         — start a run (Image Clipper, narration, Editor 2.0, voiceover) on the phone through the relay, or stop it
 *                         (`after`: once what it's on is done). `split` with `assignments` ({ <phone id>: [chapter folders] }, as the
 *                         plan below was confirmed) sends each phone its share.
 *   POST /phone/automation/plan { kind, seriesId, language?, devices?, chapters? (Metadata) } — a split's plan, sending nothing: which phone takes which
 *                         chapters, which keeps what it's on, and which are left alone (phoneSplit.ts)
 *   GET  /phone/screens   each phone's screen state and last screenshot (relay only)
 *   GET  /phone/screens/:device/:index   one screenshot image (JPEG, never cached)
 *   POST /phone/profile   { command: select|options, device, profile } — pick the phone's profile, or have it read what that
 *                         profile's ChatGPT account offers (modes, models, efforts)
 *   DELETE /phone/screens/:device/screenshot   forget that phone's screenshot (its viewer closed)
 *   POST /phone/screen    { command: on|off|shot, device } — Wake, Screen off or Screenshot on one phone
 *   GET  /relay          the phone relay's settings (no token) and connection state
 *   PUT  /relay          { url, token, clearToken } — save; a blank token keeps the saved one
 *   POST /relay/test     ask the relay what it holds, to check the URL and token
 *     (the GETs answer from the server's last copy; fresh=1 re-reads R2)
 *   DELETE /objects?key=…   delete one object (free) to make room
 *   GET  /phone-send/plan?fresh=1   per series: chapters to send, on the phone, cleared there
 *   POST /phone-send   { series: [{ seriesId, chapterIds? }] } — send new/changed chapters, or exactly those
 *   PUT  /phone-send/auto   { seriesId, enabled } — send new chapters by itself after downloads
 *   POST /phone-send/index   { seriesId? } — write the phone's chapter index where it is behind
 *   POST /cancel   stop the running send
 *   GET  /phone-pull   chapters the Master phone downloaded and sent that this library doesn't have (or has with other pages)
 *   POST /phone-pull   { series: [{ folder, chapters: [name] }] } — bring them into the library (Get chapters from phones)
 *
 * Progress is pushed as `phone-send:progress` on the socket; /status is there
 * for a page that mounts mid-send or after it finished.
 */

import { cleanupR2Voiceovers } from '../services/voiceoverCleanup.js'
import { cleanupDonePartPages } from '../services/partDoneCleanup.js'
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
  type PhoneRunKind,
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
import { listPhoneChapters, pullPhoneChapters } from '../services/phonePull.js'
import { fixRunReadiness, getRunReadiness, type ReadinessFixAction } from '../services/phoneReadiness.js'
import { forgetPhone, relayConfigured, relayStatus, testRelay, updateRelayConfig } from '../services/phoneRelay.js'
import { planSplit } from '../services/phoneSplit.js'
import { parseChatGptSettings, sendProfileCommand } from '../services/phoneProfiles.js'
import { dropPhoneScreenshot, getPhoneScreens, phoneScreenshotImage, sendScreenCommand } from '../services/phoneScreen.js'

/** A split's confirmed shares: { <phone id>: [chapter folders] }. */
function isAssignments(value: unknown): value is Record<string, string[]> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.values(value).every(list => Array.isArray(list) && list.every(c => typeof c === 'string' && !!c))
}

/** The phones picked for a split ("Selected devices"): two or more distinct phone ids. */
function isDeviceList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length >= 2 && value.every(d => typeof d === 'string' && !!d) && new Set(value).size === value.length
}

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
      const library = await import('../services/librarySync.js')
      library.scheduleLibraryPublish()
      void library.resumeLibraryUploads().catch(error => console.error('[library-sync] upload recovery failed:', error))
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
      const overview=await getPhoneOverview(sync, fresh)
      const hidden=new Set(await hiddenLibrarySeriesIds())
      res.json({...overview,series:overview.series.filter(s=>!hidden.has(s.id))})
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
      const { command, kind, seriesId, chapters, tabs, ai, flow, language, device, split, after, chatGpt, assignments, smallBatches, devices } = req.body ?? {}
      if (command !== 'start' && command !== 'stop') throw new Error('command must be start or stop')
      if (kind !== undefined && !PHONE_RUN_KINDS.includes(kind)) throw new Error(`kind must be one of ${PHONE_RUN_KINDS.join(', ')}`)
      if (ai !== undefined && ai !== 'chatgpt' && ai !== 'aistudio' && ai !== 'gemini') throw new Error('ai must be chatgpt, aistudio or gemini')
      if (flow !== undefined && flow !== 'classic' && flow !== 'steps') throw new Error('flow must be classic or steps')
      if (language !== undefined && language !== 'en' && language !== 'hi') throw new Error('language must be en or hi')
      if (smallBatches !== undefined && (kind !== 'editor' || typeof smallBatches !== 'boolean')) throw new Error('smallBatches must be true or false for Editor')
      if (after !== undefined && typeof after !== 'boolean') throw new Error('after must be true or false')
      if (seriesId !== undefined && (typeof seriesId !== 'string' || !seriesId)) throw new Error('seriesId must be a series id')
      if (chapters !== undefined && (!Array.isArray(chapters) || !chapters.length || chapters.some((c: unknown) => typeof c !== 'string' || !c))) throw new Error('chapters must be a nonempty list of chapter folders')
      if (tabs !== undefined && typeof tabs !== 'number') throw new Error('tabs must be a number')
      if (device !== undefined && (typeof device !== 'string' || !device)) throw new Error('device must be a phone id')
      if (split !== undefined && typeof split !== 'boolean') throw new Error('split must be true or false')
      if (device !== undefined && split) throw new Error('Pick one phone or split, not both')
      if (assignments !== undefined && (!split || !isAssignments(assignments))) throw new Error('assignments must go with split, as { <phone id>: [chapter folders] }')
      if (devices !== undefined && (!split || !isDeviceList(devices))) throw new Error('devices must go with split, as a list of two or more phone ids')
      const choices = chatGpt === undefined || chatGpt === null ? undefined : parseChatGptSettings(chatGpt)
      res.json(await sendAutomationCommand(command, { kind, seriesId, chapters, tabs, ai, flow, chatGpt: choices, language, device, split, after, assignments, smallBatches, devices }))
    } catch (error) {
      console.error('Phone automation command failed:', error)
      res.status(400).json({ error: message(error, 'Could not reach the phone') })
    }
  })

  /**
   * Split across the phones, step 1 (phoneSplit.ts): which phone would take which chapters of the series, and which
   * are left alone, without sending anything. Run automation shows it to confirm, then starts it with
   * POST /phone/automation { split: true, assignments }.
   */
  router.post('/phone/automation/plan', async (req: Request, res: Response) => {
    try {
      const { kind = 'clipper', seriesId, language = 'en', devices, chapters } = req.body ?? {}
      if (!PHONE_RUN_KINDS.includes(kind)) throw new Error(`kind must be one of ${PHONE_RUN_KINDS.join(', ')}`)
      if (typeof seriesId !== 'string' || !seriesId) throw new Error('Pick a series to split between the phones')
      if (language !== 'en' && language !== 'hi') throw new Error('language must be en or hi')
      if (devices !== undefined && !isDeviceList(devices)) throw new Error('devices must be a list of two or more phone ids')
      if (chapters !== undefined && (!Array.isArray(chapters) || !chapters.length || chapters.some((c: unknown) => typeof c !== 'string' || !c))) throw new Error('chapters must be a nonempty list of chapter folders')
      if (!relayConfigured()) throw new Error('Splitting runs between the phones needs the phone relay (Settings → Cloudflare)')
      res.json(await planSplit(kind, seriesId, language, { devices, chapters: kind === 'metadata' || kind === 'voiceover' ? chapters : undefined }))
    } catch (error) {
      console.error('Phone automation command failed:', error)
      res.status(400).json({ error: message(error, 'Could not reach the phone') })
    }
  })

  /** Run automation's checklist: what `kind` needs of the series on the phone (phoneReadiness.ts). Editor 2.0's LISTs R2. */
  router.get('/phone/readiness', async (req: Request, res: Response) => {
    try {
      const { kind, seriesId, language = 'en', part } = req.query
      if (typeof kind !== 'string' || !PHONE_RUN_KINDS.includes(kind as PhoneRunKind)) throw new Error(`kind must be one of ${PHONE_RUN_KINDS.join(', ')}`)
      if (typeof seriesId !== 'string' || !seriesId) throw new Error('seriesId is required')
      if (language !== 'en' && language !== 'hi') throw new Error('language must be en or hi')
      if (part !== undefined && ((kind !== 'narration' && kind !== 'voiceover') || typeof part !== 'string' ||
          part !== 'all' && (!/^[1-9]\d*$/.test(part) || !Number.isSafeInteger(Number(part)) || Number(part) > 100000))) {
        throw new Error('part must be a positive part number or all for Narration scripts or Voiceover')
      }
      res.json(await getRunReadiness(kind as PhoneRunKind, seriesId, language, part === undefined ? undefined : part === 'all' ? 'all' : Number(part)))
    } catch (error) {
      console.error('Phone run readiness failed:', error)
      res.status(400).json({ error: message(error, 'Could not check what the phone needs') })
    }
  })

  /** One fix from that checklist: send the pages or packages, the prompt, or ask the phones to download. */
  router.post('/phone/readiness/fix', async (req: Request, res: Response) => {
    try {
      const { action, seriesId, chapterIds, prompt } = req.body ?? {}
      const actions: ReadinessFixAction[] = ['send_pages', 'ask_download', 'send_editor', 'send_prompt']
      if (!actions.includes(action)) throw new Error(`action must be one of ${actions.join(', ')}`)
      if (typeof seriesId !== 'string' || !seriesId) throw new Error('seriesId is required')
      if (chapterIds !== undefined && (!Array.isArray(chapterIds) || !chapterIds.every((id: unknown) => typeof id === 'string'))) {
        throw new Error('chapterIds must be an array of strings')
      }
      if (prompt !== undefined && typeof prompt !== 'string') throw new Error('prompt must be a string')
      res.json(await fixRunReadiness({ action, seriesId, chapterIds, prompt }, io))
    } catch (error) {
      console.error('Phone run readiness fix failed:', error)
      res.status(400).json({ error: message(error, 'Could not get it to the phone') })
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

  router.post('/phone/profile', async (req: Request, res: Response) => {
    try {
      const { command, device, profile } = req.body ?? {}
      if (command !== 'select' && command !== 'options') throw new Error('command must be select or options')
      if (typeof device !== 'string' || !device) throw new Error('device must be a phone id')
      if (typeof profile !== 'string' || !profile) throw new Error('profile must be a profile id')
      res.json(await sendProfileCommand(command, device, profile))
    } catch (error) {
      console.error('Phone profile command failed:', error)
      res.status(400).json({ error: message(error, 'Could not reach the phone') })
    }
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

  /**
   * R2 clean-up (Storage): done Parts' page zips (partDoneCleanup.ts), then voiceover zips already imported and
   * aligned or of done Parts (voiceoverCleanup.ts). `dryRun` only lists.
   */
  router.post('/cleanup', async (req: Request, res: Response) => {
    try {
      const dryRun = req.body?.dryRun === true
      const pages = await cleanupDonePartPages({ dryRun })
      res.json({ pages, voiceover: await cleanupR2Voiceovers({ dryRun }) })
    } catch (error) {
      console.error('R2 cleanup failed:', error)
      res.status(400).json({ error: message(error, 'Could not clean up R2') })
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
        if (item.resetClipping !== undefined && typeof item.resetClipping !== 'boolean') throw new Error('resetClipping must be a boolean')
        return { seriesId: item.seriesId, chapterIds: item.chapterIds, resetClipping: item.resetClipping === true }
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

  router.get('/phone-pull', async (_req: Request, res: Response) => {
    try {
      res.json(await listPhoneChapters())
    } catch (error) {
      console.error('Listing the phones’ chapters failed:', error)
      res.status(400).json({ error: message(error, 'Could not list the phones’ chapters') })
    }
  })

  router.post('/phone-pull', async (req: Request, res: Response) => {
    try {
      const raw = req.body?.series
      if (!Array.isArray(raw)) throw new Error('series must be an array')
      const requests = raw.map(item => {
        if (typeof item?.folder !== 'string' || !item.folder) throw new Error('Each series needs a folder')
        if (!Array.isArray(item.chapters) || !item.chapters.every((c: unknown) => typeof c === 'string')) throw new Error('chapters must be an array of names')
        return { folder: item.folder as string, chapters: item.chapters as string[] }
      })
      const result = await pullPhoneChapters(requests)
      if (result.pulled.length > 0) io.emit('chapters:updated', [])
      res.json(result)
    } catch (error) {
      console.error('Getting chapters from the phones failed:', error)
      res.status(400).json({ error: message(error, 'Could not get the chapters') })
    }
  })

  router.post('/cancel', async (_req: Request, res: Response) => {
    await cancelPhoneSend()
    res.json({ job: getSendJob() })
  })

  return router
}
