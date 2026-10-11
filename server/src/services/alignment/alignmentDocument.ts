/**
 * Alignment document — a chapter's whole "Script with Timeline" on disk.
 *
 * Alignment stores one timeline per voiceover section (AudioSection.timelineScript).
 * Once every section of a chapter in a language has one, they are joined in
 * section order and written to `<library root>/<chapter folder>/script-timeline.md`
 * (`script-timeline.hi.md` for Hindi, see alignmentFileName). Editor 2.0's
 * checklist looks for that file, so it only exists while it is complete: a
 * chapter whose sections lose a timeline (new audio fetched from the phone, a
 * re-split) has its document removed until alignment finishes again.
 *
 * The layout matches Editor 2.0's chapter timeline bundle: a `## Section N`
 * heading per section, blank lines between.
 */

import fs from 'fs/promises'
import path from 'path'
import { prisma } from '../../index.js'
import { NARRATION_LANGUAGES, alignmentFileName, type NarrationLanguage } from '../narrationLanguage.js'
import { queueEditorPublish } from '../editorAutoPublish.js'

function chapterDir(folderPath: string): string {
  return path.join(process.env.DOWNLOAD_ROOT || './downloads', folderPath)
}

export function alignmentDocumentPath(folderPath: string, language: NarrationLanguage): string {
  return path.join(chapterDir(folderPath), alignmentFileName(language))
}

/**
 * The document for these sections, or null while any section has no timeline
 * (or there are no sections at all).
 */
export function buildAlignmentDocument(
  sections: { index: number; timelineScript: string | null }[]
): string | null {
  if (sections.length === 0) return null
  const ordered = [...sections].sort((a, b) => a.index - b.index)
  if (!ordered.every(s => !!s.timelineScript?.trim())) return null
  return ordered.map(s => `## Section ${s.index + 1}\n\n${s.timelineScript!.trim()}`).join('\n\n') + '\n'
}

export async function hasAlignmentDocument(folderPath: string, language: NarrationLanguage): Promise<boolean> {
  try {
    await fs.access(alignmentDocumentPath(folderPath, language))
    return true
  } catch {
    return false
  }
}

export async function removeAlignmentDocument(folderPath: string, language: NarrationLanguage): Promise<void> {
  await fs.rm(alignmentDocumentPath(folderPath, language), { force: true })
}

/**
 * Writes the chapter's document when every section is aligned, and removes a
 * stale one when not. Returns whether the document exists afterwards.
 */
export async function writeAlignmentDocument(chapterId: string, language: NarrationLanguage): Promise<boolean> {
  const chapter = await prisma.chapter.findUnique({
    where: { id: chapterId },
    select: {
      folderPath: true,
      audioSections: { where: { language }, select: { index: true, timelineScript: true } }
    }
  })
  if (!chapter) return false

  const document = buildAlignmentDocument(chapter.audioSections)
  if (!document) {
    await removeAlignmentDocument(chapter.folderPath, language)
    return false
  }
  await fs.writeFile(alignmentDocumentPath(chapter.folderPath, language), document, 'utf-8')
  // The chapter may now be ready for its timeline JSON: Editor 2.0 sends it to the phone.
  queueEditorPublish(chapterId)
  return true
}

/**
 * Writes the missing document of every chapter that is already fully aligned
 * (chapters aligned before documents existed, or a file deleted by hand). Run
 * once at startup; touches nothing that already has its document.
 */
export async function backfillAlignmentDocuments(): Promise<number> {
  let written = 0
  for (const language of NARRATION_LANGUAGES) {
    const chapters = await prisma.chapter.findMany({
      where: { status: 'done', completedAt: null, audioSections: { some: { language } } },
      select: {
        folderPath: true,
        audioSections: { where: { language }, select: { index: true, timelineScript: true } }
      }
    })
    for (const chapter of chapters) {
      const document = buildAlignmentDocument(chapter.audioSections)
      if (!document || (await hasAlignmentDocument(chapter.folderPath, language))) continue
      try {
        await fs.writeFile(alignmentDocumentPath(chapter.folderPath, language), document, 'utf-8')
        written++
      } catch {
        // The chapter folder is gone (deleted by hand); disk reconcile deals with that.
      }
    }
  }
  return written
}

/** backfillAlignmentDocuments for startup: logs what it did, never throws. */
export function backfillAlignmentDocumentsQuietly(): void {
  backfillAlignmentDocuments()
    .then(n => { if (n > 0) console.log(`[alignment] wrote ${n} missing alignment document(s)`) })
    .catch(error => console.error('[alignment] backfilling alignment documents failed:', error instanceof Error ? error.message : error))
}
