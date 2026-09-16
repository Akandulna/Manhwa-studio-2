/**
 * Output-filename rules for Image Clipper 3.0, mirrored EXACTLY from the
 * server so anything the UI shows or writes matches what the cutter produces.
 *
 *  - seriesSlug  -> routes/clipper3.ts seriesSlug()      (40-char cap)
 *  - reasonSlug  -> services/clipper3/perImageCrop.ts    (60-char cap)
 *
 * Keeping the caps matters: a long title or reason truncates on disk, and a
 * name generated without them would refer to a file that never exists.
 *
 * Shared by Clipper3ImageList (the export-context block handed to the
 * describing AI) and CropPointerEditor (renumbering metadata after a crop is
 * removed) so the two can never drift.
 */

export function seriesSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'series'
}

export function reasonSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'crop'
}

export function stemOf(filename: string): string {
  return filename.replace(/\.[^/.]+$/, '')
}

/**
 * The exact filename perImageCrop.ts will produce for crop `index` (0-based).
 * The reason suffix comes from the CROP JSON, never from the describing AI.
 */
export function exportedFilenameFor(
  slug: string,
  stem: string,
  index: number,
  reason?: string
): string {
  const reasonPart = reason && reason.trim() ? `_${reasonSlug(reason)}` : ''
  return `${slug}_${stem}_${String(index + 1).padStart(2, '0')}${reasonPart}.png`
}
