/**
 * Deletes phone voiceover zips from R2 once Studio no longer needs them.
 *
 * The phones upload `voiceover/<Series>/<Chapter>[.hi].zip` plus a small
 * `<zip>.status.json` sidecar (SharedVoiceover.kt). Studio downloads the zip
 * once (phoneVoiceoverImport), so it is dead weight after that:
 *
 *   - imported: the chapter's audio folder marker holds this exact zip's ETag
 *     and its alignment document exists → the zip goes. The sidecar stays: the
 *     other phones read it to know the chapter is voiced.
 *   - part done: the chapter is completed or its Part is marked done in the
 *     Library (after the last restart) → zip and sidecar both go.
 *
 * Empty objects are restart tombstones and are never touched. Series Studio
 * doesn't know, or whose restart is still synchronizing, are left alone.
 *
 * R2 cost: one LIST (Class A) per 1000 objects under each of the two roots
 * (ours and the bucket root, as phoneVoiceoverImport looks); deletes are free.
 * Runs after a chapter's alignment finishes (debounced per series) and from
 * Storage's "Clean up R2 voiceovers". Never on a timer.
 */
import fs from 'fs/promises'
import path from 'path'
import { DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { prisma } from '../index.js'
import { createClient, getR2Config, invalidateStorage } from './r2Service.js'
import { FETCH_MARKER, VOICEOVER_FOLDER, zipChapter } from './phoneVoiceoverImport.js'
import { hasAlignmentDocument } from './alignment/alignmentDocument.js'
import { audioFolderName, type NarrationLanguage } from './narrationLanguage.js'
import { libraryControls } from './libraryControls.js'
import { unfinishedVoiceoverChapters } from './voiceoverChapterScope.js'
import { seriesRestartPending } from './seriesRestartGuard.js'

const SIDECAR = '.status.json'
const SETTLE_MS = 30_000

export interface ListedObject { key: string; size: number; etag: string }

export interface CleanupChapter {
  folderPath: string
  /** Completed, or in a Part marked done. */
  done: boolean
  /** Per language: the ETag the audio was imported from, when alignment is complete too. */
  importedEtag: Partial<Record<NarrationLanguage, string>>
}

export interface CleanupTarget { key: string; bytes: number; reason: 'imported' | 'part-done' }

/**
 * Which objects to delete. `objects` are under `<root>voiceover/`; `series`
 * maps a series folder name to its chapters by chapter folder name.
 */
export function planVoiceoverCleanup(
  objects: (ListedObject & { root: string })[],
  series: Map<string, Map<string, CleanupChapter>>
): CleanupTarget[] {
  const targets: CleanupTarget[] = []
  for (const obj of objects) {
    if (obj.size === 0) continue // restart tombstone
    const rest = obj.key.slice(obj.root.length + VOICEOVER_FOLDER.length)
    const slash = rest.indexOf('/')
    if (slash <= 0 || rest.indexOf('/', slash + 1) !== -1) continue
    const chapters = series.get(rest.slice(0, slash))
    if (!chapters) continue
    const name = rest.slice(slash + 1)
    const sidecar = name.endsWith(`.zip${SIDECAR}`)
    if (!sidecar && !name.endsWith('.zip')) continue
    const base = name.slice(0, -(sidecar ? `.zip${SIDECAR}` : '.zip').length)
    const { folder, language } = zipChapter(base, new Set(chapters.keys()))
    const chapter = chapters.get(folder)
    if (!chapter) continue
    if (chapter.done) targets.push({ key: obj.key, bytes: obj.size, reason: 'part-done' })
    else if (!sidecar && obj.etag && chapter.importedEtag[language] === obj.etag) {
      targets.push({ key: obj.key, bytes: obj.size, reason: 'imported' })
    }
  }
  return targets
}

function chapterDir(folderPath: string): string {
  return path.join(process.env.DOWNLOAD_ROOT || './downloads', folderPath)
}

async function importedEtag(folderPath: string, language: NarrationLanguage): Promise<string | undefined> {
  try {
    const marker = JSON.parse(await fs.readFile(path.join(chapterDir(folderPath), audioFolderName(language), FETCH_MARKER), 'utf-8'))
    if (typeof marker?.etag !== 'string' || !marker.etag) return undefined
    return (await hasAlignmentDocument(folderPath, language)) ? marker.etag : undefined
  } catch {
    return undefined
  }
}

/** Studio's chapters that the plan may match, by series folder name. One series when `seriesId` is given. */
async function knownSeries(seriesId?: string): Promise<Map<string, Map<string, CleanupChapter>>> {
  const rows = await prisma.series.findMany({
    where: seriesId ? { id: seriesId } : {},
    select: { rootFolder: true, chapters: { select: { folderPath: true, number: true, completedAt: true } } }
  })
  const controls = await libraryControls()
  const result = new Map<string, Map<string, CleanupChapter>>()
  for (const row of rows) {
    const folder = path.basename(row.rootFolder)
    if (await seriesRestartPending(folder)) continue
    const control = controls.find(c => c.folder === folder)
    if (control?.deleted) continue
    const open = new Set(unfinishedVoiceoverChapters(row.chapters, control))
    const chapters = new Map<string, CleanupChapter>()
    for (const ch of row.chapters) {
      const done = !open.has(ch)
      chapters.set(path.basename(ch.folderPath), {
        folderPath: ch.folderPath,
        done,
        importedEtag: done ? {} : { en: await importedEtag(ch.folderPath, 'en'), hi: await importedEtag(ch.folderPath, 'hi') }
      })
    }
    result.set(folder, chapters)
  }
  return result
}

export interface VoiceoverCleanupResult {
  deleted: CleanupTarget[]
  freedBytes: number
  dryRun: boolean
  skipped?: string
}

let running: Promise<unknown> = Promise.resolve()

/** Lists the phones' voiceover folder(s) and deletes what Studio no longer needs. `dryRun` only reports. */
export function cleanupR2Voiceovers(opts: { seriesId?: string; dryRun?: boolean } = {}): Promise<VoiceoverCleanupResult> {
  const next = running.catch(() => {}).then(() => sweep(opts))
  running = next
  return next
}

async function sweep({ seriesId, dryRun = false }: { seriesId?: string; dryRun?: boolean }): Promise<VoiceoverCleanupResult> {
  const config = getR2Config()
  if (!config) return { deleted: [], freedBytes: 0, dryRun, skipped: 'R2 is not configured' }
  const series = await knownSeries(seriesId)
  if (series.size === 0) return { deleted: [], freedBytes: 0, dryRun }
  const only = seriesId ? [...series.keys()][0] : null
  const client = createClient(config)
  try {
    const objects: (ListedObject & { root: string })[] = []
    for (const root of [...new Set([config.prefix, ''])]) {
      const prefix = `${root}${VOICEOVER_FOLDER}${only ? `${only}/` : ''}`
      let token: string | undefined
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix, ContinuationToken: token }))
        for (const o of page.Contents ?? []) {
          if (o.Key) objects.push({ key: o.Key, size: o.Size ?? 0, etag: (o.ETag ?? '').replace(/"/g, ''), root })
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined
      } while (token)
    }
    const targets = planVoiceoverCleanup(objects, series)
    const deleted: CleanupTarget[] = []
    if (!dryRun) {
      for (const target of targets) {
        await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: target.key }))
        deleted.push(target)
      }
      if (deleted.length) {
        invalidateStorage()
        console.log(`[voiceoverCleanup] deleted ${deleted.length} R2 object(s), ${deleted.reduce((n, t) => n + t.bytes, 0)} B`)
      }
    }
    const list = dryRun ? targets : deleted
    return { deleted: list, freedBytes: list.reduce((n, t) => n + t.bytes, 0), dryRun }
  } finally {
    client.destroy()
  }
}

const timers = new Map<string, NodeJS.Timeout>()

/** After a chapter finishes aligning: clean its series a little later, so a batch of chapters is one LIST. */
export function scheduleVoiceoverCleanup(seriesId: string): void {
  if (!getR2Config()) return
  clearTimeout(timers.get(seriesId))
  timers.set(seriesId, setTimeout(() => {
    timers.delete(seriesId)
    cleanupR2Voiceovers({ seriesId })
      .catch(error => console.error('[voiceoverCleanup] failed:', error instanceof Error ? error.message : error))
  }, SETTLE_MS))
}

/**
 * Chapter folders whose `language` voiceover Studio already imported and aligned. Their zip may be gone from R2,
 * so the phones can no longer see another phone voiced them: voiceover splits leave them out.
 */
export async function importedVoiceoverFolders(folderPaths: string[], language: NarrationLanguage): Promise<string[]> {
  const found: string[] = []
  for (const folderPath of folderPaths) if (await importedEtag(folderPath, language)) found.push(path.basename(folderPath))
  return found
}
