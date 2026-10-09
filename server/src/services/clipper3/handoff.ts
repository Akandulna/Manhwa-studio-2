/**
 * Crop Studio (hybrid ChatGPT loop) — the ChatGPT handoff package for ONE page.
 *
 * The package is what makes a hand-carried ChatGPT reply safe to import later:
 *
 *  - the page's slices, cut losslessly by the existing slicer and then checked
 *    against the fingerprinted original — they must tile it exactly and decode
 *    to the very same pixels, or the package is refused;
 *  - `chatgpt-handoff.json`, the manifest: page identity (hash, true W×H), the
 *    immutable job id, and every slice's exact rectangle on the original;
 *  - `prompt.txt`, the copy-ready prompt with that manifest inlined, so the
 *    only attachments are the slice images themselves.
 *
 * State lives in `<Series>/.crop-studio/<Chapter>/<stem>/` — a dot-folder, so
 * the chapter importer (which skips dot-entries) never mistakes it for a
 * chapter. The slices stay where the slicer already puts them (getSliceDir).
 *
 * No filesystem paths go into the manifest or prompt: they are pasted into an
 * external service, and only file NAMES are needed to match slices up.
 */

import fs from 'fs/promises'
import path from 'path'
import sharp from 'sharp'
import { getSourceFolderPath, stemOf } from './perImageStore.js'
import { computeSlices, getSliceDir, sliceImage, SLICE_HEIGHT, type SliceImageResult } from './perImageSlice.js'
import {
  loadOriginal,
  sha256Hex,
  sha256OfFile,
  type DecodedPixels,
  type OriginalPage,
  type SourceInspection,
  type SourceIssue
} from './pageIdentity.js'

export const HANDOFF_SCHEMA = 'handoff/1.0'
export const ANALYSIS_SCHEMA = 'chatgpt-analysis/1.0'
export const CANONICAL_COORDINATES = 'canonical_original_pixels'
/** Corners measured inside the slice they fall in; the app adds the offsets. */
export const SLICE_COORDINATES = 'slice_local_pixels'

export const HANDOFF_FILE = 'chatgpt-handoff.json'
export const PROMPT_FILE = 'prompt.txt'
export const SOURCE_MANIFEST_FILE = 'source-manifest.json'

/**
 * The review flags ChatGPT may attach. The importer treats anything outside
 * this list as an explicit warning, never as an instruction.
 */
export const REVIEW_FLAGS = [
  'seam_crossing',
  'boundary_uncertain',
  'possible_multiple_shots',
  'tall_continuous_scene',
  'small_detail_unreadable',
  'clipped_subject',
  'possible_duplicate',
  'needs_closer_view'
] as const

export interface HandoffSlice {
  id: string
  file: string
  x0: number
  y0: number
  x1: number
  y1: number
  width: number
  height: number
  sha256: string
}

export interface HandoffManifest {
  schema_version: typeof HANDOFF_SCHEMA
  job_id: string
  created_at: string
  source: {
    series_title: string
    series_slug: string
    chapter_folder: string
    chapter_number: number
    page_stem: string
    original_filename: string
    sha256: string
    width: number
    height: number
    format: string
    orientation: 'stored_pixels'
  }
  coordinate_system: typeof CANONICAL_COORDINATES
  slicing: {
    mode: 'full_width_fixed_height'
    slice_height: number
    encoding: 'webp_lossless'
  }
  slices: HandoffSlice[]
  verification: {
    tiling: 'exact'
    pixels: 'identical'
    verified_at: string
  }
  /** sha256 of this manifest serialized without this field. */
  manifest_sha256: string
}

export type HandoffIssueCode =
  | SourceIssue['code']
  | 'SLICE_MAPPING_UNVERIFIED'
  | 'SLICE_PIXEL_MISMATCH'

export interface HandoffIssue {
  code: HandoffIssueCode
  message: string
}

export class HandoffError extends Error {
  constructor(public readonly issues: HandoffIssue[], public readonly inspection?: SourceInspection) {
    super(issues.map(issue => issue.message).join('; '))
    this.name = 'HandoffError'
  }
}

export interface HandoffContext {
  folderPath: string
  imageFilename: string
  seriesTitle: string
  seriesSlug: string
  chapterNumber: number
}

// ============ Paths ============

/**
 * `<Series>/.crop-studio/<Chapter>/<image stem>/` — every per-page state file
 * the hybrid loop writes (handoff now; the imported reply and review state in
 * later phases).
 */
export function getStudioDir(folderPath: string, imageFilename: string): string {
  const base = path.basename(imageFilename)
  if (!base || base === '.' || base === '..') {
    throw new Error(`Unusable image filename: ${imageFilename}`)
  }
  const chapterDir = getSourceFolderPath(folderPath)
  const seriesDir = path.dirname(chapterDir)
  return path.join(seriesDir, '.crop-studio', path.basename(chapterDir), stemOf(base))
}

// ============ Pure pieces ============

/** "10" -> "010", "10.5" -> "010.5": the chapter token used in job ids. */
export function chapterToken(chapterNumber: number): string {
  const [whole, fraction] = String(chapterNumber).split('.')
  const padded = whole.padStart(3, '0')
  return fraction ? `${padded}.${fraction}` : padded
}

/**
 * Deterministic for a given source version: the same bytes always produce the
 * same id, and any byte change produces a different one — so a reply echoing
 * an old id is recognisably about an old page.
 */
export function jobIdFor(seriesSlug: string, chapterNumber: number, pageStem: string, sha256: string): string {
  const safe = (value: string) =>
    value.toLowerCase().replace(/[^a-z0-9._]+/g, '-').replace(/^-+|-+$/g, '')
  return [safe(seriesSlug), `ch${chapterToken(chapterNumber)}`, safe(pageStem), sha256.slice(0, 12)].join('-')
}

export function sliceIdFor(index: number, total: number): string {
  return `slice-${String(index).padStart(Math.max(2, String(total).length), '0')}`
}

/**
 * Checks that the slices tile a W×H page exactly: full width, top to bottom,
 * no gap, no overlap, nothing past the edge. Returns every violation found.
 */
export function verifyTiling(
  width: number,
  height: number,
  slices: Pick<HandoffSlice, 'id' | 'x0' | 'y0' | 'x1' | 'y1'>[]
): HandoffIssue[] {
  const issues: HandoffIssue[] = []
  const fail = (message: string) => issues.push({ code: 'SLICE_MAPPING_UNVERIFIED', message })

  if (slices.length === 0) {
    fail('No slices were produced')
    return issues
  }

  let expectedTop = 0
  for (const slice of slices) {
    if (slice.x0 !== 0 || slice.x1 !== width) {
      fail(`${slice.id} spans x ${slice.x0}–${slice.x1}, not the full width 0–${width}`)
    }
    if (slice.y0 !== expectedTop) {
      fail(`${slice.id} starts at y ${slice.y0}; the previous slice ended at ${expectedTop}`)
    }
    if (slice.y1 <= slice.y0) {
      fail(`${slice.id} has no height (y ${slice.y0}–${slice.y1})`)
    }
    if (slice.y1 > height) {
      fail(`${slice.id} ends at y ${slice.y1}, past the page height ${height}`)
    }
    expectedTop = slice.y1
  }
  if (expectedTop !== height) {
    fail(`Slices end at y ${expectedTop} but the page is ${height} px tall`)
  }
  return issues
}

/** The manifest checksum: sha256 over the manifest serialized without it. */
export function manifestChecksum(manifest: Omit<HandoffManifest, 'manifest_sha256'>): string {
  return sha256Hex(JSON.stringify(manifest))
}

/**
 * The copy-ready prompt (PRD Appendix A) with this page's real values and the
 * manifest inlined. Corners are asked for in slice-local pixels: measuring
 * inside the 2048 px image being looked at is far more reliable than adding
 * offsets across a page ten thousand pixels tall, and the app does that sum.
 */
export function buildHandoffPrompt(manifest: HandoffManifest): string {
  const { source, slices } = manifest
  const sliceLines = slices
    .map(s => `  ${s.id} = ${s.file} — ${s.width}×${s.height} px, page y ${s.y0}–${s.y1}`)
    .join('\n')

  const example = {
    schema_version: ANALYSIS_SCHEMA,
    job_id: manifest.job_id,
    source_sha256: source.sha256,
    page_stem: source.page_stem,
    source_width: source.width,
    source_height: source.height,
    coordinate_system: SLICE_COORDINATES,
    page_inspection_complete: true,
    candidates: [
      {
        candidate_id: 'candidate-01',
        reason: 'framed_reaction',
        top_left: { slice_id: slices[0].id, x: 35, y: 110 },
        bottom_right: { slice_id: slices[0].id, x: Math.min(1045, source.width), y: Math.min(810, slices[0].height) },
        description: 'A dark-haired character appears in a close reaction shot against a softly shaded background.',
        visual_evidence: 'Distinct framed shot with one main reaction',
        review_flags: []
      }
    ],
    page_review_flags: []
  }

  return [
    `You are analyzing ONE manhwa page: "${source.page_stem}" from ${source.series_title}, ${source.chapter_folder}.`,
    '',
    `The ${slices.length} attached image${slices.length === 1 ? ' is' : 's are'} losslessly cut, ordered, full-width vertical slices of that single page (${source.width}×${source.height} px). Attach order and file names:`,
    sliceLines,
    '',
    'HOW TO LOOK',
    '- Inspect the whole page top to bottom, including both sides of every slice seam. A seam is NOT a panel boundary.',
    '- Identify every independently readable illustrated moment: framed panels, distinct shots inside continuous artwork, small inserts, grayscale scenes, objects, landscapes and effects shots.',
    '- Do not split continuous action just because it is tall. Do not merge different shots just because their backgrounds match.',
    '- Speech bubbles, narration boxes and SFX never start or split a crop.',
    '- A stretch holding only speech/thought/narration bubbles, caption boxes or SFX is NOT a crop. A plain, gradient, sky, sparkle, particle, glow or speed-line background behind them does not count as artwork — leave that stretch uncovered.',
    '- Self-check every crop: if its honest description would be mainly bubbles, narration or lettering over a background (not a person, creature, object, place or action), drop it.',
    '- Keep people, faces, hands, clothing, weapons and important effects whole.',
    '- If crop rules were shared earlier in this conversation, apply them to decide WHAT to crop. The JSON contract below overrides any output format they describe.',
    '',
    'HOW TO MEASURE (important)',
    `- Give each crop's top-left and bottom-right corner in the pixel grid of the SLICE that corner falls in: { "slice_id", "x", "y" }, with x from 0 to the slice width and y from 0 to that slice's height. Do NOT add slice offsets yourself.`,
    '- bottom_right is exclusive (the first pixel row/column outside the crop). A crop crossing a seam simply has its two corners in different slices.',
    '- Use integers. If a boundary is uncertain, give your best estimate AND add the flag "boundary_uncertain" — never invent precision.',
    '',
    'WHAT TO WRITE PER CROP',
    '- reason: a short factual snake_case label (e.g. framed_reaction, action_effects, wide_landscape).',
    '- description: ONE plain sentence of 12–35 words ending in a period, describing only visible artwork. No character names, no plot, no dialogue transcription.',
    '- visual_evidence: a short phrase saying why this is its own crop.',
    `- review_flags: zero or more of ${REVIEW_FLAGS.map(f => `"${f}"`).join(', ')}.`,
    '',
    'IDENTITY — copy these EXACTLY:',
    `  job_id: ${manifest.job_id}`,
    `  source_sha256: ${source.sha256}`,
    `  page_stem: ${source.page_stem}`,
    `  source_width: ${source.width}`,
    `  source_height: ${source.height}`,
    '',
    'If detail is too small to judge, set "page_inspection_complete" to false and say what needs a closer view in "page_review_flags" instead of guessing.',
    '',
    `Return ONE JSON object in exactly this shape (${ANALYSIS_SCHEMA}), with no prose and no Markdown fences.`,
    'The identity fields below are real; the candidate is only an example of the shape — replace it with your own crops, one entry per crop:',
    JSON.stringify(example, null, 2),
    '',
    'Handoff manifest for reference:',
    JSON.stringify(manifest, null, 2)
  ].join('\n')
}

// ============ Build ============

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temp, content, 'utf-8')
  await fs.rename(temp, filePath)
}

/**
 * Decodes one written slice and compares it byte for byte with the same rows
 * of the fingerprinted original. Slices are full width, so a slice's rows are
 * one contiguous run of the decoded page buffer.
 */
async function slicePixelsMatch(slicePath: string, rows: { y0: number; y1: number }, original: DecodedPixels): Promise<string | null> {
  const { data, info } = await sharp(slicePath).raw().toBuffer({ resolveWithObject: true })
  if (info.width !== original.width || info.height !== rows.y1 - rows.y0) {
    return `decoded to ${info.width}×${info.height}, expected ${original.width}×${rows.y1 - rows.y0}`
  }
  const rowBytes = original.width * original.channels
  const expected = original.data.subarray(rows.y0 * rowBytes, rows.y1 * rowBytes)
  if (info.channels === original.channels && data.equals(expected)) return null
  return webpPixelsMatch(data, info.channels, expected, original.channels)
}

/**
 * Slices are lossless WebP, which only stores RGB or RGBA: greyscale comes
 * back as R=G=B, a fully opaque alpha channel is dropped, and the colour under
 * a fully transparent pixel may be discarded. Compares what is visible under
 * that mapping, pixel by pixel.
 */
function webpPixelsMatch(slice: Buffer, sliceChannels: number, original: Buffer, originalChannels: number): string | null {
  const greyOriginal = originalChannels <= 2
  const originalHasAlpha = originalChannels === 2 || originalChannels === 4
  const sliceHasAlpha = sliceChannels === 4
  if (sliceChannels < 3 || (!originalHasAlpha && sliceHasAlpha) || original.length / originalChannels !== slice.length / sliceChannels) {
    return `decoded with ${sliceChannels} channels, which cannot hold the original's ${originalChannels}`
  }
  const alphaAt = greyOriginal ? 1 : 3
  for (let s = 0, o = 0; o < original.length; s += sliceChannels, o += originalChannels) {
    const alpha = originalHasAlpha ? original[o + alphaAt] : 255
    if ((sliceHasAlpha ? slice[s + 3] : 255) !== alpha) return 'pixels differ from the original'
    if (alpha === 0) continue
    for (let c = 0; c < 3; c++) {
      if (slice[s + c] !== original[o + (greyOriginal ? 0 : c)]) return 'pixels differ from the original'
    }
  }
  return null
}

export interface HandoffBuildResult {
  manifest: HandoffManifest
  prompt: string
  inspection: SourceInspection
  studioDirectory: string
  sliceDirectory: string
  /** What the slicer wrote, in the same shape the plain slice route returns. */
  sliced: SliceImageResult
}

/**
 * Builds and verifies the handoff package for one page. Throws HandoffError
 * (with every issue found) when the original is blocked or a slice fails
 * verification — a package is either fully verified or not written.
 */
export async function buildHandoff(ctx: HandoffContext): Promise<HandoffBuildResult> {
  const imageFilename = path.basename(ctx.imageFilename)
  const sourcePath = path.join(getSourceFolderPath(ctx.folderPath), imageFilename)

  const { pixels, ...inspection } = await loadOriginal(sourcePath)
  if (!inspection.ready || !inspection.page || !pixels) {
    throw new HandoffError(
      inspection.issues
        .filter(issue => issue.severity === 'error')
        .map(issue => ({ code: issue.code, message: issue.message })),
      inspection
    )
  }
  const page: OriginalPage = inspection.page

  // The existing slicer writes the files (so this package and the plain
  // "Slice image" button always agree on names and geometry); everything it
  // wrote is then checked against the pixels fingerprinted above.
  const sliced = await sliceImage({ folderPath: ctx.folderPath, imageFilename })
  if (sliced.sourceWidth !== page.width || sliced.sourceHeight !== page.height) {
    throw new HandoffError([{
      code: 'SLICE_PIXEL_MISMATCH',
      message: `The page read as ${sliced.sourceWidth}×${sliced.sourceHeight} while slicing but ${page.width}×${page.height} when fingerprinted — it changed on disk; try again`
    }], inspection)
  }

  const rects = computeSlices(page.width, page.height)
  const files = [...sliced.files].sort((a, b) => a.index - b.index)
  if (files.length !== rects.length) {
    throw new HandoffError([{
      code: 'SLICE_MAPPING_UNVERIFIED',
      message: `Expected ${rects.length} slices for ${page.width}×${page.height}, the slicer wrote ${files.length}`
    }], inspection)
  }

  const slices: HandoffSlice[] = []
  const issues: HandoffIssue[] = []
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i]
    const file = files[i]
    const slicePath = path.join(sliced.directory, file.filename)
    const slice: HandoffSlice = {
      id: sliceIdFor(rect.index, rects.length),
      file: file.filename,
      x0: rect.left,
      y0: rect.top,
      x1: rect.left + rect.width,
      y1: rect.top + rect.height,
      width: file.width,
      height: file.height,
      sha256: await sha256OfFile(slicePath)
    }
    const mismatch = await slicePixelsMatch(slicePath, slice, pixels)
    if (mismatch) issues.push({ code: 'SLICE_PIXEL_MISMATCH', message: `${slice.id} (${slice.file}) ${mismatch}` })
    slices.push(slice)
  }
  issues.push(...verifyTiling(page.width, page.height, slices))
  if (issues.length > 0) throw new HandoffError(issues, inspection)

  const now = new Date().toISOString()
  const stem = stemOf(imageFilename)
  const unsigned: Omit<HandoffManifest, 'manifest_sha256'> = {
    schema_version: HANDOFF_SCHEMA,
    job_id: jobIdFor(ctx.seriesSlug, ctx.chapterNumber, stem, page.sha256),
    created_at: now,
    source: {
      series_title: ctx.seriesTitle,
      series_slug: ctx.seriesSlug,
      chapter_folder: path.basename(getSourceFolderPath(ctx.folderPath)),
      chapter_number: ctx.chapterNumber,
      page_stem: stem,
      original_filename: imageFilename,
      sha256: page.sha256,
      width: page.width,
      height: page.height,
      format: page.format,
      orientation: 'stored_pixels'
    },
    coordinate_system: CANONICAL_COORDINATES,
    slicing: { mode: 'full_width_fixed_height', slice_height: SLICE_HEIGHT, encoding: 'webp_lossless' },
    slices,
    verification: { tiling: 'exact', pixels: 'identical', verified_at: now }
  }
  const manifest: HandoffManifest = { ...unsigned, manifest_sha256: manifestChecksum(unsigned) }
  const prompt = buildHandoffPrompt(manifest)

  const studioDirectory = getStudioDir(ctx.folderPath, imageFilename)
  await fs.mkdir(studioDirectory, { recursive: true })
  await writeFileAtomic(
    path.join(studioDirectory, SOURCE_MANIFEST_FILE),
    JSON.stringify({ inspected_at: now, ...inspection }, null, 2) + '\n'
  )
  await writeFileAtomic(path.join(studioDirectory, HANDOFF_FILE), JSON.stringify(manifest, null, 2) + '\n')
  await writeFileAtomic(path.join(studioDirectory, PROMPT_FILE), prompt + '\n')

  return {
    manifest,
    prompt,
    inspection,
    studioDirectory: path.resolve(studioDirectory),
    sliceDirectory: sliced.directory,
    sliced
  }
}

// ============ Status ============

export type HandoffStaleReason = 'SOURCE_CHANGED' | 'SLICES_CHANGED' | 'MANIFEST_CORRUPT'

export interface HandoffStatus {
  status: 'none' | 'ready' | 'stale'
  staleReasons: { code: HandoffStaleReason; message: string }[]
  manifest: HandoffManifest | null
  prompt: string | null
}

/**
 * Whether this page's stored package still describes the page on disk. Cheap
 * enough to run on every open — file hashes only, no decoding — and it is what
 * later phases consult before accepting an import against a job id.
 */
export async function getHandoffStatus(folderPath: string, imageFilename: string): Promise<HandoffStatus> {
  const studioDirectory = getStudioDir(folderPath, imageFilename)

  let raw: string
  try {
    raw = await fs.readFile(path.join(studioDirectory, HANDOFF_FILE), 'utf-8')
  } catch {
    return { status: 'none', staleReasons: [], manifest: null, prompt: null }
  }

  const staleReasons: HandoffStatus['staleReasons'] = []
  let manifest: HandoffManifest | null = null
  try {
    manifest = JSON.parse(raw) as HandoffManifest
    const { manifest_sha256, ...unsigned } = manifest
    if (manifest.schema_version !== HANDOFF_SCHEMA || manifestChecksum(unsigned) !== manifest_sha256) {
      staleReasons.push({ code: 'MANIFEST_CORRUPT', message: 'The stored manifest was edited or is from another version' })
    }
  } catch {
    return {
      status: 'stale',
      staleReasons: [{ code: 'MANIFEST_CORRUPT', message: 'The stored manifest is not valid JSON' }],
      manifest: null,
      prompt: null
    }
  }

  const sourcePath = path.join(getSourceFolderPath(folderPath), path.basename(imageFilename))
  try {
    if ((await sha256OfFile(sourcePath)) !== manifest.source?.sha256) {
      staleReasons.push({ code: 'SOURCE_CHANGED', message: 'The original page changed after this package was built' })
    }
  } catch {
    staleReasons.push({ code: 'SOURCE_CHANGED', message: 'The original page can no longer be read' })
  }

  const sliceDir = getSliceDir(folderPath, imageFilename)
  const changed: string[] = []
  for (const slice of manifest.slices ?? []) {
    try {
      if ((await sha256OfFile(path.join(sliceDir, path.basename(slice.file)))) !== slice.sha256) changed.push(slice.file)
    } catch {
      changed.push(slice.file)
    }
  }
  if (changed.length > 0) {
    staleReasons.push({
      code: 'SLICES_CHANGED',
      message: `${changed.length} slice file${changed.length === 1 ? '' : 's'} missing or changed (${changed.slice(0, 3).join(', ')}${changed.length > 3 ? ', …' : ''})`
    })
  }

  let prompt: string | null = null
  try {
    prompt = (await fs.readFile(path.join(studioDirectory, PROMPT_FILE), 'utf-8')).replace(/\n$/, '')
  } catch {
    prompt = buildHandoffPrompt(manifest)
  }

  return { status: staleReasons.length > 0 ? 'stale' : 'ready', staleReasons, manifest, prompt }
}
