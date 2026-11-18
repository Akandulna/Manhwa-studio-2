/**
 * Final pointer file and Clipper 3.0 import for one AntiGravity page
 * (docs/PRD-antigravity-studio.md §11.3, §12).
 *
 * The pointer file matches what Sleeper-Cell's geometry export writes
 * (PageExport.finalize + pointerFile): reading order with a 12 px row
 * tolerance, ids crop-01…, rectangle points P1–P4, ratios rounded to 9
 * decimals, plus workflow "clipper-geometry/1" and the source SHA-256.
 *
 * The import mirrors the geometry-only branch of processedSync for a single
 * page: saved pointers are never replaced (except a pending explicit redo,
 * which the import then finishes), Studio-reviewed chapters are left alone,
 * the source hash and image identity must match, and the write goes through
 * writeImagePoints, so managed-page locks and review revocation still apply.
 * Nothing here marks a chapter reviewed or cropped, or writes Metadata.
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { readEffectiveReview } from '../clipper3/chapterReview.js'
import { finishPageRedo, readPageRedo } from '../clipper3/pageRedo.js'
import { extractCrops, getSourceFolderPath, readImagePoints, writeImagePoints, type Clipper3ImageCropFile } from '../clipper3/perImageStore.js'

export interface PageBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface FinalCropInput {
  reason: string
  bounds: PageBox
  /** Sideways art: the quarter turn that stands the cut crop upright. Absent = upright. */
  rotate?: 90 | -90
}

export const ROW_TOLERANCE_PX = 12
const sha256 = (data: Buffer | string) => crypto.createHash('sha256').update(data).digest('hex')

/** Stable insertion sort, same comparison as the phone's PageExport.readingOrder. */
export function readingOrder<T>(items: T[], bounds: (item: T) => PageBox): T[] {
  const compare = (a: PageBox, b: PageBox) => {
    const dy = a.y0 - b.y0
    if (Math.abs(dy) > ROW_TOLERANCE_PX) return dy
    return a.x0 - b.x0 !== 0 ? a.x0 - b.x0 : dy
  }
  const out = [...items]
  for (let i = 1; i < out.length; i++) {
    const item = out[i]
    let j = i - 1
    while (j >= 0 && compare(bounds(out[j]), bounds(item)) > 0) {
      out[j + 1] = out[j]
      j--
    }
    out[j + 1] = item
  }
  return out
}

/** BigDecimal(value).setScale(9, HALF_UP).stripTrailingZeros() as a JSON number. */
export function ratio(value: number): number {
  if (!Number.isFinite(value)) return 0
  const rounded = Math.round((value + Number.EPSILON) * 1e9) / 1e9
  return Object.is(rounded, -0) ? 0 : rounded
}

export const cropIdFor = (index: number) => `crop-${String(index + 1).padStart(2, '0')}`

export function validateBoxes(crops: FinalCropInput[], width: number, height: number): string[] {
  const problems: string[] = []
  crops.forEach((c, i) => {
    const b = c.bounds
    const ints = [b.x0, b.y0, b.x1, b.y1].every(Number.isInteger)
    if (!ints) problems.push(`crop ${i + 1}: corners must be whole pixels`)
    if (b.x0 < 0 || b.y0 < 0 || b.x1 > width || b.y1 > height) problems.push(`crop ${i + 1}: outside the ${width}×${height} page`)
    if (b.x1 <= b.x0 || b.y1 <= b.y0) problems.push(`crop ${i + 1}: needs positive width and height`)
  })
  return problems
}

export function buildPointerFile(crops: FinalCropInput[], image: { filename: string; width: number; height: number; sourceSha256: string }) {
  const problems = validateBoxes(crops, image.width, image.height)
  if (problems.length) throw new Error(`Invalid final geometry: ${problems.join('; ')}`)
  const ordered = readingOrder(crops, c => c.bounds)
  const file = {
    format: 'four-point-crop',
    version: '1.0',
    image: { filename: image.filename, width: image.width, height: image.height },
    coordinateSystem: 'normalized',
    crops: ordered.map((c, i) => {
      const x0 = ratio(c.bounds.x0 / image.width)
      const x1 = ratio(c.bounds.x1 / image.width)
      const y0 = ratio(c.bounds.y0 / image.height)
      const y1 = ratio(c.bounds.y1 / image.height)
      return {
        id: cropIdFor(i),
        reason: c.reason,
        crop: {
          mode: 'rectangle' as const,
          points: [
            { id: 'P1', x: x0, y: y0 },
            { id: 'P2', x: x1, y: y0 },
            { id: 'P3', x: x1, y: y1 },
            { id: 'P4', x: x0, y: y1 }
          ]
        },
        // Same as the phone's PageExport: only turned crops carry the key.
        ...(c.rotate === 90 || c.rotate === -90 ? { rotate: c.rotate } : {})
      }
    }),
    workflow: 'clipper-geometry/1' as const,
    sourceSha256: image.sourceSha256
  }
  const text = JSON.stringify(file, null, 2) + '\n'
  return { file, text, sha256: sha256(text) }
}

export type ImportOutcome =
  | { state: 'imported'; crops: number; finishedRedo: boolean }
  | { state: 'already_imported' }
  | { state: 'conflict'; reason: string }
  | { state: 'stale'; reason: string }

/** Fingerprint of the saved pointers for a page ("none" when there are none). */
export async function pointerFingerprint(folderPath: string, filename: string): Promise<string> {
  const current = await readImagePoints(folderPath, filename)
  return current ? sha256(current.text) : 'none'
}

const geometryKey = (f: Partial<Clipper3ImageCropFile> | null | undefined) => JSON.stringify([f?.workflow, f?.sourceSha256, f?.image, f?.coordinateSystem, f?.crops])

/** Is the page's saved geometry still exactly this result? (receivedAt and formatting ignored) */
export async function compareWithSaved(folderPath: string, filename: string, pointer: Partial<Clipper3ImageCropFile>): Promise<'same' | 'different' | 'missing'> {
  const current = await readImagePoints(folderPath, filename)
  if (!current?.file) return 'missing'
  return geometryKey(current.file) === geometryKey(pointer) ? 'same' : 'different'
}

export async function importPointerFile(input: {
  folderPath: string
  filename: string
  pointer: ReturnType<typeof buildPointerFile>['file']
  /** Saved-pointer fingerprint captured when the job started. */
  preexisting: string
}): Promise<ImportOutcome> {
  const { folderPath, filename, pointer } = input
  const bytes = await fs.readFile(path.join(getSourceFolderPath(folderPath), filename)).catch(() => null)
  if (!bytes) return { state: 'stale', reason: 'The source page no longer exists.' }
  if (sha256(bytes) !== pointer.sourceSha256) return { state: 'stale', reason: 'The source page changed after this job started.' }

  const current = await readImagePoints(folderPath, filename)
  if (current?.file && geometryKey(current.file) === geometryKey(pointer)) return { state: 'already_imported' }

  const redo = await readPageRedo(folderPath, filename)
  const replacingRejected = redo?.status === 'pending'
  const now = current ? sha256(current.text) : 'none'
  if (current && !replacingRejected) {
    return { state: 'conflict', reason: 'Saved pointers exist for this page; they were preserved. Use the explicit redo to replace them.' }
  }
  if (now !== input.preexisting && !replacingRejected) {
    return { state: 'conflict', reason: 'This page\'s pointers changed while the job ran; the newer saved work was preserved.' }
  }
  const review = await readEffectiveReview(folderPath)
  if (review.reviewed && (review.by === 'desktop' || review.by === 'cropped') && !replacingRejected) {
    return { state: 'conflict', reason: 'The chapter is already human-reviewed in Studio; its geometry was preserved.' }
  }

  const artifact: Clipper3ImageCropFile = { ...pointer, receivedAt: new Date().toISOString(),
    // The redo these pointers answer, as the phone import records it; Metadata jobs and Editor rely on it.
    ...(replacingRejected && redo ? { studioRedoRevision: redo.revision } : {}) } as Clipper3ImageCropFile
  const crops = extractCrops(artifact)
  if (crops.length !== pointer.crops.length) throw new Error('Final pointer file did not round-trip through Clipper\'s reader.')
  await writeImagePoints(folderPath, filename, artifact)
  if (replacingRejected && redo) await finishPageRedo(folderPath, redo)
  return { state: 'imported', crops: crops.length, finishedRedo: replacingRejected }
}
