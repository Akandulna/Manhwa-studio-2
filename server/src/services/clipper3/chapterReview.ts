/**
 * Image Clipper 3.0 — whether a whole chapter's crops have been reviewed.
 *
 * Crop JSON made on a clipping phone is a first draft. Before any PNG is cut
 * for a chapter, somebody looks at every page of it — on the Master phone
 * (which re-uploads the chapter zip with corrected JSON and a `review` object
 * in chapter.json) or here in Preview — and marks it reviewed. Cropping is
 * refused until then (POST /chapters/:id/crop).
 *
 * The record is one file in the chapter folder, beside crop_points3/ and
 * friends, so it travels with the chapter like the rest of Clipper 3.0's
 * state and needs no database row:
 *
 *     <chapter folder>/.clipper3-review.json
 *
 * A review marked on the Master phone (`by: 'phone'`) also lets Sync json cut
 * the chapter straight away (chapterCrop.ts queueAutoCrop).
 *
 * Cropped counts as reviewed. Chapters cut in Manhwa Studio before reviews
 * existed were looked over by the user as they were cut, so a chapter with
 * crops3/ output is reviewed (`by: 'cropped'`) unless its record says "not
 * reviewed" and was written AFTER the newest cut — new phone crops arrived
 * since, and those haven't been looked at. `readEffectiveReview` is that
 * rule; it is what the UI and the crop gate use.
 */

import fs from 'fs/promises'
import path from 'path'
import { getSourceFolderPath, latestOutputTime } from './perImageStore.js'

export const CHAPTER_REVIEW_FILE = '.clipper3-review.json'

/** Longest device name kept; it is only ever shown, never matched. */
const MAX_DEVICE = 120
/** More page folders than any chapter has; a longer list is not one of ours. */
const MAX_EDITED_PAGES = 2000

export interface ChapterReview {
  reviewed: boolean
  reviewedAt: string | null
  /**
   * Where it was marked: the Master phone (via its zip), the desktop's
   * Preview, or — effective review only — implied by the chapter being cut.
   */
  by: 'phone' | 'desktop' | 'cropped' | null
  /** The phone's name, for "reviewed on <device>". Phone reviews only. */
  device?: string
  /** The R2 zip ETag the phone review arrived in, so it can be traced to one upload. */
  etag?: string
  editedPages?: string[]
  movedCrops?: number
  deletedCrops?: number
  /** Effective review only: crops3/ holds output for this chapter. */
  cropped?: boolean
  /** Effective review only: when the newest file in crops3/ was cut. */
  croppedAt?: string | null
}

/** A fresh copy each time, so no caller can mutate the shared default. */
export function notReviewed(): ChapterReview {
  return { reviewed: false, reviewedAt: null, by: null }
}

/** The phone's own review, as read out of chapter.json. */
export interface ManifestReview {
  reviewedAt: string | null
  device?: string
  editedPages: string[]
  movedCrops: number
  deletedCrops: number
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const time = Date.parse(value)
  return Number.isNaN(time) ? null : new Date(time).toISOString()
}

/**
 * The `review` object of a phone chapter.json, or null when the chapter is
 * not reviewed.
 *
 * Only `reviewed: true` counts. A clipping phone's zip has no `review` at all,
 * and anything short of an explicit true (a string, a missing flag) is read as
 * "not reviewed" — the safe direction, since this gates cutting. The other
 * fields are only shown, so a bad one is dropped rather than failing the
 * whole review.
 */
export function parseManifestReview(manifest: unknown): ManifestReview | null {
  const review = (manifest as { review?: unknown } | null)?.review
  if (!review || typeof review !== 'object' || (review as { reviewed?: unknown }).reviewed !== true) return null
  const r = review as Record<string, unknown>

  const device = typeof r.device === 'string' ? r.device.trim().slice(0, MAX_DEVICE) : ''
  const editedPages = Array.isArray(r.edited_pages)
    ? r.edited_pages
        .filter((p): p is string => typeof p === 'string' && p.length > 0 && p.length <= 64)
        .slice(0, MAX_EDITED_PAGES)
    : []

  return {
    reviewedAt: isoOrNull(r.reviewed_at),
    ...(device ? { device } : {}),
    editedPages,
    movedCrops: count(r.moved_crops),
    deletedCrops: count(r.deleted_crops)
  }
}

function reviewFilePath(folderPath: string): string {
  return path.join(getSourceFolderPath(folderPath), CHAPTER_REVIEW_FILE)
}

/**
 * The chapter's review record; "not reviewed" when there is none.
 *
 * Read permissively and re-shaped, because the file can be hand-edited: a
 * record that doesn't say `reviewed: true` in so many words is not a review.
 */
export async function readChapterReview(folderPath: string): Promise<ChapterReview> {
  return (await readReviewRecord(folderPath)).review
}

/**
 * The record plus when it was written: its own `updatedAt` stamp, or the
 * file's modification time for a record written before the stamp existed.
 * `writtenAt` is null when there is no record.
 */
async function readReviewRecord(folderPath: string): Promise<{ review: ChapterReview; writtenAt: number | null }> {
  let raw: any
  let writtenAt: number | null = null
  try {
    const file = reviewFilePath(folderPath)
    raw = JSON.parse(await fs.readFile(file, 'utf-8'))
    const stamped = typeof raw?.updatedAt === 'string' ? Date.parse(raw.updatedAt) : NaN
    writtenAt = Number.isNaN(stamped) ? (await fs.stat(file)).mtimeMs : stamped
  } catch {
    return { review: notReviewed(), writtenAt }
  }
  return { review: shapeRecord(raw), writtenAt }
}

function shapeRecord(raw: any): ChapterReview {
  if (raw?.reviewed !== true) return notReviewed()

  const review: ChapterReview = {
    reviewed: true,
    reviewedAt: isoOrNull(raw.reviewedAt),
    by: raw.by === 'phone' || raw.by === 'desktop' ? raw.by : null
  }
  if (typeof raw.device === 'string' && raw.device) review.device = raw.device.slice(0, MAX_DEVICE)
  if (typeof raw.etag === 'string' && raw.etag) review.etag = raw.etag
  if (Array.isArray(raw.editedPages)) {
    review.editedPages = raw.editedPages.filter((p: unknown): p is string => typeof p === 'string').slice(0, MAX_EDITED_PAGES)
  }
  if (raw.movedCrops !== undefined) review.movedCrops = count(raw.movedCrops)
  if (raw.deletedCrops !== undefined) review.deletedCrops = count(raw.deletedCrops)
  return review
}

/**
 * The review that counts, from the record, when it was written and when the
 * chapter was last cut (null: never). Pure, so the rule is tested on its own.
 *
 *  - an explicit review stands, whether or not the chapter is cut;
 *  - a cut chapter is reviewed (`by: 'cropped'`, reviewed when it was cut)…
 *  - …unless the record says not reviewed and is newer than the cut: a
 *    clipping phone's fresh zip reset it, so the cut shows old content.
 *
 * `cropped` / `croppedAt` are set on every result.
 */
export function effectiveReview(record: ChapterReview, writtenAt: number | null, croppedAtMs: number | null): ChapterReview {
  const croppedAt = croppedAtMs != null ? new Date(croppedAtMs).toISOString() : null
  const base: ChapterReview = { ...record, cropped: croppedAt != null, croppedAt }
  if (record.reviewed || croppedAtMs == null) return base
  if (writtenAt != null && writtenAt > croppedAtMs) return base
  return { ...base, reviewed: true, reviewedAt: croppedAt, by: 'cropped' }
}

/** The chapter's effective review (see `effectiveReview`): what the UI shows and the crop gate checks. */
export async function readEffectiveReview(folderPath: string): Promise<ChapterReview> {
  const { review, writtenAt } = await readReviewRecord(folderPath)
  return effectiveReview(review, writtenAt, await latestOutputTime(folderPath))
}

/**
 * Replaces the chapter's review record. Written to a temp file and renamed,
 * so a crash mid-write can't leave half a record that reads as "not
 * reviewed" (or worse, parses as something else).
 */
export async function writeChapterReview(folderPath: string, review: ChapterReview): Promise<ChapterReview> {
  const target = reviewFilePath(folderPath)
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.tmp`
  // Stamped so the effective review can tell a reset written after a cut
  // from one written before it; not part of the returned review.
  const stamped = { ...review, updatedAt: new Date().toISOString() }
  await fs.writeFile(temp, JSON.stringify(stamped, null, 2) + '\n', 'utf-8')
  await fs.rename(temp, target)
  return review
}

/** The desktop's own Mark reviewed / Unmark, from Preview. */
export async function setDesktopReview(folderPath: string, reviewed: boolean): Promise<ChapterReview> {
  return writeChapterReview(
    folderPath,
    reviewed ? { reviewed: true, reviewedAt: new Date().toISOString(), by: 'desktop' } : notReviewed()
  )
}
