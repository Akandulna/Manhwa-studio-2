import fs from 'fs/promises'
import path from 'path'
import { createHash } from 'crypto'
import { getSourceFolderPath, readImagePoints } from './clipper3/perImageStore.js'

export const RETAINED_METADATA_FILE = '.retained-metadata.json'
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const hash = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s)

/** Explicit reuse binds unchanged original metadata/geometry to this narration and restart.
 * It preserves the historical paragraph index; it never calls those links newly generated. */
export async function retainedMetadataApproval(chapter: {folderPath: string}, restartRevision: string | null, metadata: string) {
  try {
    const dir = getSourceFolderPath(chapter.folderPath)
    const record = JSON.parse(await fs.readFile(path.join(dir, RETAINED_METADATA_FILE), 'utf8'))
    const english = (await fs.readFile(path.join(dir, 'script.md'), 'utf8')).replace(/\r\n/g, '\n').trim()
    if (record.schema !== 'retained-crop-metadata/1' || record.restartRevision !== restartRevision ||
        !Number.isFinite(Date.parse(record.approvedAt)) || !english || record.currentEnglishScriptSha256 !== sha(english) ||
        record.metadataSha256 !== sha(metadata) || !hash(record.sourceScriptSha256)) return null
    const pages = [...metadata.matchAll(/^## ([^\n]+)\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)]
    if (!pages.length || !record.pointers || Object.keys(record.pointers).length !== pages.length) return null
    const seen = new Set<string>()
    for (const match of pages) {
      const page = match[1].trim(), value = JSON.parse(match[2])
      if (!page || path.basename(page) !== page || page.startsWith('.') || seen.has(page) || value.metadataJob ||
          value.storyLinking?.scriptSha256 !== record.sourceScriptSha256) return null
      seen.add(page)
      const points = await readImagePoints(chapter.folderPath, page)
      if (!points?.file || points.file.workflow === 'clipper-geometry/1' || record.pointers[page] !== sha(points.text)) return null
    }
    return { schema: 'retained-story-links/1', currentEnglishScriptSha256: record.currentEnglishScriptSha256 as string,
      sourceScriptSha256: record.sourceScriptSha256 as string }
  } catch { return null }
}
