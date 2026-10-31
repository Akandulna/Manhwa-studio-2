import { restartRevision } from './seriesRestartModel.js'
import fs from 'fs/promises'
import path from 'path'
import { createHash } from 'crypto'
import type { PrismaClient } from '@prisma/client'
import type { Server } from 'socket.io'
import type { Request, Response, NextFunction } from 'express'

const KEY = 'library.seriesActivity'
type Source = { hash: string; at: number }
type Activity = { at: number; sources: Record<string, Source> }
type SeriesRow = { rootFolder: string; createdAt?: Date | string }
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const time = (v: unknown): number => v instanceof Date ? v.getTime() : typeof v === 'string' ? Date.parse(v) || 0 : 0

// Stable keys keep a refreshed/reordered receipt from looking like new work.
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical)
  if (!object(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]))
}
function savedTime(value: unknown): number {
  if (!object(value) && !Array.isArray(value)) return 0
  return Math.max(0, ...Object.entries(value).map(([key, item]) =>
    /^(savedAt|uploadedAt|downloadedAt|completedAt|at|since)$/.test(key) ? time(item) : savedTime(item)))
}

/** One shared order for every module. Settings storage avoids a database migration. */
export class SeriesActivityStore {
  private entries: Record<string, Activity> = Object.create(null)
  private ready: Promise<void>
  private seeded = new Map<string, Promise<void>>()
  private timer: NodeJS.Timeout | null = null
  private writes: Promise<void> = Promise.resolve()

  constructor(private db: PrismaClient, private root: () => string, private changed: (times: Record<string, string>) => void) {
    this.ready = db.setting.findUnique({ where: { key: KEY } }).then(row => {
      if (!row) return
      const parsed = JSON.parse(row.value)
      if (object(parsed)) for (const [folder, entry] of Object.entries(parsed)) {
        if (object(entry) && Number.isFinite(entry.at)) this.entries[folder] = { at: entry.at, sources: Object.assign(Object.create(null), object(entry.sources) ? entry.sources : {}) }
      }
    })
  }

  async times(): Promise<Record<string, string>> {
    await this.ready
    return Object.fromEntries(Object.entries(this.entries).map(([folder, entry]) => [folder, new Date(entry.at).toISOString()]))
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = null; void this.flush().catch(error => console.error('[series-activity]', error)) }, 300)
    this.timer.unref()
  }

  async flush(): Promise<void> {
    await this.ready
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    const value = JSON.stringify(this.entries)
    this.writes = this.writes.catch(() => {}).then(async () => {
      await this.db.setting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } })
    })
    await this.writes
    this.changed(await this.times())
  }

  async touch(folder: string, at = Date.now()): Promise<void> {
    await this.ready
    if (!folder || folder !== path.basename(folder) || !Number.isFinite(at) || at <= 0) return
    at = Math.min(at, Date.now())
    const entry = this.entries[folder] ??= { at: 0, sources: Object.create(null) }
    if (at <= entry.at) return
    entry.at = at
    this.schedule()
  }

  async file(relative: string): Promise<void> {
    const parts = relative.split(path.sep)
    if (parts.length < 2 || parts.some(p => p === '..' || p === '.DS_Store')) return
    const stat = await fs.stat(path.join(this.root(), relative)).catch(() => null)
    if (stat?.isFile()) await this.touch(parts[0], stat.mtimeMs)
  }

  private seed(folder: string): Promise<void> {
    let pending = this.seeded.get(folder)
    if (!pending) {
      pending = (async () => {
        await this.ready
        // Catch work done while the server was closed, once per folder per startup.
        let latest = 0
        const walk = async (dir: string): Promise<void> => {
          for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
            if (entry.name === '.DS_Store' || entry.name.startsWith('.')) continue
            const file = path.join(dir, entry.name)
            if (entry.isDirectory()) await walk(file)
            else if (entry.isFile()) latest = Math.max(latest, (await fs.stat(file).catch(() => null))?.mtimeMs ?? 0)
          }
        }
        await walk(path.join(this.root(), folder))
        if (latest) await this.touch(folder, latest)
      })()
      this.seeded.set(folder, pending)
    }
    return pending
  }

  async order<T extends SeriesRow>(rows: T[]): Promise<(T & { lastActivityAt: string })[]> {
    await Promise.all(rows.map(row => this.seed(path.basename(row.rootFolder))))
    return rows.map(row => ({ ...row, lastActivityAt: new Date(Math.max(this.entries[path.basename(row.rootFolder)]?.at ?? 0, time(row.createdAt))).toISOString() }))
      .sort((a, b) => time(b.lastActivityAt) - time(a.lastActivityAt) || a.rootFolder.localeCompare(b.rootFolder))
  }

  /** Observe only each series' work, excluding receipt-wide refresh/presence fields. */
  async phone(kind: string, device: string, body: unknown, receivedAt = Date.now()): Promise<void> {
    await this.ready
    if (!object(body)) return
    const at = Math.min(time(body.updatedAt) || receivedAt, Date.now())
    const series = Array.isArray(body.series)
      ? body.series.filter(object).map(s => [s.folder, s] as const)
      : Object.entries(object(body.series) ? body.series : {})
    for (const [folder, data] of series) {
      if (typeof folder !== 'string' || folder !== path.basename(folder) || !object(data)) continue
      const runs = Array.isArray(body.runs) ? body.runs.filter(r => object(r) && r.series === folder) : []
      const value = { ...data, ...(runs.length ? { runs } : {}) }
      const hash = createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
      const entry = this.entries[folder] ??= { at: 0, sources: Object.create(null) }
      const source = `${device}:${kind}`
      const prior = entry.sources[source]
      if (prior && at <= prior.at) continue
      if (prior?.hash === hash) {
        // Keep the receipt watermark so an older delayed payload cannot win.
        prior.at = at
        this.schedule()
        continue
      }
      entry.sources[source] = { hash, at }
      // A first snapshot with no per-series timestamps establishes a baseline;
      // it must not promote every old series just because a phone reconnected.
      const saved = savedTime(value)
      await this.touch(folder, prior ? Math.max(at, saved) : saved)
      this.schedule()
    }
  }
}

let store: SeriesActivityStore | null = null
export function startSeriesActivity(db: PrismaClient, io: Server): void {
  store = new SeriesActivityStore(db, () => path.resolve(process.env.DOWNLOAD_ROOT || './downloads'), times => io.emit('series:activity', times))
  io.on('connection', socket => { void store!.times().then(times => socket.emit('series:activity', times)).catch(error => console.error('[series-activity]', error)) })
}
export async function withSeriesActivity<T extends SeriesRow>(rows: T[]) {
  return store ? store.order(rows) : rows.map(row => ({ ...row, lastActivityAt: new Date(time(row.createdAt)).toISOString() }))
}
export function recordSeriesFileActivity(file: string): void {
  void store?.file(file).catch(error => console.error('[series-activity]', error))
}
export async function flushSeriesActivity(): Promise<void> { await store?.flush() }
export function recordPhoneActivity(kind: string, device: string, body: unknown, at?: number): void {
  void store?.phone(kind, device, body, at).catch(error => console.error('[series-activity]', error))
}

const activeMutations = new Map<string, number>()
export async function withSeriesMutation<T>(folder: string, work: () => Promise<T>): Promise<T> {
  activeMutations.set(folder, (activeMutations.get(folder) ?? 0) + 1)
  try { return await work() } finally { const count = (activeMutations.get(folder) ?? 1) - 1; if (count) activeMutations.set(folder, count); else activeMutations.delete(folder) }
}
export const seriesMutationBusy = (folder: string): boolean => (activeMutations.get(folder) ?? 0) > 0

/** Successful processing requests also count before an asynchronous job writes its first file. */
export function seriesActivityMiddleware(db: PrismaClient) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || !/^\/api\/(series|chapters|manual|downloads|narration|clipper3|video2|storage|stitch|page-preview|r2)\//.test(req.path)
      || /\/(preview|plan|check-image-refs|scan)$/.test(req.path)) return next()
    // Resolve the series before a route can delete its chapter or series row.
    const seriesMatch = req.path.match(/\/series\/([^/]+)/) ?? req.path.match(/^\/api\/series\/([^/]+)/)
    const chapterMatch = req.path.match(/\/chapters\/([^/]+)/)
    const ids = new Set<string>()
    if (typeof req.body?.seriesId === 'string') ids.add(req.body.seriesId)
    if (Array.isArray(req.body?.series)) for (const item of req.body.series) {
      if (typeof item?.seriesId === 'string') ids.add(item.seriesId)
    }
    if (seriesMatch) ids.add(decodeURIComponent(seriesMatch[1]))
    const chapters = chapterMatch ? [decodeURIComponent(chapterMatch[1])] : Array.isArray(req.body?.chapterIds) ? req.body.chapterIds.filter((id: unknown) => typeof id === 'string') : []
    if (!ids.size && !chapters.length) return next()
    const folders = Promise.all([
      db.series.findMany({ where: { id: { in: [...ids] } }, select: { rootFolder: true } }),
      chapters.length ? db.chapter.findMany({ where: { id: { in: chapters } }, select: { series: { select: { rootFolder: true } } } }).then(rows => rows.map(c => c.series)) : []
    ]).then(rows => rows.flat()).catch(error => { console.error('[series-activity]', error); return [] })
    res.on('finish', () => {
      if (res.statusCode >= 400) return
      const at = Date.now()
      void folders.then(rows => Promise.all(rows.map(row => store?.touch(path.basename(row.rootFolder), at)))).catch(error => console.error('[series-activity]', error))
    })
    void folders.then(async rows => {
      const names = [...new Set(rows.map(row => path.basename(row.rootFolder)))]
      for (const folder of names) activeMutations.set(folder, (activeMutations.get(folder) ?? 0) + 1)
      let released = false
      const release = () => {
        if (released) return
        released = true
        for (const folder of names) { const count = (activeMutations.get(folder) ?? 1) - 1; if (count) activeMutations.set(folder, count); else activeMutations.delete(folder) }
      }
      res.once('finish', release); res.once('close', release)
      try {
        for (const folder of names) {
          const saved = await db.setting.findUnique({ where: { key: 'libraryControl:' + folder } })
          const revision = saved ? restartRevision(JSON.parse(saved.value)) : null
          if (revision && (await db.setting.findUnique({ where: { key: 'libraryRestartReady:' + folder } }))?.value !== revision) {
            release()
            res.status(409).json({ error: 'Series restart is synchronizing. Wait for Library to finish before starting work.' })
            return
          }
        }
        next()
      } catch (error) { release(); next(error) }
    }).catch(next)
  }
}
