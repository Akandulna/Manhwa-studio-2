import type { TaskSql } from './taskAuthority'

import { LEGACY_BROWSER_ACTIONS } from '../../server/src/services/managedTaskProtocol'
export { LEGACY_BROWSER_ACTIONS } from '../../server/src/services/managedTaskProtocol'

export class ManagedLegacyConflict extends Error {
  constructor() { super('This phone is enrolled for managed work. Reconcile its managed tasks before using legacy run or profile controls.') }
}

/** Read existing enrollment without creating managed tables or depending on the feature flag. */
export function legacyRequestBlocked(sql: TaskSql, action: string | undefined, device: string): boolean {
  if (!action || !LEGACY_BROWSER_ACTIONS.has(action)) return false
  const exists = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'managed_enrollment'").toArray()
  if (!exists.length) return false
  // Broadcast controls are rejected as a whole; never silently dispatch a partial start.
  return (device
    ? sql.exec('SELECT id FROM managed_enrollment WHERE id = ? LIMIT 1', device)
    : sql.exec('SELECT id FROM managed_enrollment LIMIT 1')).toArray().length > 0
}
