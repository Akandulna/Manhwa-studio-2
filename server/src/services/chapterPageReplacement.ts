import fs from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'

/** Travels inside the page ZIP; the same revision identifies subsequent crop uploads. */
export const PAGE_REPLACEMENT_FILE = '.page-replacement.json'
export interface PageReplacement {
  schema: 'manhwa-page-replacement/1'
  revision: string
  replacedAt: string
}

const replacing = new Set<string>()
export const pageReplacementActive = (folderPath: string) => replacing.has(folderPath)
export const beginPageReplacement = (folderPath: string) => replacing.add(folderPath)
export const endPageReplacement = (folderPath: string) => replacing.delete(folderPath)

export function newPageReplacement(): PageReplacement {
  return { schema: 'manhwa-page-replacement/1', revision: randomUUID(), replacedAt: new Date().toISOString() }
}

function chapterDir(folderPath: string): string {
  const root = path.resolve(process.env.DOWNLOAD_ROOT || './downloads')
  const dir = path.resolve(root, folderPath)
  if (!dir.startsWith(root + path.sep)) throw new Error('Invalid chapter folder')
  return dir
}

export async function readPageReplacement(folderPath: string): Promise<PageReplacement | null> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(chapterDir(folderPath), PAGE_REPLACEMENT_FILE), 'utf-8'))
    if (value.schema !== 'manhwa-page-replacement/1' || !/^[a-f0-9-]{36}$/.test(value.revision) || !Number.isFinite(Date.parse(value.replacedAt))) {
      throw new Error('Invalid page replacement record')
    }
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Old/offline phones must not restore crop JSON made against a previous set of pages. */
export function matchesPageRevision(replacement: PageReplacement | null, revision: unknown): boolean {
  return !replacement || revision === replacement.revision
}

/** Discard pre-replacement crop facts before devices' receipts are merged. */
export async function filterReplacedCropFacts<T extends object>(body: T): Promise<T> {
  const value = body as Record<string, any>
  if (!value.series || typeof value.series !== 'object') return body
  const series = { ...value.series }
  let changed = false
  for (const [folder, entry] of Object.entries<any>(series)) {
    if (!entry?.chapters || typeof entry.chapters !== 'object' || !safe(folder)) continue
    const chapters = { ...entry.chapters }
    let reset = false
    for (const [name, chapter] of Object.entries<any>(chapters)) {
      if (!safe(name) || !chapter || typeof chapter !== 'object') continue
      const replacement = await readPageReplacement(path.join(folder, name))
      if (!matchesPageRevision(replacement, chapter.pageRevision)) {
        chapters[name] = { total: chapter.total, done: 0, pages: {}, pageRevision: replacement!.revision }
        reset = changed = true
      }
    }
    if (reset) series[folder] = { ...entry, chapters, done: Object.values<any>(chapters).reduce((sum, c) => sum + (Number(c?.done) || 0), 0) }
  }
  return changed ? { ...body, series } : body
}

const safe = (value: string) => !!value && !value.startsWith('.') && !/[/\\\0]/.test(value)

/** Back up clipping only. Scripts, voiceover, alignment and source page files are never moved. */
export async function resetChapterClipping(folderPath: string, replacement: PageReplacement): Promise<void> {
  if ((await readPageReplacement(folderPath))?.revision === replacement.revision) return
  const dir = chapterDir(folderPath)
  const seriesDir = path.dirname(dir)
  const backup = path.join(dir, '.page-replacements', replacement.revision)
  const artifacts = [
    ['points', path.join(dir, 'crop_points3')],
    ['metadata', path.join(dir, 'crop_metadata3')],
    ['crops', path.join(dir, 'crops3')],
    ['review', path.join(dir, '.clipper3-review.json')],
    ['processed', path.join(seriesDir, 'Processed', path.basename(dir))],
    ['slices', path.join(seriesDir, path.basename(seriesDir), path.basename(dir), 'slices3')]
  ]
  await fs.mkdir(backup, { recursive: true })
  for (const [name, source] of artifacts) {
    try { await fs.rename(source, path.join(backup, name)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  const temp = path.join(dir, `${PAGE_REPLACEMENT_FILE}.tmp`)
  await fs.writeFile(temp, JSON.stringify(replacement))
  await fs.rename(temp, path.join(dir, PAGE_REPLACEMENT_FILE))
}
