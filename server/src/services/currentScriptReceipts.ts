import type { LibraryControl } from './libraryControlModel.js'
import { restartRevision, sameRestart } from './seriesRestartModel.js'

/** Filter each device before merging: an offline phone must not restore pre-restart completion. */
export function filterRestartedScriptFacts<T extends object>(body: T, controls: readonly LibraryControl[]): T {
  const value = body as Record<string, any>
  if (!value.series || typeof value.series !== 'object' || Array.isArray(value.series)) return body
  const byFolder = new Map(controls.map(control => [control.folder, control]))
  const series = { ...value.series }
  const excluded = new Set<string>()
  for (const [folder, entry] of Object.entries<any>(series)) {
    const control = byFolder.get(folder)
    const revision = control ? restartRevision(control) : null
    if (entry?.restartPending || control?.deleted || !sameRestart(revision, entry?.restartRevision)) {
      delete series[folder]
      excluded.add(folder)
    }
  }
  // Runs have no revision of their own; their device's series entry supplies it.
  for (const run of Array.isArray(value.runs) ? value.runs : []) {
    const control = byFolder.get(run?.series)
    if (control && (control.deleted || restartRevision(control) && !series[run.series])) excluded.add(run.series)
  }
  if (!excluded.size) return body
  return { ...body, series, ...(Array.isArray(value.runs) ? { runs: value.runs.filter((run: any) => !excluded.has(run?.series)) } : {}) }
}
