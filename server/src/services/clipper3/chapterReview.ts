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
 * Not to be confused with Crop Studio's per-page `review-state.json`
 * (reviewState.ts), which is the working copy of one page's crops.
 */

import fs from 'fs/promises'
import path from 'path'
import { getSourceFolderPath } from './perImageStore.js'

export const CHAPTER_REVIEW_FILE = '.clipper3-review.json'

/** Longest device name kept; it is only ever shown, never matched. */
const MAX_DEVICE = 120
/** More page folders than any chapter has; a longer list is not one of ours. */
const MAX_EDITED_PAGES = 2000

export interface ChapterReview {
  reviewed: boolean
  reviewedAt: string | null
  /** Where it was marked: the Master phone (via its zip) or the desktop's Preview. */
  by: 'phone' | 'desktop' | null
  /** The phone's name, for "reviewed on <device>". Phone reviews only. */
  device?: string
  /** The R2 zip ETag the phone review arrived in, so it can be traced to one upload. */
  etag?: string
  editedPages?: string[]
  movedCrops?: number
  deletedCrops?: number
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
  let raw: any
  try {
    raw = JSON.parse(await fs.readFile(reviewFilePath(folderPath), 'utf-8'))
  } catch {
    return notReviewed()
  }
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
 * Replaces the chapter's review record. Written to a temp file and renamed,
 * so a crash mid-write can't leave half a record that reads as "not
 * reviewed" (or worse, parses as something else).
 */
export async function writeChapterReview(folderPath: string, review: ChapterReview): Promise<ChapterReview> {
  const target = reviewFilePath(folderPath)
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.tmp`
  await fs.writeFile(temp, JSON.stringify(review, null, 2) + '\n', 'utf-8')
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
