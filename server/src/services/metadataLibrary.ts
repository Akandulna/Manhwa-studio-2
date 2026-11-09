import type { Server } from 'socket.io'
import { prisma } from '../index.js'
import { hiddenLibraryFolders } from './libraryControls.js'
import { withSeriesActivity } from './seriesActivity.js'
import { getR2Config } from './r2Service.js'
import { onPhoneReceipt } from './phoneRelay.js'
import { fetchMetadataResults } from './clipper3/metadataSplit.js'
import { readMetadataChapter } from './metadataChapterStatus.js'
import { notifySeriesProcessChanged } from './seriesProcess.js'
import type { MetadataLibrarySnapshot, MetadataSyncReport } from './metadataLibraryModel.js'

let io: Server | undefined
let running: Promise<MetadataSyncReport> | undefined
let timer: NodeJS.Timeout | undefined
let interval: NodeJS.Timeout | undefined
let started = false
let lastReport: MetadataSyncReport = { checkedAt: null, imported: 0, errors: [] }
const signatures = new Map<string, string>()

async function libraryRows() {
  const hidden = await hiddenLibraryFolders()
  return prisma.series.findMany({
    where: { rootFolder: { notIn: hidden } },
    select: { id: true, title: true, rootFolder: true, sourceSite: true, createdAt: true,
      chapters: { where: { status: 'done', completedAt: null }, orderBy: { number: 'asc' },
        select: { id: true, number: true, title: true, folderPath: true, seriesId: true } } },
    orderBy: { createdAt: 'desc' }
  })
}

export async function getMetadataLibrary(): Promise<MetadataLibrarySnapshot> {
  const rows = await withSeriesActivity(await libraryRows())
  const series: MetadataLibrarySnapshot['series'] = []
  for (const row of rows) {
    if (!row.chapters.length) continue
    const chapters = []
    for (const chapter of row.chapters) chapters.push(await readMetadataChapter({ ...chapter, series: { title: row.title } }))
    series.push({ id: row.id, title: row.title, rootFolder: row.rootFolder, sourceSite: row.sourceSite,
      lastActivityAt: row.lastActivityAt, chapters })
  }
  return { updatedAt: new Date().toISOString(), configured: !!getR2Config(), syncing: !!running, sync: lastReport, series }
}

/** Automatic and manual fetches share one run; the existing importer rechecks every write. */
export function syncMetadataLibrary(): Promise<MetadataSyncReport> {
  if (running) return running
  const run = async () => {
    const report: MetadataSyncReport = { checkedAt: new Date().toISOString(), imported: 0, errors: [] }
    if (getR2Config()) for (const series of await libraryRows()) {
      for (const row of series.chapters) {
        const chapter = { ...row, series: { title: series.title } }
        try {
          const status = await readMetadataChapter(chapter)
          if (!status.ready || status.state === 'complete') continue
          const fetched = await fetchMetadataResults(chapter)
          report.imported += fetched.imported
          report.errors.push(...fetched.errors.map(reason => ({ chapterId: chapter.id, reason })))
        } catch (error) {
          report.errors.push({ chapterId: chapter.id, reason: error instanceof Error ? error.message : String(error) })
        }
      }
    }
    lastReport = report
    if (report.imported) notifySeriesProcessChanged(true)
    return report
  }
  // Defer work until `running` is set, including the no-R2 path.
  running = Promise.resolve().then(run).finally(() => {
    running = undefined
    io?.emit('metadata:updated', lastReport)
  })
  io?.emit('metadata:syncing')
  return running
}

function schedule(delay = 1_500) {
  if (timer) return
  timer = setTimeout(() => {
    timer = undefined
    if (running) { schedule(); return }
    void syncMetadataLibrary().catch(error => console.error('[metadata] automatic fetch:', error))
  }, delay)
  timer.unref()
}

/** Only Metadata receipt changes trigger cloud reads; working-page progress does not. */
export function metadataReceiptChanged(device: string, body: object): boolean {
  const metadata = (body as { metadata?: unknown }).metadata
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false
  const signature = JSON.stringify(Object.entries(metadata).sort(([a], [b]) => a.localeCompare(b)))
  if (signatures.get(device) === signature) return false
  signatures.set(device, signature)
  return true
}

/** Receipts give prompt updates; periodic catch-up also handles offline/missed upload notifications. */
export function startMetadataAutoSync(socketIo: Server): void {
  io = socketIo
  if (started) return
  started = true
  onPhoneReceipt((kind, device, body) => {
    if (kind === 'crops' && metadataReceiptChanged(device, body)) schedule()
  })
  schedule(5_000)
  interval = setInterval(() => schedule(), 60_000)
  interval.unref()
}

export function stopMetadataAutoSync(): void {
  if (timer) clearTimeout(timer)
  if (interval) clearInterval(interval)
  timer = interval = undefined
}
