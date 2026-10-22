/** Browser-only operator contract. A server adapter must supply authoritative inspection and keep credentials private. */
export interface RecoveryTarget {
  workspaceId: string; taskId: string; attemptId: string; generation: number; fingerprint: string
  artifactId: string; sha256: string; destinationId: string
  chapterLabel: string; pageLabel: string; destinationLabel: string
}
export interface RecoveryEpisode {
  revision: number; enabled: boolean; paused: boolean; cancelled: boolean; nextEligibleAt: number
  actions: { id: string; phase: 'reserved' | 'executing' | 'safe_failure' | 'unknown' | 'verified'; at: number; finishedAt: number | null }[]
}
export interface RecoveryInspection {
  target: RecoveryTarget; observedAt: number; globalEnabled: boolean; canonical: boolean; sourceMatches: boolean
  localState: 'missing' | 'verified' | 'conflict' | 'unknown'; episode: RecoveryEpisode | null
}
export type RecoveryPanelAction = 'inspect' | 'enable' | 'run' | 'reconcile' | 'pause' | 'cancel'
export interface RecoveryPanelGateway {
  readonly connected: boolean
  perform(action: RecoveryPanelAction, target: RecoveryTarget, expectedRevision: number, actionId?: string): Promise<RecoveryInspection>
}
export const disconnectedRecoveryGateway: RecoveryPanelGateway = {
  connected: false,
  async perform() { throw new Error('Recovery controls are not connected. Live recovery remains disabled.') },
}
export interface RecoveryPanelState {
  target: RecoveryTarget | null; inspection: RecoveryInspection | null; pending: RecoveryPanelAction | null
  confirmed: boolean; error: string | null; current: boolean
}
export interface RecoveryActionGate { allowed: boolean; reason: string }
const fingerprint = (v: string) => /^[a-f0-9]{64}$/.test(v)
const identifier = (v: string) => /^[A-Za-z0-9_-]{1,128}$/.test(v)
export function targetKey(t: RecoveryTarget): string {
  return JSON.stringify([t.workspaceId, t.taskId, t.attemptId, t.generation, t.fingerprint, t.artifactId, t.sha256, t.destinationId])
}
export function validateTarget(t: RecoveryTarget): void {
  if (!t || !identifier(t.workspaceId) || !identifier(t.attemptId) || !identifier(t.artifactId) ||
    !/^task:sha256:[a-f0-9]{64}$/.test(t.taskId) || !Number.isSafeInteger(t.generation) || t.generation < 1 ||
    ![t.fingerprint, t.sha256, t.destinationId].every(fingerprint) ||
    ![t.chapterLabel, t.pageLabel, t.destinationLabel].every(v => typeof v === 'string' && v.trim().length > 0 && v.length <= 300)) {
    throw new Error('Select an exact saved artifact and destination.')
  }
}
function validateInspection(v: RecoveryInspection, target: RecoveryTarget, now: number): void {
  validateTarget(v.target)
  if (targetKey(v.target) !== targetKey(target)) throw new Error('Inspection belongs to another saved artifact or destination.')
  if (!Number.isSafeInteger(v.observedAt) || v.observedAt <= 0 || v.observedAt > now || now - v.observedAt >= 120_000 ||
    ![v.globalEnabled, v.canonical, v.sourceMatches].every(b => typeof b === 'boolean') ||
    !['missing', 'verified', 'conflict', 'unknown'].includes(v.localState)) throw new Error('Inspection is invalid or stale. Inspect again.')
  const e = v.episode
  if (e === null) return
  if (!e || !Number.isSafeInteger(e.revision) || e.revision < 1 ||
    ![e.enabled, e.paused, e.cancelled].every(b => typeof b === 'boolean') ||
    !Number.isSafeInteger(e.nextEligibleAt) || e.nextEligibleAt < 0 || !Array.isArray(e.actions) || e.actions.length > 3) throw new Error('Invalid recovery history. Inspect again.')
  const ids = new Set<string>()
  e.actions.forEach((a, index) => {
    const pending = a.phase === 'reserved' || a.phase === 'executing'
    if (!identifier(a.id) || ids.has(a.id) || !['reserved', 'executing', 'safe_failure', 'unknown', 'verified'].includes(a.phase) ||
      !Number.isSafeInteger(a.at) || a.at < 0 || a.at > now ||
      (pending ? a.finishedAt !== null : a.finishedAt === null || !Number.isSafeInteger(a.finishedAt) || a.finishedAt < a.at || a.finishedAt > now) ||
      index < e.actions.length - 1 && a.phase !== 'safe_failure') throw new Error('Invalid recovery history. Inspect again.')
    ids.add(a.id)
  })
}

/** No fetch, timers, provider calls or automatic retries. Each explicit action has one injected gateway call. */
export class SavedCropRecoverySession {
  private state: RecoveryPanelState = { target: null, inspection: null, pending: null, confirmed: false, error: null, current: false }
  private listeners = new Set<() => void>()
  private sequence = 0
  private unconfirmedRuns = new Map<string, string>()
  constructor(private gateway: RecoveryPanelGateway = disconnectedRecoveryGateway, private now = Date.now,
    private actionId = () => crypto.randomUUID()) {}
  get connected(): boolean { return this.gateway.connected }
  getSnapshot = (): RecoveryPanelState => this.state
  subscribe = (callback: () => void): (() => void) => { this.listeners.add(callback); return () => { this.listeners.delete(callback) } }
  private set(update: Partial<RecoveryPanelState>): void {
    this.state = { ...this.state, ...update }
    this.listeners.forEach(listener => listener())
  }
  select(target: RecoveryTarget | null): void {
    // A mutation pins the selected scope until the result is known. Read-only inspections may be superseded.
    if (this.state.pending && this.state.pending !== 'inspect') return
    if (target) validateTarget(target)
    this.sequence++
    this.set({ target: target ? structuredClone(target) : null, inspection: null, pending: null, error: null, confirmed: false, current: false })
  }
  confirm(value: boolean): void { if (!this.state.pending) this.set({ confirmed: value }) }
  /** Local UI expiry only; callers may schedule this without polling the server. */
  expireInspection(): void {
    if (this.state.inspection && this.now() - this.state.inspection.observedAt >= 120_000)
      this.set({ current: false, confirmed: false, error: 'Inspection is stale. Inspect again.' })
  }
  gate(action: RecoveryPanelAction): RecoveryActionGate {
    const deny = (reason: string): RecoveryActionGate => ({ allowed: false, reason })
    const allow: RecoveryActionGate = { allowed: true, reason: '' }
    if (!this.gateway.connected) return deny('Recovery controls are not connected. Live recovery remains disabled.')
    if (!this.state.target) return deny('Select a saved result and destination.')
    if (this.state.pending) return deny('Wait for the current action to finish.')
    if (action === 'inspect') return allow
    const v = this.state.inspection, e = v?.episode, last = e ? e.actions[e.actions.length - 1] : undefined
    if (!v) return deny('Inspect this saved result first.')
    // These controls cannot create another copy. The backend must still recheck identity and revisions.
    if (action === 'reconcile') return (e && last) || this.unconfirmedRuns.has(targetKey(this.state.target)) ? allow : deny('There is no retained recovery action to inspect.')
    if (action === 'pause' || action === 'cancel') {
      if (!e || e.cancelled) return deny('No active recovery can be changed.')
      if (last?.phase === 'verified') return deny('Recovery is already complete.')
      if (!v.globalEnabled) return deny('Recovery is off. Pending outcomes can still be checked.')
      if (action === 'pause' && e.paused) return deny('This recovery is already paused.')
      return allow
    }
    if (this.unconfirmedRuns.has(targetKey(this.state.target))) return deny('The original restore action is unconfirmed. Check its saved outcome.')
    if (!this.state.current || this.now() - v.observedAt >= 120_000) return deny('Inspection is stale. Inspect again.')
    if (!v.globalEnabled) return deny('Recovery is off. Pending outcomes can still be checked.')
    if (!v.canonical || !v.sourceMatches) return deny('The verified result or current source does not match. Inspect the original task.')
    if (e?.cancelled) return deny('This recovery is cancelled. Its history is retained.')
    if (last && ['reserved', 'executing', 'unknown'].includes(last.phase)) return deny('Check the saved outcome before any further action.')
    if (v.localState === 'verified') return deny('The local copy is already verified.')
    if (last?.phase === 'verified') return deny('A prior restore is recorded. Inspect the current local files.')
    if (v.localState === 'conflict') return deny('Local files conflict with the saved result. Keep them for review.')
    if (v.localState !== 'missing') return deny('Local file state is unknown. Inspect again.')
    if ((e?.actions.length ?? 0) >= 3) return deny('The three-attempt recovery limit has been reached.')
    if (e && this.now() < e.nextEligibleAt) return deny('Recovery is waiting for its next eligible time.')
    if (action === 'enable' && e?.enabled && !e.paused) return deny('This recovery is already enabled.')
    if (action === 'run' && (!e?.enabled || e.paused)) return deny('Enable this inspected recovery first.')
    if (!this.state.confirmed) return deny('Confirm this exact saved result and destination.')
    return allow
  }
  async perform(action: RecoveryPanelAction): Promise<void> {
    const gate = this.gate(action)
    if (!gate.allowed) { this.set({ error: gate.reason }); return }
    const target = structuredClone(this.state.target!), sequence = ++this.sequence
    const previous = this.state.inspection?.episode?.revision ?? 0
    this.set({ pending: action, confirmed: false, error: null })
    try {
      const key = targetKey(target)
      const actionId = action === 'run' ? this.actionId() : action === 'reconcile' ? this.unconfirmedRuns.get(key) : undefined
      if (action === 'run') {
        if (!actionId || !identifier(actionId)) throw new Error('Invalid action identity')
        this.unconfirmedRuns.set(key, actionId)
      }
      const response = await this.gateway.perform(action, target, previous, actionId)
      if (sequence !== this.sequence) return
      validateInspection(response, target, this.now())
      if ((response.episode?.revision ?? 0) < previous) throw new Error('Recovery history changed unexpectedly. Inspect again.')
      const unresolved = this.unconfirmedRuns.get(key)
      const observedAction = response.episode?.actions.find(a => a.id === unresolved)
      if (action === 'run' && !observedAction) throw new Error('Original action receipt is missing')
      if (observedAction && ['safe_failure', 'verified'].includes(observedAction.phase)) this.unconfirmedRuns.delete(key)
      this.set({ inspection: structuredClone(response), pending: null, current: true, error: null })
    } catch {
      if (sequence !== this.sequence) return
      // Raw provider/server errors can contain private content; display an action-specific message instead.
      this.set({ pending: null, current: false, confirmed: false, error: action === 'inspect'
        ? 'Inspection failed. Previous evidence is last known; inspect again.'
        : 'The action outcome is unconfirmed. Inspect or check the saved outcome before continuing.' })
    }
  }
}
