import fs from 'fs/promises'
import path from 'path'
import { createHash } from 'crypto'
import { getSourceFolderPath } from './clipper3/perImageStore.js'
import { readEffectiveReview } from './clipper3/chapterReview.js'
import { getChapterBlockers } from './videoEditor2Service.js'

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
/** Publish the exact reviewed/cropped inventory, never a phone's intermediate clipping state. */
export async function editorFinalCrops(chapter: { id: string; folderPath: string }, language: 'en' | 'hi', metadata: string, images: string[]) {
  const blockers = await getChapterBlockers(chapter.id, language)
  if (blockers === null || blockers.length || !(await readEffectiveReview(chapter.folderPath)).reviewed)
    throw new Error('Editor requires final reviewed and cropped JSON. Finish review/cropping before sending this chapter.')
  const pages: { filename: string; sourceSha256: string; inputRevision: string; redoRevision: string | null }[] = []
  const names = new Set<string>()
  for (const match of metadata.matchAll(/^## ([^\n]+)\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)) {
    const filename = match[1].trim()
    if (!filename || filename.startsWith('.') || /[/\\]/.test(filename) || pages.some(p => p.filename === filename)) throw new Error('Invalid final crop page identity')
    const page = JSON.parse(match[2]), header = page.storyLinking
    const sourceSha256 = sha256(await fs.readFile(path.join(getSourceFolderPath(chapter.folderPath), filename)))
    if (!Array.isArray(page.crops) || (!header && language === 'en') || (header &&
        (!/^[a-f0-9]{64}$/.test(header.sourceSha256 ?? '') || !/^[a-f0-9]{64}$/.test(header.inputRevision ?? ''))))
      throw new Error('Final crop metadata needs complete source and input revisions')
    if (header && sourceSha256 !== header.sourceSha256) throw new Error('Final crops belong to changed source images')
    for (const crop of page.crops) {
      if (typeof crop.exportedFilename !== 'string' || !crop.description?.trim() || names.has(crop.exportedFilename)) throw new Error('Invalid final crop inventory')
      names.add(crop.exportedFilename)
    }
    pages.push({ filename, sourceSha256, inputRevision: header?.inputRevision ?? sha256(match[2].trim()), redoRevision: typeof page.studioRedoRevision === 'string' ? page.studioRedoRevision : null })
  }
  if (!pages.length || !images.length || names.size !== images.length || new Set(images).size !== images.length || images.some(name => !names.has(name))) throw new Error('Final crop metadata and cropped image inventory differ')
  return { schema: 'studio-final-editor-crops/1', metadataSha256: sha256(metadata), imagesSha256: sha256(images.join('\0')), pages }
}
