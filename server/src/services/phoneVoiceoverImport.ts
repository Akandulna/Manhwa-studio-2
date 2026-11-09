/**
 * Fetch voiceovers made on the Sleeper-Cell phone and attach them to the
 * chapter's voiceover sections.
 *
 * The phone splits each chapter's script itself (a port of
 * splitScriptIntoSections, so the splits match what Auto-Split would make),
 * voices every split in AI Studio, and once a chapter is fully voiced uploads
 * `<phone prefix>voiceover/<Series>/<Chapter>.zip` (see VoiceoverUpload.kt),
 * replacing any earlier upload of that chapter:
 *
 *     <Series>/<Chapter>/voiceover.json    the splits and their audio files
 *     <Series>/<Chapter>/section_01.wav    split 0's audio, and so on
 *
 * Fetching lists the series' folder in R2, downloads each chapter zip that is
 * new or changed since the last fetch, and attaches it: the phone's splits
 * become the chapter's English sections (re-splitting only when they differ
 * from the sections already there), and each split's audio is written to
 * `audio/section_NN.<ext>` and attached as generated audio, then aligned like
 * any other. The phone's splits win over the desktop's: the audio was made from
 * them. New audio clears the sections' old timelines and the chapter's
 * alignment document; alignment writes them again once it finishes.
 *
 * Hinglish voiceovers (the Hindi tab) sit in the same folder as
 * `<Chapter>.hi.zip`, laid out the same way, with `"language": "hi"` in the
 * manifest and `script_sha256` taken over script.hi.md. A fetch handles one
 * language: its zips only, its sections, its audio folder (audio_hi/) and its
 * script file. See zipChapter for how the two are told apart.
 *
 * R2 cost per fetch: one or two LISTs (Class A), plus one GET (Class B) per
 * chapter whose zip changed. A marker file in each chapter's audio folder
 * remembers the ETag it was attached from, so a re-run downloads nothing new.
 * `previewPhoneVoiceover` is the LIST alone, to show what a fetch would bring.
 * Nothing here runs on a timer; only Narration's "Fetch from phone" calls it.
 */

import crypto from 'crypto'
import { recordManagerTransfer } from './managerReporting.js'
import { withSeriesMutation } from './seriesActivity.js'
import { requireSeriesRestartReady } from './seriesRestartGuard.js'
import fs from 'fs/promises'
import path from 'path'
import { GetObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3'
import type { Server } from 'socket.io'
import { prisma } from '../index.js'
import { readZip, type ZipEntry } from '../utils/zipReader.js'
import { createClient, getR2Config, type R2Config } from './r2Service.js'
import { backupAudioFile, initializeSections } from './voiceoverService.js'
import { validateAudioFile, type AudioMetadata } from './audioProcessor.js'
import { alignSectionInBackground } from './alignment/alignmentService.js'
import { removeAlignmentDocument } from './alignment/alignmentDocument.js'
import { LANGUAGE_NAMES, audioFolderName, scriptFileName, type NarrationLanguage } from './narrationLanguage.js'

/** Folder the phone uploads chapter zips to, inside its R2 prefix. Keep in step with FOLDER in VoiceoverUpload.kt. */
export const VOICEOVER_FOLDER = 'voiceover/'

/** In each chapter's audio folder: which R2 zip its sections were attached from. */
export const FETCH_MARKER = '.r2-voiceover.json'

const MANIFEST_FILE = 'voiceover.json'
const SCHEMA = /^sleeper-cell-voiceover-chapter\/1\./

/** Allow full-chapter WAVs as well as short splits, while bounding compressed and expanded chapter sizes. */
const MAX_ZIP_BYTES = 512 * 1024 * 1024

/** What the desktop accepts as uploaded section audio (see uploadSectionAudio). */
const AUDIO_EXTENSIONS = new Set(['wav', 'mp3', 'ogg', 'flac', 'aac', 'm4a', 'opus', 'weba'])

export interface PhoneVoiceoverSection {
  index: number
  text: string
  /** File name in the zip's chapter folder, e.g. section_01.wav. */
  file: string
  format: string
  data: Buffer
}

/** A chapter zip, read and checked. */
export interface PhoneVoiceoverChapter {
  restartRevision?: string
  provider: string | null
  model: string | null
  voice: string | null
  style: string | null
  /** SHA-256 of the script file the phone split, to tell whether the desktop has the same script. */
  scriptSha256: string | null
  sections: PhoneVoiceoverSection[]
}

export interface FetchedVoiceover {
  chapterId: string
  chapterNumber: number
  /** Chapter folder name, as on the desktop and in R2. */
  folder: string
  sections: number
  /** The phone's splits differed from the chapter's sections, so they were replaced (losing their audio). */
  resplit: boolean
  /** Whether the desktop's script file is the one the phone split; null when either side doesn't say. */
  scriptMatches: boolean | null
}

/** Each chapter as it starts downloading, for live progress. */
export type VoiceoverFetchProgress = (step: { chapterNumber: number; current: number; total: number }) => void

/** One chapter zip in R2 as a fetch would see it, before anything is downloaded. */
export interface PhoneVoiceoverPreviewChapter {
  chapterId: string
  number: number
  folder: string
  /** new: never attached · changed: re-uploaded since it was attached · same: already attached from this zip */
  state: 'new' | 'changed' | 'same'
  bytes: number
  uploadedAt: string | null
}

export interface PhoneVoiceoverPreview {
  configured: boolean
  chapters: PhoneVoiceoverPreviewChapter[]
  /** Zips in R2 with no desktop chapter folder of that name. */
  unmatched: string[]
}

export interface PhoneVoiceoverFetch {
  /** False when R2 is not set up; nothing was looked at. */
  configured: boolean
  /** Chapter zips in R2 for this series in this language (every one is a fully voiced chapter). */
  found: number
  /** Chapters attached by this run: new, or the phone re-uploaded them. */
  fetched: FetchedVoiceover[]
  /** Chapters already attached from the same zip earlier. */
  upToDate: number
  /** Zips in R2 with no desktop chapter folder of that name. */
  unmatched: string[]
  failed: { folder: string; reason: string }[]
}

// ============ Reading a zip ============

/** A single path segment that can't climb out of the folder it is joined to. */
function isSafeSegment(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && !/[/\\\0]/.test(name)
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null)

/**
 * Reads a chapter zip's manifest and audio. Entries are `<Series>/<Chapter>/…`;
 * both leading folders are dropped rather than checked, so a series or chapter
 * renamed on one side still lands in the chapter the zip was matched to.
 * Throws when the manifest is missing or malformed, is for another language (a
 * manifest without one is English), the sections aren't numbered 0, 1, 2… in
 * order, or a section's audio isn't in the zip.
 */
export function parseVoiceoverZip(entries: ZipEntry[], language: NarrationLanguage = 'en'): PhoneVoiceoverChapter {
  const files = new Map<string, Buffer>()
  for (const { name, data } of entries) {
    const rel = name.split('/').filter(Boolean).slice(2)
    if (rel.length === 1 && isSafeSegment(rel[0])) files.set(rel[0], data)
  }
  const raw = files.get(MANIFEST_FILE)
  if (!raw) throw new Error(`The zip has no ${MANIFEST_FILE}`)

  let manifest: any
  try {
    manifest = JSON.parse(raw.toString('utf-8'))
  } catch {
    throw new Error(`${MANIFEST_FILE} is not valid JSON`)
  }
  if (!SCHEMA.test(String(manifest?.schema_version ?? ''))) {
    throw new Error(`Unknown ${MANIFEST_FILE} version: ${manifest?.schema_version}`)
  }
  if ((manifest.language ?? 'en') !== language) {
    throw new Error(`Expected a ${LANGUAGE_NAMES[language]} voiceover, but this one is "${manifest.language}"`)
  }
  if (!Array.isArray(manifest.sections) || manifest.sections.length === 0) {
    throw new Error(`${MANIFEST_FILE} lists no sections`)
  }

  const sections = (manifest.sections as any[]).map((s, i): PhoneVoiceoverSection => {
    if (s?.index !== i) throw new Error(`Section ${i + 1} is numbered ${s?.index}`)
    const sectionText = text(s.text)
    if (!sectionText) throw new Error(`Section ${i + 1} has no text`)
    const file = text(s.file)
    if (!file || !isSafeSegment(file)) throw new Error(`Section ${i + 1} names no audio file`)
    const format = path.extname(file).slice(1).toLowerCase()
    if (!AUDIO_EXTENSIONS.has(format)) throw new Error(`Section ${i + 1}'s audio is not a supported format (${file})`)
    const data = files.get(file)
    if (!data || data.length === 0) throw new Error(`${file} is missing from the zip`)
    return { index: i, text: sectionText, file, format, data }
  })

  return {
    ...(text(manifest.restartRevision) ? { restartRevision: text(manifest.restartRevision)! } : {}),
    provider: text(manifest.provider),
    model: text(manifest.model),
    voice: text(manifest.voice),
    style: text(manifest.style),
    scriptSha256: text(manifest.script_sha256),
    sections
  }
}

// ============ Attaching ============

function chapterDir(folderPath: string): string {
  // As voiceoverService's getFullFolderPath.
  return path.join(process.env.DOWNLOAD_ROOT || './downloads', folderPath)
}

/** Whether the desktop's script file is byte for byte the one the phone split. */
async function scriptMatches(folderPath: string, sha256: string | null, language: NarrationLanguage): Promise<boolean | null> {
  if (!sha256) return null
  try {
    const script = await fs.readFile(path.join(chapterDir(folderPath), scriptFileName(language)))
    return crypto.createHash('sha256').update(script).digest('hex') === sha256
  } catch {
    return null
  }
}

/**
 * Makes the phone's splits the chapter's sections in this language and
 * attaches their audio. Every file is written and checked with ffprobe before
 * anything in the database changes, so a bad zip leaves the chapter as it was.
 * Returns whether the sections had to be replaced.
 */
export async function attachVoiceover(
  chapterId: string,
  folderPath: string,
  voiceover: PhoneVoiceoverChapter,
  io?: Server | null,
  language: NarrationLanguage = 'en'
): Promise<boolean> {
  const audioDir = path.join(chapterDir(folderPath), audioFolderName(language))
  const staging = path.join(audioDir, '.phone-staging')
  await fs.rm(staging, { recursive: true, force: true })
  await fs.mkdir(staging, { recursive: true })

  try {
    const staged: { section: PhoneVoiceoverSection; path: string; metadata: AudioMetadata }[] = []
    for (const section of voiceover.sections) {
      const stagedPath = path.join(staging, section.file)
      await fs.writeFile(stagedPath, section.data)
      const validation = await validateAudioFile(stagedPath)
      if (!validation.valid || !validation.metadata) {
        throw new Error(`${section.file}: ${validation.error || 'not playable audio'}`)
      }
      staged.push({ section, path: stagedPath, metadata: validation.metadata })
    }

    const existing = await prisma.audioSection.findMany({
      where: { chapterId, language },
      orderBy: { index: 'asc' }
    })
    const sameSplits = existing.length === voiceover.sections.length &&
      existing.every((s, i) => s.index === i && s.text === voiceover.sections[i].text)
    if (!sameSplits) {
      await initializeSections(chapterId, voiceover.sections.map(({ index, text }) => ({ index, text })), language)
    }

    const rows = await prisma.audioSection.findMany({
      where: { chapterId, language },
      include: { audioFile: true },
      orderBy: { index: 'asc' }
    })
    // The old timelines were measured on the old audio.
    await removeAlignmentDocument(folderPath, language)
    const aligning: string[] = []
    for (const { section, path: stagedPath, metadata } of staged) {
      const row = rows[section.index]
      const dest = path.join(audioDir, `section_${String(section.index + 1).padStart(2, '0')}.${section.format}`)
      // Kept in backup/ as when audio is generated again.
      await backupAudioFile(dest)
      if (row.audioFile) {
        if (row.audioFile.filePath !== dest) await backupAudioFile(row.audioFile.filePath)
        await prisma.audioFile.delete({ where: { id: row.audioFile.id } }).catch(() => {})
      }
      await fs.rename(stagedPath, dest)
      await prisma.audioFile.create({
        data: {
          chapterId,
          sectionId: row.id,
          language,
          kind: 'generated',
          provider: voiceover.provider ?? 'sleeper-cell',
          model: voiceover.model,
          voice: voiceover.voice,
          filePath: dest,
          format: section.format,
          durationMs: metadata.durationMs,
          sampleRate: metadata.sampleRate,
          bytes: metadata.bytes,
          status: 'done'
        }
      })
      await prisma.audioSection.update({ where: { id: row.id }, data: { status: 'done', error: null, timelineScript: null } })
      aligning.push(row.id)
    }
    // A timeline authored against the old audio must not survive a re-voice.
    // Keep a newer empty row so browser caches also discard their old paste.
    const timelineWhere = { chapterId_language: { chapterId, language } }
    const previousTimeline = await prisma.editor2Timeline.findUnique({ where: timelineWhere })
    if (previousTimeline?.json.trim()) {
      const backupDir = path.join(audioDir, 'backup')
      await fs.mkdir(backupDir, { recursive: true })
      await fs.writeFile(path.join(backupDir, `editor-timeline-${Date.now()}.json`), previousTimeline.json, 'utf-8')
    }
    const updatedAt = new Date(Math.max(Date.now(), (previousTimeline?.updatedAt.getTime() ?? 0) + 1))
    await prisma.editor2Timeline.upsert({
      where: timelineWhere,
      create: { chapterId, language, json: '', processedJson: null, updatedAt },
      update: { json: '', processedJson: null, updatedAt }
    })
    // Queued once every section is attached, so the last one to finish writes the document.
    for (const id of aligning) alignSectionInBackground(id, io)
    return !sameSplits
  } finally {
    await fs.rm(staging, { recursive: true, force: true })
  }
}

// ============ Finding the zips ============

interface ListedZip {
  key: string
  /** The key's file name without `.zip`: `<Chapter>`, or `<Chapter>.hi` for Hinglish (see zipChapter). */
  base: string
  etag: string
  size: number
  uploadedAt: string | null
}

/**
 * Which chapter and language a zip in the series folder is for, from its file
 * name without `.zip`: `<Chapter>.hi` is that chapter's Hinglish voiceover,
 * anything else an English one. The only ambiguous name is a chapter folder
 * that itself ends in `.hi`; it is read as English when that folder exists and
 * the name without `.hi` doesn't.
 */
export function zipChapter(base: string, chapterFolders: Set<string>): { folder: string; language: NarrationLanguage } {
  if (base.endsWith('.hi')) {
    const stripped = base.slice(0, -'.hi'.length)
    if (!(chapterFolders.has(base) && !chapterFolders.has(stripped))) return { folder: stripped, language: 'hi' }
  }
  return { folder: base, language: 'en' }
}

/** Where each series' zips were found last time, so a re-run tries that folder first. */
const foundFolders = new Map<string, string>()

async function listFolder(client: S3Client, config: R2Config, folder: string): Promise<ListedZip[]> {
  const zips: ListedZip[] = []
  let token: string | undefined
  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: config.bucket,
      Prefix: folder,
      ContinuationToken: token
    }))
    for (const obj of page.Contents ?? []) {
      const rest = obj.Key?.slice(folder.length) ?? ''
      // Only `<Chapter>.zip` directly in the folder.
      if (obj.Size === 0 || !rest.toLowerCase().endsWith('.zip') || rest.includes('/')) continue
      zips.push({
        key: obj.Key!,
        base: rest.slice(0, -'.zip'.length),
        etag: (obj.ETag ?? '').replace(/"/g, ''),
        size: obj.Size ?? 0,
        uploadedAt: obj.LastModified?.toISOString() ?? null
      })
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (token)
  return zips
}

/** The phone uploads under its own prefix setting, which may not match ours, so the bucket root is tried too. */
async function listSeriesZips(client: S3Client, config: R2Config, seriesId: string, seriesName: string): Promise<ListedZip[]> {
  const rel = `${VOICEOVER_FOLDER}${seriesName}/`
  const candidates = [...new Set([`${config.prefix}${rel}`, rel])]
  const last = foundFolders.get(seriesId)
  if (last) candidates.sort((a, b) => Number(b === last) - Number(a === last))

  for (const folder of candidates) {
    const zips = await listFolder(client, config, folder)
    if (zips.length > 0) {
      foundFolders.set(seriesId, folder)
      return zips
    }
  }
  foundFolders.delete(seriesId)
  return []
}

async function readMarker(audioDir: string): Promise<{ etag?: unknown; fetchedAt?: unknown } | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(audioDir, FETCH_MARKER), 'utf-8'))
  } catch {
    return null
  }
}

async function readMarkerEtag(audioDir: string): Promise<string | null> {
  const marker = await readMarker(audioDir)
  return typeof marker?.etag === 'string' ? marker.etag : null
}

/** When the chapter's voiceover in `language` was last fetched from the phone; null if never. */
export async function voiceoverFetchedAt(folderPath: string, language: NarrationLanguage): Promise<string | null> {
  const marker = await readMarker(path.join(chapterDir(folderPath), audioFolderName(language)))
  return typeof marker?.fetchedAt === 'string' ? marker.fetchedAt : null
}

// ============ Preview ============

interface SeriesZips {
  client: S3Client
  config: R2Config
  /** This language's zips, sorted by chapter folder. */
  zips: (ListedZip & { folder: string; language: NarrationLanguage })[]
  byFolder: Map<string, { id: string; number: number; folderPath: string }>
}

/** Lists the series' chapter zips in R2 in one language (one or two LISTs); null when R2 isn't set up. */
async function listLanguageZips(seriesId: string, language: NarrationLanguage): Promise<SeriesZips | null> {
  const config = getR2Config()
  if (!config) return null
  const series = await prisma.series.findUnique({
    where: { id: seriesId },
    select: {
      rootFolder: true,
      chapters: { select: { id: true, number: true, folderPath: true }, orderBy: { number: 'asc' } }
    }
  })
  if (!series) throw new Error('Series not found')

  const client = createClient(config)
  const byFolder = new Map(series.chapters.map(c => [path.basename(c.folderPath), c]))
  const folders = new Set(byFolder.keys())
  // The other language's zips share the folder; they are not this fetch's.
  const zips = (await listSeriesZips(client, config, seriesId, path.basename(series.rootFolder)))
    .map(zip => ({ ...zip, ...zipChapter(zip.base, folders) }))
    .filter(zip => zip.language === language)
    .sort((a, b) => a.folder.localeCompare(b.folder, undefined, { numeric: true }))
  return { client, config, zips, byFolder }
}

/** What a fetch would bring in `language`, from the LIST alone: nothing is downloaded. */
export async function previewPhoneVoiceover(seriesId: string, language: NarrationLanguage = 'en'): Promise<PhoneVoiceoverPreview> {
  const listed = await listLanguageZips(seriesId, language)
  if (!listed) return { configured: false, chapters: [], unmatched: [] }

  const chapters: PhoneVoiceoverPreviewChapter[] = []
  const unmatched: string[] = []
  for (const zip of listed.zips) {
    const chapter = listed.byFolder.get(zip.folder)
    if (!chapter) {
      unmatched.push(zip.folder)
      continue
    }
    const attached = await readMarkerEtag(path.join(chapterDir(chapter.folderPath), audioFolderName(language)))
    chapters.push({
      chapterId: chapter.id,
      number: chapter.number,
      folder: zip.folder,
      state: !attached ? 'new' : zip.etag && attached === zip.etag ? 'same' : 'changed',
      bytes: zip.size,
      uploadedAt: zip.uploadedAt
    })
  }
  return { configured: true, chapters, unmatched }
}

// ============ Fetch ============

/** Series being fetched, so two runs can't attach the same chapter at once. */
const fetching = new Set<string>()

/**
 * Downloads and attaches every chapter voiceover in `language` the phone has
 * uploaded for this series that isn't attached yet (or was re-uploaded since).
 * `chapterIds` narrows it to those chapters. A chapter that fails is reported
 * and the rest carry on. `onProgress` hears each chapter as it starts.
 */
export async function fetchPhoneVoiceover(
  seriesId: string,
  chapterIds?: string[],
  io?: Server | null,
  language: NarrationLanguage = 'en',
  onProgress?: VoiceoverFetchProgress,
  options: { requireMatchingScript?: boolean } = {}
): Promise<PhoneVoiceoverFetch> {
  const result: PhoneVoiceoverFetch = { configured: false, found: 0, fetched: [], upToDate: 0, unmatched: [], failed: [] }
  if (!getR2Config()) return result
  result.configured = true
  const lock = `${seriesId}:${language}`
  if (fetching.has(lock)) throw new Error('A fetch for this series is already running')
  fetching.add(lock)

  try {
    const listed = await listLanguageZips(seriesId, language)
    if (!listed) return { ...result, configured: false }
    const { client, config, zips, byFolder } = listed
    return await withSeriesMutation(path.basename(path.dirname([...byFolder.values()][0]?.folderPath ?? '_/_')), async () => {
    result.found = zips.length

    const wanted = chapterIds ? new Set(chapterIds) : null
    // Matched, wanted and not attached from this very zip already.
    const todo: { zip: (typeof zips)[number]; chapter: { id: string; number: number; folderPath: string }; audioDir: string }[] = []
    for (const zip of zips) {
      const chapter = byFolder.get(zip.folder)
      if (!chapter) {
        result.unmatched.push(zip.folder)
        continue
      }
      if (wanted && !wanted.has(chapter.id)) continue

      const audioDir = path.join(chapterDir(chapter.folderPath), audioFolderName(language))
      if (zip.etag && (await readMarkerEtag(audioDir)) === zip.etag) {
        result.upToDate++
        continue
      }
      todo.push({ zip, chapter, audioDir })
    }

    for (const [i, { zip, chapter, audioDir }] of todo.entries()) {
      onProgress?.({ chapterNumber: chapter.number, current: i + 1, total: todo.length })
      let managerObjectVersion: string | null = null
      try {
        if (zip.size > MAX_ZIP_BYTES) throw new Error(`The zip is unexpectedly large (${zip.size} bytes)`)
        const res = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: zip.key }))
        const body = Buffer.from(await res.Body!.transformToByteArray())
        if (body.length > MAX_ZIP_BYTES) throw new Error(`The zip is unexpectedly large (${body.length} bytes)`)
        managerObjectVersion = res.VersionId ?? res.ETag ?? zip.etag ?? null
        recordManagerTransfer({ seriesId,chapterId:chapter.id,stage:`voice_${language}`,phase:'cloud',objectVersion:managerObjectVersion })
        const voiceover = parseVoiceoverZip(readZip(body, {
          maxEntryBytes: MAX_ZIP_BYTES,
          maxTotalBytes: MAX_ZIP_BYTES
        }), language)
        await requireSeriesRestartReady(path.dirname(chapter.folderPath).split(path.sep).at(-1)!, voiceover.restartRevision, true)
        const replacement = await fs.readFile(path.join(chapterDir(chapter.folderPath), `.script-replacement${language === 'hi' ? '.hi' : ''}.json`), 'utf-8')
          .then(text => JSON.parse(text) as { sha256?: string }).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e })
        if (replacement?.sha256 && replacement.sha256 !== voiceover.scriptSha256) {
          throw new Error('The phone voiceover is from before the script replacement. Generate and upload the new voiceover first.')
        }
        // Automatic fetches attach only audio made from the script this chapter has here.
        if (options.requireMatchingScript && (await scriptMatches(chapter.folderPath, voiceover.scriptSha256, language)) !== true) {
          throw new Error('The phone voiceover was made from a different script than this chapter has here. Fetch it from Narration to decide.')
        }
        const resplit = await attachVoiceover(chapter.id, chapter.folderPath, voiceover, io, language)
        const marker = {
          key: zip.key,
          etag: (res.ETag ?? zip.etag).replace(/"/g, ''),
          fetchedAt: new Date().toISOString(),
          sections: voiceover.sections.length,
          voice: voiceover.voice,
          style: voiceover.style,
          scriptSha256: voiceover.scriptSha256
        }
        await fs.writeFile(path.join(audioDir, FETCH_MARKER), JSON.stringify(marker, null, 2) + '\n', 'utf-8')
        recordManagerTransfer({ seriesId,chapterId:chapter.id,stage:`voice_${language}`,phase:'imported',objectVersion:managerObjectVersion })
        result.fetched.push({
          chapterId: chapter.id,
          chapterNumber: chapter.number,
          folder: zip.folder,
          sections: voiceover.sections.length,
          resplit,
          scriptMatches: await scriptMatches(chapter.folderPath, voiceover.scriptSha256, language)
        })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        recordManagerTransfer({ seriesId,chapterId:chapter.id,stage:`voice_${language}`,phase:'failed',objectVersion:managerObjectVersion })
        console.error(`[voiceover] fetching ${zip.key} failed:`, reason)
        result.failed.push({ folder: zip.folder, reason })
      }
    }

    return result
    })
  } finally {
    fetching.delete(lock)
  }
}
