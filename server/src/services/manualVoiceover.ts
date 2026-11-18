/**
 * A voiceover added by hand in Narration, instead of fetched from a phone.
 *
 * One audio file voices the whole chapter. It becomes the chapter's only
 * section in that language, whose text is the script flattened to one line —
 * exactly what the phone's full-script mode makes (VoiceoverMode.FULL_SCRIPT),
 * so alignment, the alignment document and Editor 2.0 treat it like any phone
 * voiceover. Attaching goes through attachVoiceover: the file is checked with
 * ffprobe before anything changes, the old audio and Editor timeline are
 * backed up, and the section is queued for alignment.
 *
 * The audio folder's fetch marker is rewritten with `manual: true` and the
 * script's hash (Editor sends read it) but no R2 ETag, so a later "Fetch from
 * phone" offers the phone's own voiceover again instead of calling it
 * attached. Automatic phone fetches never touch it: they only fill chapters
 * that have no sections.
 */

import crypto from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import type { Server } from 'socket.io'
import { prisma } from '../index.js'
import { AUDIO_EXTENSIONS, FETCH_MARKER, attachVoiceover, type PhoneVoiceoverChapter } from './phoneVoiceoverImport.js'
import { withSeriesMutation } from './seriesActivity.js'
import { requireSeriesRestartReady } from './seriesRestartGuard.js'
import { LANGUAGE_NAMES, audioFolderName, scriptFileName, type NarrationLanguage } from './narrationLanguage.js'

/** As a phone chapter zip may carry: a full-chapter WAV fits comfortably. */
export const MAX_MANUAL_VOICEOVER_BYTES = 512 * 1024 * 1024

export class ManualVoiceoverError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

/** The script on one line, as the phone's VoiceoverText.flatten (JavaScript's `\s`). */
export function flattenScript(script: string): string {
  return script.replace(/\s+/g, ' ').trim()
}

export interface ManualVoiceoverResult {
  sections: number
  /** The chapter's sections were replaced by the one full-script section. */
  resplit: boolean
}

export async function addManualVoiceover(
  chapterId: string,
  language: NarrationLanguage,
  file: { name: string; data: Buffer },
  io?: Server | null
): Promise<ManualVoiceoverResult> {
  const chapter = await prisma.chapter.findUnique({ where: { id: chapterId }, select: { folderPath: true } })
  if (!chapter) throw new ManualVoiceoverError('Chapter not found', 404)

  const format = path.extname(file.name).slice(1).toLowerCase()
  if (!AUDIO_EXTENSIONS.has(format)) {
    throw new ManualVoiceoverError(`Choose an audio file (${[...AUDIO_EXTENSIONS].join(', ')}).`)
  }
  if (file.data.length === 0) throw new ManualVoiceoverError('The audio file is empty.')

  const dir = path.join(process.env.DOWNLOAD_ROOT || './downloads', chapter.folderPath)
  const script = await fs.readFile(path.join(dir, scriptFileName(language))).catch(() => null)
  const text = script ? flattenScript(script.toString('utf-8')) : ''
  if (!script || !text) {
    throw new ManualVoiceoverError(`This chapter has no ${LANGUAGE_NAMES[language]} script yet. Add the script first, then its voiceover.`)
  }
  const scriptSha256 = crypto.createHash('sha256').update(script).digest('hex')

  const voiceover: PhoneVoiceoverChapter = {
    provider: 'manual',
    model: null,
    voice: null,
    style: null,
    scriptSha256,
    sections: [{ index: 0, text, file: `section_01.${format}`, format, data: file.data }]
  }

  const seriesFolder = path.basename(path.dirname(chapter.folderPath))
  return withSeriesMutation(seriesFolder, async () => {
    await requireSeriesRestartReady(seriesFolder)
    const resplit = await attachVoiceover(chapterId, chapter.folderPath, voiceover, io, language, { kind: 'uploaded' })
    const marker = { manual: true, fileName: file.name, fetchedAt: new Date().toISOString(), sections: 1, scriptSha256 }
    await fs.writeFile(path.join(dir, audioFolderName(language), FETCH_MARKER), JSON.stringify(marker, null, 2) + '\n', 'utf-8')
    return { sections: 1, resplit }
  })
}
