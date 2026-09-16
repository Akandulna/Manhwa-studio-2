/**
 * Image Clipper 3.0 — per-image crop artifacts on disk.
 *
 * The 2.0 model treats a chapter as ONE stitched canvas: a single
 * crop_points.json whose coordinates are normalized against the combined page.
 * 3.0 is deliberately different — each source image is its own independent
 * unit:
 *
 *  - Each image gets its own JSON file, named after the image.
 *  - Its coordinates are normalized 0.0–1.0 against THAT IMAGE alone. There is
 *    no stitching, no canvas offset, and no cross-image coordinate space.
 *  - An image is "done" if and only if its own JSON exists. Nothing is inferred
 *    from geometry, and one image's crops can never imply another's state.
 *
 * That last property is the whole reason this module exists separately from
 * clipper2/pointerStore: sharing the chapter-wide artifact made one page's
 * paste leak into every other page's status.
 *
 * Paths and bytes only — no express, no image decoding.
 */

import fs from 'fs/promises'
import path from 'path'

/** Mirrors clipperService.getFullFolderPath / clipper2's pointerStore. */
function getFullFolderPath(relativePath: string): string {
  const downloadRoot = process.env.DOWNLOAD_ROOT || './downloads'
  return path.join(downloadRoot, relativePath)
}

/** The chapter's source images. */
export function getSourceFolderPath(folderPath: string): string {
  return getFullFolderPath(folderPath)
}

/** Where the per-image JSONs live. Distinct from 2.0's `crop_points/`. */
export function getPointsDir(folderPath: string): string {
  return path.join(getFullFolderPath(folderPath), 'crop_points3')
}

/**
 * Where each image's metadata document lives. Kept beside the crop JSONs but in
 * its own directory: an image needs BOTH before it counts as done, and keeping
 * them apart means neither read has to filter the other's files out.
 */
export function getMetadataDir(folderPath: string): string {
  return path.join(getFullFolderPath(folderPath), 'crop_metadata3')
}

/** Cut sections land here. Distinct from v1's `crops/` and 2.0's `crops2/`. */
export function getOutputDir(folderPath: string): string {
  return path.join(getFullFolderPath(folderPath), 'crops3')
}

/**
 * The JSON filename for one source image: the image's own name with its
 * extension swapped for `.json`, so `page_003.webp` -> `page_003.json`.
 *
 * Guards against path traversal: an image filename arrives from the client, and
 * only a bare basename may ever be turned into a path under the points dir.
 */
export function pointsFileNameFor(imageFilename: string): string {
  const base = path.basename(imageFilename)
  if (!base || base === '.' || base === '..') {
    throw new Error(`Unusable image filename: ${imageFilename}`)
  }
  return `${base.replace(/\.[^/.]+$/, '')}.json`
}

export function getPointsFilePathFor(folderPath: string, imageFilename: string): string {
  return path.join(getPointsDir(folderPath), pointsFileNameFor(imageFilename))
}

/**
 * The metadata filename for one source image. Stored as `.txt` because the
 * metadata document is free-form — it is whatever the template in Settings
 * produced — and is never parsed, only kept and handed back.
 */
export function metadataFileNameFor(imageFilename: string): string {
  const base = path.basename(imageFilename)
  if (!base || base === '.' || base === '..') {
    throw new Error(`Unusable image filename: ${imageFilename}`)
  }
  return `${base.replace(/\.[^/.]+$/, '')}.txt`
}

export function getMetadataFilePathFor(folderPath: string, imageFilename: string): string {
  return path.join(getMetadataDir(folderPath), metadataFileNameFor(imageFilename))
}

// ============ Artifact shape ============

export interface Clipper3Point {
  id: string
  /** Normalized against THIS IMAGE, never a stitched canvas. */
  x: number
  y: number
}

export interface Clipper3CropEntry {
  id: string
  reason: string
  crop: {
    mode: 'rectangle' | 'perspective'
    points: Clipper3Point[]
  }
}

/** One image's artifact. `image` describes that single source file. */
export interface Clipper3ImageCropFile {
  format: string
  version: string
  image: {
    filename: string
    width?: number
    height?: number
  }
  coordinateSystem: string
  crops: Clipper3CropEntry[]
  /** When this JSON was received. Provenance, not part of the crop contract. */
  receivedAt?: string
}

/**
 * Pulls crop entries out of whatever shape was stored.
 *
 * The client validates and normalizes before storing, but the file is a
 * user-visible artifact that can be hand-edited, so the read path stays
 * permissive about container shape and strict about what a crop must contain.
 */
export function extractCrops(file: Clipper3ImageCropFile | null): Clipper3CropEntry[] {
  if (!file || !Array.isArray(file.crops)) return []
  return file.crops.filter(
    entry =>
      entry &&
      entry.crop &&
      Array.isArray(entry.crop.points) &&
      entry.crop.points.length === 4 &&
      entry.crop.points.every(p => Number.isFinite(p?.x) && Number.isFinite(p?.y))
  )
}

// ============ Metadata validation ============

/**
 * Slug rules mirrored EXACTLY from perImageCrop.ts (`slugify`, 60-char cap)
 * and routes/clipper3.ts (`seriesSlug`, 40-char cap). If those change, these
 * must change with them — a name built by different rules would flag correct
 * metadata as wrong, which is worse than not checking at all.
 */
function reasonSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'crop'
}

/** The source-page stem encoded in an exported name, e.g. "page_007". */
function stemOfExportedName(filename: string): string {
  const match = /_(page_\d+)_\d{2}(?:_|\.)/.exec(filename)
  return match ? match[1] : ''
}

/**
 * The exact filenames perImageCrop.ts will write for `crops`, in order.
 *
 * This is the single source of truth the metadata check compares against, so
 * it deliberately reuses the cutter's own composition:
 *   {slug}_{stem}_{NN}{_reason}.png
 */
export function expectedExportedFilenames(
  slug: string,
  imageFilename: string,
  crops: { reason?: string | null }[]
): string[] {
  const stem = path.basename(imageFilename).replace(/\.[^/.]+$/, '')
  return crops.map((entry, i) => {
    const reasonPart = entry?.reason ? `_${reasonSlug(entry.reason)}` : ''
    return `${slug}_${stem}_${String(i + 1).padStart(2, '0')}${reasonPart}.png`
  })
}


export interface MetadataValidation {
  isValid: boolean
  /** Human-readable reasons, for surfacing in the UI and API error bodies. */
  errors: string[]
}

/**
 * A metadata document is only meaningful once it actually describes the crops
 * it claims to — it is what removeCropFromMetadata (client-side) and any
 * future tooling key off of `crops[].id` to match against the points file, so
 * an id that doesn't exist there (or a crop that has no metadata entry at all)
 * would silently desync the two files.
 *
 * Checked here, not just accepted verbatim as before:
 *   1. Parses as JSON.
 *   2. Has a `crops` array.
 *   3. Every entry has a non-empty string `id`, with no duplicates.
 *   4. The set of ids matches the points file's crop ids EXACTLY — no id
 *      pointing at a crop that doesn't exist, and no crop left undescribed.
 *
 *   5. Every `exportedFilename`, when present, is the name the cutter will
 *      actually write for that crop — see expectedExportedFilenames.
 *
 * Check 5 exists because of a real failure: a describing pass emitted crops
 * for page_007 and page_010 carrying `page_011` filenames. Ids matched, so the
 * document validated and the image was marked done; the names only broke much
 * later, downstream, when nothing on disk answered to them. A filename that
 * names the wrong source page is the one error this shape can carry silently,
 * so it is caught here rather than at render time.
 *
 * `expectedCropIds` is the points file's own crop ids (already validated by
 * extractCrops), so this never invents its own idea of what a crop id is.
 * `expectedFilenames` is positional alongside it; omit it (or leave an entry
 * null) where the true name isn't known, and that entry is simply not checked.
 */
export function validateMetadata(
  text: string,
  expectedCropIds: string[],
  expectedFilenames?: (string | null)[]
): MetadataValidation {
  const errors: string[] = []

  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { isValid: false, errors: [`Invalid JSON: ${err instanceof Error ? err.message : 'could not parse'}`] }
  }

  if (!Array.isArray(parsed?.crops)) {
    return { isValid: false, errors: ['Metadata must have a "crops" array.'] }
  }

  const ids: string[] = []
  parsed.crops.forEach((entry: any, index: number) => {
    if (typeof entry?.id !== 'string' || !entry.id.trim()) {
      errors.push(`Entry ${index + 1} is missing a non-empty "id".`)
      return
    }
    ids.push(entry.id)
  })

  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) errors.push(`Duplicate crop id "${id}" in metadata.`)
    seen.add(id)
  }

  const expected = new Set(expectedCropIds)
  const unknown = [...new Set(ids)].filter(id => !expected.has(id))
  const missing = expectedCropIds.filter(id => !seen.has(id))

  if (unknown.length > 0) {
    errors.push(`Metadata describes crop id(s) not in this image's points: ${unknown.join(', ')}.`)
  }
  if (missing.length > 0) {
    errors.push(`Metadata is missing crop id(s) from this image's points: ${missing.join(', ')}.`)
  }

  if (expectedFilenames && expectedFilenames.length > 0) {
    const expectedStem = stemOfExportedName(
      expectedFilenames.find((name): name is string => typeof name === 'string' && name.length > 0) ?? ''
    )

    parsed.crops.forEach((entry: any, index: number) => {
      const actual = entry?.exportedFilename
      if (typeof actual !== 'string' || !actual.trim()) return

      const want = expectedFilenames[index]
      if (typeof want !== 'string' || !want) return
      if (actual === want) return

      const label = typeof entry?.id === 'string' && entry.id.trim() ? entry.id : `entry ${index + 1}`
      const actualStem = stemOfExportedName(actual)

      // Called out separately because it is the dangerous one: the name refers
      // to a DIFFERENT source page, so it can collide with that page's real
      // crops instead of simply not existing.
      if (expectedStem && actualStem && actualStem !== expectedStem) {
        errors.push(
          `Crop "${label}" has exportedFilename "${actual}", which belongs to source page "${actualStem}" — this image is "${expectedStem}". Expected "${want}".`
        )
      } else {
        errors.push(`Crop "${label}" has exportedFilename "${actual}" but the cutter will write "${want}".`)
      }
    })
  }

  return { isValid: errors.length === 0, errors }
}

// ============ Read / write ============

async function ensurePointsDir(folderPath: string): Promise<void> {
  await fs.mkdir(getPointsDir(folderPath), { recursive: true })
}

export async function readImagePoints(
  folderPath: string,
  imageFilename: string
): Promise<{ text: string; file: Clipper3ImageCropFile | null } | null> {
  let text: string
  try {
    text = await fs.readFile(getPointsFilePathFor(folderPath, imageFilename), 'utf-8')
  } catch {
    return null
  }

  try {
    return { text, file: JSON.parse(text) as Clipper3ImageCropFile }
  } catch {
    // Present but unparseable. The caller decides whether that is "done" — it
    // is not, but the bytes still matter for showing the user what is wrong.
    return { text, file: null }
  }
}

export async function writeImagePoints(
  folderPath: string,
  imageFilename: string,
  file: Clipper3ImageCropFile
): Promise<string> {
  await ensurePointsDir(folderPath)
  const target = getPointsFilePathFor(folderPath, imageFilename)
  await fs.writeFile(target, JSON.stringify(file, null, 2), 'utf-8')
  return path.resolve(target)
}

export async function deleteImagePoints(folderPath: string, imageFilename: string): Promise<boolean> {
  try {
    await fs.unlink(getPointsFilePathFor(folderPath, imageFilename))
    return true
  } catch {
    return false
  }
}

// ============ Metadata ============

/** One image's metadata document, verbatim. Never parsed — stored and returned as-is. */
export async function readImageMetadata(
  folderPath: string,
  imageFilename: string
): Promise<string | null> {
  try {
    return await fs.readFile(getMetadataFilePathFor(folderPath, imageFilename), 'utf-8')
  } catch {
    return null
  }
}

export async function writeImageMetadata(
  folderPath: string,
  imageFilename: string,
  content: string
): Promise<string> {
  await fs.mkdir(getMetadataDir(folderPath), { recursive: true })
  const target = getMetadataFilePathFor(folderPath, imageFilename)
  await fs.writeFile(target, content, 'utf-8')
  return path.resolve(target)
}

export async function deleteImageMetadata(folderPath: string, imageFilename: string): Promise<boolean> {
  try {
    await fs.unlink(getMetadataFilePathFor(folderPath, imageFilename))
    return true
  } catch {
    return false
  }
}

/** Every image stem that currently has a metadata document on disk. */
export async function listMetadataImageStems(folderPath: string): Promise<Set<string>> {
  const dir = getMetadataDir(folderPath)
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return new Set()
  }
  return new Set(
    entries
      .filter(name => name.toLowerCase().endsWith('.txt'))
      .map(name => name.replace(/\.txt$/i, ''))
  )
}

/**
 * Every image filename that currently has an artifact on disk.
 *
 * Returned as the JSON basenames (no extension) so the caller can match them
 * against manifest image names regardless of image extension — `page_003.json`
 * answers for `page_003.webp` just as well as `page_003.png`.
 */
export async function listPointedImageStems(folderPath: string): Promise<Set<string>> {
  const dir = getPointsDir(folderPath)
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return new Set()
  }
  return new Set(
    entries
      .filter(name => name.toLowerCase().endsWith('.json'))
      .map(name => name.replace(/\.json$/i, ''))
  )
}

/** The stem used to match an image against a stored artifact. */
export function stemOf(imageFilename: string): string {
  return path.basename(imageFilename).replace(/\.[^/.]+$/, '')
}

// ============ Outputs ============

export async function listOutputs(folderPath: string): Promise<{ filename: string; bytes: number }[]> {
  const dir = getOutputDir(folderPath)
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }

  const files: { filename: string; bytes: number }[] = []
  for (const filename of names.sort()) {
    if (!/\.(png|jpe?g|webp)$/i.test(filename)) continue
    try {
      const stat = await fs.stat(path.join(dir, filename))
      files.push({ filename, bytes: stat.size })
    } catch {
      // A file that vanished between readdir and stat is simply not listed.
    }
  }
  return files
}
