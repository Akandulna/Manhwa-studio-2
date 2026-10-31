import { validWebsiteUi, type WebsiteUiEvidence } from './websiteUiProtocol.js'
/** Phase 1 observation transport. Pure code shared with the relay; no execution authority. */
export const MANAGERS = {
  studio: 'Manhwa Studio', fleet: 'Device Fleet', cloud: 'Cloudflare', issues: 'Issues',
  library: 'Library & Download', preparation: 'Page Preparation', narration: 'Narration & Alignment',
  clipping: 'Image Clipper', editor: 'Editor & Export', storage: 'Storage', automation: 'Automation', accounts: 'Accounts',
  device: 'Device', device_library: 'Library & Preparation', device_narration: 'Narration',
  voiceover: 'Voiceover', device_clipping: 'Device Image Clipper', device_editor: 'Editor',
  device_accounts: 'Accounts & Capacity', sync: 'Sync', website_ui: 'Website UI Monitor'
} as const
export type ManagerId = keyof typeof MANAGERS
export const STAGES = ['download', 'cleanup', 'stitch', 'script_en', 'script_hi', 'split_en', 'split_hi', 'voice_en', 'voice_hi', 'align_en', 'align_hi', 'crop_json', 'review', 'crop', 'timeline_en', 'timeline_hi', 'processed_en', 'processed_hi', 'export_en', 'export_hi', 'account', 'capacity', 'presence', 'website_ui'] as const
export type ManagerStage = typeof STAGES[number]
export type WorkState = 'queued' | 'running' | 'waiting' | 'uncertain' | 'awaiting_review' | 'failed' | 'verified_complete'
export interface ManagerScope { seriesId: string | null; chapterId: string | null; profileId: string | null }
export interface ManagerFact {
  /** Stable entity/fact key. Display paths are never used as shared identity. */
  key: string
  scope: ManagerScope
  stage: ManagerStage
  workState: WorkState
  inputRevision: string | null
  compatibility: 'current' | 'outdated' | 'unknown'
  identity: 'mapped' | 'unresolved'
  availability: { destination: string; state: 'produced_local' | 'uploaded' | 'downloaded' | 'imported' | 'validated' | 'missing' | 'unknown'; evidenceRef: string | null }[]
  override: boolean
  declaresCurrentRevision?: boolean
  websiteUi?: WebsiteUiEvidence
  /** Counts/status only, never raw provider responses or account identities. */
  done: number | null
  total: number | null
  condition: null | { cause: string; resource: string; state: 'action_required' | 'waiting' | 'resolved'; severity: 'info' | 'warning' | 'blocking'; summary: string; nextAction: string }
}
export interface ManagerReport {
  schema: 'manager-report/1'
  eventId: string
  source: { id: string; deviceId: string; manager: ManagerId; sequence: number }
  observedAt: string
  /** Assigned by authority; absent on producer submissions. */
  receivedAt?: string
  facts: ManagerFact[]
  acknowledgment?: { incidentId: string; notificationId: string }
}
export interface ManagerObservation extends ManagerFact {
  source: ManagerReport['source']; eventId: string; observedAt: string; receivedAt: string | null
}
export interface ManagerIncident {
  authorityRevision?: number
  id: string; cause: string; resource: string; severity: 'info' | 'warning' | 'blocking'
  state: 'action_required' | 'waiting' | 'resolved'; summary: string; nextAction: string
  firstOccurredAt: string; lastOccurredAt: string; resolvedAt: string | null; acknowledgedAt: string | null
  notificationId: string; occurrences: number
  impacts: Record<string, { source: ManagerReport['source']; scope: ManagerScope; stage: ManagerStage; active: boolean; observedAt: string; conditionState?: 'action_required' | 'waiting'; severity?: 'info' | 'warning' | 'blocking'; summary?: string; nextAction?: string }>
  history: { eventId: string; at: string; action: 'detected' | 'updated' | 'resolved' | 'acknowledged' | 'reopened'; evidenceRef: string }[]
}
export interface ManagerProjection { observations: Record<string, ManagerObservation>; incidents: Record<string, ManagerIncident>; currentRevisions?: Record<string,string> }
export const emptyManagerProjection = (): ManagerProjection => ({ observations: {}, incidents: {} })
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f]/.test(v)
const nullable = (v: unknown) => v === null || text(v)
const date = (v: unknown) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v))
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k))
export const observationKey = (report: ManagerReport, fact: ManagerFact) => JSON.stringify([report.source.id, fact.key])
export const incidentKey = (cause: string, resource: string) => JSON.stringify([cause, resource])
export function parseManagerReport(value: unknown): ManagerReport | null {
  if (!object(value) || !keys(value, ['schema','eventId','source','observedAt','receivedAt','facts','acknowledgment']) || value.schema !== 'manager-report/1' || !text(value.eventId) || !date(value.observedAt) || value.receivedAt !== undefined && !date(value.receivedAt)) return null
  const s = value.source
  if (!object(s) || !keys(s, ['id','deviceId','manager','sequence']) || !text(s.id) || !text(s.deviceId) || !Object.prototype.hasOwnProperty.call(MANAGERS, s.manager) || !Number.isSafeInteger(s.sequence) || s.sequence < 1) return null
  if (!Array.isArray(value.facts) || value.facts.length > 100 || !value.facts.every(f => {
    if (!object(f) || !keys(f, ['key','scope','stage','workState','inputRevision','compatibility','identity','availability','override','done','total','condition','declaresCurrentRevision','websiteUi']) || !text(f.key) || !STAGES.includes(f.stage) || !['queued','running','waiting','uncertain','awaiting_review','failed','verified_complete'].includes(f.workState) || !nullable(f.inputRevision) || !['current','outdated','unknown'].includes(f.compatibility) || !['mapped','unresolved'].includes(f.identity) || typeof f.override !== 'boolean' || f.declaresCurrentRevision !== undefined && typeof f.declaresCurrentRevision !== 'boolean') return false
    if (f.websiteUi !== undefined) {
      if (!validWebsiteUi(f.websiteUi) || f.stage !== 'website_ui' || !['website_ui','device_clipping'].includes(s.manager) || f.websiteUi.route.issuesReceivedAt !== null) return false
      if (s.manager === 'website_ui' && (f.condition !== null || f.websiteUi.route.clipperReceivedAt !== null)) return false
      if (s.manager === 'device_clipping' && !f.websiteUi.route.clipperReceivedAt) return false
      if (f.websiteUi.route.clipperReceivedAt && Date.parse(f.websiteUi.route.clipperReceivedAt) < Date.parse(f.websiteUi.route.monitorObservedAt)) return false
      if (f.condition && (!f.websiteUi.baselineVersion || !f.websiteUi.changeId || !f.websiteUi.firstChangedAt || f.websiteUi.reason !== 'stable')) return false
      if (f.condition && f.condition.state !== 'resolved' && f.condition.state !== 'action_required') return false
      if (f.condition?.state !== 'resolved' && f.condition && (!['suspected','informational','compatibility_warning','blocking'].includes(f.websiteUi.classification) || f.condition.severity !== ({ informational:'info',blocking:'blocking',suspected:'warning',compatibility_warning:'warning' } as Record<string,string>)[f.websiteUi.classification])) return false
      if (f.condition?.state === 'resolved' && (!f.websiteUi.compatibilityVerifiedAt || !f.websiteUi.baselineAcceptedAt || f.websiteUi.reason !== 'stable' || f.websiteUi.classification !== 'unchanged' || f.websiteUi.audit.state !== 'checked')) return false
      if (f.condition && (s.manager !== 'device_clipping' || !f.websiteUi.changeId || f.condition.cause !== 'website_ui' || f.condition.resource !== `ui-change/${f.websiteUi.changeId}`)) return false
    }
    if (f.declaresCurrentRevision && (s.manager !== 'library' || !s.deviceId.startsWith('mac-') || f.stage !== 'download')) return false
    if (!object(f.scope) || !keys(f.scope, ['seriesId','chapterId','profileId']) || !['seriesId','chapterId','profileId'].every(k => nullable(f.scope[k]))) return false
    if (![f.done,f.total].every(v => v === null || Number.isSafeInteger(v) && v >= 0)) return false
    if (!Array.isArray(f.availability) || f.availability.length > 8 || !f.availability.every(a => object(a) && keys(a, ['destination','state','evidenceRef']) && text(a.destination) && ['produced_local','uploaded','downloaded','imported','validated','missing','unknown'].includes(a.state) && nullable(a.evidenceRef))) return false
    const c = f.condition
    return c === null || object(c) && keys(c, ['cause','resource','state','severity','summary','nextAction']) && text(c.cause) && text(c.resource) && ['action_required','waiting','resolved'].includes(c.state) && ['info','warning','blocking'].includes(c.severity) && text(c.summary, 500) && text(c.nextAction, 500)
  })) return null
  if (new Set(value.facts.map((f: ManagerFact) => f.key)).size !== value.facts.length) return null
  if (value.acknowledgment !== undefined && (!object(value.acknowledgment) || !keys(value.acknowledgment, ['incidentId','notificationId']) || !text(value.acknowledgment.incidentId, 1024) || !text(value.acknowledgment.notificationId, 1024) || value.facts.length !== 0 || value.source.manager !== 'issues')) return null
  return value as ManagerReport
}
/** Receiver stamps are excluded from immutable producer payload comparisons. */
export function managerPayload(report: ManagerReport): string {
  const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : object(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v
  const { receivedAt: _, ...payload } = report
  return JSON.stringify(canonical(payload))
}
/** Source sequence orders facts, not clocks and not unrelated devices. Historical revisions remain separate. */
export function applyManagerReport(state: ManagerProjection, report: ManagerReport): boolean {
  let changed = false
  const revisions = state.currentRevisions ??= {}
  // Page Preparation/Library on the Mac owns the current page revision declaration.
  if (report.source.manager === 'library' && report.source.deviceId.startsWith('mac-')) {
    for (const fact of report.facts) {
      const prior = state.observations[observationKey(report,fact)]
      if ((!prior || prior.source.sequence < report.source.sequence) && fact.declaresCurrentRevision && fact.scope.chapterId && fact.inputRevision?.startsWith('pages:') && fact.compatibility === 'current' && fact.identity === 'mapped' && !fact.override) revisions[fact.scope.chapterId] = fact.inputRevision
    }
  }
  if (report.acknowledgment) {
    const i = state.incidents[report.acknowledgment.incidentId]
    if (i && i.notificationId === report.acknowledgment.notificationId && !i.acknowledgedAt) {
      i.acknowledgedAt = report.receivedAt ?? report.observedAt
      i.history.push({ eventId: report.eventId, at: i.acknowledgedAt, action: 'acknowledged', evidenceRef: report.eventId }); changed = true
    }
  }
  for (const fact of report.facts) {
    const key = observationKey(report, fact)
    const prior = state.observations[key]
    if (prior && prior.source.sequence >= report.source.sequence) continue
    // Revision changes are not inferred from message order. Keep per-revision evidence for comparison.
    if (prior && prior.inputRevision !== fact.inputRevision) state.observations[JSON.stringify([report.source.id, fact.key, prior.inputRevision, 'history'])] = prior
    const value: ManagerObservation = { ...fact, source: report.source, eventId: report.eventId, observedAt: report.observedAt, receivedAt: report.receivedAt ?? null }
    if (fact.websiteUi) value.websiteUi = { ...fact.websiteUi,route:{ ...fact.websiteUi.route,issuesReceivedAt:report.source.manager === 'device_clipping' ? report.receivedAt ?? null : null } }
    if (fact.scope.chapterId && fact.inputRevision?.startsWith('pages:') && revisions[fact.scope.chapterId] && revisions[fact.scope.chapterId] !== fact.inputRevision) value.compatibility = 'outdated'
    state.observations[key] = value; changed = true
    const c = fact.condition
    if (!c || fact.override || fact.identity !== 'mapped' || value.compatibility === 'outdated') continue
    const id = incidentKey(c.cause, c.resource)
    const impact = observationKey(report, fact)
    let i = state.incidents[id]
    // Unknown, stale, superseded or unvalidated evidence cannot resolve an incident.
    const resolves = c.state === 'resolved' && value.compatibility === 'current' && fact.workState === 'verified_complete' && fact.availability.some(a => a.state === 'validated')
    if (c.state === 'resolved' && !resolves) continue
    if (!i && resolves) continue
    if (!i) {
      i = state.incidents[id] = { id, cause: c.cause, resource: c.resource, severity: c.severity, state: c.state as 'action_required' | 'waiting', summary: c.summary, nextAction: c.nextAction, firstOccurredAt: report.observedAt, lastOccurredAt: report.observedAt, resolvedAt: null, acknowledgedAt: null, notificationId: report.eventId, occurrences: 1, impacts: {}, history: [] }
      i.history.push({ eventId: report.eventId, at: report.observedAt, action: 'detected', evidenceRef: report.eventId })
    } else if (i.state === 'resolved' && !resolves) {
      i.occurrences++; i.resolvedAt = null; i.acknowledgedAt = null; i.notificationId = report.eventId
      i.history.push({ eventId: report.eventId, at: report.observedAt, action: 'reopened', evidenceRef: report.eventId })
    }
    const wasActive = i.impacts[impact]?.active
    i.impacts[impact] = { source: report.source, scope: fact.scope, stage: fact.stage, active: !resolves, observedAt: report.observedAt, conditionState: c.state === 'action_required' ? 'action_required' : 'waiting', severity: c.severity, summary: c.summary, nextAction: c.nextAction }
    i.lastOccurredAt = new Date(Math.max(Date.parse(i.lastOccurredAt), Date.parse(report.observedAt))).toISOString()
    const active = Object.values(i.impacts).filter(p => p.active)
    if (active.length) {
      i.state = active.some(p => p.conditionState === 'action_required') ? 'action_required' : 'waiting'
      i.severity = active.some(p => p.severity === 'blocking') ? 'blocking' : active.some(p => p.severity === 'warning') ? 'warning' : 'info'
      const primary = active.find(p => p.severity === i.severity && p.conditionState === i.state) ?? active.find(p => p.severity === i.severity)
      i.summary = primary?.summary ?? c.summary; i.nextAction = primary?.nextAction ?? c.nextAction
    }
    if (resolves && Object.values(i.impacts).every(p => !p.active)) {
      i.state = 'resolved'; i.resolvedAt = report.observedAt
      i.history.push({ eventId: report.eventId, at: report.observedAt, action: 'resolved', evidenceRef: report.eventId })
    } else if (i.history[i.history.length - 1]?.eventId !== report.eventId && (!resolves || wasActive !== !resolves)) i.history.push({ eventId: report.eventId, at: report.observedAt, action: 'updated', evidenceRef: report.eventId })
  }
  return changed
}
export function currentManagerObservations(state: ManagerProjection): ManagerObservation[] {
  return Object.entries(state.observations).filter(([key]) => (JSON.parse(key) as unknown[]).length === 2).map(([, v]) => v.scope.chapterId && v.inputRevision?.startsWith('pages:') && state.currentRevisions?.[v.scope.chapterId] && state.currentRevisions[v.scope.chapterId] !== v.inputRevision ? { ...v,compatibility:'outdated' as const } : v)
}

export interface ManagerOverview {
  enabled: boolean; error: string | null; pendingReports: number; pendingAcknowledgments?: string[]; deliveryError?: string | null
  observations: ManagerObservation[]; incidents: ManagerIncident[]
  managers: { id: string; name: string; deviceId?: string | null; observedAt: string | null; state: string; authorityAccepted?: boolean }[]
  chapters: { seriesId: string; chapterId: string; title: string; name: string }[]
  disagreements?: { chapterId: string; stage: string; source: string; reason: string }[]
}
