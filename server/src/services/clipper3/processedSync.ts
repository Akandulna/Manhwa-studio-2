/**
 * Image Clipper 3.0 — importing hand-produced crop JSON from `Processed/`.
 *
 * The pointers and metadata for a page are written by hand (a chat model reads
 * the page's slices and emits them), then dropped into ONE `Processed/` folder
 * per SERIES. This module is the bridge from that drop-off layout into the
 * store the app actually reads:
 *
 *   <Series>/Processed/<Chapter>/page_###/crop-pointers-ch###-p###.json
 *                                       ->  <Chapter>/crop_points3/<stem>.json
 *   <Series>/Processed/<Chapter>/page_###/crop-metadata-ch###-p###.json
 *                                       ->  <Chapter>/crop_metadata3/<stem>.txt
 *
 * Source images stay in `<Series>/<Chapter>/` alongside their `slices3/`; only
 * generated files live under `Processed/`. The older per-chapter location,
 * `<Series>/<Chapter>/Processed/`, is still read when the new one has nothing
 * for that chapter, so drop-offs made before the move keep working.
 *
 * Two naming systems meet here and neither can be assumed to match the other:
 *
 *  - The chapter folder under `Processed/` is named for the source chapter
 *    folder character for character (`Chapter 003`), so it is read from the
 *    chapter's own path rather than rebuilt from its number.
 *  - `page_###` is a PAGE NUMBER, always 3 digits.
 *  - The store is keyed by the source image's own STEM, which is whatever the
 *    downloader called the file — `page_003.webp`, but also `003.jpg` or
 *    `ch12_003.png`. So a Processed folder is resolved to a real image by
 *    matching page numbers, never by matching text (see `pageNumberOf`).
 *
 * Nothing is trusted on arrival. A page is imported only when its pointers
 * parse into at least one usable four-point crop AND its metadata validates
 * against exactly those crops — the same two checks the PUT routes apply, run
 * through the same helpers, so a synced page is indistinguishable from a
 * pasted one. Anything else is skipped and reported; a bad file in one folder
 * never stops the rest of the chapter.
 */

import fs from 'fs/promises'
import path from 'path'
import {
  deleteImageMetadata,
  deleteImagePoints,
  extractCrops,
  expectedExportedFilenames,
  getSourceFolderPath,
  listMetadataImageStems,
  listPointedImageStems,
  stemOf,
  validateMetadata,
  writeImageMetadata,
  canonicalizeExportedFilenames,
  writeImagePoints,
  type Clipper3ImageCropFile
} from './perImageStore.js'

const FORMAT = 'four-point-crop'
const VERSION = '1.0'

/**
 * Where this chapter's drop-off files live: ONE `Processed/` folder per series,
 * holding a folder per chapter.
 *
 *   <Series>/Processed/<Chapter>/page_###/
 *
 * The chapter folder is named for the SOURCE chapter folder character for
 * character (`Chapter 003`, not `Chapter 3`), so it is taken from
 * `folderPath`'s own basename rather than rebuilt from the chapter number —
 * padding and wording vary between series, and a rebuilt name would miss a
 * folder sitting right there.
 */
export function getProcessedDir(folderPath: string): string {
  const chapterDir = getSourceFolderPath(folderPath)
  return path.join(path.dirname(chapterDir), 'Processed', path.basename(chapterDir))
}

/**
 * The old per-chapter location, `<Series>/<Chapter>/Processed/`.
 *
 * Read only when the new one holds nothing for this chapter, so drop-offs made
 * before the move keep working. New files are expected at `getProcessedDir`.
 */
export function getLegacyProcessedDir(folderPath: string): string {
  return path.join(getSourceFolderPath(folderPath), 'Processed')
}

/**
 * The page number a name refers to, as a plain number, so zero-padding can
 * never decide a match: `page_007`, `page_7` and `007` are all page 7.
 *
 * Reads the LAST run of digits, because a stem can carry a chapter number in
 * front of the page one (`ch12_003` is page 3, not page 12).
 */
export function pageNumberOf(name: string): number | null {
  const match = /(\d+)(?!.*\d)/.exec(path.basename(name).replace(/\.[^/.]+$/, ''))
  return match ? Number(match[1]) : null
}

/**
 * What happened to one `Processed/page_###` folder — or, on a dry run, what
 * WOULD happen: 'ready' is the preview's form of 'imported', reached by every
 * check the real run makes and stopping only at the write itself.
 */
export interface SyncedPage {
  /** The folder as it appears on disk, e.g. "page_007". */
  folder: string
  /** The source image it resolved to, when it resolved to one. */
  filename: string | null
  status: 'imported' | 'ready' | 'skipped' | 'failed'
  /** Why, for 'skipped' and 'failed'. Empty for 'imported'/'ready'. */
  reason: string
  cropCount: number
}

export interface ChapterSyncResult {
  chapterId: string
  chapterNumber: number
  /** Pages newly written into the store by this run. Always 0 on a dry run. */
  imported: number
  /** Pages a dry run found attachable. Always 0 on a real run. */
  ready: number
  /** Already done, or no Processed folder to read. */
  skipped: number
  /** Present but unusable — the ones worth showing the user. */
  failed: number
  pages: SyncedPage[]
}

/** One page folder's two files, already read off disk. */
interface ProcessedPageFiles {
  folder: string
  pointersText: string | null
  metadataText: string | null
}

/** A directory's entries, or null when it does not exist / cannot be read. */
async function readDirOrNull(dir: string): Promise<import('fs').Dirent[] | null> {
  try {
    return await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
}

/**
 * Reads `Processed/` into one entry per page folder.
 *
 * The two files are found by PREFIX (`crop-pointers-`/`crop-metadata-`) rather
 * than by rebuilding their exact names. The full name embeds the chapter
 * number, and the chapter number in the database need not agree with the one
 * whoever produced the files typed — a chapter row numbered 7 whose files say
 * `ch008` is still obviously this page's file when it is the only pointers
 * file sitting in `Processed/page_012`. Matching on the prefix imports it;
 * rebuilding the name would reject the whole chapter over a digit that
 * addresses nothing.
 */
async function readProcessedDir(folderPath: string): Promise<ProcessedPageFiles[] | null> {
  // The series-level folder first; the old per-chapter one only if it holds
  // nothing, so a chapter that has been moved is never read from both.
  let dir = getProcessedDir(folderPath)
  let entries: import('fs').Dirent[] | null = await readDirOrNull(dir)
  if (entries === null || !entries.some(e => e.isDirectory())) {
    const legacy = await readDirOrNull(getLegacyProcessedDir(folderPath))
    if (legacy !== null && legacy.some(e => e.isDirectory())) {
      dir = getLegacyProcessedDir(folderPath)
      entries = legacy
    }
  }
  if (entries === null) {
    // No Processed folder in either place — nothing was dropped off.
    return null
  }

  const pages: ProcessedPageFiles[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue

    const pageDir = path.join(dir, entry.name)
    let files: string[]
    try {
      files = await fs.readdir(pageDir)
    } catch {
      continue
    }

    const pointersName = files.find(
      f => f.toLowerCase().startsWith('crop-pointers-') && f.toLowerCase().endsWith('.json')
    )
    const metadataName = files.find(
      f => f.toLowerCase().startsWith('crop-metadata-') && f.toLowerCase().endsWith('.json')
    )

    const read = async (name: string | undefined) => {
      if (!name) return null
      try {
        return await fs.readFile(path.join(pageDir, name), 'utf-8')
      } catch {
        return null
      }
    }

    pages.push({
      folder: entry.name,
      pointersText: await read(pointersName),
      metadataText: await read(metadataName)
    })
  }

  return pages
}

/**
 * Normalizes a pasted pointers document into the stored artifact shape.
 *
 * Mirrors the PUT /points route exactly: the container fields are defaulted,
 * `image` is overwritten with the REAL file's name and pixel size (the
 * coordinates are normalized against that image, so its dimensions are a fact
 * of the file and never whatever the document claims), and a single-crop
 * document is accepted in its `{ crop }` form as well as the `{ crops: [] }`
 * one.
 */
function toArtifact(
  parsed: any,
  image: { filename: string; width: number; height: number }
): Clipper3ImageCropFile {
  return {
    format: typeof parsed?.format === 'string' ? parsed.format : FORMAT,
    version: typeof parsed?.version === 'string' ? parsed.version : VERSION,
    image: { filename: image.filename, width: image.width, height: image.height },
    coordinateSystem:
      typeof parsed?.coordinateSystem === 'string' ? parsed.coordinateSystem : 'normalized',
    crops: Array.isArray(parsed?.crops)
      ? parsed.crops
      : parsed?.crop
        ? [{ id: parsed.id ?? 'c1', reason: parsed.reason ?? '', crop: parsed.crop }]
        : [],
    receivedAt: new Date().toISOString()
  }
}

export interface SyncChapterInput {
  chapterId: string
  chapterNumber: number
  folderPath: string
  seriesSlug: string
  /** The chapter's real images, from the manifest. */
  images: { filename: string; width: number; height: number }[]
  /**
   * Run every check but write nothing, reporting attachable pages as 'ready'.
   *
   * This is the SAME pass as the real run rather than a cheaper look-alike —
   * a preview that validated less than the import would promise pages it then
   * rejects, which is worse than no preview at all.
   */
  dryRun?: boolean
}

/**
 * Imports every usable page in one chapter's `Processed/` folder, or — with
 * `dryRun` — reports what it would import without touching anything.
 *
 * A page that is ALREADY done is left completely alone — not re-read, not
 * re-written. Sync fills gaps; it is not a restore, and silently replacing a
 * page that was hand-corrected in the workspace with an older drop-off file
 * would lose that work with nothing on screen to show for it.
 */
export async function syncChapterProcessed(input: SyncChapterInput): Promise<ChapterSyncResult> {
  const result: ChapterSyncResult = {
    chapterId: input.chapterId,
    chapterNumber: input.chapterNumber,
    imported: 0,
    ready: 0,
    skipped: 0,
    failed: 0,
    pages: []
  }

  const processed = await readProcessedDir(input.folderPath)
  if (processed === null || processed.length === 0) return result

  // Images indexed by page number, so a Processed folder resolves to a real
  // file regardless of how that file is named. A number claimed by two images
  // is ambiguous and resolves to neither — better a reported skip than a
  // confident write to the wrong page.
  const byPage = new Map<number, { filename: string; width: number; height: number } | null>()
  for (const img of input.images) {
    const page = pageNumberOf(img.filename)
    if (page == null) continue
    byPage.set(page, byPage.has(page) ? null : img)
  }

  const pointed = await listPointedImageStems(input.folderPath)
  const described = await listMetadataImageStems(input.folderPath)

  for (const page of processed) {
    const record = (status: SyncedPage['status'], reason: string, filename: string | null, cropCount = 0) => {
      result.pages.push({ folder: page.folder, filename, status, reason, cropCount })
      result[status]++
    }

    const pageNumber = pageNumberOf(page.folder)
    if (pageNumber == null) {
      record('failed', 'Folder name carries no page number.', null)
      continue
    }

    const image = byPage.get(pageNumber)
    if (image === undefined) {
      record('failed', `No page ${pageNumber} in this chapter.`, null)
      continue
    }
    if (image === null) {
      record('failed', `Page ${pageNumber} matches more than one image in this chapter.`, null)
      continue
    }

    const stem = stemOf(image.filename)

    // Already finished — see the note above.
    if (pointed.has(stem) && described.has(stem)) {
      record('skipped', 'Already attached.', image.filename)
      continue
    }

    if (!page.pointersText || !page.metadataText) {
      const missing = [
        !page.pointersText ? 'crop-pointers' : null,
        !page.metadataText ? 'crop-metadata' : null
      ].filter(Boolean).join(' and ')
      record('failed', `Missing ${missing} file.`, image.filename)
      continue
    }

    let parsed: any
    try {
      parsed = JSON.parse(page.pointersText)
    } catch (err) {
      record('failed', `Pointers file is not valid JSON: ${err instanceof Error ? err.message : 'could not parse'}`, image.filename)
      continue
    }

    const artifact = toArtifact(parsed, image)
    const crops = extractCrops(artifact)
    if (crops.length === 0) {
      record('failed', 'No usable four-point crop in the pointers file.', image.filename)
      continue
    }
    artifact.crops = crops

    // Both halves are validated BEFORE either is written, so a page can never
    // be left half-imported: pointers on disk with no metadata beside them is
    // exactly the state the workspace shows as "pending" for a reason the user
    // did not cause and cannot see.
    // Rebuilt from the pointers before validation, for the same reason the
    // paste route does it: these documents are AI-authored, and an
    // `exportedFilename` that drifted from the cutter's own composition
    // resolves nowhere downstream. See canonicalizeExportedFilenames.
    const canonical = canonicalizeExportedFilenames(
      page.metadataText,
      input.seriesSlug,
      image.filename,
      crops
    )
    const metadataText = canonical ? canonical.text : page.metadataText
    if (canonical && canonical.corrected.length > 0) {
      console.warn(
        `[clipper3] sync ${image.filename}: corrected ${canonical.corrected.length} exportedFilename(s) to match the cutter — ` +
          canonical.corrected.map(c => `${c.id}: "${c.was}" -> "${c.now}"`).join('; ')
      )
    }

    const validation = validateMetadata(
      metadataText,
      crops.map(c => c.id),
      expectedExportedFilenames(input.seriesSlug, image.filename, crops),
      input.seriesSlug
    )
    if (!validation.isValid) {
      record('failed', validation.errors.join(' '), image.filename, crops.length)
      continue
    }

    // Everything above is a read, so a dry run reaches here having proven the
    // page attachable by exactly the checks the real run applies.
    if (input.dryRun) {
      record('ready', '', image.filename, crops.length)
      continue
    }

    try {
      await writeImagePoints(input.folderPath, image.filename, artifact)
      await writeImageMetadata(input.folderPath, image.filename, metadataText)
    } catch (err) {
      record('failed', `Could not write: ${err instanceof Error ? err.message : String(err)}`, image.filename, crops.length)
      continue
    }

    record('imported', '', image.filename, crops.length)
  }

  return result
}

/**
 * What unsync did — or, on a dry run, would do — to one page of a chapter.
 *
 * 'detached' is the real run's form of 'attached': the preview reaches it by
 * the same look at the store the real run acts on, so a page listed in the
 * confirmation dialog is exactly a page the run will clear.
 */
export interface UnsyncedPage {
  filename: string
  status: 'detached' | 'attached' | 'failed'
  /** Why, for 'failed'. Empty otherwise. */
  reason: string
  /** Whether each half was actually on disk. Both are cleared together. */
  hadPoints: boolean
  hadMetadata: boolean
}

export interface ChapterUnsyncResult {
  chapterId: string
  chapterNumber: number
  /** Pages cleared from the store by this run. Always 0 on a dry run. */
  detached: number
  /** Pages a dry run found clearable. Always 0 on a real run. */
  attached: number
  /** Present but could not be removed — the ones worth showing the user. */
  failed: number
  pages: UnsyncedPage[]
}

export interface UnsyncChapterInput {
  chapterId: string
  chapterNumber: number
  folderPath: string
  /** The chapter's real images, from the manifest. */
  images: { filename: string }[]
  /** Report what would be cleared without deleting anything. */
  dryRun?: boolean
}

/**
 * Removes one chapter's attached crop JSON from the store, flipping every page
 * that had it back to pending — the exact inverse of `syncChapterProcessed`.
 *
 * Only the store is touched: `crop_points3/` and `crop_metadata3/`. The
 * hand-made files under `Processed/` are left exactly where they are, so an
 * unsync is always undoable by running Sync json again. Deleting the drop-off
 * would make this a destructive action wearing the same button as a reversible
 * one, and the files it would destroy cannot be regenerated by the app.
 *
 * A page carrying only ONE half (pointers written, metadata never pasted) is
 * still cleared. That state is not "partly done" to be preserved — it is the
 * pending state with a leftover file, and leaving the leftover behind would
 * have the next sync skip logic see something the user just asked to remove.
 */
export async function unsyncChapterProcessed(
  input: UnsyncChapterInput
): Promise<ChapterUnsyncResult> {
  const result: ChapterUnsyncResult = {
    chapterId: input.chapterId,
    chapterNumber: input.chapterNumber,
    detached: 0,
    attached: 0,
    failed: 0,
    pages: []
  }

  // The store is read once per chapter rather than probed per image: a chapter
  // runs to dozens of pages and the answer for all of them is in two readdirs.
  const pointed = await listPointedImageStems(input.folderPath)
  const described = await listMetadataImageStems(input.folderPath)

  for (const image of input.images) {
    const stem = stemOf(image.filename)
    const hadPoints = pointed.has(stem)
    const hadMetadata = described.has(stem)

    // Nothing attached — not reported at all. A series is mostly pages in this
    // state and listing them would bury the ones the dialog exists to show.
    if (!hadPoints && !hadMetadata) continue

    const record = (status: UnsyncedPage['status'], reason: string) => {
      result.pages.push({ filename: image.filename, status, reason, hadPoints, hadMetadata })
      result[status]++
    }

    if (input.dryRun) {
      record('attached', '')
      continue
    }

    // Both halves go, and a half that was not there is not a failure — the
    // goal is the page ending up pending, which `false` from a missing file
    // already satisfies.
    try {
      if (hadPoints) await deleteImagePoints(input.folderPath, image.filename)
      if (hadMetadata) await deleteImageMetadata(input.folderPath, image.filename)
    } catch (err) {
      record('failed', `Could not remove: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }

    record('detached', '')
  }

  return result
}
