import fs from 'fs/promises'
import path from 'path'
import { getChapterManifest } from './chapterManifest.js'
import { managedCropBindingCount } from './managedCropProjection.js'
import { currentMetadataJobs, metadataGenerations, validateMetadataResult } from './clipper3/metadataSplit.js'
import { expectedExportedFilenames, extractCrops, getSourceFolderPath, hasNoCrops, readImageMetadata, readImagePoints, validateMetadata } from './clipper3/perImageStore.js'
import type { MetadataChapterStatus, MetadataPageStatus } from './metadataLibraryModel.js'

export interface MetadataChapterInput {
  id: string; number: number; title?: string | null; folderPath: string; seriesId: string
  series: { title: string }
}

const cache = new Map<string, { fingerprint: string; status: MetadataChapterStatus }>()
/** File identities catch replacements as well as ordinary edits; byte validation still runs on every import. */
async function fingerprint(chapter: MetadataChapterInput): Promise<string> {
  const dir = getSourceFolderPath(chapter.folderPath)
  const files = []
  for (const relative of ['', 'crop_points3', 'crop_metadata3', 'crops3']) {
    const folder = path.join(dir, relative)
    const entries = await fs.readdir(folder, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' && relative) return []
      throw error
    })
    const values = await Promise.all(entries.filter(e => e.isFile()).map(async entry => {
      const stat = await fs.stat(path.join(folder, entry.name))
      return [relative, entry.name, stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino]
    }))
    files.push(...values)
  }
  return JSON.stringify([chapter, await metadataGenerations(chapter), files.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))])
}

/** Count validated metadata, independently of pointer/cut completion and phone receipts. */
export async function readMetadataChapter(chapter: MetadataChapterInput): Promise<MetadataChapterStatus> {
  const key = `${getSourceFolderPath(chapter.folderPath)}:${chapter.id}`
  try {
    if (await managedCropBindingCount(chapter.folderPath)) return inspectMetadataChapter(chapter)
    const before = await fingerprint(chapter)
    const previous = cache.get(key)
    if (previous?.fingerprint === before) return structuredClone(previous.status)
    const status = await inspectMetadataChapter(chapter)
    if (before === await fingerprint(chapter)) {
      if (cache.size >= 1_000) cache.delete(cache.keys().next().value!)
      cache.set(key, { fingerprint: before, status: structuredClone(status) })
    }
    return status
  } catch {
    // Missing/changing files and restart guards are reported by the validator, never hidden by a cached result.
    cache.delete(key)
    return inspectMetadataChapter(chapter)
  }
}

async function inspectMetadataChapter(chapter: MetadataChapterInput): Promise<MetadataChapterStatus> {
  const result: MetadataChapterStatus = {
    id: chapter.id, number: chapter.number, title: chapter.title ?? null,
    name: path.basename(chapter.folderPath), state: 'pending', done: 0, total: 0, ready: false, pages: []
  }
  try {
    const manifest = await getChapterManifest(chapter.folderPath)
    result.total = manifest.images.length
    if (!result.total) { result.reason = 'No downloaded pages'; return result }
    const stored = await Promise.all(manifest.images.map(async image => ({ image,
      points: await readImagePoints(chapter.folderPath, image.filename),
      text: await readImageMetadata(chapter.folderPath, image.filename)
    })))
    result.pages = stored.map(({ image, text }) => ({ filename: image.filename, state: 'pending', hasMetadata: text !== null }))
    if (await managedCropBindingCount(chapter.folderPath)) {
      result.state = 'blocked'; result.reason = 'Metadata split is not supported for managed/mixed chapters yet'
      return result
    }
    const split = stored.some(({ points, text }) => points?.file?.workflow === 'clipper-geometry/1' ||
      (() => { try { return !!text && !!JSON.parse(text).metadataJob } catch { return false } })()) ||
      await fs.stat(path.join(getSourceFolderPath(chapter.folderPath), '.metadata-cut-receipt.json')).then(() => true, () => false)
    let current: Awaited<ReturnType<typeof currentMetadataJobs>> | undefined
    if (split) {
      try {
        current = await currentMetadataJobs(chapter, await metadataGenerations(chapter))
        result.ready = true
      } catch (error) {
        result.state = 'blocked'
        result.reason = error instanceof Error ? error.message : String(error)
        for (const page of result.pages) if (page.hasMetadata) {
          page.state = 'invalid'; page.reason = result.reason
        }
        return result
      }
    }
    const slug = chapter.series.title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'series'
    for (let i = 0; i < stored.length; i++) {
      const { image, points, text } = stored[i]
      const page: MetadataPageStatus = result.pages[i]
      if (text === null) continue
      try {
        if (current) {
          const job = current.jobs.find(j => JSON.parse(j.payloadText).page === image.filename)
          if (!job) throw new Error('No current Metadata job for this page')
          validateMetadataResult(text, job, current.script)
        } else {
          const crops = extractCrops(points?.file ?? null)
          if (!points?.file || (!crops.length && !hasNoCrops(points.file)) || crops.length !== points.file.crops.length)
            throw new Error('Current crop pointers are missing or invalid')
          const checked = validateMetadata(text, crops.map(c => c.id), expectedExportedFilenames(slug, image.filename, crops), slug)
          if (!checked.isValid) throw new Error(checked.errors.join('; '))
          if (JSON.parse(text).crops.some((crop: { description?: unknown }) => typeof crop.description !== 'string' || !crop.description.trim()))
            throw new Error('Crop descriptions are missing')
        }
        page.state = 'complete'; result.done++
      } catch (error) {
        page.state = 'invalid'; page.reason = error instanceof Error ? error.message : String(error)
      }
    }
    result.state = result.done === result.total ? 'complete' : result.done > 0 ? 'partial' : 'pending'
    const invalid = result.pages.find(page => page.state === 'invalid')
    if (invalid) result.reason = `${invalid.filename}: ${invalid.reason}`
    else if (result.state !== 'complete') result.reason = result.ready ? 'Waiting for metadata from Sleeper Cell' : 'Waiting for Studio review and cut'
    return result
  } catch (error) {
    result.state = 'blocked'; result.reason = error instanceof Error ? error.message : String(error)
    return result
  }
}
