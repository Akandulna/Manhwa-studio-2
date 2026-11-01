import {managerRecoveryFact} from './managerRecoveryFact.js'
import path from 'node:path'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import type { Server } from 'socket.io'
import { ManagerStore } from './managerStore.js'
import { encodeManagerState, decodeManagerState } from './managerStoreCodec.js'
import { RelayDeliveryPause,relayPauseForDatabase } from './relayDeliveryPause.js'
import { hasRelayFeature } from './relayTraffic.js'
import { sendManagerBatch, sendManagerReport } from './managerReportDelivery.js'
import { MANAGERS, currentManagerObservations, parseManagerReport, type ManagerFact, type ManagerId, type ManagerIncident, type ManagerObservation, type ManagerOverview, type ManagerReport, type ManagerStage } from './managerProtocol.js'
import type { ChapterStages, ProcessStage } from './seriesProcessModel.js'

const KEY = 'managerReporting.v1'
let deliveryPause: RelayDeliveryPause | null = null
let store: ManagerStore | null = null
let database: PrismaClient | null = null
const phoneDevices = new Set<string>()
let io: Server | null = null
let timer: NodeJS.Timeout | null = null
let delivery: Promise<void> | null = null
let reportingError: string | null = null
let remapTimer: NodeJS.Timeout | null = null
const chapters = new Map<string, { seriesId: string; chapterId: string; title: string; name: string; revision: string | null; archived: boolean; sharedChapterId?: string; sharedSeriesId?: string; ambiguous?: boolean }>()
const nativeFacts=new Map<string,ManagerFact>()
const nativeKey=(device:string,fact:ManagerFact)=>JSON.stringify([device,fact.scope.seriesId,fact.scope.chapterId,fact.scope.profileId,fact.stage,fact.stage==='account'?fact.key:null])
function indexNative(report:ManagerReport):void {
  if(report.source.deviceId.startsWith('legacy-')||report.source.deviceId.startsWith('mac-'))return
  for(const fact of report.facts)nativeFacts.set(nativeKey(report.source.deviceId,fact),fact)
}
function nativeCovers(device:string,body:any,kind:string,fact:ManagerFact):boolean {
  if(body.managerCoverage?.schema!=='native-manager-coverage/1'||!Array.isArray(body.managerCoverage.kinds)||!body.managerCoverage.kinds.includes(kind))return false
  const native=nativeFacts.get(nativeKey(device,fact))
  return !!native&&native.workState===fact.workState&&native.inputRevision===fact.inputRevision&&native.done===fact.done&&native.total===fact.total
}
const legacy = new Map<string, { device: string; kind: string; body: any; at: number }>()
const localStages = new Map<string, ChapterStages>()
const enabled = () => process.env.MANAGER_OBSERVATIONS === '1'
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const validTime = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v))
const managerForStage = (stage: string): ManagerId => stage === 'download' ? 'library' : ['cleanup','stitch'].includes(stage) ? 'preparation' : ['crop_json','review','crop'].includes(stage) ? 'clipping' : /^(timeline|processed|export)_/.test(stage) ? 'editor' : 'narration'
const workState = (state: string): ManagerFact['workState'] => ({ done: 'verified_complete', active: 'running', failed: 'failed', review: 'awaiting_review', partial: 'waiting', pending: 'queued' } as const)[state as 'done'] ?? 'uncertain'
export function managerFact(key: string, stage: ManagerStage, scope: ManagerFact['scope']): ManagerFact {
  return { key, stage, scope, workState: 'uncertain', inputRevision: null, compatibility: 'unknown', identity: 'mapped', availability: [], override: false, done: null, total: null, condition: null }
}
function notify(): void {
  if (timer) return
  timer = setTimeout(() => { timer = null; io?.emit('managers:updated') }, 2000); timer.unref()
}
function failure(error: unknown): void { reportingError = 'Manager reporting could not save or read its durable records.'; console.error('[managers]', error instanceof Error ? error.message : 'reporting failed'); notify() }
export function startManagerReporting(db: PrismaClient, socket: Server): void {
  if (!enabled() || store) return
  io = socket
  database = db
  deliveryPause = relayPauseForDatabase(db)
  store = new ManagerStore({
    load: async () => { const row = await db.setting.findUnique({ where: { key: KEY } }); return row ? decodeManagerState(row.value) : null },
    save: async state => { const value = await encodeManagerState(state); await db.setting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } }) }
  }, () => { reportingError = null; notify() },undefined,true)
  const retry = setInterval(() => { void observe('issues',[],new Date().toISOString()).catch(failure); void observe('studio',[],new Date().toISOString()).catch(failure); void deliverManagerReports() }, 30_000); retry.unref()
  void store.snapshot().then(async state => { for(const observation of Object.values(state.projection.observations))indexNative({schema:'manager-report/1',eventId:observation.eventId,source:observation.source,observedAt:observation.observedAt,facts:[observation]}); await observe('issues',[],new Date().toISOString()); await observe('studio',[],new Date().toISOString()); await deliverManagerReports() }).catch(failure)
}
const pendingObservations = new Map<string, { manager: ManagerId; facts: Map<string,ManagerFact>; at: string; device?: string; waiters: { resolve: () => void; reject: (error: unknown) => void }[] }>()
let observationTimer: NodeJS.Timeout | null = null
let observationDue=0
async function observe(manager: ManagerId, facts: ManagerFact[], at: string, device?: string): Promise<void> {
  if (!store) return
  return new Promise<void>((resolve,reject) => {
    const key = JSON.stringify([manager,device,at])
    const pending = pendingObservations.get(key) ?? { manager,facts:new Map<string,ManagerFact>(),at,device,waiters:[] }
    const ordinary=(fact:ManagerFact)=>!fact.websiteUi&&!fact.condition&&['running','queued','waiting'].includes(fact.workState)
    for (const fact of facts) {
      if(ordinary(fact))for(const prior of pendingObservations.values()) {
        if(prior.manager!==manager||prior.device!==device||Date.parse(prior.at)>Date.parse(at))continue
        const old=prior.facts.get(fact.key)
        if(old&&ordinary(old)&&old.inputRevision===fact.inputRevision&&JSON.stringify(old.scope)===JSON.stringify(fact.scope))prior.facts.delete(fact.key)
      }
      pending.facts.set(fact.key,fact)
    }
    pending.waiters.push({ resolve,reject }); pendingObservations.set(key,pending)
    const wait=facts.some(f=>f.websiteUi||f.condition?.state==='action_required'||['failed','awaiting_review','verified_complete'].includes(f.workState))?500:5_000
    if(observationTimer&&Date.now()+wait<observationDue){clearTimeout(observationTimer);observationTimer=null}
    if (!observationTimer) {
      observationDue=Date.now()+wait
      observationTimer = setTimeout(() => {
        observationTimer = null
        const batches = [...pendingObservations.values()]; pendingObservations.clear()
        void (async () => {
          for (const batch of batches) {
            try { await store!.observe(batch.manager,[...batch.facts.values()],batch.at,batch.device,[...batch.facts.values()].some(f=>f.workState==='running')?300_000:900_000); batch.waiters.forEach(w => w.resolve()) }
            catch (error) { batch.waiters.forEach(w => w.reject(error)) }
          }
          void deliverManagerReports()
        })()
      },wait)
      observationTimer.unref()
    }
  })
}
export async function deliverManagerReports(): Promise<void> {
  if (!store || !database) return
  const pause=relayPauseForDatabase(database)
  try { if (await pause.isPaused()) return }
  catch (error) { failure(error); return }
  if (delivery) return delivery
  const url = process.env.RELAY_URL?.trim().replace(/\/+$/, ''), token = process.env.RELAY_TOKEN?.trim()
  if (!url || !token) return
  delivery = store.drain(report => sendManagerReport(url, token, report, pause),hasRelayFeature('manager-batch/1')?reports=>sendManagerBatch(url,token,reports,pause):undefined).catch(failure).finally(() => { delivery = null })
  return delivery
}
let incomingReports: ManagerReport[] = []
let incomingTimer: NodeJS.Timeout | null = null
export function receiveManagerReport(body: unknown): void {
  if (!store) return
  const parsed = parseManagerReport(body)
  if (!parsed?.receivedAt) return
  indexNative(parsed)
  incomingReports.push(parsed)
  if (!incomingTimer) {
    incomingTimer = setTimeout(() => {
      incomingTimer = null
      const reports = incomingReports; incomingReports = []
      void store!.receiveMany(reports).catch(failure)
    },100)
    incomingTimer.unref()
  }
}
export function receiveManagerIncident(body: unknown): void {
  if (!store || !body || typeof body !== 'object') return
  const incident = body as ManagerIncident
  if (!Number.isSafeInteger(incident.authorityRevision) || incident.authorityRevision! < 1 || typeof incident.id !== 'string' || !Array.isArray(incident.history) || !incident.impacts || !validTime(incident.lastOccurredAt)) return
  void store.receiveIncident(incident).catch(failure)
}
/** Snapshot from existing local validators BEFORE merged phone completion can obscure a missing Mac handoff. */
export function recordLocalManagerChapter(input: { seriesId: string; chapterId: string; title: string; folder: string; name: string; stages: ChapterStages; pageRevision: string | null; archived: boolean; declaresRevision?: boolean; observedAt?: string; sharedSeriesId?: string | null; sharedChapterId?: string | null }): void {
  if (!store) return
  const scope = { seriesId: input.sharedSeriesId ?? input.seriesId, chapterId: input.sharedChapterId ?? input.chapterId, profileId: null }
  const mapping = { seriesId: input.seriesId, chapterId: input.chapterId, title: input.title, name: input.name, revision: input.pageRevision, archived: input.archived, sharedChapterId: scope.chapterId, sharedSeriesId: scope.seriesId }
  const previousMapping = chapters.get(JSON.stringify([input.folder, input.name]))
  chapters.set(JSON.stringify([input.folder, input.name]), { ...mapping, ambiguous: previousMapping?.ambiguous || !!previousMapping && previousMapping.chapterId !== mapping.chapterId })
  chapters.set(JSON.stringify([scope.seriesId, scope.chapterId]), mapping)
  localStages.set(input.chapterId, structuredClone(input.stages))
  const at = input.observedAt ?? new Date().toISOString()
  const grouped = new Map<ManagerId, ManagerFact[]>()
  for (const [key, stage] of Object.entries(input.stages)) {
    // Metadata is carried by the split protocol; older manager/1 peers reject unknown stages.
    if(key==='metadata')continue
    const fact = managerFact(`${scope.chapterId}/${key}`, key as Exclude<ProcessStage, 'metadata'>, scope)
    fact.workState = workState(stage.state); fact.done = stage.done ?? null; fact.total = stage.total ?? null
    fact.inputRevision = input.pageRevision ? `pages:${input.pageRevision}` : null
    // A page revision alone says nothing about script/audio/prompt compatibility.
    fact.compatibility = input.pageRevision && ['download','cleanup','stitch','crop_json','review','crop'].includes(key) ? 'current' : 'unknown'
    fact.override = input.archived
    if (key === 'download') fact.declaresCurrentRevision = input.declaresRevision === true
    fact.availability = [{ destination: 'mac', state: stage.state === 'done' && !input.archived ? 'validated' : 'unknown', evidenceRef: stage.state === 'done' && !input.archived ? `validator:${managerForStage(key)}:${input.chapterId}:${key}` : null }]
    const resource = `${scope.chapterId}/${key}`
    fact.condition = { cause: 'module_validation', resource, state: stage.state === 'failed' ? 'action_required' : 'resolved', severity: 'warning', summary: 'A production stage reported a failure.', nextAction: 'Open the chapter, inspect its module error and repair the affected stage.' }
    const manager = managerForStage(key); grouped.set(manager, [...(grouped.get(manager) ?? []), fact])
  }
  for (const [manager, facts] of grouped) void observe(manager, facts, at).catch(failure)
  // Replay already-received legacy snapshots after identity lookup becomes available, retaining source times.
  if ((!previousMapping || previousMapping.revision !== mapping.revision) && !remapTimer) {
    remapTimer = setTimeout(() => { remapTimer = null; for (const value of legacy.values()) recordLegacyManagerReceipt(value.kind, value.device, value.body, value.at) }, 300); remapTimer.unref()
  }
}
/** Legacy receipts are explicitly last-known, unverified revision evidence, never a new managed completion. */
export function recordLegacyManagerReceipt(kind: string, device: string, body: any, receivedAt: number): void {
  if (!store || !device || !body || !validTime(body.updatedAt)) return
  const key = JSON.stringify([device,kind]), prior = legacy.get(key)
  if (prior && Date.parse(prior.body.updatedAt) > Date.parse(body.updatedAt)) return
  legacy.set(key, { kind,device,body,at:receivedAt })

  const series = Array.isArray(body.series) ? body.series : Object.entries(body.series ?? {}).map(([folder, data]) => ({ folder, ...(data as object) }))
  const grouped = new Map<ManagerId, ManagerFact[]>()
  for (const s of series) for (const [name, raw] of Object.entries(s.chapters ?? {})) {
    const chapter = raw as any, mapping = chapters.get(JSON.stringify([s.folder,name]))
    if (!mapping || mapping.ambiguous) continue // Ambiguous or unrecognized aliases never invent shared identity.
    const scope = { seriesId: mapping.seriesId, chapterId: mapping.chapterId, profileId: null }
    const facts: { stage: ManagerStage; state: string; done?: number; total?: number }[] = []
    if (kind === 'process') for (const [stage, v] of Object.entries(chapter.stages ?? {})) facts.push({ stage: stage as ManagerStage, ...(v as any) })
    if (kind === 'crops') facts.push({ stage: 'crop_json', state: chapter.total > 0 && chapter.done >= chapter.total ? 'done' : 'partial', done: chapter.done, total: chapter.total })
    if (kind === 'scripts') for (const language of ['en','hi']) {
      const script = language === 'en' ? chapter : s.hi?.chapters?.[name]
      if (script) {
        facts.push({ stage: `script_${language}` as ManagerStage, state: script.status === 'done' ? 'done' : script.status === 'stale' ? 'review' : script.status === 'failed' ? 'failed' : 'pending' })
        if (script.voiceover) facts.push({ stage: `voice_${language}` as ManagerStage, state: script.voiceover.total > 0 && script.voiceover.done >= script.voiceover.total ? 'done' : 'partial', done: script.voiceover.done, total: script.voiceover.total })
      }
    }
    if (kind === 'sync') facts.push({ stage: 'download', state: chapter.state === 'downloaded' ? 'done' : 'pending' })
    for (const status of facts) {
      if (!['download','cleanup','stitch','script_en','script_hi','split_en','split_hi','voice_en','voice_hi','crop_json','review','timeline_en','timeline_hi'].includes(status.stage)) continue
      const fact = managerFact(`${mapping.chapterId}/${status.stage}/${kind}`, status.stage, scope)
      fact.identity = 'unresolved'; fact.workState = workState(status.state); fact.inputRevision = typeof chapter.pageRevision === 'string' ? `pages:${chapter.pageRevision}` : null
      fact.compatibility = mapping.revision && fact.inputRevision ? fact.inputRevision === `pages:${mapping.revision}` ? 'current' : 'outdated' : 'unknown'
      fact.done = Number.isSafeInteger(status.done) && status.done! >= 0 ? status.done! : null; fact.total = Number.isSafeInteger(status.total) && status.total! >= 0 ? status.total! : null
      fact.availability = [{ destination: `phone:${device}`, state: status.state === 'done' ? 'produced_local' : 'unknown', evidenceRef: `legacy:${device}:${kind}` }]
      // A phone's zip receipt is a claim, not independent cloud verification.
      if (chapter.zip?.uploadedAt) fact.availability.push({ destination: 'cloud', state: 'unknown', evidenceRef: `legacy-upload-claim:${device}:${kind}` })
      const manager: ManagerId = status.stage === 'crop_json' || status.stage === 'review' ? 'device_clipping' : status.stage.startsWith('voice') ? 'voiceover' : status.stage.startsWith('script') ? 'device_narration' : status.stage.startsWith('timeline') ? 'device_editor' : 'device_library'
      if(!nativeCovers(device,body,kind,fact))grouped.set(manager, [...(grouped.get(manager) ?? []), fact])
    }
  }
  // Keep original source timestamp; no dashboard clock is used for fact freshness.
  for (const [manager,facts] of grouped) void observe(manager, facts, body.updatedAt, `legacy-${device}-${kind}`).catch(failure)
  if (kind === 'crops') { recordPassiveAccounts(device, body) }
}
function recordPassiveAccounts(device: string, body: any): void {
  for (const profile of Array.isArray(body.profiles) ? body.profiles : []) {
    if (typeof profile.id !== 'string') continue
    const check = profile.check
    if (!check || !validTime(check.checkedAt)) continue
    for (const provider of ['chatGpt','gemini']) {
      const observation = check[provider]
      const fact = managerFact(`${device}/${profile.id}/${provider}`, 'account', { seriesId: null, chapterId: null, profileId: profile.id })
      const known = observation && !observation.error && typeof observation.signedIn === 'boolean'
      fact.workState = !known ? 'uncertain' : observation.signedIn ? 'verified_complete' : 'waiting'
      fact.compatibility = known ? 'current' : 'unknown'
      fact.availability = [{ destination: `phone:${device}`, state: known && observation.signedIn ? 'validated' : 'unknown', evidenceRef: `profile-check:${device}:${profile.id}:${provider}` }]
      // Profiles are not grouped into shared accounts until account identity has explicit confirmation.
      fact.condition = !known ? null : { cause: 'sign_in', resource: `${device}/${profile.id}/${provider}`, state: observation.signedIn ? 'resolved' : 'action_required', severity: 'warning', summary: 'A browser profile needs sign-in.', nextAction: 'Open Accounts, sign in on that phone, then run its existing profile check.' }
      if(!nativeCovers(device,body,'crops',fact))void observe('device_accounts', [fact], check.checkedAt, `legacy-${device}-accounts`).catch(failure)
    }
  }
}
export async function recordManagerStorage(): Promise<void> {
  if (!store) return
  const root = path.resolve(process.env.DOWNLOAD_ROOT || './downloads')
  const stat = await fs.statfs(root).catch(() => null)
  const { deviceId } = await store.snapshot()
  const fact = managerFact('local-storage', 'capacity', { seriesId: null, chapterId: null, profileId: null })
  fact.workState = stat ? stat.bavail * stat.bsize < 1024 ** 3 ? 'waiting' : 'verified_complete' : 'uncertain'
  fact.compatibility = stat ? 'current' : 'unknown'
  fact.availability = [{ destination: 'mac', state: stat ? 'validated' : 'unknown', evidenceRef: stat ? 'statfs:download-root' : null }]
  fact.condition = stat ? { cause: 'storage_capacity', resource: `${deviceId}/storage`, state: fact.workState === 'waiting' ? 'action_required' : 'resolved', severity: 'warning', summary: 'Less than 1 GB of storage is available.', nextAction: 'Review Storage and free space before starting more work.' } : null
  await observe('storage', [fact], new Date().toISOString())
}
let overviewCache: { at:number; value:ManagerOverview } | null = null
export async function managerOverview(): Promise<ManagerOverview> {
  if (!store) return { enabled: false, error: null, observations: [], incidents: [], managers: Object.entries(MANAGERS).slice(0,12).map(([id,name]) => ({ id,name,state:'not_reporting',observedAt:null })), chapters: [], pendingReports: 0 }
  if (overviewCache && Date.now() - overviewCache.at < 2000) return overviewCache.value
  // Read the latest committed projection without waiting behind a library catch-up backlog.
  const state = await store.snapshot(false), now = Date.now()
  const observations = currentManagerObservations(state.projection)
  const revisions = new Map(Object.entries(state.projection.currentRevisions ?? {}))
  const navigation = new Map([...chapters.values()].map(c => [c.sharedChapterId ?? c.chapterId,c]))
  const latest = new Map<string,ManagerObservation>()
  const mapped: ManagerObservation[] = observations.map(o => ({ ...o, compatibility: o.scope.chapterId && revisions.has(o.scope.chapterId) && o.inputRevision?.startsWith('pages:') && o.inputRevision !== revisions.get(o.scope.chapterId) ? 'outdated' : o.compatibility })).map(o => {
    const mapping = o.scope.chapterId ? navigation.get(o.scope.chapterId) : undefined
    return mapping ? { ...o, scope: { ...o.scope, seriesId: mapping.seriesId, chapterId: mapping.chapterId } } : o
  })
  for (const observation of mapped) {
    const key = JSON.stringify([observation.source.id,observation.scope,observation.stage,observation.key.startsWith('handoff/')])
    if (!latest.has(key) || latest.get(key)!.source.sequence < observation.source.sequence) latest.set(key,observation)
  }
  const projected = [...latest.values()]
  const logicalHealth = new Map<string,typeof state.health[string]>()
  const deviceOf = (device: string) => device.match(/^legacy-(.+)-(sync|scripts|crops|process|accounts)$/)?.[1] ?? device
  for (const h of Object.values(state.health)) {
    const key = JSON.stringify([deviceOf(h.source.deviceId),h.source.manager])
    if (!logicalHealth.has(key) || Date.parse(logicalHealth.get(key)!.observedAt) < Date.parse(h.observedAt)) logicalHealth.set(key,h)
  }
  const health = [...logicalHealth.values()].map(h => ({ id: h.source.manager, name: MANAGERS[h.source.manager], deviceId: deviceOf(h.source.deviceId), observedAt: h.observedAt, state: now - Date.parse(h.observedAt) > 45 * 60_000 ? 'last_known' : 'reporting', authorityAccepted: !!h.receivedAt }))
  const phoneMissing = [...phoneDevices].flatMap(deviceId => Object.entries(MANAGERS).slice(12).filter(([id]) => !health.some(h => h.deviceId === deviceId && h.id === id)).map(([id,name]) => ({ id,name,deviceId,observedAt:null,state:'not_reporting',authorityAccepted:false })))
  const missing = Object.entries(MANAGERS).slice(0,12).filter(([id]) => !health.some(h => h.id === id)).map(([id,name]) => ({ id,name,deviceId:null,observedAt:null,state:'not_reporting',authorityAccepted:false }))
  const value: ManagerOverview = { enabled: true, error: reportingError, pendingReports: state.outbox.length, pendingAcknowledgments: state.outbox.flatMap(r => r.acknowledgment ? [r.acknowledgment.incidentId] : []), deliveryError: state.lastDeliveryError, observations: projected, incidents: Object.values(state.projection.incidents).map(i => ({ ...i, impacts: Object.fromEntries(Object.entries(i.impacts).map(([key,impact]) => {
    const mapping = impact.scope.chapterId ? navigation.get(impact.scope.chapterId) : undefined
    return [key, mapping ? { ...impact, scope: { ...impact.scope, seriesId: mapping.seriesId, chapterId: mapping.chapterId } } : impact]
  })) })).sort((a,b) => b.lastOccurredAt.localeCompare(a.lastOccurredAt)), managers: [...health,...missing,...phoneMissing], chapters: [...new Map([...chapters.values()].map(c => [c.chapterId,c])).values()], disagreements: projected.filter(o => o.source.deviceId !== state.deviceId && o.scope.chapterId && o.workState === 'verified_complete' && o.compatibility !== 'outdated' && localStages.get(o.scope.chapterId)?.[o.stage as ProcessStage]?.state !== 'done').map(o => ({ chapterId: o.scope.chapterId!, stage: o.stage, source: o.source.deviceId, reason: 'Phone reports output; Mac validation or import is still missing.' })) }
  overviewCache = { at:now,value }
  return value
}
export async function acknowledgeManagerIncident(id: string, notificationId: string): Promise<void> {
  if (!store) throw new Error('Manager observations are disabled')
  await store.acknowledge(id,notificationId); void deliverManagerReports()
}

/** Called only after an existing cloud GET/import operation; never initiates cloud scans or retries. */
type ManagerTransferInput = { seriesId: string; chapterId: string; stage: Exclude<ProcessStage,'metadata'>; phase: 'cloud' | 'imported' | 'failed'; objectVersion: string | null }
export function managerTransferFact(input: ManagerTransferInput): ManagerFact {
  const fact = managerFact(`handoff/${input.chapterId}/${input.stage}`, input.stage, { seriesId: input.seriesId, chapterId: input.chapterId, profileId: null })
  fact.inputRevision = input.objectVersion ? `object:${digest(input.objectVersion)}` : null
  fact.compatibility = input.objectVersion ? 'current' : 'unknown'
  fact.workState = input.phase === 'failed' ? 'waiting' : input.phase === 'cloud' ? 'waiting' : 'verified_complete'
  fact.availability = [
    { destination: 'cloud', state: input.objectVersion ? 'validated' : 'unknown', evidenceRef: input.objectVersion ? `cloud-object:${digest(input.objectVersion)}` : null },
    { destination: 'mac_import', state: input.phase === 'imported' ? 'imported' : 'missing', evidenceRef: input.phase === 'imported' ? `import:${input.chapterId}:${input.stage}` : null }
  ]
  // This confirms the transfer/import postcondition, not the production module's content validation.
  if (input.phase === 'imported') fact.availability.push({ destination: 'mac_import', state: 'validated', evidenceRef: `import-postcondition:${input.chapterId}:${input.stage}` })
  fact.condition = input.phase === 'cloud' ? null : { cause: 'artifact_import', resource: `${input.chapterId}/${input.stage}`, state: input.phase === 'failed' ? 'action_required' : 'resolved', severity: 'warning', summary: 'A phone output is waiting for Mac import.', nextAction: 'Open the chapter and retry the missing import after inspecting its error. The generated output is retained.' }
  return fact
}
export function recordManagerTransfer(input: ManagerTransferInput): void {
  if (!store) return
  void observe('cloud', [managerTransferFact(input)], new Date().toISOString()).catch(failure)
}

export async function managerChapterIdentity(chapterId: string): Promise<{ seriesId: string; chapterId: string } | null> {
  if (!store || !database) return null
  const row = await database.setting.findUnique({ where: { key: `managerIdentity:${chapterId}` } })
  if (!row) return null
  try { const value = JSON.parse(row.value); return typeof value.seriesId === 'string' && typeof value.chapterId === 'string' ? value : null } catch { return null }
}
export function recordManagerFleet(devices: { id: string; connected: boolean }[]): void {
  if (!store) return
  phoneDevices.clear()
  const facts = devices.filter(d => !!d.id).map(device => {
    phoneDevices.add(device.id)
    const fact = managerFact(`presence/${device.id}`, 'presence', { seriesId:null, chapterId:null, profileId:null })
    fact.workState = device.connected ? 'verified_complete' : 'uncertain'
    fact.compatibility = 'current'
    fact.availability = [{ destination:`phone:${device.id}`,state: device.connected ? 'validated' : 'unknown', evidenceRef:'relay-presence' }]
    return fact
  })
  void observe('fleet',facts,new Date().toISOString()).catch(failure)
}
export function recordManagerAutomation(job: import('./productionAutomationModel.js').ProductionJob): void {
  if (!store) return
  const fact = managerFact(`run/${job.seriesId}`, 'presence', { seriesId:job.seriesId,chapterId:null,profileId:null })
  fact.workState = job.status === 'failed' ? 'failed' : job.status === 'running' ? 'running' : job.status === 'review' ? 'awaiting_review' : 'uncertain'
  fact.inputRevision = `run:${job.id}`
  if (job.status === 'failed') fact.condition = { cause:'production_run',resource:job.seriesId,state:'action_required',severity:'warning',summary:'Production automation stopped after an error.',nextAction:'Open the series automation dialog and inspect the saved error before resuming.' }
  void observe('automation',[fact],job.updatedAt).catch(failure)
}

export async function managerCanDeclareRevision(seriesId: string, sourceSite?: string): Promise<boolean> {
  if (!store || !database) return false
  const [owner,device] = await Promise.all([
    database.setting.findUnique({ where:{ key:`libraryOwner:${seriesId}` } }),
    database.setting.findUnique({ where:{ key:'libraryDeviceId' } })
  ])
  return owner ? owner.value === device?.value : !!sourceSite && !['phone','shared'].includes(sourceSite)
}

let relayUsageCache: { url: string; at: number; value: unknown } | null = null
/** On-demand only, cached locally: the relay credential never reaches the browser. */
export async function managerRelayUsage(): Promise<unknown> {
  const url = process.env.RELAY_URL?.trim().replace(/\/+$/, ''), token = process.env.RELAY_TOKEN?.trim()
  if (!url || !token) throw new Error('Relay is not configured')
  if (relayUsageCache?.url === url && Date.now() - relayUsageCache.at < 30_000) return relayUsageCache.value
  const response = await fetch(`${url}/usage`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error('Relay usage unavailable')
  const raw = await response.json() as Record<string,unknown>
  const names = ['operations','rowsRead','rowsWritten'] as const
  if (typeof raw.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.day) || !raw.limits || typeof raw.limits !== 'object') throw new Error('Invalid relay usage')
  const limits = raw.limits as Record<string,unknown>
  if (names.some(k => !Number.isSafeInteger(raw[k]) || Number(raw[k]) < 0 || !Number.isSafeInteger(limits[k]) || Number(limits[k]) <= 0)) throw new Error('Invalid relay usage counters')
  const signals=raw.signals&&typeof raw.signals==='object'&&!Array.isArray(raw.signals)?Object.fromEntries(Object.entries(raw.signals as Record<string,unknown>).filter(([k,v])=>/^(http_|manager_|alarm)/.test(k)&&k.length<40&&Number.isSafeInteger(v)&&Number(v)>=0).slice(0,16)):{}
  const rows=raw.rows&&typeof raw.rows==='object'&&!Array.isArray(raw.rows)?Object.fromEntries(Object.entries(raw.rows as Record<string,unknown>).filter(([k,v])=>/^(http_|manager_|ws_|alarm|checkpoint|other)/.test(k)&&k.length<40&&!!v&&typeof v==='object'&&['read','written'].every(n=>Number.isSafeInteger((v as any)[n])&&(v as any)[n]>=0)).slice(0,24).map(([k,v])=>[k,{read:(v as any).read,written:(v as any).written}])):{}
  const value = { signals, rows, day: raw.day, ...Object.fromEntries(names.map(k => [k,raw[k]])), limits: Object.fromEntries(names.map(k => [k,limits[k]])), scope: 'Relay-local counters since protection was deployed; not Cloudflare account-wide billing.', resetsAt: `${raw.day}T00:00:00Z` }
  // The next reset is the following UTC midnight.
  value.resetsAt = new Date(Date.parse(value.resetsAt) + 86_400_000).toISOString()
  relayUsageCache = { url,at:Date.now(),value }
  return value
}

/** Recovery controllers report after their transaction; Issues/monitoring never execute the playbook. */
export function recordManagerRecovery(diagnosis:import('./automationRecovery.js').RecoveryDiagnosis):void {
 if(!store)return
 void observe('automation',[managerRecoveryFact(diagnosis)],new Date(diagnosis.evidence.observedAt).toISOString()).catch(failure)
}
