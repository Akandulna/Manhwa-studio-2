/**
 * Image Clipper 3.0 — cutting a whole chapter (Crop Sections), by hand or
 * automatically after Sync json.
 *
 * A page is cut when it is Done: crop JSON with usable crops (or an explicit empty list) AND
 * metadata that still validates against those crops — the same definition the
 * page list shows, read from the same files. A cut replaces the chapter's
 * previous crops3/ output (removeStaleOutputs).
 *
 * Two ways in, one job:
 *  - Crop Sections (POST /chapters/:id/crop) — reviewed chapters only, started
 *    straight away.
 *  - Auto crop — after Sync json, every chapter the Master phone reviewed whose
 *    pages are all attached and whose crops3/ doesn't already match is queued
 *    here and cut one chapter at a time. A chapter reviewed only on the desktop
 *    is never auto-cut: its review happens in Preview, followed by Crop.
 *
 * Both report over `clipper3:crop-progress` / `clipper3:crop-complete`; an
 * auto cut says `auto: true`, so the UI can tell the user why it is running.
 */

import path from 'path'
import { Server } from 'socket.io'
import { getChapterManifest } from '../chapterManifest.js'
import {
  chapterCropOutputs,
  expectedExportedFilenames,
  extractCrops,
  hasNoCrops,
  findUnresolvedMetadataNames,
  getOutputDir,
  listMetadataImageStems,
  listOutputs,
  listPointedImageStems,
  readImageMetadata,
  readImagePoints,
  removeStaleOutputs,
  stemOf,
  validateMetadata,
  type ChapterCropOutputs,
  type Clipper3CropEntry
} from './perImageStore.js'
import { cutImageCrops, type CutFile } from './perImageCrop.js'
import { readChapterReview } from './chapterReview.js'
import { pageReplacementActive } from '../chapterPageReplacement.js'

/** The chapter fields cutting needs. */
export interface CropChapter {
  id: string
  number: number
  folderPath: string
  seriesId: string
  series: { title: string }
}

export interface CropTarget {
  filename: string
  crops: Clipper3CropEntry[]
}

/** The prefix every cut file carries — kept identical to the names the metadata check expects. */
export function seriesSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'series'
}

/** Chapters currently being cut, so two runs cannot interleave their writes. */
const cropping = new Set<string>()

/**
 * Called after every finished cut that wrote files (by hand or auto). The
 * routes use it to tell the phones the chapter is cropped (phoneCropImport.ts
 * publishChapterCropped); registered there rather than imported here so this
 * module stays free of the database and R2.
 */
const croppedListeners: ((chapter: CropChapter) => Promise<unknown>)[] = []

export function onChapterCropped(listener: (chapter: CropChapter) => Promise<unknown>): void {
  croppedListeners.push(listener)
}

export function isChapterCropping(chapterId: string): boolean {
  return cropping.has(chapterId)
}

/** Where a chapter stands: which pages are Done (and so cut), and how crops3/ compares. */
export interface ChapterCropState {
  totalImages: number
  /** The Done pages, with the crops each one cuts to. */
  targets: CropTarget[]
  /** Every page is Done. */
  fullyAttached: boolean
  /** crops3/ holds at least one file. */
  chopped: boolean
  outputs: ChapterCropOutputs
}

/**
 * Reads the chapter's Done pages and compares crops3/ with them. Throws when
 * the chapter has no readable manifest (not downloaded, or its pages deleted).
 */
export async function readChapterCropState(chapter: Pick<CropChapter, 'folderPath' | 'series'>): Promise<ChapterCropState> {
  const manifest = await getChapterManifest(chapter.folderPath)
  const pointed = await listPointedImageStems(chapter.folderPath)
  const described = await listMetadataImageStems(chapter.folderPath)
  const slug = seriesSlug(chapter.series.title)

  const targets: CropTarget[] = []
  const expectedOutputs: string[] = []
  for (const img of manifest.images) {
    const stem = stemOf(img.filename)
    if (!pointed.has(stem) || !described.has(stem)) continue
    const stored = await readImagePoints(chapter.folderPath, img.filename)
    const crops = extractCrops(stored?.file ?? null)
    if (crops.length === 0 && !hasNoCrops(stored?.file ?? null)) continue

    // Metadata that no longer validates against these crops must not be cut
    // as if it still did — the page list shows such a page as pending too.
    const metadataText = await readImageMetadata(chapter.folderPath, img.filename)
    const exportedNames = expectedExportedFilenames(slug, img.filename, crops)
    if (
      metadataText == null ||
      !validateMetadata(metadataText, crops.map(c => c.id), exportedNames, slug).isValid
    ) continue

    targets.push({ filename: img.filename, crops })
    expectedOutputs.push(...exportedNames)
  }

  const totalImages = manifest.images.length
  const fullyAttached = totalImages > 0 && targets.length === totalImages
  return {
    totalImages,
    targets,
    fullyAttached,
    chopped: (await listOutputs(chapter.folderPath)).length > 0,
    outputs: await chapterCropOutputs(chapter.folderPath, expectedOutputs, fullyAttached, {
      slug,
      filenames: targets.map(t => t.filename)
    })
  }
}

/**
 * Cuts the given Done pages, replacing the chapter's previous cut. Resolves
 * once the run has finished and reported; never rejects — a crash is reported
 * over `clipper3:crop-complete` with `error`.
 *
 * The caller checks `isChapterCropping` first; this claims the chapter itself
 * so the claim and the cut cannot drift apart.
 */
export async function runChapterCrop(
  io: Server,
  chapter: CropChapter,
  targets: CropTarget[],
  opts: { auto?: boolean } = {}
): Promise<void> {
  const chapterId = chapter.id
  const slug = seriesSlug(chapter.series.title)
  const auto = opts.auto === true
  // Carried on every event so the series page can follow a cut it did not start.
  const tag = { chapterId, chapterNumber: chapter.number, seriesId: chapter.seriesId, auto }
  if (pageReplacementActive(chapter.folderPath)) throw new Error('This chapter’s pages are being replaced')
  cropping.add(chapterId)

  const allFiles: CutFile[] = []
  let failed = 0
  const warnings: string[] = []
  const unreadable: string[] = []

  try {
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i]
      io.emit('clipper3:crop-progress', {
        ...tag,
        current: i + 1,
        total: targets.length,
        filename: target.filename
      })

      try {
        const result = await cutImageCrops({
          folderPath: chapter.folderPath,
          imageFilename: target.filename,
          crops: target.crops,
          slug
        })
        allFiles.push(...result.files)
        failed += result.failed
        warnings.push(...result.warnings)
      } catch (err) {
        // One unreadable image must not abandon the rest of the chapter.
        failed += target.crops.length
        unreadable.push(stemOf(target.filename))
        const message = err instanceof Error ? err.message : String(err)
        warnings.push(`${target.filename}: ${message}`)
        console.error(`[clipper3] cutting ${target.filename} failed:`, message)
      }
    }

    // This run's files are now the chapter's crops: anything else in crops3/
    // is from older pointers (or pages no longer done) and would otherwise sit
    // beside the new cut as duplicates.
    const removed = await removeStaleOutputs(
      chapter.folderPath,
      new Set(allFiles.map(f => f.filename)),
      slug,
      unreadable
    )

    // The whole chapter has now been cut, so crops3/ is complete and a
    // metadata name with no file behind it can only be a real mismatch.
    // Checked here rather than in the image listing because only a finished
    // run can tell a bad name from a page not cut yet.
    const unresolved = await findUnresolvedMetadataNames(chapter.folderPath)
    if (unresolved.length > 0) {
      console.warn(
        `[clipper3] ${chapter.folderPath}: ${unresolved.length} page(s) name crops that are not in crops3/ — ` +
          unresolved.map(u => `${u.imageFilename} (${u.missing.length}/${u.total})`).join(', ')
      )
    }

    io.emit('clipper3:crop-complete', {
      ...tag,
      images: targets.length,
      exported: allFiles.length,
      removed: removed.length,
      failed,
      warnings,
      unresolved,
      exportDir: path.resolve(getOutputDir(chapter.folderPath))
    })

    // After the event, and not awaited: a slow or failing R2 PUT must not
    // hold up (or fail) the cut the user is waiting on. Listeners log their
    // own failures.
    if (allFiles.length > 0) {
      for (const listener of croppedListeners) {
        void listener(chapter).catch(err => console.error('[clipper3] after-crop step failed:', err))
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[clipper3] crop job crashed:', message)
    io.emit('clipper3:crop-complete', { ...tag, error: message })
  } finally {
    cropping.delete(chapterId)
  }
}

// ============ Auto crop after Sync json ============

/** Chapters waiting in (or being cut by) the auto-crop queue. */
const autoQueued = new Set<string>()

/** The tail of the queue: each auto cut starts when the previous one is done. */
let autoChain: Promise<void> = Promise.resolve()

/**
 * Whether a chapter should be cut without asking: reviewed on the Master
 * phone, every page Done, and crops3/ not already matching. Returns the pages
 * to cut, or null.
 */
async function autoCropTargets(chapter: CropChapter): Promise<CropTarget[] | null> {
  if (pageReplacementActive(chapter.folderPath)) return null
  const review = await readChapterReview(chapter.folderPath)
  if (!review.reviewed || review.by !== 'phone') return null
  let state: ChapterCropState
  try {
    state = await readChapterCropState(chapter)
  } catch {
    return null // not downloaded, or its pages were deleted
  }
  if (!state.fullyAttached || state.outputs.complete) return null
  return state.targets
}

/**
 * Picks the phone-reviewed chapters among `chapters` that need cutting and
 * queues them, one chapter at a time. Returns the ones queued by this call
 * (a chapter already queued or being cut is not queued twice).
 *
 * Each chapter is re-checked when its turn comes, so one edited or cut by
 * hand while it waited is not cut again.
 */
export async function queueAutoCrop(
  io: Server,
  chapters: CropChapter[]
): Promise<{ chapterId: string; chapterNumber: number }[]> {
  const queued: { chapterId: string; chapterNumber: number }[] = []
  for (const chapter of chapters) {
    if (autoQueued.has(chapter.id) || cropping.has(chapter.id)) continue
    if (!(await autoCropTargets(chapter))) continue

    autoQueued.add(chapter.id)
    queued.push({ chapterId: chapter.id, chapterNumber: chapter.number })
    autoChain = autoChain
      .then(async () => {
        if (cropping.has(chapter.id)) return
        const targets = await autoCropTargets(chapter)
        if (!targets) return
        console.log(`[clipper3] auto crop: chapter ${chapter.number} (${chapter.series.title}), reviewed on phone`)
        await runChapterCrop(io, chapter, targets, { auto: true })
      })
      .catch(err => {
        console.error(`[clipper3] auto crop of chapter ${chapter.number} failed:`, err)
      })
      .finally(() => {
        autoQueued.delete(chapter.id)
      })
  }
  return queued
}
