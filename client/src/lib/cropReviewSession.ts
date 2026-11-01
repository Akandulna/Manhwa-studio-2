import type { Clipper3CropEntry, Clipper3ImageCropFile } from './api'
import { seriesSlug, stemOf, exportedFilenameFor } from './clipper3Naming'

/**
 * Drops one crop's entry from a metadata document and renumbers what's left.
 *
 * The store treats this document as opaque text (it is written by whatever
 * template Settings holds), so this is best-effort by design: it only rewrites
 * a document that actually parses as JSON with a `crops` array, and returns
 * null for anything else rather than mangling it. A null result means the
 * caller leaves the metadata file untouched and says so.
 *
 * Renumbering matters because `exportedFilename` encodes a 1-based position
 * that the cutter regenerates from array order — after a removal, every later
 * entry's stored name would otherwise point at a file that never gets written.
 * Ids are deliberately NOT renumbered: they are the join key back to the crop
 * points file, and rewriting them would break that pairing.
 */
export function removeCropFromMetadata(
  metadataText: string,
  removedCropId: string,
  remainingCrops: Clipper3CropEntry[],
  opts: { seriesTitle: string; imageFilename: string }
): string | null {
  let parsed: any
  try {
    parsed = JSON.parse(metadataText)
  } catch {
    return null
  }
  if (!parsed || !Array.isArray(parsed.crops)) return null

  const slug = seriesSlug(opts.seriesTitle)
  const stem = stemOf(opts.imageFilename)

  const kept = parsed.crops.filter((entry: any) => entry?.id !== removedCropId)

  // Reason strings live in the POINTS file, not here, so the new filename is
  // rebuilt from the surviving crop entries in their post-removal order.
  const reasonById = new Map(remainingCrops.map(c => [c.id, c.reason]))
  const renumbered = kept.map((entry: any, index: number) => {
    if (typeof entry?.exportedFilename !== 'string') return entry
    return {
      ...entry,
      exportedFilename: exportedFilenameFor(slug, stem, index, reasonById.get(entry?.id))
    }
  })

  return JSON.stringify({ ...parsed, crops: renumbered }, null, 2)
}

export interface CropReviewPage {
  file: Clipper3ImageCropFile
  metadata: string
}

interface ReviewStore {
  putPoints: (filename: string, file: Clipper3ImageCropFile) => Promise<unknown>
  putMetadata: (filename: string, content: string) => Promise<unknown>
}

/** Chapter-local history and one serial autosave queue per page. */
export class CropReviewSession {
  pages: Record<string, CropReviewPage>
  readonly errors = new Map<string, string>()
  private history: { filename: string; before: CropReviewPage }[] = []
  private dirty = new Set<string>()
  private running = new Set<string>()
  private savedMetadata = new Map<string, string>()
  private uncertainMetadata = new Set<string>()

  constructor(
    pages: Record<string, CropReviewPage>,
    private seriesTitle: string,
    private store: ReviewStore,
    private changed: () => void
  ) {
    this.pages = pages
    Object.entries(pages).forEach(([filename, page]) => this.savedMetadata.set(filename, page.metadata))
  }

  get undoFilename() { return this.history[this.history.length - 1]?.filename }
  get pending() { return this.dirty.size > 0 || this.running.size > 0 }
  get saving() { return this.running.size > 0 }

  commit(filename: string, file: Clipper3ImageCropFile, removedCropId?: string) {
    const before = this.pages[filename]
    if (!before || JSON.stringify(before.file) === JSON.stringify(file)) return
    let metadata = before.metadata
    if (removedCropId && metadata.trim()) {
      const updated = removeCropFromMetadata(metadata, removedCropId, file.crops, {
        seriesTitle: this.seriesTitle,
        imageFilename: filename
      })
      if (updated == null) throw new Error('This page’s metadata could not be read. Reload it before removing crops.')
      metadata = updated
    }
    this.history.push({ filename, before })
    this.replace(filename, { file, metadata })
  }

  undo() {
    const edit = this.history.pop()
    if (!edit) return
    this.replace(edit.filename, edit.before)
    return edit.filename
  }

  retry() {
    for (const filename of this.dirty) this.save(filename)
  }

  private replace(filename: string, page: CropReviewPage) {
    this.pages = { ...this.pages, [filename]: page }
    this.dirty.add(filename)
    this.errors.delete(filename)
    this.save(filename)
    this.changed()
  }

  private save(filename: string) {
    if (this.running.has(filename)) return
    this.running.add(filename)
    this.errors.delete(filename)
    this.changed()
    void this.drain(filename)
  }

  private async drain(filename: string) {
    try {
      while (this.dirty.has(filename)) {
        const page = this.pages[filename]
        // A newer edit or Undo may arrive during either request. Never replace
        // the visible draft with an older response; save the latest draft next.
        await this.store.putPoints(filename, page.file)
        if (this.savedMetadata.get(filename) !== page.metadata || this.uncertainMetadata.has(filename)) {
          this.uncertainMetadata.add(filename)
          await this.store.putMetadata(filename, page.metadata)
          this.savedMetadata.set(filename, page.metadata)
          this.uncertainMetadata.delete(filename)
        }
        if (this.pages[filename] === page) this.dirty.delete(filename)
      }
    } catch (error) {
      this.errors.set(filename, error instanceof Error ? error.message : 'Could not save pointers')
    } finally {
      this.running.delete(filename)
      this.changed()
    }
  }
}
