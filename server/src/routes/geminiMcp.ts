/**
 * /api/gemini-mcp (docs/PRD-gemini-app-narration.md).
 *
 * Connector (Phase 1):
 *   GET  /connector            status: installed?, the command to paste into Gemini, last call
 *   POST /connector/install    install or repair the connector in ~/.local (keeps the token)
 *   POST /connector/readded    the user re-added the connector in Gemini (tool list now current)
 *   POST /connector/test       run the installed connector like Gemini does and call get_job
 *
 * Narration jobs (Phase 2):
 *   GET  /series                       series with downloaded chapters, script counts, active jobs
 *   GET  /series/:id/chapters          each chapter's English and Hinglish status and current job
 *   POST /jobs/process                 { chapterId, language, rewrite?, restart? } → { job, prompt }
 *   POST /master                       { seriesId, language } → queue the remaining chapters → { queued, skipped, prompt }
 *   POST /master/stop                  { seriesId } → cancel the series' queued jobs Gemini hasn't started
 *   GET  /jobs/:id                     { job, prompt }
 *   POST /jobs/:id/cancel
 *   POST /jobs/:id/retry               a stopped job continues with its accepted work kept
 *   GET  /jobs/:id/log                 accepted steps and refused submissions
 *   POST /drive/cleanup                delete gemini-narration folders no current job uses
 *
 *   POST /bridge/call          the connector's relay: Bearer token, loopback only
 *
 * Studio routes are for the Studio client on this Mac (loopback + origin + client header, like Google Drive).
 * The bridge is called by the connector process, so it has no Origin or client header; its token is the capability.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import type { PrismaClient } from '@prisma/client'
import { allowedOrigins, googleDriveService, isLoopback, STUDIO_CLIENT_HEADER } from './googleDrive.js'
import { GeminiMcpConnector, SELF_TEST_CLIENT, noJobsReply, type KeyValueStore } from '../services/geminiMcp/connector.js'
import { GeminiJobError, GeminiJobs, jobArg, jobView } from '../services/geminiMcp/jobs.js'
import { masterPrompt, processPrompt } from '../services/geminiMcp/prompts.js'
import { prismaDriveStore } from '../services/googleDrive/store.js'
import { parseLanguage } from '../services/narrationLanguage.js'

export function prismaKeyValueStore(prisma: PrismaClient): KeyValueStore {
  return {
    get: async key => (await prisma.setting.findUnique({ where: { key } }))?.value ?? null,
    set: async (key, value) => { await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } }) }
  }
}

function studioOnly(origins = allowedOrigins()) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!isLoopback(req.socket.remoteAddress)) return res.status(403).json({ error: 'Gemini MCP is only available on the Mac running Studio.' })
    const origin = req.get('origin')
    if (origin && !origins.has(origin)) return res.status(403).json({ error: 'Request origin not allowed.' })
    if (req.method !== 'GET' && req.get(STUDIO_CLIENT_HEADER) !== '1') return res.status(403).json({ error: 'Missing Studio client header.' })
    res.setHeader('Cache-Control', 'no-store')
    next()
  }
}

let instance: GeminiMcpConnector | null = null
export const geminiMcpConnector = () => {
  if (!instance) throw new Error('Gemini MCP connector not initialized')
  return instance
}
let jobsInstance: GeminiJobs | null = null
export const geminiMcpJobs = () => jobsInstance

export function createGeminiMcpRouter(connector: GeminiMcpConnector, origins = allowedOrigins(), jobs: GeminiJobs | null = null, prisma: PrismaClient | null = null): Router {
  const router = Router()
  const fail = (res: Response, error: unknown) => {
    const status = error instanceof GeminiJobError ? error.status : 500
    if (status >= 500) console.error('[gemini-mcp]', error instanceof Error ? error.message : error)
    res.status(status).json({ error: error instanceof Error ? error.message : String(error) })
  }
  const studio = studioOnly(origins)

  router.get('/connector', studio, async (_req, res) => {
    try { res.json(await connector.status()) } catch (error) { fail(res, error) }
  })
  router.post('/connector/install', studio, async (_req, res) => {
    try { res.json(await connector.install()) } catch (error) { fail(res, error) }
  })
  router.post('/connector/readded', studio, async (_req, res) => {
    try { res.json(await connector.markReadded()) } catch (error) { fail(res, error) }
  })
  router.post('/connector/test', studio, async (_req, res) => {
    try {
      const status = await connector.status()
      if (status.state === 'not_installed') return res.status(409).json({ error: 'Install the connector first.' })
      res.json(await connector.selfTest())
    } catch (error) { fail(res, error) }
  })

  // ─── Narration jobs ───

  const needJobs = (res: Response) => {
    if (jobs && prisma) return { jobs, prisma }
    res.status(503).json({ error: 'Gemini MCP jobs are not available.' })
    return null
  }
  /** The job with the prompt that starts (or continues) it in a new Gemini chat. */
  const withPrompt = async (db: PrismaClient, job: Awaited<ReturnType<GeminiJobs['job']>>) => {
    const chapter = await db.chapter.findUnique({ where: { id: job.chapterId }, select: { number: true, series: { select: { title: true } } } })
    return {
      job: jobView(job),
      prompt: processPrompt({ ref: job.ref, language: job.language, seriesTitle: chapter?.series.title ?? '', chapterNumber: chapter?.number ?? 0, driveFolderName: job.driveFolderName })
    }
  }
  const text = (value: unknown) => (typeof value === 'string' ? value : '')

  router.get('/series', studio, async (_req, res) => {
    const ctx = needJobs(res); if (!ctx) return
    try { res.json({ series: await ctx.jobs.seriesList() }) } catch (error) { fail(res, error) }
  })
  router.get('/series/:id/chapters', studio, async (req, res) => {
    const ctx = needJobs(res); if (!ctx) return
    try {
      const result = await ctx.jobs.chapters(req.params.id)
      const queued = result.chapters.some(c => [c.en.job, c.hi.job].some(j => j && j.queueOrder !== null && ['queued', 'preparing', 'ready', 'working'].includes(j.state)))
      res.json({ ...result, masterPrompt: masterPrompt(), masterActive: queued })
    } catch (error) { fail(res, error) }
  })
  router.post('/jobs/process', studio, async (req, res) => {
    const ctx = needJobs(res); if (!ctx) return
    try {
      const chapterId = text(req.body?.chapterId)
      if (!chapterId) throw new GeminiJobError('Missing chapter.')
      const job = await ctx.jobs.process(chapterId, parseLanguage(req.body?.language), { rewrite: req.body?.rewrite === true, restart: req.body?.restart === true })
      res.json(await withPrompt(ctx.prisma, job))
    } catch (error) { fail(res, error) }
  })
  router.post('/master', studio, async (req, res) => {
    const ctx = needJobs(res); if (!ctx) return
    try {
      const seriesId = text(req.body?.seriesId)
      if (!seriesId) throw new GeminiJobError('Missing series.')
      const { queued, skipped } = await ctx.jobs.master(seriesId, parseLanguage(req.body?.language))
      res.json({ queued: queued.map(jobView), skipped, prompt: masterPrompt() })
    } catch (error) { fail(res, error) }
  })
  router.post('/master/stop', studio, async (req, res) => {
    const ctx = needJobs(res); if (!ctx) return
    try {
      const seriesId = text(req.body?.seriesId)
      if (!seriesId) throw new GeminiJobError('Missing series.')
      res.json({ cancelled: await ctx.jobs.stopMaster(seriesId) })
    } catch (error) { fail(res, error) }
  })
  router.get('/jobs/:id', studio, async (req, res) => {
    const ctx = needJobs(res); if (!ctx) return
    try { res.json(await withPrompt(ctx.prisma, await ctx.jobs.job(req.params.id))) } catch (error) { fail(res, error) }
  })
  router.post('/jobs/:id/retry', studio, async (req, res) => {
    const ctx = needJobs(res); if (!ctx) return
    try { res.json(await withPrompt(ctx.prisma, await ctx.jobs.retry(req.params.id))) } catch (error) { fail(res, error) }
  })
  router.get('/jobs/:id/log', studio, async (req, res) => {
    const ctx = needJobs(res); if (!ctx) return
    try { res.json(await ctx.jobs.history(req.params.id)) } catch (error) { fail(res, error) }
  })
  router.post('/drive/cleanup', studio, async (_req, res) => {
    const ctx = needJobs(res); if (!ctx) return
    try { res.json(await ctx.jobs.cleanupDrive()) } catch (error) { fail(res, error) }
  })
  router.post('/jobs/:id/cancel', studio, async (req, res) => {
    const ctx = needJobs(res); if (!ctx) return
    try { res.json({ job: jobView(await ctx.jobs.cancel(req.params.id)) }) } catch (error) { fail(res, error) }
  })

  // ─── The connector's relay ───

  router.post('/bridge/call', async (req, res) => {
    if (!isLoopback(req.socket.remoteAddress)) return res.status(403).json({ error: 'Loopback only.' })
    res.setHeader('Cache-Control', 'no-store')
    try {
      if (!(await connector.verifyToken(req.get('authorization')))) return res.status(401).json({ error: 'The connector token is not valid. Repair the connector in Studio → Settings → Gemini MCP.' })
      const tool = typeof req.body?.tool === 'string' ? req.body.tool : ''
      const args = req.body?.arguments && typeof req.body.arguments === 'object' && !Array.isArray(req.body.arguments) ? req.body.arguments as Record<string, unknown> : {}
      const client = typeof req.body?.client === 'string' ? req.body.client.slice(0, 80) : null
      await connector.noteCall(tool, client, jobArg(args))
      // Settings → Test connection proves the relay end to end; it must never claim or touch a job.
      if (client === SELF_TEST_CLIENT) return res.json({ data: { status: 'ok', note: 'Manhwa Studio is reachable.' } })
      res.json({ data: jobs ? await jobs.bridge(tool, args) : noJobsReply(tool, args) })
    } catch (error) {
      console.error('[gemini-mcp] bridge:', error instanceof Error ? error.message : error)
      // Still data, so Gemini reports it instead of retrying blindly.
      res.json({ data: { status: 'error', reason: 'Manhwa Studio hit an internal error handling this call.' } })
    }
  })
  return router
}

export function initGeminiMcpRoutes(prisma: PrismaClient): Router {
  instance = new GeminiMcpConnector({ store: prismaKeyValueStore(prisma) })
  const driveStore = prismaDriveStore(prisma)
  jobsInstance = new GeminiJobs({
    prisma,
    drive: () => {
      const drive = googleDriveService()
      return { connection: () => drive.requireActiveConnection(), api: id => drive.api(id), store: driveStore }
    }
  })
  jobsInstance.init().catch(error => console.error('[gemini-mcp] jobs init:', error instanceof Error ? error.message : error))
  return createGeminiMcpRouter(instance, allowedOrigins(), jobsInstance, prisma)
}
