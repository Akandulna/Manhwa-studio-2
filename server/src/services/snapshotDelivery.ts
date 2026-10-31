import { createHash } from 'node:crypto'

export interface SnapshotJournal { load(key: string): Promise<string | null>; save(key: string, value: string): Promise<void> }
export interface SnapshotDestination {
  id: string
  send(body: string): Promise<void>
  /** An ambiguous prior write must be reconciled before transmitting again. */
  reconcile?(body: string): Promise<boolean>
}
interface Delivery { revision: string; body: string; acknowledged: string[]; uncertain: string[] }
export function snapshotDigest(value: unknown): string {
  const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}
/** Serialized by the publisher. A relay failure never reopens an acknowledged R2 destination. */
export async function deliverSnapshot(journal: SnapshotJournal, key: string, revision: string, value: unknown, targets: SnapshotDestination[]): Promise<void> {
  const raw = await journal.load(key)
  let state: Delivery | null = raw ? JSON.parse(raw) : null
  if (state && (typeof state.revision !== 'string' || typeof state.body !== 'string' || !Array.isArray(state.acknowledged) || !Array.isArray(state.uncertain))) throw new Error('Invalid snapshot delivery journal')
  if (!state || state.revision !== revision) {
    state = { revision, body: JSON.stringify(value), acknowledged: [], uncertain: [] }
    await journal.save(key, JSON.stringify(state))
  }
  for (const target of targets) {
    if (state.acknowledged.includes(target.id)) continue
    if (state.uncertain.includes(target.id) && target.reconcile && await target.reconcile(state.body)) {
      state.acknowledged.push(target.id)
      state.uncertain = state.uncertain.filter(id => id !== target.id)
      await journal.save(key, JSON.stringify(state))
      continue
    }
    if (!state.uncertain.includes(target.id)) state.uncertain.push(target.id)
    await journal.save(key, JSON.stringify(state))
    await target.send(state.body)
    state.acknowledged.push(target.id)
    state.uncertain = state.uncertain.filter(id => id !== target.id)
    await journal.save(key, JSON.stringify(state))
  }
}
