/**
 * Run automation → Metadata's part selection: the same fixed twenty-chapter
 * parts as the Library and the phone (PART_CHAPTERS in the server's
 * seriesProcessModel.ts, ToolPartGroups on the phone), so "Part 2" is
 * Chapters 21–40 and nothing from Part 1 is listed, checked or sent.
 */

export const PART_CHAPTERS = 20

export type MetadataPartChoice = number | 'all'

export interface MetadataChapter {
  name: string
  number: number
}

export interface MetadataBlockedChapter extends MetadataChapter {
  id: string
  reason: string
}

export interface MetadataPart {
  part: number
  from: number
  to: number
  ready: MetadataChapter[]
  blocked: MetadataBlockedChapter[]
}

/** Chapter 20 is Part 1, 20.5 and 21 are Part 2. */
export function partOf(number: number): number {
  return Math.max(1, Math.ceil(number / PART_CHAPTERS))
}

const byNumber = <T extends MetadataChapter>(a: T, b: T) => a.number - b.number

/**
 * The series' parts that have any chapter the check saw, in order. `keep` is
 * a part picked before that has since lost its chapters: it stays listed
 * (empty) rather than the selection moving to another part.
 */
export function metadataParts(ready: MetadataChapter[], blocked: MetadataBlockedChapter[], keep?: MetadataPartChoice | null): MetadataPart[] {
  const parts = new Map<number, MetadataPart>()
  const get = (part: number) => {
    let entry = parts.get(part)
    if (!entry) {
      entry = { part, from: (part - 1) * PART_CHAPTERS + 1, to: part * PART_CHAPTERS, ready: [], blocked: [] }
      parts.set(part, entry)
    }
    return entry
  }
  for (const chapter of ready) get(partOf(chapter.number)).ready.push(chapter)
  for (const chapter of blocked) get(partOf(chapter.number)).blocked.push(chapter)
  if (typeof keep === 'number') get(keep)
  return [...parts.values()]
    .sort((a, b) => a.part - b.part)
    .map(p => ({ ...p, ready: [...p.ready].sort(byNumber), blocked: [...p.blocked].sort(byNumber) }))
}

/** The earliest part with a chapter ready for metadata; else the earliest part; else all. */
export function defaultMetadataPart(parts: MetadataPart[]): MetadataPartChoice {
  return parts.find(p => p.ready.length)?.part ?? parts[0]?.part ?? 'all'
}

/** The ready and blocked chapters of the chosen part (or every part). */
export function scopeMetadata(parts: MetadataPart[], choice: MetadataPartChoice): { ready: MetadataChapter[]; blocked: MetadataBlockedChapter[] } {
  const chosen = choice === 'all' ? parts : parts.filter(p => p.part === choice)
  return { ready: chosen.flatMap(p => p.ready), blocked: chosen.flatMap(p => p.blocked) }
}
