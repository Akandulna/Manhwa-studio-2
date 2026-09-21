/**
 * Editor 2.0 — repairing timeline image references that name no file on disk.
 *
 * This is the correction behind the preview's "N image references could not be
 * found on disk".
 *
 * The refs come from the pasted timeline JSON, which is AI-authored: the model
 * is handed the chapter's crop metadata and asked to name images back, and the
 * names it returns drift. Observed, on real data:
 *
 *   - The REASON suffix is carried over from a neighbouring index:
 *     `page_001_11_full_width_tall_scene` where the file is
 *     `page_001_11_full_width_wide_scene` — `_tall_scene` is index 10's reason.
 *   - The name belongs to ANOTHER CHAPTER's crop set entirely. Every chapter
 *     has a `page_001`, so `page_001_08_inset_wide_scene` is a real file — in
 *     Chapter 001, while the timeline being previewed is Chapter 011. This one
 *     is the dangerous shape: it looks resolvable and is simply wrong.
 *
 * What never drifts is the PAGE and the INDEX. The cutter composes
 * `{slug}_{stem}_{NN}{_reason}.png`, and within one chapter `{stem}_{NN}` is
 * unique — it is the crop's identity, while the reason is a label the cut can
 * change. So a broken ref is matched on page + index against the chapter's own
 * crops3/ listing, and the whole name is replaced with the real one.
 *
 * Deliberately NOT repaired:
 *   - A ref whose page+index matches nothing in this chapter. That is a crop
 *     that was never written, and no rename produces a missing file — it needs
 *     a re-cut, and the scan says so rather than guessing at a neighbour.
 *   - A ref that already resolves. Correct names are left exactly alone.
 *
 * The repair rewrites the timeline JSON, which lives in the browser, so this
 * module is pure: it takes JSON in and hands corrected JSON back. Nothing on
 * disk is touched — the metadata documents are the cutter's own record and are
 * read here only as evidence of what exists.
 */

import fs from 'fs/promises'
import path from 'path'
import { prisma } from '../index.js'
import { getOutputDir } from './clipper3/perImageStore.js'

/** How a ref is written in the JSON: a bare filename, or "<page>/<crop id>". */
function refFilename(ref: string): string {
  // A pair ref ("page_002.webp/crop-01") names its crop after the slash. The
  // half before it is the source page, which is not a crops3 filename.
  const slash = ref.lastIndexOf('/')
  return slash >= 0 ? ref.slice(slash + 1) : ref
}

/**
 * The page stem and crop index a name carries, e.g. "page_001" + 11.
 *
 * This is the part of a crop filename that the cutter derives from the crop's
 * own position rather than from a label, so it is the part an AI cannot
 * meaningfully corrupt without naming a different crop outright.
 */
function pageIndexKey(name: string): string | null {
  const match = /(page[_-]?\d+)[_-](\d+)/i.exec(path.basename(name))
  if (!match) return null
  const page = match[1].toLowerCase().replace(/[_-]/g, '_')
  // The index is compared as a number so "08" and "8" are the same crop.
  return `${page}#${Number(match[2])}`
}

/** One timeline reference this run would rewrite, or did. */
export interface RepairedRef {
  /** The ref exactly as the JSON wrote it. */
  was: string
  /** The crops3 filename it will become. */
  now: string
  /** Where it appears, for the report: "Section 2 · 00:14.20 - 00:19.80". */
  where: string
}

/** One reference that names a crop this chapter does not have. */
export interface UnfixableRef {
  ref: string
  where: string
  /** Why no rename can help, in one phrase. */
  reason: string
}

/** What one chapter's scan or repair found. */
export interface CropRepairChapter {
  chapterId: string
  chapterNumber: number
  chapterTitle: string | null
  repaired: RepairedRef[]
  unfixable: UnfixableRef[]
  /**
   * The corrected timeline JSON, when anything was repaired. The client swaps
   * this in for the paste it holds — Editor 2.0 keeps the JSON in the browser,
   * so the correction has to travel back the same way.
   */
  correctedJson: string | null
  /** Why this chapter could not be examined, when it could not be. */
  error: string | null
}

export interface CropRepairResult {
  seriesId: string
  seriesTitle: string
  /** Only chapters with something to report; clean ones are left out. */
  chapters: CropRepairChapter[]
  repairedCount: number
  unfixableCount: number
  /** How many chapters carried a timeline to check, including clean ones. */
  chaptersChecked: number
}

/** One chapter's pasted timeline, as the client holds it. */
export interface CropRepairInput {
  chapterId: string
  json: string
}

/**
 * Check every supplied chapter's timeline JSON against the crops that chapter
 * actually has, and rewrite the references that name nothing.
 *
 * Read-only with respect to disk in every case. The corrected JSON comes back
 * in the result rather than being saved, so the caller decides whether to keep
 * it — which is what lets the same call serve both the scan and the fix.
 */
export async function repairSeriesTimelineRefs(
  seriesId: string,
  inputs: CropRepairInput[]
): Promise<CropRepairResult> {
  const series = await prisma.series.findUnique({
    where: { id: seriesId },
    select: { id: true, title: true }
  })
  if (!series) throw new Error('Series not found')

  const chapters = await prisma.chapter.findMany({
    where: { seriesId, id: { in: inputs.map(i => i.chapterId) } },
    orderBy: { number: 'asc' },
    select: { id: true, number: true, title: true, folderPath: true }
  })
  const byId = new Map(chapters.map(c => [c.id, c]))

  const result: CropRepairResult = {
    seriesId,
    seriesTitle: series.title,
    chapters: [],
    repairedCount: 0,
    unfixableCount: 0,
    chaptersChecked: 0
  }

  // Chapter order, not the order the client happened to send them in, so the
  // report reads the way the series does.
  for (const chapter of chapters) {
    const input = inputs.find(i => i.chapterId === chapter.id)
    if (!input) continue
    result.chaptersChecked++

    const entry: CropRepairChapter = {
      chapterId: chapter.id,
      chapterNumber: chapter.number,
      chapterTitle: chapter.title,
      repaired: [],
      unfixable: [],
      correctedJson: null,
      error: null
    }

    try {
      const found = await repairChapterTimeline(chapter.folderPath, input.json)
      entry.repaired = found.repaired
      entry.unfixable = found.unfixable
      entry.correctedJson = found.repaired.length > 0 ? found.json : null
    } catch (err) {
      entry.error = err instanceof Error ? err.message : String(err)
    }

    if (entry.repaired.length > 0 || entry.unfixable.length > 0 || entry.error) {
      result.chapters.push(entry)
      result.repairedCount += entry.repaired.length
      result.unfixableCount += entry.unfixable.length
    }
  }

  return result
}

/**
 * One chapter: every `selectedImages` entry checked against crops3/, and the
 * broken ones rewritten in place.
 *
 * The JSON is walked and mutated rather than rebuilt, so anything the shape
 * carries that this module does not model — extra fields, key order, sections
 * it has no opinion about — survives the round trip untouched.
 */
async function repairChapterTimeline(
  folderPath: string,
  rawJson: string
): Promise<{ json: string; repaired: RepairedRef[]; unfixable: UnfixableRef[] }> {
  let parsed: any
  try {
    parsed = JSON.parse(rawJson)
  } catch (err) {
    throw new Error(`Timeline JSON does not parse: ${err instanceof Error ? err.message : 'bad JSON'}`)
  }

  const outputDir = getOutputDir(folderPath)
  let outputs: string[]
  try {
    outputs = (await fs.readdir(outputDir)).filter(n => /\.(png|jpe?g|webp)$/i.test(n))
  } catch {
    throw new Error('This chapter has no crops3 folder — run "Crop Sections" in Image Clipper 3.0 first.')
  }

  // Exact names, for deciding whether a ref is broken at all.
  const onDisk = new Set(outputs)

  // page+index -> the real filename. Where a page was cut more than once and
  // two files share an index, the newest wins: that is the cut the user last
  // asked for, the same rule the timeline's own index uses.
  const byPageIndex = new Map<string, { filename: string; mtimeMs: number }>()
  for (const filename of outputs) {
    const key = pageIndexKey(filename)
    if (!key) continue
    let mtimeMs = 0
    try {
      mtimeMs = (await fs.stat(path.join(outputDir, filename))).mtimeMs
    } catch {
      // A file that vanished mid-scan simply loses the tie-break.
    }
    const seen = byPageIndex.get(key)
    if (!seen || mtimeMs > seen.mtimeMs) byPageIndex.set(key, { filename, mtimeMs })
  }

  const repaired: RepairedRef[] = []
  const unfixable: UnfixableRef[] = []

  const sections = Array.isArray(parsed?.sections) ? parsed.sections : []
  for (let s = 0; s < sections.length; s++) {
    const section = sections[s]
    const label = typeof section?.section === 'string' ? section.section : `Section ${s + 1}`
    const timelines = Array.isArray(section?.timelines) ? section.timelines : []

    for (const slot of timelines) {
      const slotLabel = typeof slot?.timeline === 'string' ? slot.timeline : ''
      const where = slotLabel ? `${label} · ${slotLabel}` : label
      const refs = slot?.selectedImages
      if (!Array.isArray(refs)) continue

      for (let i = 0; i < refs.length; i++) {
        const ref = refs[i]
        if (typeof ref !== 'string' || !ref.trim()) continue

        const named = refFilename(ref)
        // A ref that already names a real file is correct and is left alone.
        // Pair refs ("page_002.webp/crop-01") resolve through the metadata and
        // crop ids instead, which is a path this repair does not touch — a
        // crop id carries no reason suffix, so it cannot drift the way a
        // filename does.
        if (onDisk.has(named)) continue
        const key = pageIndexKey(named)
        if (!key) continue

        const real = byPageIndex.get(key)
        if (!real) {
          // Page and index name a crop this chapter never produced. Guessing a
          // neighbour here would put the WRONG PANEL in the video silently,
          // which is worse than the gap the preview already shows.
          unfixable.push({
            ref,
            where,
            reason: 'no crop with that page and index was cut for this chapter'
          })
          continue
        }

        refs[i] = real.filename
        repaired.push({ was: ref, now: real.filename, where })
      }
    }
  }

  // Two spaces, matching what the pasting side emits, so a corrected paste
  // does not read as wholly rewritten if the user compares it to the original.
  return { json: JSON.stringify(parsed, null, 2), repaired, unfixable }
}
