import path from 'path'
import fs from 'fs/promises'
import { setTimeout as delay } from 'timers/promises'
import type { Server } from 'socket.io'
import { prisma } from '../index.js'
import { ProductionRunner } from './productionRunner.js'
import { productionChapters, productionDevices, productionShares, stagesDone, type ProductionJob, type ProductionStep } from './productionAutomationModel.js'
import { getSeriesProcess, notifySeriesProcessChanged } from './seriesProcess.js'
import type { ProcessStage } from './seriesProcessModel.js'
import { getPhoneOverview, getR2Config, sendAutomationCommand, type PhoneRunKind } from './r2Service.js'
import { relayReceipts, relayStatus, sendPhoneRequest } from './phoneRelay.js'
import { getSendJob, getSeriesSendPlan, startPhoneSend } from './phoneSend.js'
import { sendProfileCommand } from './phoneProfiles.js'
import { getPhoneScreens } from './phoneScreen.js'
import { previewPhoneScripts, importPhoneScripts } from './phoneScriptImport.js'
import { fetchPhoneVoiceover } from './phoneVoiceoverImport.js'
import { alignSectionInBackground, pendingAlignments } from './alignment/alignmentService.js'
import { getChapterManifest } from './chapterManifest.js'
import { fetchPhoneCrops } from './phoneCropImport.js'
import { syncChapterProcessed } from './clipper3/processedSync.js'
import { seriesSlug, queueAutoCrop, readChapterCropState } from './clipper3/chapterCrop.js'

const PREFIX = 'productionAutomation:'
const LANGUAGES = ['en', 'hi'] as const
let io: Server

async function series(id: string) {
  const value = (await getSeriesProcess()).series.find(s => s.seriesId === id)
  if (!value) throw new Error('Series not found')
  return value
}
async function chapters(job: ProductionJob) {
  const ids = productionChapters(await series(job.seriesId)).map(c => c.id)
  return prisma.chapter.findMany({ where: { seriesId: job.seriesId, id: { in: ids }, completedAt: null }, include: { series: true }, orderBy: { number: 'asc' } })
}
const overview = () => getPhoneOverview(null)
const busy = (data: Awaited<ReturnType<typeof overview>>, device: string) =>
  data.working.some(w => w.device === device) || data.runs.some(r => r.device === device)

async function waitFor(signal: AbortSignal, check: () => Promise<boolean>, message: string, timeout = 30 * 60_000) {
  const until = Date.now() + timeout
  while (true) {
    signal.throwIfAborted()
    if (await check()) return
    if (Date.now() >= until) throw new Error(message)
    await delay(3000, undefined, { signal })
  }
}

async function selectProfile(job: ProductionJob, signal: AbortSignal) {
  const data = await overview()
  const target = data.phones.find(p => p.id === job.config.device)
  if (!relayStatus().connected || !target?.connected || !target.automation?.remoteStart) throw new Error('The chosen phone is unavailable. Reconnect it, then resume automation.')
  if (busy(data, job.config.device)) throw new Error('The chosen phone is busy. Wait for its current run, then resume automation.')
  const profile = data.profiles.find(p => p.device === target.id && p.profileId === job.config.profileId)
  if (!profile) throw new Error('The chosen profile is no longer on this phone')
  if (profile.selected) return
  signal.throwIfAborted()
  const sent = await sendProfileCommand('select', target.id, profile.profileId)
  await waitFor(signal, async () => {
    const screen = getPhoneScreens().find(s => s.device === target.id)?.screen
    if (screen?.answers === sent.id && screen.last?.ok === false) throw new Error(screen.last.note || 'The phone could not switch profile')
    return !!(await overview()).profiles.find(p => p.device === target.id && p.profileId === profile.profileId && p.selected)
  }, 'The phone did not confirm its profile switch. Check it and resume.', 60_000)
}

/** Verify the selected phone's receipt, never another phone's merged download counts. */
async function ensurePages(job: ProductionJob, signal: AbortSignal, chapterIds: string[]) {
  const rows = (await chapters(job)).filter(c => chapterIds.includes(c.id))
  const folder = path.basename(rows[0]?.series.rootFolder ?? '')
  if (!rows.length) throw new Error('No unfinished chapters are available')
  const hasPages = () => {
    const receipt = relayReceipts<any>('sync')?.find(r => r.device === job.config.device)
    return rows.every(c => receipt?.body.series?.[folder]?.chapters?.[path.basename(c.folderPath)]?.state === 'downloaded')
  }
  if (hasPages()) return
  const plan = await getSeriesSendPlan(job.seriesId)
  const wanted = new Set(rows.map(c => c.id))
  const toSend = plan?.chapters.filter(c => wanted.has(c.chapterId) && ['new', 'changed'].includes(c.state)).map(c => c.chapterId) ?? []
  if (toSend.length) {
    await waitFor(signal, async () => getSendJob()?.state !== 'running', 'Another chapter send is still running')
    signal.throwIfAborted()
    const sent = await startPhoneSend([{ seriesId: job.seriesId, chapterIds: toSend }], io)
    await waitFor(signal, async () => getSendJob()?.id !== sent.id || getSendJob()?.state !== 'running', 'Chapter upload did not finish')
    const outcome = getSendJob()
    if (outcome?.id === sent.id && (outcome.state !== 'done' || outcome.series.some(s => s.state === 'failed' || s.state === 'cancelled'))) throw new Error('Chapter upload failed or was cancelled. Check Send to phone and resume.')
  }
  signal.throwIfAborted()
  await sendPhoneRequest('sync', { device: job.config.device })
  await waitFor(signal, async () => hasPages(), 'The chosen phone has not downloaded the required chapters. Check Phone Status, then resume.')
}

type Report = (message: string, command?: ProductionJob['command']) => Promise<void>
async function stopCommandPhones(job: ProductionJob) {
  if (!job.command) return
  const data = await overview()
  const results = await Promise.allSettled((job.command.devices ?? [job.config.device]).map(async device => {
    const foreign = data.runs.some(r => r.device === device && (r.seriesId !== job.seriesId || r.kind !== job.command?.kind || job.command?.language && r.tabs.some(t => t.language !== job.command?.language)))
      || data.working.some(w => w.device === device && (w.seriesId !== job.seriesId || job.command?.kind !== 'clipper'))
    if (!foreign) await sendAutomationCommand('stop', { device })
  }))
  const failed = results.filter(r => r.status === 'rejected')
  if (failed.length) throw new Error(`Could not stop ${failed.length} phone(s). Check Phone Status before resuming.`)
}

async function ensureScripts(job: ProductionJob, signal: AbortSignal, names: string[], language: 'en' | 'hi') {
  const rows = await chapters(job)
  const folder = path.basename(rows[0]?.series.rootFolder ?? '')
  signal.throwIfAborted()
  // A phone may already have the pages while it still needs the newly generated shared scripts.
  await sendPhoneRequest('sync', { device: job.config.device })
  await waitFor(signal, async () => {
    const receipts = relayReceipts<any>('scripts') ?? []
    const script = (device: string, chapter: string) => {
      const series = receipts.find(r => r.device === device)?.body.series?.[folder]
      return (language === 'hi' ? series?.hi : series)?.chapters?.[chapter]
    }
    return names.every(name => {
      const own = script(job.config.device, name)
      const newest = Math.max(0, ...receipts.map(r => Date.parse(script(r.device, name)?.savedAt) || 0))
      return ['done', 'needs_summary', 'review'].includes(own?.status) && (Date.parse(own?.savedAt) || 0) >= newest
    })
  }, 'The latest scripts have not synced to every phone. Check shared scripts and resume.', 10 * 60_000)
}

async function runPhone(job: ProductionJob, signal: AbortSignal, report: Report, kind: Exclude<PhoneRunKind, 'editor'>, keys: ProcessStage[], language?: 'en' | 'hi') {
  const scope = productionChapters(await series(job.seriesId)).filter(c => !stagesDone([c], keys))
  const shares = productionShares(job.config, kind, scope)
  if (!shares.length) return
  const label = `${kind}${language ? ` · ${language === 'en' ? 'English' : 'Hinglish'}` : ''}`
  // Uploads use one shared send queue. Prepare every participant before dispatching any starts.
  for (const { target, chapters } of shares) {
    const local = { ...job, config: { ...job.config, ...target } }
    await report(`Preparing ${target.device} for ${label}…`)
    await ensurePages(local, signal, chapters.map(c => c.id))
    if (kind === 'voiceover' && language) await ensureScripts(local, signal, chapters.map(c => c.name), language)
    await selectProfile(local, signal)
    const phone = (await overview()).phones.find(p => p.id === target.device)
    if (!phone?.automation?.runs.includes(kind)) throw new Error(`Update Sleeper-Cell on ${target.device} to run ${kind}`)
  }
  // Persist every possible recipient before the first network call, including partial dispatches.
  await report(`Running ${label} on ${shares.length} phone${shares.length === 1 ? '' : 's'}…`,
    { kind, language, devices: shares.map(s => s.target.device), sentAt: new Date().toISOString() })
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) controller.abort()
  let firstError: unknown
  try {
    const results = await Promise.allSettled(shares.map(async ({ target, chapters }) => {
      const runSignal = controller.signal
      try {
        runSignal.throwIfAborted()
        const sent = await sendAutomationCommand('start', { kind, seriesId: job.seriesId, device: target.device, chapters: chapters.map(c => c.name),
          ...(kind === 'voiceover' ? { language, tabs: 2 } : {}),
          ...(kind === 'clipper' ? job.config.clipper : {}) })
        if (runSignal.aborted) await sendAutomationCommand('stop', { device: target.device })
        runSignal.throwIfAborted()
        if (!sent.phones) throw new Error(`${target.device} disconnected while starting. Check its run before resuming.`)
        let lastActive = Date.now()
        await waitFor(runSignal, async () => {
          const data = await overview()
          const phone = data.phones.find(p => p.id === target.device)
          if (!phone?.connected || busy(data, target.device) || phone.automation?.resume) lastActive = Date.now()
          const current = productionChapters(await series(job.seriesId)).filter(c => chapters.some(assigned => assigned.id === c.id))
          const done = current.length === 0 || stagesDone(current, keys)
          if (done && phone?.connected && !busy(data, target.device)) return true
          if (!done && Date.now() - lastActive > 120_000) throw new Error(`${label} stopped early on ${phone?.name ?? target.device}. Check its limits or errors, then resume.`)
          return false
        }, 'The phone run has not finished. Check Phone Status and resume when ready.', 24 * 60 * 60_000)
      } catch (error) { firstError ??= error; controller.abort(); throw error }
    }))
    const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failure) {
      try { await stopCommandPhones(job) }
      catch (stopError) { throw new Error(`${firstError instanceof Error ? firstError.message : String(firstError)} ${stopError instanceof Error ? stopError.message : String(stopError)}`) }
      throw firstError
    }
  } finally { signal.removeEventListener('abort', abort) }
}

/** Pull only at stage handoffs; waiting for uploads never continuously lists R2. */
async function importScripts(job: ProductionJob, signal: AbortSignal, report: Report) {
  const rows = await chapters(job)
  for (const language of LANGUAGES) {
    signal.throwIfAborted()
    const candidates = await prisma.chapterScript.findMany({ where: { chapterId: { in: rows.map(c => c.id) }, language, status: { in: ['done', 'edited'] } } })
    const existing: typeof candidates = []
    for (const c of candidates) if (c.scriptPath && (await fs.stat(c.scriptPath).catch(() => null))?.size) existing.push(c)
    if (existing.length === rows.length) continue
    await report(`Fetching ${language === 'en' ? 'English' : 'Hinglish'} scripts from the phone…`)
    // Uploads may still be finalizing after the run's final receipt. One retry per minute, bounded.
    for (let attempt = 0; attempt < 6; attempt++) {
      signal.throwIfAborted()
      const preview = await previewPhoneScripts(job.seriesId, language)
      const missing = preview?.chapters.filter(c => rows.some(r => r.id === c.chapterId) && !existing.some(e => e.chapterId === c.chapterId) && !c.published) ?? []
      if (missing.some(c => c.sourceMatches === false || c.review?.length)) throw new Error('A Hinglish script needs review in Narration before automation can continue.')
      const ids = missing.map(c => c.chapterId)
      if (preview && rows.every(c => ids.includes(c.id) || existing.some(e => e.chapterId === c.id))) {
        if (ids.length) await importPhoneScripts(job.seriesId, preview.zip.etag, ids, language)
        break
      }
      if (attempt === 5) throw new Error('The phone’s complete script upload is not available yet, or a script needs review. Check Narration and resume.')
      await delay(60_000, undefined, { signal })
    }
  }
  notifySeriesProcessChanged(true)
}

async function importVoice(job: ProductionJob, signal: AbortSignal, report: Report, language: 'en' | 'hi') {
  const rows = await chapters(job)
  const queueAlignment = async () => {
    const sections = await prisma.audioSection.findMany({ where: { chapterId: { in: rows.map(c => c.id) }, language }, include: { audioFile: true } })
    for (const c of rows) {
      if (pendingAlignments(c.id, language)) continue
      for (const s of sections.filter(s => s.chapterId === c.id && s.audioFile?.status === 'done' && !s.timelineScript?.trim())) {
        signal.throwIfAborted()
        alignSectionInBackground(s.id, io)
      }
    }
  }
  const attached = async () => {
    const sections = await prisma.audioSection.findMany({ where: { chapterId: { in: rows.map(c => c.id) }, language }, include: { audioFile: true } })
    if (!rows.every(c => sections.some(s => s.chapterId === c.id))) return false
    for (const s of sections) if (s.audioFile?.status !== 'done' || !(await fs.stat(s.audioFile.filePath).catch(() => null))?.size) return false
    return true
  }
  if (await attached()) { await queueAlignment(); return }
  await report(`Fetching ${language === 'en' ? 'English' : 'Hinglish'} voiceovers and aligning on this Mac…`)
  for (let attempt = 0; attempt < 6; attempt++) {
    signal.throwIfAborted()
    const result = await fetchPhoneVoiceover(job.seriesId, rows.map(c => c.id), io, language)
    if (result.failed.length) throw new Error(result.failed[0].reason)
    if (result.fetched?.some(c => c.scriptMatches === false)) throw new Error('A phone voiceover does not match the current script. Review it in Narration before continuing.')
    notifySeriesProcessChanged(true)
    if (await attached()) { await queueAlignment(); return }
    if (attempt === 5) throw new Error('The phone’s complete voiceover upload is not available yet. Check Narration and resume.')
    await delay(60_000, undefined, { signal })
  }
}

async function syncCrops(job: ProductionJob, signal: AbortSignal, report: Report) {
  const rows = await chapters(job)
  const local = await Promise.all(rows.map(c => readChapterCropState(c)))
  if (local.every(c => c.fullyAttached)) { await queueAutoCrop(io, rows); return }
  await report('Fetching crop JSON for manual review…')
  for (let attempt = 0; attempt < 6; attempt++) {
    signal.throwIfAborted()
    const fetched = await fetchPhoneCrops(job.seriesId, rows.map(c => c.id))
    if (fetched.failed.length) throw new Error(fetched.failed[0].reason)
    let allAttached = true
    for (const c of rows) {
      signal.throwIfAborted()
      const manifest = await getChapterManifest(c.folderPath)
      const result = await syncChapterProcessed({ chapterId: c.id, chapterNumber: c.number, folderPath: c.folderPath, seriesSlug: seriesSlug(c.series.title), images: manifest.images })
      if (result.failed) throw new Error(`Crop JSON could not be attached for chapter ${c.number}. Review it in Image Clipper.`)
      if (!(await readChapterCropState(c)).fullyAttached) allAttached = false
    }
    if (allAttached) {
      // Preserve the established review rule: only chapters already reviewed by a human are cut.
      await queueAutoCrop(io, rows)
      notifySeriesProcessChanged(true)
      return
    }
    if (attempt === 5) throw new Error('Some crop JSON uploads are not available yet. Check Image Clipper and resume.')
    await delay(60_000, undefined, { signal })
  }
}

async function perform(step: ProductionStep, job: ProductionJob, signal: AbortSignal, report: Report) {
  if (step === 'preparation') {
    throw new Error('Complete Preparation before starting the Scripts → Voiceovers → Image Clipping automation.')
  } else if (step === 'scripts') {
    await runPhone(job, signal, report, 'narration', ['script_en', 'script_hi'])
    await importScripts(job, signal, report)
  } else if (step === 'voiceover') {
    await importScripts(job, signal, report)
    for (const language of LANGUAGES) {
      await runPhone(job, signal, report, 'voiceover', [`voice_${language}`], language)
      await importVoice(job, signal, report, language)
    }
  } else if (step === 'clipping') {
    // A resumed run may have phone-complete voiceovers that have not been fetched yet.
    // The importer queues alignment on this Mac while the phone continues with clipping.
    await importScripts(job, signal, report)
    for (const language of LANGUAGES) await importVoice(job, signal, report, language)
    await runPhone(job, signal, report, 'clipper', ['crop_json'])
    await syncCrops(job, signal, report)
  } else if (step === 'review') {
    await importScripts(job, signal, report)
    for (const language of LANGUAGES) await importVoice(job, signal, report, language)
    await syncCrops(job, signal, report)
  }
}

export const productionAutomation = new ProductionRunner({
  load: async () => (await prisma.setting.findMany({ where: { key: { startsWith: PREFIX } } })).flatMap(r => {
    try { const j = JSON.parse(r.value); return j?.seriesId && j?.config?.device ? [j as ProductionJob] : [] } catch { return [] }
  }),
  save: async job => { const key = PREFIX + job.seriesId; const value = JSON.stringify(job); await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } }) },
  series,
  validate: async (id, config) => {
    if ((await productionAutomation.get(id)).nextStep === 'preparation') throw new Error('Complete Preparation before starting production automation')
    if (!getR2Config()) throw new Error('Set up Cloudflare R2 before starting production automation')
    if (!relayStatus().configured || !relayStatus().connected) throw new Error('Connect the phone relay before starting production automation')
    const data = await overview()
    for (const selected of productionDevices(config)) {
      const target = data.phones.find(p => p.id === selected.device)
      if (!target?.connected || !target.automation?.remoteStart) throw new Error('Choose connected phones with “Start from Manhwa Studio” enabled')
      const kinds: PhoneRunKind[] = selected.device === config.device ? ['narration', 'voiceover', 'clipper'] : ['voiceover', 'clipper']
      if (!kinds.every(kind => target.automation?.runs.includes(kind) && target.automation.chapterRuns.includes(kind))) throw new Error(`Update Sleeper-Cell on ${target.name} to automate unfinished chapters`)
      if (busy(data, selected.device)) throw new Error(`${target.name} already has a run in progress. Check Phone Status first.`)
      if (!data.profiles.some(p => p.device === target.id && p.profileId === selected.profileId)) throw new Error(`Choose a profile on ${target.name}`)
      if (!target.automation.clipper) throw new Error(`Update Sleeper-Cell on ${target.name} to choose Image Clipping settings`)
    }
  },
  perform,
  stop: stopCommandPhones,
  emit: job => io?.emit('production:updated', job)
})

/** A phone's finished JSON still needs fetching before the desktop can offer its review. */
export async function getProductionStatus(seriesId: string) {
  const status = await productionAutomation.get(seriesId)
  if (status.nextStep !== 'review' || status.job?.status === 'running') return status
  const ids = productionChapters(await series(seriesId)).map(c => c.id)
  const rows = await prisma.chapter.findMany({ where: { seriesId, id: { in: ids } }, include: { series: true } })
  const ready = await Promise.all(rows.map(c => readChapterCropState(c).then(s => s.fullyAttached, () => false)))
  return ready.every(Boolean) ? status : { ...status, nextStep: 'clipping' as const }
}

export function startProductionAutomation(socket: Server) { io = socket; void productionAutomation.init().catch(error => console.error('[production]', error)) }
