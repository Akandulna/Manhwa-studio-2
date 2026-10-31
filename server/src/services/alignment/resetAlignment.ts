import fs from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'
import { prisma } from '../../index.js'
import { alignmentDocumentPath } from './alignmentDocument.js'
import type { NarrationLanguage } from '../narrationLanguage.js'

/** Save recoverable state before clearing one section and its dependent Editor timeline. */
export async function resetSectionAlignment(chapterId: string, sectionId: string, language: NarrationLanguage): Promise<void> {
  const section = await prisma.audioSection.findFirst({
    where: { id: sectionId, chapterId, language }, include: { audioFile: true, chapter: true }
  })
  if (!section?.audioFile || section.audioFile.status !== 'done') throw new Error('Choose a section with ready audio')
  await fs.access(path.resolve(section.audioFile.filePath))
  const where = { chapterId_language: { chapterId, language } }
  const timeline = await prisma.editor2Timeline.findUnique({ where })
  const documentPath = alignmentDocumentPath(section.chapter.folderPath, language)
  const backup = path.join(path.dirname(documentPath), '.alignment-resets', `${Date.now()}-${randomUUID()}`)
  await fs.mkdir(backup, { recursive: true })
  await fs.writeFile(path.join(backup, 'state.json'), JSON.stringify({ section, timeline }, null, 2))
  const document = await fs.readFile(documentPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (document) await fs.writeFile(path.join(backup, path.basename(documentPath)), document)
  // Remove the stale document before publishing any new state. Restore on a DB failure.
  await fs.rm(documentPath, { force: true })
  try {
    await prisma.$transaction(async tx => {
      await tx.audioSection.update({ where: { id: sectionId }, data: { timelineScript: null } })
      const updatedAt = new Date(Math.max(Date.now(), (timeline?.updatedAt.getTime() ?? 0) + 1))
      await tx.editor2Timeline.upsert({ where,
        create: { chapterId, language, json: '', processedJson: null, updatedAt },
        update: { json: '', processedJson: null, updatedAt } })
    })
  } catch (error) {
    if (document) await fs.writeFile(documentPath, document)
    throw error
  }
}
