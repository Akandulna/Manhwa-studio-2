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
 * them.
 *
 * R2 cost per fetch: one or two LISTs (Class A), plus one GET (Class B) per
 * chapter whose zip changed. A marker file in each chapter's audio folder
 * remembers the ETag it was attached from, so a re-run downloads nothing new.
 * Nothing here runs on a timer; only the Fetch button calls it.
 */

import crypto from 'crypto'
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
import { audioFolderName, scriptFileName, type NarrationLanguage } from './narrationLanguage.js'

/** Folder the phone uploads chapter zips to, inside its R2 prefix. Keep in step with FOLDER in VoiceoverUpload.kt. */
export const VOICEOVER_FOLDER = 'voiceover/'

/** In each chapter's audio folder: which R2 zip its sections were attached from. */
export const FETCH_MARKER = '.r2-voiceover.json'

const MANIFEST_FILE = 'voiceover.json'
const SCHEMA = /^sleeper-cell-voiceover-chapter\/1\./

/** A chapter of 500-character splits is a few dozen MB of WAV; anything far bigger is not one of ours. */
const MAX_ZIP_BYTES = 512 * 1024 * 1024

/** What the desktop accepts as uploaded section audio (see uploadSectionAudio). */
const AUDIO_EXTENSIONS = new Set(['wav', 'mp3', 'ogg', 'flac', 'aac', 'm4a', 'opus', 'weba'])

/** The phone only voices English scripts. */
const LANGUAGE: NarrationLanguage = 'en'

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
  provider: string | null
  model: string | null
  voice: string | null
  style: string | null
  /** SHA-256 of the script.md the phone split, to tell whether the desktop has the same script. */
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
  /** Whether the desktop's script.md is the one the phone split; null when either side doesn't say. */
  scriptMatches: boolean | null
}

export interface PhoneVoiceoverFetch {
  /** False when R2 is not set up; nothing was looked at. */
  configured: boolean
  /** Chapter zips in R2 for this series (every one is a fully voiced chapter). */
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
 * Throws when the manifest is missing or malformed, the sections aren't
 * numbered 0, 1, 2… in order, or a section's audio isn't in the zip.
 */
export function parseVoiceoverZip(entries: ZipEntry[]): PhoneVoiceoverChapter {
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
  if ((manifest.language ?? LANGUAGE) !== LANGUAGE) {
    throw new Error(`Only English voiceovers can be fetched (this one is "${manifest.language}")`)
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

/** Whether the desktop's script.md is byte for byte the one the phone split. */
async function scriptMatches(folderPath: string, sha256: string | null): Promise<boolean | null> {
  if (!sha256) return null
  try {
    const script = await fs.readFile(path.join(chapterDir(folderPath), scriptFileName(LANGUAGE)))
    return crypto.createHash('sha256').update(script).digest('hex') === sha256
  } catch {
    return null
  }
}

/**
 * Makes the phone's splits the chapter's English sections and attaches their
 * audio. Every file is written and checked with ffprobe before anything in the
 * database changes, so a bad zip leaves the chapter as it was. Returns whether
 * the sections had to be replaced.
 */
export async function attachVoiceover(
  chapterId: string,
  folderPath: string,
  voiceover: PhoneVoiceoverChapter,
  io?: Server | null
): Promise<boolean> {
  const audioDir = path.join(chapterDir(folderPath), audioFolderName(LANGUAGE))
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
      where: { chapterId, language: LANGUAGE },
      orderBy: { index: 'asc' }
    })
    const sameSplits = existing.length === voiceover.sections.length &&
      existing.every((s, i) => s.index === i && s.text === voiceover.sections[i].text)
    if (!sameSplits) {
      await initializeSections(chapterId, voiceover.sections.map(({ index, text }) => ({ index, text })), LANGUAGE)
    }

    const rows = await prisma.audioSection.findMany({
      where: { chapterId, language: LANGUAGE },
      include: { audioFile: true },
      orderBy: { index: 'asc' }
    })
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
          language: LANGUAGE,
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
      await prisma.audioSection.update({ where: { id: row.id }, data: { status: 'done', error: null } })
      alignSectionInBackground(row.id, io)
    }
    return !sameSplits
  } finally {
    await fs.rm(staging, { recursive: true, force: true })
  }
}

// ============ Finding the zips ============

interface ListedZip {
  key: string
  /** Chapter folder name: the key's file name without `.zip`. */
  folder: string
  etag: string
  size: number
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
      if (!rest.toLowerCase().endsWith('.zip') || rest.includes('/')) continue
      zips.push({
        key: obj.Key!,
        folder: rest.slice(0, -'.zip'.length),
        etag: (obj.ETag ?? '').replace(/"/g, ''),
        size: obj.Size ?? 0
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

async function readMarkerEtag(audioDir: string): Promise<string | null> {
  try {
    const marker = JSON.parse(await fs.readFile(path.join(audioDir, FETCH_MARKER), 'utf-8'))
    return typeof marker?.etag === 'string' ? marker.etag : null
  } catch {
    return null
  }
}

// ============ Fetch ============

/** Series being fetched, so two runs can't attach the same chapter at once. */
const fetching = new Set<string>()

/**
 * Downloads and attaches every chapter voiceover the phone has uploaded for
 * this series that isn't attached yet (or was re-uploaded since). `chapterIds`
 * narrows it to those chapters. A chapter that fails is reported and the rest
 * carry on.
 */
export async function fetchPhoneVoiceover(seriesId: string, chapterIds?: string[], io?: Server | null): Promise<PhoneVoiceoverFetch> {
  const result: PhoneVoiceoverFetch = { configured: false, found: 0, fetched: [], upToDate: 0, unmatched: [], failed: [] }
  const config = getR2Config()
  if (!config) return result
  result.configured = true
  if (fetching.has(seriesId)) throw new Error('A fetch for this series is already running')
  fetching.add(seriesId)

  try {
    const series = await prisma.series.findUnique({
      where: { id: seriesId },
      select: {
        rootFolder: true,
        chapters: { select: { id: true, number: true, folderPath: true }, orderBy: { number: 'asc' } }
      }
    })
    if (!series) throw new Error('Series not found')

    const client = createClient(config)
    const zips = await listSeriesZips(client, config, seriesId, path.basename(series.rootFolder))
    result.found = zips.length

    const wanted = chapterIds ? new Set(chapterIds) : null
    const byFolder = new Map(series.chapters.map(c => [path.basename(c.folderPath), c]))
    zips.sort((a, b) => a.folder.localeCompare(b.folder, undefined, { numeric: true }))

    for (const zip of zips) {
      const chapter = byFolder.get(zip.folder)
      if (!chapter) {
        result.unmatched.push(zip.folder)
        continue
      }
      if (wanted && !wanted.has(chapter.id)) continue

      const audioDir = path.join(chapterDir(chapter.folderPath), audioFolderName(LANGUAGE))
      if (zip.etag && (await readMarkerEtag(audioDir)) === zip.etag) {
        result.upToDate++
        continue
      }

      try {
        if (zip.size > MAX_ZIP_BYTES) throw new Error(`The zip is unexpectedly large (${zip.size} bytes)`)
        const res = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: zip.key }))
        const body = Buffer.from(await res.Body!.transformToByteArray())
        const voiceover = parseVoiceoverZip(readZip(body))
        const resplit = await attachVoiceover(chapter.id, chapter.folderPath, voiceover, io)
        const marker = {
          key: zip.key,
          etag: (res.ETag ?? zip.etag).replace(/"/g, ''),
          fetchedAt: new Date().toISOString(),
          sections: voiceover.sections.length,
          voice: voiceover.voice,
          style: voiceover.style
        }
        await fs.writeFile(path.join(audioDir, FETCH_MARKER), JSON.stringify(marker, null, 2) + '\n', 'utf-8')
        result.fetched.push({
          chapterId: chapter.id,
          chapterNumber: chapter.number,
          folder: zip.folder,
          sections: voiceover.sections.length,
          resplit,
          scriptMatches: await scriptMatches(chapter.folderPath, voiceover.scriptSha256)
        })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        console.error(`[voiceover] fetching ${zip.key} failed:`, reason)
        result.failed.push({ folder: zip.folder, reason })
      }
    }

    return result
  } finally {
    fetching.delete(seriesId)
  }
}
