import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { readManagedChapterAssets, managedChapterImage } from './managedChapterAssets.js'
import { getOutputDir, listOutputs } from './clipper3/perImageStore.js'
import { YouTubeTitleError } from './youtubeTitles.js'
export interface YouTubeCropChapter { id: string; number: number; folderPath: string }
const token = (value: string) => createHash('sha256').update(value).digest('hex')
export async function cropInventory(chapter: YouTubeCropChapter) {
  const managed = await readManagedChapterAssets(chapter.folderPath)
  const files = managed ? managed.assets.map(file => ({ filename: file.filename, bytes: file.bytes, stamp: '' })) : await Promise.all((await listOutputs(chapter.folderPath)).map(async file => ({ ...file, stamp: String((await fs.stat(path.join(getOutputDir(chapter.folderPath), file.filename))).mtimeMs) })))
  return { revision: managed?.revision ?? null, files: files.map(({ stamp, ...file }) => ({ ...file, id: token(`${chapter.id}\0${managed?.revision ?? stamp}\0${file.filename}\0${file.bytes}`), chapterId: chapter.id, label: `Chapter ${chapter.number} · ${file.filename}` })) }
}
export async function readYouTubeCrop(chapter: YouTubeCropChapter, id: string) {
  const inventory = await cropInventory(chapter)
  const crop = inventory.files.find(file => file.id === id)
  if (!crop) throw new YouTubeTitleError('This crop changed or is no longer available. Refresh the crop browser.')
  if (crop.bytes > 20 * 1024 * 1024) throw new YouTubeTitleError('Choose a crop up to 20 MB.')
  if (inventory.revision) return { buffer: await managedChapterImage(chapter.folderPath, inventory.revision, crop.filename), label: crop.label }
  const root = await fs.realpath(getOutputDir(chapter.folderPath))
  const target = await fs.realpath(path.join(root, crop.filename))
  if (path.dirname(target) !== root) throw new YouTubeTitleError('Crop is outside this chapter.')
  const stat = await fs.stat(target)
  if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new YouTubeTitleError('Crop unavailable or too large.')
  return { buffer: await fs.readFile(target), label: crop.label }
}
