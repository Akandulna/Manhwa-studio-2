import { prisma } from '../index.js'
import { libraryControl } from './libraryControls.js'
import { restartRevision, sameRestart } from './seriesRestartModel.js'
const key = (folder: string) => `libraryRestartReady:${folder}`
export async function seriesRestartPending(folder: string): Promise<boolean> {
  const revision = restartRevision(await libraryControl(folder))
  return !!revision && (await prisma.setting.findUnique({ where: { key: key(folder) } }))?.value !== revision
}
export async function requireSeriesRestartReady(folder: string, incoming?: unknown, checkIncoming = false): Promise<string | null> {
  const revision = restartRevision(await libraryControl(folder))
  if (revision && (await prisma.setting.findUnique({ where: { key: key(folder) } }))?.value !== revision) throw new Error('Series restart is synchronizing. Wait for Library to finish before starting work.')
  if (checkIncoming && !sameRestart(revision, incoming)) throw new Error('This upload belongs to an earlier series restart. Regenerate it from the current scripts.')
  return revision
}
