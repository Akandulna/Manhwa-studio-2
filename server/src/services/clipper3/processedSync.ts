import {withUnmanagedCropChapter} from '../managedCropProjection.js'
/**
 * Image Clipper 3.0 — importing hand-produced crop JSON from `Processed/`.
 *
 * The pointers and metadata for a page are made on the Sleeper-Cell phones
 * (phoneCropImport.ts unpacks their chapter zips) or dropped in by hand, into
 * ONE `Processed/` folder per SERIES. This module is the bridge from that
 * drop-off layout into the store the app actually reads:
 *
 *   <Series>/Processed/<Chapter>/page_###/crop-pointers-ch###-p###.json
 *                                       ->  <Chapter>/crop_points3/<stem>.json
 *   <Series>/Processed/<Chapter>/page_###/crop-metadata-ch###-p###.json
 *                                       ->  <Chapter>/crop_metadata3/<stem>.txt
 *
 * Source images stay in `<Series>/<Chapter>/` (their slices sit apart, under
 * `<Series>/<Series>/<Chapter>/slices3/`); only generated files live under
 * `Processed/`. The older per-chapter location,
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
 *
 * One exception to "already attached pages are left alone": a chapter the
 * Master phone reviewed (its FETCH_MARKER says `reviewed: true` and not yet
 * `applied`) has its attached pages REPLACED where the review changed them,
 * once — see `syncChapterProcessed`.
 */

import { readEffectiveReview } from './chapterReview.js'
import { sha256, storyLinksCurrent } from './studioCropAuthorityModel.js'
import { queueEditorPublish } from '../editorAutoPublish.js'
import { stripCropStory } from '../seriesRestartModel.js'
import { readPageRedo, matchesRedo, finishPageRedo } from './pageRedo.js'
import fs from 'fs/promises'
import path from 'path'
import { pageReplacementActive } from '../chapterPageReplacement.js'
import {
  deleteImageMetadata,
  deleteImagePoints,
  extractCrops,
  readImageMetadata,
  readImagePoints,
  expectedExportedFilenames,
  getSourceFolderPath,
  listMetadataImageStems,
  listPointedImageStems,
  stemOf,
  validateMetadata,
  writeImageMetadata,
  canonicalizeExportedFilenames,
  writeImagePoints,
  type Clipper3CropEntry,
  type Clipper3ImageCropFile
} from './perImageStore.js'

const FORMAT = 'four-point-crop'
const VERSION = '1.0'

/**
 * In each `Processed/<Chapter>/`: which R2 zip it was unpacked from
 * (phoneCropImport.ts writes it). Kept here rather than there because Sync
 * json reads it too, and phoneCropImport already depends on this module.
 * Sync json ignores plain files, so it is never mistaken for a page.
 */
export const FETCH_MARKER = '.r2-crops.json'

/** What phoneCropImport records about the zip a Processed folder came from. */
export interface FetchMarker {
  restartRevision?: string
  key?: string
  etag?: string
  fetchedAt?: string
  pages?: number
  /** The zip's chapter.json said the Master phone reviewed it. */
  reviewed?: boolean
  /** A sync has already put that review into the store; back to the skip rule. */
  applied?: boolean
  appliedAt?: string
}

/** The chapter's FETCH_MARKER, or null when it was not fetched from R2 (or is unreadable). */
export async function readFetchMarker(folderPath: string): Promise<FetchMarker | null> {
  try {
    const marker = JSON.parse(await fs.readFile(path.join(getProcessedDir(folderPath), FETCH_MARKER), 'utf-8'))
    return marker && typeof marker === 'object' ? marker : null
  } catch {
    return null
  }
}

/**
 * Records that a reviewed chapter's pages are now in the store, so the next
 * Sync json goes back to skipping attached pages. Without this every later
 * sync would put the phone's review back over edits made on the desktop
 * since — the review is applied once, not enforced.
 */
async function markReviewApplied(folderPath: string, marker: FetchMarker): Promise<void> {
  const next = { ...marker, applied: true, appliedAt: new Date().toISOString() }
  await fs.writeFile(path.join(getProcessedDir(folderPath), FETCH_MARKER), JSON.stringify(next, null, 2) + '\n', 'utf-8')
}

/**
 * JSON with every object's keys sorted, so two documents that differ only in
 * key order or whitespace compare equal. The phone re-serializes what it
 * uploads; byte equality would call an untouched page "changed".
 */
function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v as object).sort().map(k => [k, sort((v as Record<string, unknown>)[k])]))
    }
    return v
  }
  return JSON.stringify(sort(value))
}

/** Just what decides the cut: id, reason (it names the file), mode and the four points. */
function cropsKey(crops: Clipper3CropEntry[]): string {
  return canonicalJson(crops.map(c => ({
    id: c.id,
    reason: c.reason ?? '',
    mode: c.crop.mode,
    points: c.crop.points.map(p => ({ id: p.id, x: p.x, y: p.y }))
  })))
}

function metadataKey(text: string): string {
  try {
    return canonicalJson(JSON.parse(text))
  } catch {
    return text.trim()
  }
}

/**
 * Whether the store already holds exactly this page — same crops, same
 * metadata — by content, not bytes. A page the review didn't touch must stay
 * "skipped", not be rewritten (which would also mark its cut out of date).
 */
async function storeMatches(
  folderPath: string,
  imageFilename: string,
  crops: Clipper3CropEntry[],
  metadataText: string
): Promise<boolean> {
  const stored = await readImagePoints(folderPath, imageFilename)
  const storedMeta = await readImageMetadata(folderPath, imageFilename)
  if (!stored?.file || storedMeta == null) return false
  return cropsKey(extractCrops(stored.file)) === cropsKey(crops) && metadataKey(storedMeta) === metadataKey(metadataText)
}

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
 *
 * 'replaced' is an attached page overwritten by the Master phone's review of
 * it; on a dry run it means "would be replaced" (the same word in both, since
 * the preview dialog shows it either way).
 */
export interface SyncedPage {
  /** The folder as it appears on disk, e.g. "page_007". */
  folder: string
  /** The source image it resolved to, when it resolved to one. */
  filename: string | null
  status: 'imported' | 'ready' | 'replaced' | 'skipped' | 'failed'
  /** Why, for 'replaced', 'skipped' and 'failed'. Empty for 'imported'/'ready'. */
  reason: string
  cropCount: number
  /** Obsolete incoming output was ignored; approved Studio crops still need current links. */
  linkingRequired?: boolean
}

export interface ChapterSyncResult {
  chapterId: string
  chapterNumber: number
  /** Pages newly written into the store by this run. Always 0 on a dry run. */
  imported: number
  /** Pages a dry run found attachable. Always 0 on a real run. */
  ready: number
  /** Attached pages overwritten (or, on a dry run, to be overwritten) by a phone review. */
  replaced: number
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
export async function readProcessedDir(folderPath: string): Promise<ProcessedPageFiles[] | null> {
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
        // Strip a UTF-8 byte-order mark. Some editors (and Windows tools) save
        // one, JSON.parse rejects it, and it never survives a clipboard paste —
        // so without this a file that pastes fine fails to sync.
        const text = await fs.readFile(path.join(pageDir, name), 'utf-8')
        return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
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
  /** The Sync json button only refreshes links on attached pages. */
  storyLinksOnly?: boolean
}

/**
 * Imports every usable page in one chapter's `Processed/` folder, or — with
 * `dryRun` — reports what it would import without touching anything.
 *
 * A page that is ALREADY done is left completely alone — not re-read, not
 * re-written. Sync fills gaps; it is not a restore, and silently replacing a
 * page that was hand-corrected in the workspace with an older drop-off file
 * would lose that work with nothing on screen to show for it.
 *
 * Except once after a Master phone review. When the chapter's FETCH_MARKER
 * says the zip was reviewed and that review has not been applied yet, an
 * attached page whose Processed files differ from the store is replaced and
 * reported as 'replaced' — the review is newer than the draft that was
 * attached, and is the version the user asked to be cut. Pages that match
 * stay 'skipped'. A real run then marks the review applied, so desktop edits
 * made after it are protected by the normal rule again.
 */
async function syncChapterProcessedLegacy(input: SyncChapterInput): Promise<ChapterSyncResult> {
  if (pageReplacementActive(input.folderPath)) throw new Error('This chapter’s pages are being replaced')
  const result: ChapterSyncResult = {
    chapterId: input.chapterId,
    chapterNumber: input.chapterNumber,
    imported: 0,
    ready: 0,
    replaced: 0,
    skipped: 0,
    failed: 0,
    pages: []
  }

  const processed = await readProcessedDir(input.folderPath)
  if (processed === null || processed.length === 0) return result

  const marker = await readFetchMarker(input.folderPath)
  const review = await readEffectiveReview(input.folderPath)
  const studioFinal = review.reviewed && (review.by === 'desktop' || review.by === 'cropped')
  const applyReview = !studioFinal && marker?.reviewed === true && marker.applied !== true
  const applyStoryLinks = !applyReview && (studioFinal || input.storyLinksOnly === true || !!marker?.restartRevision)

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
    const redo = await readPageRedo(input.folderPath, image.filename)
    if (redo && (!page.pointersText || !page.metadataText || !matchesRedo(redo, page.pointersText, page.metadataText))) {
      record('skipped', 'Waiting for Sleeper Cell to regenerate this rejected page.', image.filename)
      continue
    }
    if (redo && sha256(await fs.readFile(path.join(getSourceFolderPath(input.folderPath), image.filename))) !== redo.sourceSha256) {
      record('failed', 'The source page changed after the redo request. Request a redo for the current page.', image.filename)
      continue
    }

    const replacingRejectedPage = redo?.status === 'pending'

    // Already finished — see the note above. A phone review goes on through
    // the same checks and is compared with the store before anything is
    // written.
    const attached = pointed.has(stem) && described.has(stem)
    if (attached && !replacingRejectedPage && !applyReview && !applyStoryLinks) {
      record('skipped', 'Already attached.', image.filename)
      continue
    }
    // A reviewed page that fails a check keeps what is attached: the reason
    // says the review was the problem, not the page on screen.
    const failPrefix = attached ? 'Reviewed on the phone, but not applied: ' : ''
    const currentMeta = attached && applyStoryLinks ? await readImageMetadata(input.folderPath, image.filename) : null
    // Studio review is final. An older phone export cannot replace completed
    // links or turn that page into an attachment failure, even if malformed.
    if (attached && !replacingRejectedPage && studioFinal && currentMeta != null) {
      const script = await fs.readFile(path.join(getSourceFolderPath(input.folderPath), 'script.md'), 'utf8').catch(() => '')
      const sourceHash = sha256(await fs.readFile(path.join(getSourceFolderPath(input.folderPath), image.filename)))
      if (storyLinksCurrent(currentMeta, script, sourceHash)) {
        record('skipped', 'Studio-reviewed crops and current script links preserved.', image.filename)
        continue
      }
    }
    const rejectIncoming = (reason: string, cropCount = 0) => {
      if (attached && studioFinal) {
        record('skipped', 'Studio-reviewed crops preserved; older incoming files ignored.', image.filename, cropCount)
        result.pages[result.pages.length - 1].linkingRequired = true
      } else record('failed', reason, image.filename, cropCount)
    }

    if (!page.pointersText || !page.metadataText) {
      const missing = [
        !page.pointersText ? 'crop-pointers' : null,
        !page.metadataText ? 'crop-metadata' : null
      ].filter(Boolean).join(' and ')
      rejectIncoming(`${failPrefix}Missing ${missing} file.`)
      continue
    }

    let parsed: any
    try {
      parsed = JSON.parse(page.pointersText)
    } catch (err) {
      rejectIncoming(`${failPrefix}Pointers file is not valid JSON: ${err instanceof Error ? err.message : 'could not parse'}`)
      continue
    }

    const artifact = toArtifact(parsed, image)
    const crops = extractCrops(artifact)
    if (crops.length === 0 && !(Array.isArray(parsed?.crops) && parsed.crops.length === 0)) {
      rejectIncoming(`${failPrefix}No usable four-point crop in the pointers file.`)
      continue
    }
    artifact.crops = crops

    // Both halves are validated BEFORE either is written, so a page can never
    // be left half-imported: pointers on disk with no metadata beside them is
    // exactly the state the workspace shows as "pending" for a reason the user
    // did not cause and cannot see.
    // Retain an exact return of Studio's reviewed visual metadata, including
    // approved filenames that differ from today's cutter composition. Other
    // imports still use the existing filename normalization for older phone
    // exports. Attached story-link updates must match the reviewed metadata
    // after either path before anything can be written below.
    const reviewedMetadataMatches = currentMeta != null &&
      metadataKey(stripCropStory(currentMeta)) === metadataKey(stripCropStory(page.metadataText))
    const canonical = reviewedMetadataMatches ? null : canonicalizeExportedFilenames(
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
      rejectIncoming(failPrefix + validation.errors.join(' '), crops.length)
      continue
    }

    if (input.storyLinksOnly || studioFinal || redo) {
      const script = await fs.readFile(path.join(getSourceFolderPath(input.folderPath), 'script.md'), 'utf8').catch(() => '')
      const sourceHash = sha256(await fs.readFile(path.join(getSourceFolderPath(input.folderPath), image.filename)))
      if (!storyLinksCurrent(metadataText, script, sourceHash)) {
        rejectIncoming('Script links are missing, invalid or for an older script/source. Complete script linking in Sleeper Cell before syncing.', crops.length)
        continue
      }
    }

    if (attached && applyStoryLinks && !replacingRejectedPage) {
      const current = await readImagePoints(input.folderPath, image.filename)
      if (!current?.file || cropsKey(extractCrops(current.file)) !== cropsKey(crops) || currentMeta == null || metadataKey(stripCropStory(currentMeta)) !== metadataKey(stripCropStory(metadataText))) {
        rejectIncoming(input.storyLinksOnly ? 'Phone crops differ from Studio’s saved geometry or descriptions. Studio files were preserved. Use Reject JSON / Request redo on the page to replace it.' : 'Restart story linking cannot change approved crop geometry or visual descriptions. Review those changes separately.', crops.length)
        continue
      }
      if (metadataKey(currentMeta) === metadataKey(metadataText)) { record('skipped', 'Story links already current.', image.filename, crops.length); continue }
      if (!input.dryRun) await writeImageMetadata(input.folderPath, image.filename, metadataText)
      record('replaced', 'Story links refreshed; crop images and geometry preserved.', image.filename, crops.length)
      continue
    }

    if (attached && (await storeMatches(input.folderPath, image.filename, crops, metadataText))) {
      record('skipped', 'Already attached.', image.filename, crops.length)
      continue
    }

    // Everything above is a read, so a dry run reaches here having proven the
    // page attachable by exactly the checks the real run applies.
    if (input.dryRun) {
      if (attached) record('replaced', 'Reviewed on the phone — replaces the attached crops.', image.filename, crops.length)
      else record('ready', '', image.filename, crops.length)
      continue
    }

    try {
      if (redo) (artifact as Clipper3ImageCropFile & { studioRedoRevision: string }).studioRedoRevision = redo.revision
      await writeImagePoints(input.folderPath, image.filename, artifact)
      await writeImageMetadata(input.folderPath, image.filename, metadataText)
      if (redo?.status === 'pending') await finishPageRedo(input.folderPath, redo)
    } catch (err) {
      record('failed', `${failPrefix}Could not write: ${err instanceof Error ? err.message : String(err)}`, image.filename, crops.length)
      continue
    }

    if (attached) record('replaced', 'Reviewed on the phone.', image.filename, crops.length)
    else record('imported', '', image.filename, crops.length)
  }

  // Applied even when some page failed: those failures are in this run's
  // report, and leaving the review pending would have every later sync keep
  // overwriting whatever the desktop changes afterwards.
  if (applyReview && !input.dryRun && marker) await markReviewApplied(input.folderPath, marker)

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
async function unsyncChapterProcessedLegacy(
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

export async function syncChapterProcessed(input: SyncChapterInput):Promise<ChapterSyncResult> {
 return withUnmanagedCropChapter(input.folderPath,async()=>{
  const result = await syncChapterProcessedLegacy(input)
  // Link-only returns don't recut images or rewrite alignment, so they need their own publish trigger.
  if (!input.dryRun && (result.imported > 0 || result.replaced > 0)) queueEditorPublish(input.chapterId)
  return result
 })
}

export async function unsyncChapterProcessed(input: UnsyncChapterInput):Promise<ChapterUnsyncResult> {
 return withUnmanagedCropChapter(input.folderPath,()=>unsyncChapterProcessedLegacy(input))
}
