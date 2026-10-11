/**
 * Voiceover Service
 *
 * The Sleeper-Cell phones split the scripts and voice them; the desktop only
 * attaches what they upload (see phoneVoiceoverImport.ts). What's left here is
 * what that attach needs:
 * - replacing a chapter's sections with the phone's splits
 * - keeping a backup of audio before it's overwritten
 */

import fs from 'fs/promises'
import path from 'path'
import { prisma } from '../index.js'
import type { NarrationLanguage } from './narrationLanguage.js'

/**
 * Backup an audio file before overwriting
 * Saves to: backup/ next to the file (chapter_folder/audio/backup/ for English)
 */
export async function backupAudioFile(filePath: string): Promise<void> {
  try {
    // Check if file exists
    await fs.access(filePath)

    // Create backup folder
    const backupFolder = path.join(path.dirname(filePath), 'backup')
    await fs.mkdir(backupFolder, { recursive: true })

    // Generate backup filename with timestamp
    const originalName = path.basename(filePath)
    const ext = path.extname(originalName)
    const baseName = path.basename(originalName, ext)
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupName = `${baseName}_${timestamp}${ext}`
    const backupPath = path.join(backupFolder, backupName)

    // Copy file to backup
    await fs.copyFile(filePath, backupPath)
    console.log(`Backed up audio: ${backupPath}`)
  } catch (error) {
    // Silently fail if file doesn't exist or backup fails
    console.log(`Backup skipped: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}

export interface AudioSection {
  id: string
  index: number
  text: string
  status: string
}

/**
 * Replace a chapter's sections (in one language) with these.
 *
 * Destructive: replaces every existing section. Because AudioFile.sectionId is
 * `onDelete: SetNull`, deleting sections would otherwise leave orphaned
 * per-section audio rows (and their .wav files) behind, so they are removed
 * first. Chapter-level joined audio (sectionId = null) is left untouched.
 */
export async function initializeSections(
  chapterId: string,
  sections: { index: number; text: string }[],
  language: NarrationLanguage = 'en'
): Promise<AudioSection[]> {
  // Drop per-section audio files that are about to lose their section
  const staleAudio = await prisma.audioFile.findMany({
    where: { chapterId, language, sectionId: { not: null } }
  })

  for (const audio of staleAudio) {
    try {
      await fs.unlink(audio.filePath)
    } catch (err: any) {
      // Already gone is fine; anything else is worth knowing about but must not
      // block the re-split.
      if (err?.code !== 'ENOENT') {
        console.warn(`Could not delete stale audio ${audio.filePath}:`, err?.message)
      }
    }
  }

  if (staleAudio.length > 0) {
    await prisma.audioFile.deleteMany({
      where: { id: { in: staleAudio.map(a => a.id) } }
    })
  }

  // Delete existing sections (this language only — the other keeps its own)
  await prisma.audioSection.deleteMany({
    where: { chapterId, language }
  })

  // Create new sections
  const createdSections = await Promise.all(
    sections.map(section =>
      prisma.audioSection.create({
        data: {
          chapterId,
          language,
          index: section.index,
          text: section.text,
          status: 'pending'
        }
      })
    )
  )

  return createdSections.map(s => ({
    id: s.id,
    index: s.index,
    text: s.text,
    status: s.status
  }))
}
