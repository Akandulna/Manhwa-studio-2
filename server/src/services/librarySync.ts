/** Shared listings and automatic prepared-chapter imports. R2 is durable; relay is the change notification. */
import { randomUUID } from 'crypto'
import path from 'path'
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3'
import type { Server } from 'socket.io'
import { prisma } from '../index.js'
import { createClient, getR2Config } from './r2Service.js'
import { setAutoSend, noteChapterDownloaded, flushAutoSend, updatePhoneIndexes, phoneZipFolder } from './phoneSend.js'
import { importLibraryChapter } from './phonePull.js'
import { parseLibraryManifest, type LibraryManifest } from './libraryManifest.js'
import { notifySeriesProcessChanged } from './seriesProcess.js'
import { isLibraryDeleted, libraryControls, purgeDeletedLibrarySeries, saveLibraryControls } from './libraryControls.js'

const OWNER = 'libraryOwner:'
let io: Server | null = null
let publishing: Promise<void> | null = null
let publishDirty = false
let publishTimer: NodeJS.Timeout | null = null
const pending = new Map<string, LibraryManifest>()
let importing = false
let importTimer: NodeJS.Timeout | null = null
let cleanupTimer: NodeJS.Timeout | null = null
let cleaning = false

export function scheduleLibraryCleanup(): void {
  if (cleaning || cleanupTimer) return
  cleaning = true
  void purgeDeletedLibrarySeries().then(() => { io?.emit('library:updated'); notifySeriesProcessChanged(true) }).catch(error => {
    console.error('[library-sync] deletion cleanup will retry:', error)
    cleanupTimer = setTimeout(() => { cleanupTimer = null; scheduleLibraryCleanup() }, 30_000)
    cleanupTimer.unref()
  }).finally(() => { cleaning = false })
}

export async function libraryDeviceId(): Promise<string> {
  const key = 'libraryDeviceId'
  const existing = await prisma.setting.findUnique({ where: { key } })
  if (existing) return existing.value
  return (await prisma.setting.upsert({ where: { key }, create: { key, value: `mac-${randomUUID()}` }, update: {} })).value
}

/** Upgrade pre-sharing rows without taking ownership of chapters imported from a phone. */
export async function registerExistingLibrarySeries(): Promise<void> {
  const owner = await libraryDeviceId()
  const rows = await prisma.series.findMany({ where: { sourceSite: { notIn: ['phone', 'shared'] } }, select: { id: true } })
  for (const row of rows) {
    const key = OWNER + row.id
    if (await prisma.setting.findUnique({ where: { key } })) continue
    await prisma.setting.upsert({ where: { key }, create: { key, value: owner }, update: {} })
  }
}

/** Called only on local creation. Replicas never receive source URLs or join the source download queue. */
export async function ownLibrarySeries(seriesId: string): Promise<void> {
  const series = await prisma.series.findUnique({ where: { id: seriesId } })
  if (series && await isLibraryDeleted(path.basename(series.rootFolder))) throw new Error('This series was deleted everywhere. Use a different series folder to add it again.')
  const key = OWNER + seriesId
  const owner = await libraryDeviceId()
  const row = await prisma.setting.upsert({ where: { key }, create: { key, value: owner }, update: {} })
  if (row.value !== owner) return
  await setAutoSend(seriesId, true)
  scheduleLibraryPublish()
}

export async function isLibraryOrigin(seriesId: string): Promise<boolean> {
  const row = await prisma.setting.findUnique({ where: { key: OWNER + seriesId } })
  return !!row && row.value === await libraryDeviceId()
}

export function scheduleLibraryPublish(): void {
  publishDirty = true
  if (publishing || publishTimer) return
  publishTimer = setTimeout(() => {
    publishTimer = null
    void publishLibrary().catch(error => {
      console.error('[library-sync] publish will retry:', error)
      publishDirty = true
      publishTimer = setTimeout(() => { publishTimer = null; scheduleLibraryPublish() }, 30_000)
    })
  }, 300)
  publishTimer.unref()
}

export async function publishLibrary(): Promise<void> {
  if (publishing) { publishDirty = true; return publishing }
  publishing = (async () => {
    await registerExistingLibrarySeries()
    do {
      publishDirty = false
      const config = getR2Config()
      if (!config) return
      const deviceId = await libraryDeviceId()
      const owners = await prisma.setting.findMany({ where: { key: { startsWith: OWNER }, value: deviceId } })
      const controls = await libraryControls()
      const deleted = new Set(controls.filter(c => c.deleted).map(c => c.folder))
      const rows = (await prisma.series.findMany({ where: { id: { in: owners.map(o => o.key.slice(OWNER.length)) } }, include: { chapters: { orderBy: { number: 'asc' }, include: { phoneSend: true } } } })).filter(s => !deleted.has(path.basename(s.rootFolder)))
      // A ZIP uploaded just before a failed index write must still become downloadable on every phone.
      for (const row of rows) if (row.chapters.some(c => c.phoneSend?.sentAt)) await updatePhoneIndexes(row.id)
      const manifest: LibraryManifest = {
        schema: 'manhwa-library/1', deviceId, device: 'Manhwa Studio', updatedAt: new Date().toISOString(),
        controls, series: rows.map(s => ({ folder: path.basename(s.rootFolder), title: s.title, sourceSite: s.sourceSite,
          chapters: s.chapters.map(c => {
            const sent = c.phoneSend
            return { name: path.basename(c.folderPath), number: c.number, title: c.title,
              ...(sent?.sentAt && !sent.clearedAt && sent.key ? { key: sent.key, etag: sent.etag, sentAt: sent.sentAt.toISOString(), files: sent.files, bytes: sent.bytes, fingerprint: sent.fingerprint } : {}) }
          }) }))
      }
      if (!manifest.series.length && !controls.length) return
      const body = JSON.stringify(manifest)
      const client = createClient(config)
      try {
        // The phones may use a different prefix from the desktop's production files.
        const folder = await phoneZipFolder(client, config)
        const prefix = folder.slice(0, -'manhwa/'.length)
        await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: `${prefix}library/${deviceId}.json`, Body: body, ContentType: 'application/json' }))
      } finally { client.destroy() }
      const url = process.env.RELAY_URL?.trim().replace(/\/+$/, '')
      const token = process.env.RELAY_TOKEN?.trim()
      if (url && token) {
        const response = await fetch(`${url}/receipt/library?device=${deviceId}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(30_000) })
        if (!response.ok) throw new Error(`Library relay returned ${response.status}`)
      }
      if (deleted.size) scheduleLibraryCleanup()
    } while (publishDirty)
  })()
  try { await publishing } finally { publishing = null }
}

/** Called for stored receipts too, so reconnects catch up after the Mac was off. */
export function receiveLibraryManifest(value: unknown): void {
  const manifest = parseLibraryManifest(value)
  if (!manifest) return
  const previous = pending.get(manifest.deviceId)
  if (!previous || Date.parse(manifest.updatedAt) >= Date.parse(previous.updatedAt)) pending.set(manifest.deviceId, manifest)
  void drainImports()
}

async function drainImports(): Promise<void> {
  if (importing || !io || importTimer) return
  importing = true
  try {
    await registerExistingLibrarySeries()
    for (const [device, manifest] of pending) {
      const own = await libraryDeviceId()
      if (device === own) { pending.delete(device); continue }
      if (await saveLibraryControls(manifest.controls ?? [])) {
        notifySeriesProcessChanged()
        scheduleLibraryPublish()
        scheduleLibraryCleanup()
      }
      const key = `libraryReceived:${device}`
      const received = await prisma.setting.findUnique({ where: { key } })
      if (received && Date.parse(received.value) >= Date.parse(manifest.updatedAt)) { pending.delete(device); continue }
      // Make all listings visible before downloading any chapter.
      for (const remote of manifest.series) {
        if (await isLibraryDeleted(remote.folder)) continue
        let series = await prisma.series.findFirst({ where: { rootFolder: remote.folder } })
        series ??= await prisma.series.create({ data: { title: remote.title, rootFolder: remote.folder, sourceSite: 'phone' } })
        const ownerKey = OWNER + series.id
        const owner = await prisma.setting.upsert({ where: { key: ownerKey }, create: { key: ownerKey, value: device }, update: {} })
        // Preserve an existing origin's files and source downloads.
        if (owner.value !== device) continue
        for (const c of remote.chapters) {
          await prisma.chapter.upsert({ where: { seriesId_number: { seriesId: series.id, number: c.number } },
            create: { seriesId: series.id, number: c.number, title: c.title, folderPath: `${remote.folder}/${c.name}`, status: 'pending' }, update: {} })
        }
      }
      io.emit('library:updated')
      notifySeriesProcessChanged()
      for (const remote of manifest.series) {
        if (await isLibraryDeleted(remote.folder)) continue
        const series = await prisma.series.findFirst({ where: { rootFolder: remote.folder } })
        if (!series) continue
        const owner = await prisma.setting.findUnique({ where: { key: OWNER + series.id } })
        if (owner?.value !== device) continue
        for (const chapter of remote.chapters) if (chapter.key) {
          await importLibraryChapter(series.id, remote, chapter)
          io.emit('chapters:updated', [])
          io.emit('library:updated')
        }
      }
      await prisma.setting.upsert({ where: { key }, create: { key, value: manifest.updatedAt }, update: { value: manifest.updatedAt } })
      if (pending.get(device) === manifest) pending.delete(device)
    }
  } catch (error) {
    console.error('[library-sync] import will retry:', error)
    importTimer = setTimeout(() => { importTimer = null; void drainImports() }, 30_000)
    importTimer.unref()
  } finally {
    importing = false
    if (pending.size && !importTimer) void drainImports()
  }
}

export function startLibrarySync(socket: Server): void {
  io = socket
  scheduleLibraryCleanup()
  void drainImports()
  // One startup catch-up, no bucket polling. Relay receipts handle subsequent changes.
  void (async () => {
    await registerExistingLibrarySeries()
    const config = getR2Config()
    if (!config) return
    const client = createClient(config)
    try {
      const folder = await phoneZipFolder(client, config)
      const prefixes = new Set([`${config.prefix}library/`, `${folder.slice(0, -'manhwa/'.length)}library/`])
      for (const prefix of prefixes) {
        let continuation: string | undefined
        do {
          const list = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix, ContinuationToken: continuation }))
          for (const object of list.Contents ?? []) {
            if (!object.Key?.endsWith('.json')) continue
            const result = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: object.Key }))
            receiveLibraryManifest(JSON.parse(await result.Body!.transformToString()))
          }
          continuation = list.NextContinuationToken
        } while (continuation)
      }
      scheduleLibraryPublish()
      await resumeLibraryUploads()
    } finally { client.destroy() }
  })().catch(error => console.error('[library-sync] startup catch-up failed:', error))
}

/** Recover uploads left pending by a restart or by missing R2 settings. */
export async function resumeLibraryUploads(): Promise<void> {
  if (!io || !getR2Config()) return
  const deviceId = await libraryDeviceId()
  const owners = await prisma.setting.findMany({ where: { key: { startsWith: OWNER }, value: deviceId } })
  for (const row of owners) await noteChapterDownloaded(row.key.slice(OWNER.length))
  flushAutoSend(io)
}
