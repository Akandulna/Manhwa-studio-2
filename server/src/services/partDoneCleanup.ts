/**
 * When a Part is marked done (Library) or completed, its chapters' page zips in
 * R2 (`<phone prefix>manhwa/<Series>/<Chapter>.zip`, sent by Send to phone or
 * the shared library) are no longer needed, and neither are its voiceover zips.
 *
 * Page zips go the way Completed Parts clears them (partArchive markCompleted):
 * the send ledger row gets `clearedAt` and loses its key, the zip is deleted,
 * then the series' index.json is rewritten (cleared, no key) and the library
 * manifest republished (no key). So no phone or replica tries to download a
 * zip that is gone, and auto-send never sends the chapter again (a hand pick
 * still can). Phones keep the pages they already have.
 *
 * R2 cost: deletes are free; one index PUT per series and the library
 * manifest publish, only when something was cleared. Nothing when there's
 * nothing to clear (it is decided from the database).
 */
import path from 'path'
import { DeleteObjectCommand } from '@aws-sdk/client-s3'
import { prisma } from '../index.js'
import { createClient, getR2Config, invalidateStorage } from './r2Service.js'
import { libraryControls } from './libraryControls.js'
import { unfinishedVoiceoverChapters } from './voiceoverChapterScope.js'
import { seriesRestartPending } from './seriesRestartGuard.js'

export interface PageZipTarget { seriesId: string; chapterId: string; series: string; chapter: string; key: string; bytes: number }
export interface PageCleanupResult { cleared: PageZipTarget[]; freedBytes: number; dryRun: boolean; warnings: string[]; skipped?: string }

/** Done chapters (completed, or in a Part marked done since the last restart) whose zip is still in R2. */
async function donePageZips(seriesId?: string): Promise<PageZipTarget[]> {
  const rows = await prisma.series.findMany({
    where: seriesId ? { id: seriesId } : {},
    select: {
      id: true, rootFolder: true,
      chapters: { select: { id: true, folderPath: true, number: true, completedAt: true, phoneSend: { select: { key: true, bytes: true } } } }
    }
  })
  const controls = await libraryControls()
  const targets: PageZipTarget[] = []
  for (const row of rows) {
    const folder = path.basename(row.rootFolder)
    const control = controls.find(c => c.folder === folder)
    if (control?.deleted || await seriesRestartPending(folder)) continue
    const open = new Set(unfinishedVoiceoverChapters(row.chapters, control))
    for (const ch of row.chapters) {
      if (open.has(ch) || !ch.phoneSend?.key) continue
      targets.push({ seriesId: row.id, chapterId: ch.id, series: folder, chapter: path.basename(ch.folderPath), key: ch.phoneSend.key, bytes: ch.phoneSend.bytes })
    }
  }
  return targets
}

let running: Promise<unknown> = Promise.resolve()

/** Deletes done Parts' page zips from R2 and tells the phones and replicas. `dryRun` only reports. */
export function cleanupDonePartPages(opts: { seriesId?: string; dryRun?: boolean } = {}): Promise<PageCleanupResult> {
  const next = running.catch(() => {}).then(() => sweep(opts))
  running = next
  return next
}

async function sweep({ seriesId, dryRun = false }: { seriesId?: string; dryRun?: boolean }): Promise<PageCleanupResult> {
  const config = getR2Config()
  if (!config) return { cleared: [], freedBytes: 0, dryRun, warnings: [], skipped: 'R2 is not configured' }
  const targets = await donePageZips(seriesId)
  const freed = (list: PageZipTarget[]) => list.reduce((n, t) => n + t.bytes, 0)
  if (dryRun || targets.length === 0) return { cleared: targets, freedBytes: freed(targets), dryRun, warnings: [] }

  const warnings: string[] = []
  const client = createClient(config)
  const cleared: PageZipTarget[] = []
  try {
    for (const target of targets) {
      // Ledger first: should the delete fail, the next index/manifest still drops the key and the zip is only orphaned.
      await prisma.phoneChapterSend.update({ where: { chapterId: target.chapterId }, data: { clearedAt: new Date(), key: null, etag: null } })
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: target.key }))
      cleared.push(target)
    }
  } finally {
    client.destroy()
    if (cleared.length) invalidateStorage()
  }

  const { updatePhoneIndexes } = await import('./phoneSend.js')
  for (const id of new Set(cleared.map(t => t.seriesId))) {
    try { await updatePhoneIndexes(id) } catch (error) {
      warnings.push(`Phone index not updated: ${error instanceof Error ? error.message : error}`)
    }
  }
  const { scheduleLibraryPublish } = await import('./librarySync.js')
  scheduleLibraryPublish()
  console.log(`[partDoneCleanup] cleared ${cleared.length} chapter zip(s), ${freed(cleared)} B`)
  return { cleared, freedBytes: freed(cleared), dryRun, warnings }
}

const SETTLE_MS = 60_000
const timers = new Map<string, NodeJS.Timeout>()

/**
 * A Part of `folder` was just marked done: a minute later (so an undo in
 * between finds nothing done) clear its page zips and voiceovers.
 */
export function schedulePartDoneCleanup(folder: string): void {
  if (!getR2Config()) return
  clearTimeout(timers.get(folder))
  timers.set(folder, setTimeout(() => {
    timers.delete(folder)
    void (async () => {
      const rows = (await prisma.series.findMany({ select: { id: true, rootFolder: true } })).filter(r => path.basename(r.rootFolder) === folder)
      const { cleanupR2Voiceovers } = await import('./voiceoverCleanup.js')
      for (const row of rows) {
        await cleanupDonePartPages({ seriesId: row.id })
        await cleanupR2Voiceovers({ seriesId: row.id })
      }
    })().catch(error => console.error('[partDoneCleanup] failed:', error instanceof Error ? error.message : error))
  }, SETTLE_MS))
}
