/**
 * Studio AntiGravity API — Phase 2: local Antigravity connection, models,
 * non-secret settings and the explicit compatibility proof
 * (docs/PRD-antigravity-studio.md §5, §16.2). Local-only, like the Drive API.
 *
 * Nothing here stores or reads Antigravity credentials: the official CLI keeps
 * its own sign-in. Settings and the compatibility report are non-secret and
 * live in the Setting table.
 */

import { execFile } from 'node:child_process'
import { Router, type Response } from 'express'
import type { PrismaClient } from '@prisma/client'
import { AgyError, detectInstallation, listModels, readUsage, signedInEmail, type AgyInstallation, type AgyModel, type AgyQuota } from '../services/antigravity/cli.js'
import { runCompatibilityCheck, type CompatibilityReport } from '../services/antigravity/compatibility.js'
import { googleDriveService, localOnlyGuard } from './googleDrive.js'
import {
  DEFAULT_CODEX_SETTINGS, DEFAULT_SETTINGS, codexProofStatus, proofStatus, sanitizeCodexSettings, sanitizeSettings,
  type AiEngine, type AntigravitySettings, type CodexConnectionView, type CodexSettings, type ConnectionView
} from '../services/antigravity/settingsModel.js'
export { DEFAULT_SETTINGS, proofStatus, sanitizeSettings, type AntigravitySettings, type ConnectionView }
import { CodexError, codexAccount, detectCodex, listCodexModels, type CodexModel } from '../services/antigravity/codexCli.js'
import { CodexAccountStore, DEFAULT_ACCOUNT_ID } from '../services/antigravity/codexAccounts.js'
import { AntigravityJobs, clipperPartNumber, type JobKind, type RunSettings } from '../services/antigravity/jobs.js'
import { PROMPT_KINDS, PromptStore, type PromptKind } from '../services/antigravity/prompts.js'
import { notifySeriesProcessChanged } from '../services/seriesProcess.js'
import { AntigravityPublisher, openR2Exchange } from '../services/antigravity/publication.js'
import path from 'node:path'
import type { Server } from 'socket.io'

const SETTINGS_KEY = 'antigravitySettings'
const REPORT_KEY = 'antigravityCompatibility'
const CODEX_SETTINGS_KEY = 'antigravityCodexSettings'
const CODEX_REPORT_KEY = 'antigravityCodexCompatibility'
let jobsInstance: AntigravityJobs | null = null
/** The running job service (null until the routes are initialized). */
export const antigravityJobs = () => jobsInstance

export function initAntigravityRoutes(prisma: PrismaClient, io?: Server): Router {
  const router = Router()
  router.use(localOnlyGuard())

  const readJson = async <T>(key: string): Promise<T | null> => {
    const row = await prisma.setting.findUnique({ where: { key } })
    if (!row) return null
    try { return JSON.parse(row.value) as T } catch { return null }
  }
  const writeJson = (key: string, value: unknown) =>
    prisma.setting.upsert({ where: { key }, create: { key, value: JSON.stringify(value) }, update: { value: JSON.stringify(value) } })
  const loadSettings = async () => ({ ...DEFAULT_SETTINGS, ...(await readJson<Partial<AntigravitySettings>>(SETTINGS_KEY)) })
  const loadCodexSettings = async (): Promise<CodexSettings> => ({ ...DEFAULT_CODEX_SETTINGS, ...(await readJson<Partial<CodexSettings>>(CODEX_SETTINGS_KEY)) })

  let modelCache: { at: number; executable: string; models: AgyModel[] } | null = null
  let modelsError: ConnectionView['modelsError'] = null
  let checkRunning: AbortController | null = null

  const models = async (installation: AgyInstallation, refresh: boolean): Promise<AgyModel[] | null> => {
    if (!installation.path) return null
    if (!refresh && modelCache && modelCache.executable === installation.path && Date.now() - modelCache.at < 10 * 60_000) return modelCache.models
    try {
      const list = await listModels(installation.path)
      modelCache = { at: Date.now(), executable: installation.path, models: list }
      modelsError = null
      return list
    } catch (error) {
      modelsError = { code: error instanceof AgyError ? error.code : 'failed', message: error instanceof Error ? error.message : 'Could not list models.' }
      return null
    }
  }

  const view = async (refreshModels = false): Promise<ConnectionView> => {
    const settings = await loadSettings()
    const installation = await detectInstallation(settings.executablePath)
    const report = await readJson<CompatibilityReport>(REPORT_KEY)
    const list = await models(installation, refreshModels)
    const proof = proofStatus(report, installation, settings, { models: list, account: signedInEmail() })
    return { installation, settings, report, proofValid: proof.valid, proofNote: proof.note, checkRunning: !!checkRunning, models: list, modelsError: list ? null : modelsError }
  }

  const fail = (res: Response, error: unknown, status = 400) => res.status(status).json({ error: error instanceof Error ? error.message : 'Request failed' })

  router.get('/connection', async (req, res) => {
    try { res.json(await view(req.query.refresh === '1')) } catch (error) { fail(res, error, 500) }
  })

  router.get('/models', async (_req, res) => {
    try {
      const v = await view(true)
      if (!v.models) return res.status(409).json({ error: v.modelsError?.message ?? v.installation.error ?? 'No models available.', code: v.modelsError?.code ?? 'not_installed' })
      res.json({ models: v.models })
    } catch (error) { fail(res, error, 500) }
  })

  router.get('/settings', async (_req, res) => {
    try { res.json(await loadSettings()) } catch (error) { fail(res, error, 500) }
  })

  router.put('/settings', async (req, res) => {
    try {
      const next = sanitizeSettings(req.body, await loadSettings())
      if (next.model && modelCache && !modelCache.models.some(m => m.id === next.model)) throw new Error('That model is not offered by the signed-in Antigravity installation.')
      await writeJson(SETTINGS_KEY, next)
      res.json(next)
    } catch (error) { fail(res, error) }
  })

  /** Explicit live proof: two real turns on the selected model (uses Antigravity quota). */
  router.post('/check', async (_req, res) => {
    if (checkRunning) return res.status(409).json({ error: 'A compatibility test is already running.' })
    const controller = new AbortController()
    checkRunning = controller
    try {
      const settings = await loadSettings()
      const installation = await detectInstallation(settings.executablePath)
      if (!installation.path) return res.status(409).json({ error: installation.error })
      if (!settings.model) return res.status(409).json({ error: 'Choose and save a model first.' })
      const report = await runCompatibilityCheck({
        executable: installation.path,
        cliVersion: installation.version,
        model: settings.model,
        effort: settings.effort,
        sandbox: settings.sandbox,
        signal: controller.signal
      })
      const tested = { ...report, account: signedInEmail() }
      await writeJson(REPORT_KEY, tested)
      res.json(tested)
    } catch (error) {
      fail(res, error, 500)
    } finally {
      checkRunning = null
    }
  })

  router.post('/check/cancel', (_req, res) => {
    checkRunning?.abort()
    res.json({ cancelled: !!checkRunning })
  })

  /** Open the official interactive CLI in Terminal so the operator signs in there. */
  router.post('/sign-in', async (_req, res) => {
    const settings = await loadSettings()
    const installation = await detectInstallation(settings.executablePath)
    if (!installation.path) return res.status(409).json({ error: installation.error })
    if (process.platform !== 'darwin') return res.json({ opened: false, instructions: `Run "${installation.path}" in a terminal and follow its sign-in.` })
    execFile('open', ['-a', 'Terminal', installation.path], error => {
      res.json({ opened: !error, instructions: 'Terminal opened agy. Type /login (or /logout to switch accounts), finish the Google sign-in in the browser, then type /quit and click Refresh models here.' })
    })
  })

  // ─── ChatGPT (Codex) engine ───
  let codexCheckRunning: AbortController | null = null
  let codexModelsError: CodexConnectionView['modelsError'] = null
  const codexExecutable = async () => (await detectCodex((await loadCodexSettings()).executablePath)).path
  const codexAccounts = new CodexAccountStore({ prisma, executable: codexExecutable })
  /** Signed in when any enabled account is (each account keeps its own ChatGPT sign-in). */
  const codexSignIn = async (executable: string) => {
    const state = await codexAccounts.read()
    const enabled = state.accounts.filter(a => a.enabled)
    for (const a of enabled) {
      const login = await codexAccount(executable, codexAccounts.home(a.id)).catch(() => null)
      if (login?.signedIn) return { login, account: a }
    }
    return { login: enabled.length ? { signedIn: false, mode: null, detail: 'No ChatGPT account Studio can use is signed in to Codex.' } as const : { signedIn: false, mode: null, detail: 'Every ChatGPT account is turned off.' } as const, account: null }
  }

  const codexModels = async (): Promise<CodexModel[] | null> => {
    try {
      const state = await codexAccounts.read()
      const list = await listCodexModels(state.accounts.map(a => codexAccounts.home(a.id)))
      codexModelsError = null
      return list
    } catch (error) {
      codexModelsError = { code: error instanceof CodexError ? error.code : 'failed', message: error instanceof Error ? error.message : 'Could not list Codex models.' }
      return null
    }
  }

  const codexView = async (): Promise<CodexConnectionView> => {
    const settings = await loadCodexSettings()
    const installation = await detectCodex(settings.executablePath)
    const signIn = installation.path ? await codexSignIn(installation.path).catch(() => null) : null
    const account = signIn?.login ?? null
    const report = await readJson<CompatibilityReport>(CODEX_REPORT_KEY)
    const list = installation.path ? await codexModels() : null
    const proof = codexProofStatus(report, installation, settings, account)
    const accounts = await codexAccounts.view()
    // The usage bars at the top follow the account new pages would use now.
    const next = accounts.accounts.find(a => a.enabled && !a.limited) ?? accounts.accounts[0]
    return {
      installation, account, settings, report, proofValid: proof.valid, proofNote: proof.note, checkRunning: !!codexCheckRunning,
      models: list, modelsError: list ? null : codexModelsError, rateLimits: next?.lastLimits ?? null, accounts
    }
  }

  // ─── Usage limits (Running processes) ───
  // Google: live from agy (`/usage` answers without a model turn), cached for
  // two minutes so progress-driven refreshes don't spawn agy each time.
  // ChatGPT: each account's newest Codex session record (local files only).
  const USAGE_TTL_MS = 2 * 60_000
  let googleUsage: { at: number; quota: AgyQuota | null; error: string | null } | null = null
  let googleUsageLoading: Promise<void> | null = null
  const loadGoogleUsage = async (refresh: boolean) => {
    if (!refresh && googleUsage && Date.now() - googleUsage.at < USAGE_TTL_MS) return
    googleUsageLoading ??= (async () => {
      try {
        const installation = await detectInstallation((await loadSettings()).executablePath)
        if (!installation.path) googleUsage = { at: Date.now(), quota: null, error: installation.error ?? 'The Antigravity CLI (agy) was not found.' }
        else googleUsage = { at: Date.now(), quota: await readUsage(installation.path), error: null }
      } catch (error) {
        googleUsage = { at: Date.now(), quota: googleUsage?.quota ?? null, error: error instanceof Error ? error.message : 'Could not read Antigravity usage.' }
      } finally {
        googleUsageLoading = null
      }
    })()
    await googleUsageLoading
  }

  router.get('/usage', async (req, res) => {
    try {
      const [, codex] = await Promise.all([loadGoogleUsage(req.query.refresh === '1'), codexAccounts.usage()])
      res.json({
        google: { account: signedInEmail(), quota: googleUsage?.quota ?? null, error: googleUsage?.error ?? null, checkedAt: googleUsage ? new Date(googleUsage.at).toISOString() : null },
        codex
      })
    } catch (error) { fail(res, error, 500) }
  })

  router.get('/codex/connection', async (_req, res) => {
    try { res.json(await codexView()) } catch (error) { fail(res, error, 500) }
  })

  router.put('/codex/settings', async (req, res) => {
    try {
      const next = sanitizeCodexSettings(req.body, await loadCodexSettings())
      if (next.model) {
        const list = await codexModels()
        const model = list?.find(m => m.id === next.model)
        if (list && !model) throw new Error('That model is not offered by the signed-in Codex.')
        if (model && !model.image) throw new Error('That model has no image input, so it cannot see pages.')
        if (model && next.effort && !model.efforts.includes(next.effort)) next.effort = model.defaultEffort as CodexSettings['effort']
      }
      await writeJson(CODEX_SETTINGS_KEY, next)
      res.json(next)
    } catch (error) { fail(res, error) }
  })

  /** Explicit live proof on the selected Codex model (uses a little of the ChatGPT plan's Codex usage). */
  router.post('/codex/check', async (_req, res) => {
    if (codexCheckRunning) return res.status(409).json({ error: 'A Codex compatibility test is already running.' })
    const controller = new AbortController()
    codexCheckRunning = controller
    try {
      const settings = await loadCodexSettings()
      const installation = await detectCodex(settings.executablePath)
      if (!installation.path) return res.status(409).json({ error: installation.error })
      if (!settings.model) return res.status(409).json({ error: 'Choose and save a Codex model first.' })
      // The test runs on the account new pages would use now.
      const picked = await codexAccounts.pick()
      const login = picked ? await codexAccount(installation.path, picked.home).catch(() => null) : null
      if (!picked || !login?.signedIn) return res.status(409).json({ error: picked ? `Sign in to Codex on "${picked.label}" first.` : 'Every ChatGPT account is turned off or at its Codex limit.' })
      const report = await runCompatibilityCheck({
        engine: 'codex',
        codexHome: picked.home,
        executable: installation.path,
        cliVersion: installation.version,
        model: settings.model,
        effort: settings.effort,
        sandbox: true,
        signal: controller.signal
      })
      await writeJson(CODEX_REPORT_KEY, report)
      res.json(report)
    } catch (error) {
      fail(res, error, 500)
    } finally {
      codexCheckRunning = null
    }
  })

  router.post('/codex/check/cancel', (_req, res) => {
    codexCheckRunning?.abort()
    res.json({ cancelled: !!codexCheckRunning })
  })

  /**
   * Open `codex login` in Terminal for one account: the official ChatGPT sign-in in the browser,
   * stored in that account's own CODEX_HOME. Studio never sees credentials.
   */
  const openCodexLogin = async (res: Response, accountId: string) => {
    const settings = await loadCodexSettings()
    const installation = await detectCodex(settings.executablePath)
    if (!installation.path) return res.status(409).json({ error: installation.error })
    const account = await codexAccounts.get(accountId)
    if (!account) return res.status(404).json({ error: 'Account not found.' })
    const quote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`
    const home = accountId === DEFAULT_ACCOUNT_ID ? '' : `CODEX_HOME=${quote(account.home)} `
    const command = `${home}${quote(installation.path)} login -c 'cli_auth_credentials_store="file"'`
    const extra = accountId === DEFAULT_ACCOUNT_ID ? '' : ' This account is separate from the ChatGPT app: if the browser opens the wrong ChatGPT account, copy the login link Terminal prints into a private window and sign in with the right one.'
    if (process.platform !== 'darwin') return res.json({ opened: false, instructions: `Run in a terminal: ${command}` })
    const script = `tell application "Terminal" to do script ${JSON.stringify(command)}`
    execFile('osascript', ['-e', script, '-e', 'tell application "Terminal" to activate'], error => {
      res.json({ opened: !error, instructions: `Terminal opened codex login for "${account.label}". Choose Sign in with ChatGPT (Plus or above includes Codex), finish in the browser, then click Refresh here.${extra}` })
    })
  }
  router.post('/codex/sign-in', (_req, res) => void openCodexLogin(res, DEFAULT_ACCOUNT_ID))
  router.post('/codex/accounts/:id/sign-in', (req, res) => void openCodexLogin(res, req.params.id))

  // Several ChatGPT accounts: when one reaches its Codex limit, new pages continue on the next.
  router.get('/codex/accounts', async (_req, res) => {
    try { res.json(await codexAccounts.view()) } catch (error) { fail(res, error, 500) }
  })
  router.post('/codex/accounts', async (req, res) => {
    try { res.json(await codexAccounts.add(String(req.body?.label ?? ''))) } catch (error) { fail(res, error) }
  })
  router.patch('/codex/accounts/:id', async (req, res) => {
    try { res.json(await codexAccounts.update(req.params.id, req.body ?? {})) } catch (error) { fail(res, error) }
  })
  router.delete('/codex/accounts/:id', async (req, res) => {
    try {
      const busy = await prisma.antigravityAttempt.count({ where: { codexAccount: req.params.id, status: 'active' } })
      if (busy) throw new Error('A page is running on this account right now. Stop it or wait, then remove the account.')
      await codexAccounts.remove(req.params.id)
      res.json({ removed: true })
    } catch (error) { fail(res, error) }
  })
  router.put('/codex/accounts-order', async (req, res) => {
    try { res.json(await codexAccounts.reorder(Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [])) } catch (error) { fail(res, error) }
  })
  router.put('/codex/accounts-auto-switch', async (req, res) => {
    try { res.json(await codexAccounts.setAutoSwitch(req.body?.on === true)) } catch (error) { fail(res, error) }
  })

  // ─── Prompt pack (PRD §9.1) ───
  const prompts = new PromptStore(prisma)

  router.get('/prompts', async (_req, res) => {
    try {
      const pack = await prompts.pack()
      res.json({ kinds: PROMPT_KINDS.map(kind => ({ kind, id: pack.ids[kind], sha256: pack.hashes[kind], origin: pack.origins[kind], content: pack.texts[kind] })) })
    } catch (error) { fail(res, error, 500) }
  })

  router.get('/prompts/:kind/history', async (req, res) => {
    try {
      if (!PROMPT_KINDS.includes(req.params.kind as PromptKind)) return res.status(404).json({ error: 'Unknown prompt kind.' })
      res.json(await prompts.history(req.params.kind as PromptKind))
    } catch (error) { fail(res, error, 500) }
  })

  router.get('/prompts/version/:id', async (req, res) => {
    const version = await prompts.version(req.params.id)
    if (!version) return res.status(404).json({ error: 'Version not found.' })
    res.json(version)
  })

  router.put('/prompts/:kind', async (req, res) => {
    try {
      if (!PROMPT_KINDS.includes(req.params.kind as PromptKind)) return res.status(404).json({ error: 'Unknown prompt kind.' })
      if (typeof req.body?.content !== 'string') throw new Error('Paste the prompt text.')
      const origin = typeof req.body?.origin === 'string' && req.body.origin.trim() ? req.body.origin.trim() : 'edited in Studio'
      res.json(await prompts.save(req.params.kind as PromptKind, req.body.content, origin))
    } catch (error) { fail(res, error) }
  })

  // ─── Runs and page jobs (PRD §13, §16.2) ───
  /** Run settings for one engine (default: the engine chosen for new runs). Shared: parallel pages and page deadline. */
  const runSettings = async (engineOverride?: AiEngine): Promise<RunSettings> => {
    const settings = await loadSettings()
    const engine = engineOverride ?? settings.engine
    if (engine === 'codex') {
      const codex = await loadCodexSettings()
      const installation = await detectCodex(codex.executablePath)
      if (!installation.path) throw new Error(installation.error ?? 'The Codex CLI was not found.')
      if (!codex.model) throw new Error('Choose a Codex model in Settings → AntiGravity → ChatGPT (Codex).')
      const account = (await codexSignIn(installation.path).catch(() => null))?.login ?? null
      const proof = codexProofStatus(await readJson<CompatibilityReport>(CODEX_REPORT_KEY), installation, codex, account)
      if (!proof.valid) throw new Error(proof.note ?? 'Run the Codex compatibility test in Settings → AntiGravity.')
      return { engine, model: codex.model, modelLabel: codex.modelLabel, effort: codex.effort, sandbox: true, concurrency: settings.concurrency, pageTimeoutMinutes: settings.pageTimeoutMinutes, executable: installation.path, cliVersion: installation.version }
    }
    const installation = await detectInstallation(settings.executablePath)
    if (!installation.path) throw new Error(installation.error ?? 'The Antigravity CLI was not found.')
    if (!settings.model) throw new Error('Choose a model in AntiGravity → Settings.')
    const proof = proofStatus(await readJson<CompatibilityReport>(REPORT_KEY), installation, settings, { models: await models(installation, false), account: signedInEmail() })
    if (!proof.valid) throw new Error(proof.note ?? 'Run the compatibility test in AntiGravity → Settings.')
    return { engine, model: settings.model, modelLabel: settings.modelLabel, effort: settings.effort, sandbox: settings.sandbox, concurrency: settings.concurrency, pageTimeoutMinutes: settings.pageTimeoutMinutes, executable: installation.path, cliVersion: installation.version }
  }
  const SEEN_KEY = (seriesId: string) => `antigravitySharedSeen:${seriesId}`
  const publisher = new AntigravityPublisher({
    prisma,
    open: openR2Exchange,
    installationId: async () => (await import('../services/librarySync.js')).libraryDeviceId(),
    revisions: {
      restart: async folder => {
        const { libraryControl } = await import('../services/libraryControls.js')
        const { restartRevision } = await import('../services/seriesRestartModel.js')
        const { seriesRestartPending } = await import('../services/seriesRestartGuard.js')
        return { revision: restartRevision(await libraryControl(folder)), pending: await seriesRestartPending(folder) }
      },
      pageRevision: async folderPath => (await (await import('../services/chapterPageReplacement.js')).readPageReplacement(folderPath))?.revision ?? null
    },
    seen: {
      read: async seriesId => { const row = await prisma.setting.findUnique({ where: { key: SEEN_KEY(seriesId) } }); return row ? JSON.parse(row.value) : {} },
      write: async (seriesId, map) => { await prisma.setting.upsert({ where: { key: SEEN_KEY(seriesId) }, create: { key: SEEN_KEY(seriesId), value: JSON.stringify(map) }, update: { value: JSON.stringify(map) } }) }
    }
  })
  /** One "check R2 now" per finished run: relay when set up, else the R2 request file. */
  const notifyPhones = async (seriesId: string) => {
    const relay = await import('../services/phoneRelay.js')
    if (relay.relayConfigured()) {
      const series = await prisma.series.findUnique({ where: { id: seriesId }, select: { rootFolder: true } })
      await relay.sendPhoneRequest('sync', series ? { series: path.basename(series.rootFolder) } : {})
    } else {
      await (await import('../services/r2Service.js')).requestPhoneUpdate('sync')
    }
  }
  const jobs = new AntigravityJobs({
    prisma,
    drive: googleDriveService(),
    io,
    port: Number(process.env.PORT || 3001),
    settings: runSettings,
    prompts: () => prompts.pack(),
    onPointersChanged: () => notifySeriesProcessChanged(true),
    publisher,
    notifyPhones,
    codexAccounts,
    // Timeline: Editor 2.0's own inputs, small-batches checkpoint, processor and save (loaded on first use).
    editor: {
      savedTimeline: async (chapterId, language) => {
        const row = await prisma.editor2Timeline.findUnique({ where: { chapterId_language: { chapterId, language } } })
        return row?.json.trim() ? row.json : null
      },
      blockers: async (chapterId, language) => {
        const { getChapterBlockers } = await import('../services/videoEditor2Service.js')
        return (await getChapterBlockers(chapterId, language)) ?? ['Chapter not found']
      },
      oneShot: async (chapterId, language) => {
        const { buildEditorPackage, getEditorPrompt } = await import('../services/phoneEditor.js')
        const prompt = (await getEditorPrompt()).content
        if (!prompt) return { reason: 'Save the Editor 2.0 prompt in Settings → Editor 2.0 first: One-shot sends it with the chapter.' }
        const pkg = await buildEditorPackage(chapterId, language, 'legacy')
        if ('skip' in pkg) return { reason: `Editor package: ${pkg.skip}` }
        const c = pkg.content as { timeline: string; metadata: string; sections: { number: number; durationSec: number | null }[]; images: string[]; finalCropAuthority?: { retainedStoryLinks?: unknown } }
        const { createHash } = await import('node:crypto')
        return {
          revision: createHash('sha256').update(`${pkg.sha256} ${prompt}`).digest('hex'),
          prompt, timeline: c.timeline, metadata: c.metadata, sections: c.sections, images: c.images,
          retainedStoryLinks: !!c.finalCropAuthority?.retainedStoryLinks
        }
      },
      batches: async (chapterId, language, reply) => {
        const { editorWorkflowSession } = await import('../services/editorWorkflowStore.js')
        return editorWorkflowSession(chapterId, language, reply)
      },
      process: async (chapterId, json, language) => {
        const { processTimelineJson } = await import('../services/editor2Timeline.js')
        const plan = await processTimelineJson(chapterId, json, language)
        return { missingRefs: plan.missingRefs, warnings: plan.warnings }
      },
      save: async (chapterId, language, json, model) => {
        const { storeEditorTimeline } = await import('../services/editorTimelineStore.js')
        await storeEditorTimeline({ chapterId, language, json, processedJson: null, updatedAt: Date.now(), model })
      },
      // Phones skip chapters a Timeline job is making (editorClaims.ts).
      claimsChanged: () => { void import('../services/editorClaims.js').then(m => m.queueEditorClaims()) }
    },
    pinnedPrompts: async ids => {
      const texts: Record<string, string> = {}
      const hashes: Record<string, string> = {}
      for (const kind of PROMPT_KINDS) {
        const row = ids[kind] ? await prompts.version(ids[kind]) : null
        if (!row) return null
        texts[kind] = row.content
        hashes[kind] = row.sha256
      }
      return { ids, hashes, texts } as unknown as Awaited<ReturnType<typeof prompts.pack>>
    },
    sourceBusy: async folderPath => {
      const { pageReplacementActive } = await import('../services/chapterPageReplacement.js')
      const { seriesRestartPending } = await import('../services/seriesRestartGuard.js')
      const series = folderPath.split('/')[0]
      return pageReplacementActive(folderPath) || await seriesRestartPending(series)
    },
    // Same rejection as Clipper's "Reject", without picking a phone to redo it:
    // AntiGravity runs the page again (or the operator chooses who does).
    rejectSource: async page => {
      const { isChapterCropping, seriesSlug } = await import('../services/clipper3/chapterCrop.js')
      if (isChapterCropping(page.chapterId)) throw new Error('Wait for this chapter\'s crop to finish before rejecting a page.')
      const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: page.chapterId }, select: { number: true, series: { select: { title: true } } } })
      const { rejectPage, publishPageRedo } = await import('../services/clipper3/pageRedo.js')
      const { libraryControl } = await import('../services/libraryControls.js')
      const { restartRevision } = await import('../services/seriesRestartModel.js')
      const { readPageReplacement } = await import('../services/chapterPageReplacement.js')
      return rejectPage({
        folderPath: page.folderPath, filename: page.filename, chapterNumber: chapter.number, seriesSlug: seriesSlug(chapter.series.title), deviceId: null,
        restartRevision: restartRevision(await libraryControl(path.basename(path.dirname(page.folderPath)))),
        pageRevision: (await readPageReplacement(page.folderPath))?.revision ?? null
      }, publishPageRedo)
    }
  })
  jobsInstance = jobs
  // Markers left by a Studio that quit mid-job are settled once, only when a Timeline job ran recently.
  void import('../services/editorClaims.js').then(m => m.settleEditorClaimsOnStart()).catch(error => console.error('[editor-claims] start-up check failed:', error))
  void jobs.recoverAfterRestart().catch(error => console.error('[antigravity] recovery:', error instanceof Error ? error.message : error))

  router.post('/runs', async (req, res) => {
    try {
      const body = req.body ?? {}
      // Metadata is saved in Studio only (no Drive, no R2); a Timeline is saved in Editor 2.0, whose own sending
      // reaches the phones when R2 is set up; Image Clipper publishes its results to phones through R2.
      const kind: JobKind = body.kind === 'metadata' || body.kind === 'editor' ? body.kind : 'clipper'
      const editor = kind === 'editor' ? body.editor : undefined
      const requireR2 = async () => {
        if (kind !== 'clipper') return
        const { getR2Config } = await import('../services/r2Service.js')
        if (!getR2Config()) throw new Error('Set up Cloudflare R2 (Settings → Cloudflare) before starting: results are published there for phones.')
      }
      // Start process: the part's next pending pages, one process at a time (no page list).
      if (body.mode === 'next') {
        if (typeof body.seriesId !== 'string') throw new Error('Missing series.')
        await runSettings()
        await requireR2()
        return res.json(await jobs.startNext({ seriesId: body.seriesId, partNumber: Number(body.partNumber), kind, editor }))
      }
      const pages = Array.isArray(body.pages) ? body.pages.filter((p: unknown): p is { chapterId: string; filename: string } =>
        !!p && typeof (p as { chapterId?: unknown }).chapterId === 'string' && typeof (p as { filename?: unknown }).filename === 'string' && !/[\\/]/.test((p as { filename: string }).filename)) : []
      if (pages.length !== (Array.isArray(body.pages) ? body.pages.length : -1)) throw new Error('Pages must be {chapterId, filename} pairs.')
      if (typeof body.seriesId !== 'string') throw new Error('Missing series.')
      const prepareOnly = body.prepareOnly === true
      if (!prepareOnly) {
        await runSettings()
        // PRD §14.1: Start needs R2; preparation does not.
        await requireR2()
      }
      res.json(await jobs.start({ seriesId: body.seriesId, partNumber: Number(body.partNumber), pages, prepareOnly, kind, editor }))
    } catch (error) { fail(res, error) }
  })

  /** The live process (one at a time), else the most recent one. */
  router.get('/runs/current', async (_req, res) => {
    try { res.json(await jobs.current()) } catch (error) { fail(res, error, 500) }
  })

  router.get('/runs/:id', async (req, res) => {
    try {
      const detail = await jobs.runDetail(req.params.id)
      if (!detail) return res.status(404).json({ error: 'Run not found.' })
      res.json(detail)
    } catch (error) { fail(res, error, 500) }
  })

  router.get('/runs', async (req, res) => {
    try {
      const where = typeof req.query.seriesId === 'string' ? { seriesId: req.query.seriesId } : {}
      res.json(await prisma.antigravityRun.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, seriesId: true, partNumber: true, kind: true, engine: true, model: true, control: true, createdAt: true, finishedAt: true } }))
    } catch (error) { fail(res, error, 500) }
  })

  for (const action of ['pause', 'resume', 'stop'] as const) {
    router.post(`/runs/:id/${action}`, async (req, res) => {
      try { res.json(await jobs.control(req.params.id, action)) } catch (error) { fail(res, error) }
    })
  }

  router.post('/jobs/:id/retry', async (req, res) => {
    try { res.json(await jobs.retry(req.params.id)) } catch (error) { fail(res, error) }
  })

  router.post('/jobs/:id/reject', async (req, res) => {
    try {
      const body = req.body ?? {}
      res.json(await jobs.reject(req.params.id, { rerun: body.rerun === true, note: typeof body.note === 'string' ? body.note : undefined }))
    } catch (error) {
      const { TaskConflict } = await import('../services/managedTaskProtocol.js')
      fail(res, error, error instanceof TaskConflict ? 409 : 400)
    }
  })

  router.post('/jobs/:id/review', async (req, res) => {
    try { res.json(await jobs.reviewAgain(req.params.id)) } catch (error) { fail(res, error) }
  })

  router.post('/jobs/:id/publish', async (req, res) => {
    try { res.json(await jobs.publishAgain(req.params.id)) } catch (error) { fail(res, error) }
  })

  /** Scoped R2 collection (PRD §14.4): explicit only, never on a timer. */
  router.post('/results/fetch', async (req, res) => {
    try {
      const body = req.body ?? {}
      if (typeof body.seriesId !== 'string') throw new Error('Missing series.')
      const chapterIds = Array.isArray(body.chapterIds) ? body.chapterIds.filter((x: unknown): x is string => typeof x === 'string').slice(0, 200) : undefined
      const outcome = await publisher.fetch({ seriesId: body.seriesId, chapterIds })
      if (outcome.imported) notifySeriesProcessChanged(true)
      res.json(outcome)
    } catch (error) { fail(res, error) }
  })

  router.get('/r2-status', async (_req, res) => {
    try {
      const { getR2Config } = await import('../services/r2Service.js')
      const config = getR2Config()
      res.json({ configured: !!config })
    } catch (error) { fail(res, error, 500) }
  })

  router.post('/page-jobs', async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.chapterIds) ? req.body.chapterIds.filter((x: unknown) => typeof x === 'string').slice(0, 200) : []
      res.json(await jobs.pageJobs(ids, req.body?.kind === 'metadata' || req.body?.kind === 'editor' ? req.body.kind : 'clipper'))
    } catch (error) { fail(res, error, 500) }
  })

  /**
   * Metadata status of one part's chapters, as Studio's Metadata library reads it (clipper3/metadataSplit.ts):
   * per page complete / pending / invalid, and why a chapter can't have Metadata yet (review, cut, script).
   */
  router.post('/metadata/status', async (req, res) => {
    try {
      const seriesId = typeof req.body?.seriesId === 'string' ? req.body.seriesId : ''
      const partNumber = Number(req.body?.partNumber)
      if (!seriesId || !Number.isInteger(partNumber) || partNumber < 1) throw new Error('Missing series or part.')
      const series = await prisma.series.findUnique({ where: { id: seriesId }, select: { title: true } })
      if (!series) return res.status(404).json({ error: 'Series not found.' })
      const rows = (await prisma.chapter.findMany({ where: { seriesId }, orderBy: { number: 'asc' }, select: { id: true, number: true, title: true, folderPath: true, seriesId: true } }))
        .filter(c => clipperPartNumber(c.number) === partNumber)
      const { readMetadataChapter } = await import('../services/metadataChapterStatus.js')
      const chapters = []
      for (const row of rows) chapters.push(await readMetadataChapter({ ...row, series: { title: series.title } }))
      res.json({ chapters })
    } catch (error) { fail(res, error) }
  })

  /**
   * Timeline status of one part's chapters in both languages, as Editor 2.0's checklist reads it: whether a
   * timeline is saved (and who made it), and what else the chapter still misses (voiceover, alignment, crops).
   */
  router.post('/editor/status', async (req, res) => {
    try {
      const seriesId = typeof req.body?.seriesId === 'string' ? req.body.seriesId : ''
      const partNumber = Number(req.body?.partNumber)
      if (!seriesId || !Number.isInteger(partNumber) || partNumber < 1) throw new Error('Missing series or part.')
      if (!(await prisma.series.findUnique({ where: { id: seriesId }, select: { id: true } }))) return res.status(404).json({ error: 'Series not found.' })
      const { getEditableChapters2, CHECKLIST_LABELS } = await import('../services/videoEditor2Service.js')
      const languages = ['en', 'hi'] as const
      const lists = await Promise.all(languages.map(l => getEditableChapters2(seriesId, l)))
      const inPart = lists[0].filter(c => clipperPartNumber(c.number) === partNumber)
      const rows = await prisma.editor2Timeline.findMany({ where: { chapterId: { in: inPart.map(c => c.id) } }, select: { chapterId: true, language: true, json: true, model: true, processedJson: true } })
      const chapters = inPart.map(chapter => ({
        id: chapter.id, number: chapter.number, title: chapter.title,
        languages: Object.fromEntries(languages.map((language, i) => {
          const c = lists[i].find(x => x.id === chapter.id)!
          const row = rows.find(r => r.chapterId === chapter.id && r.language === language)
          const missing = (['audio', 'alignment', 'crops'] as const).filter(k => !c.checklist[k].ok)
          return [language, {
            saved: !!row?.json.trim(), processed: !!row?.processedJson, model: row?.json.trim() ? row.model : null,
            ready: missing.length === 0,
            missing: missing.map(k => ({ label: CHECKLIST_LABELS[k], detail: c.checklist[k].detail }))
          }]
        }))
      }))
      res.json({ chapters })
    } catch (error) { fail(res, error) }
  })

  // ─── MCP bridge: called only by resources/antigravity/job-mcp.mjs on this Mac ───
  const bearer = (header: string | undefined) => (header?.startsWith('Bearer ') ? header.slice(7) : '')
  router.post('/bridge/tools', async (req, res) => {
    const token = bearer(req.get('authorization'))
    if (token.length < 32) return res.status(401).json({ error: 'Missing capability.' })
    try {
      res.json({ tools: await jobs.tools(token) })
    } catch (error) { fail(res, error, 500) }
  })
  router.post('/bridge/call', async (req, res) => {
    const token = bearer(req.get('authorization'))
    if (token.length < 32) return res.status(401).json({ error: 'Missing capability.' })
    try {
      const body = req.body ?? {}
      res.json(await jobs.call(token, { tool: String(body.tool ?? ''), arguments: body.arguments && typeof body.arguments === 'object' ? body.arguments : {}, conversationId: typeof body.conversationId === 'string' ? body.conversationId : null }))
    } catch (error) {
      console.error('[antigravity] bridge:', error instanceof Error ? error.message : error)
      res.json({ isError: true, content: [{ type: 'text', text: 'Studio hit an internal error handling this tool call.' }] })
    }
  })

  return router
}
