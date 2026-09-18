/**
 * Client-side mirror of the server's validateMetadata (perImageStore.ts), so
 * a paste can be rejected before the network round-trip instead of only after
 * the PUT fails. The server re-validates on every write and on every listing
 * regardless — this exists purely for instant feedback in the paste dialog.
 *
 * A metadata document is only meaningful once its crops[] ids match the
 * image's own crop points exactly: no id describing a crop that doesn't
 * exist, and no crop left undescribed. Keep this in sync with
 * server/src/services/clipper3/perImageStore.ts validateMetadata.
 *
 * It must ALSO name the right PAGE. A describing pass once emitted crops for
 * page_007 and page_010 carrying `page_011` filenames — the ids all matched,
 * so the document validated and the image was marked done, and the wrong names
 * surfaced only much later downstream when nothing on disk answered to them.
 * Because such a name points at a real-but-different page, it can collide with
 * that page's own crops instead of simply 404ing, so it is caught at paste
 * time here and called out as a page mismatch.
 *
 * Only the page stem is checked, never the whole filename. The rest of the
 * name embeds the crop's `reason` and its index, and re-cutting a page changes
 * both — so metadata written against the previous cut would be rejected in
 * full despite its descriptions still being good. Describing a page takes long
 * enough that a re-cut regularly lands in between, which made that the most
 * common failure by far. Ids survive a re-cut and are checked strictly above;
 * the mutable half of the name is not worth failing a paste over.
 */

export interface MetadataValidationResult {
  isValid: boolean
  errors: string[]
}

/**
 * The source-page stem encoded in an exported name, e.g. "page_007" or "003".
 *
 * The stem is whatever the source image was called, so it CANNOT be pattern
 * matched — an earlier version looked for a literal `page_\d+`, which meant
 * every series whose pages aren't named "page_NNN" (`003.webp`, `ch12_003.webp`)
 * produced an empty stem and silently skipped the page check entirely. Instead
 * the two known ends are peeled off: the `${slug}_` prefix and the `_NN` crop
 * index (plus its optional `_reason` tail) the cutter appends. What remains is
 * the stem, whatever it looks like.
 */
function stemOfExportedName(filename: string, slug?: string): string {
  let rest = filename.trim().replace(/\.[^/.]+$/, '')
  if (slug && rest.toLowerCase().startsWith(`${slug.toLowerCase()}_`)) {
    rest = rest.slice(slug.length + 1)
  }
  // Greedy stem, then the two-digit crop index, then an optional reason tail.
  const match = /^(.+)_(\d{2})(?:_[a-z0-9_]*)?$/.exec(rest)
  return match ? match[1] : rest
}

/**
 * The page a stem refers to, as a number, so zero-padding can't fail a paste:
 * "page_7" and "page_007" are the same page. Comparing the stems as raw text
 * rejected correct metadata whenever the padding differed.
 */
function pageNumberOf(stem: string): string {
  const match = /(\d+)\s*$/.exec(stem)
  return match ? String(Number(match[1])) : ''
}

/**
 * `expectedFilenames` is positional alongside `expectedCropIds` — build it with
 * exportedFilenameFor() so it matches what the cutter will write. Omit it (or
 * leave an entry empty) where the true name isn't known; those aren't checked.
 * `slug` is the series slug those names were built with — pass it so the stem
 * can be peeled off exactly instead of guessed, since a slug contains
 * underscores and cannot be told from the stem by pattern alone.
 */
export function validateMetadataJson(
  text: string,
  expectedCropIds: string[],
  expectedFilenames?: (string | null)[],
  slug?: string
): MetadataValidationResult {
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { isValid: false, errors: [`Invalid JSON: ${err instanceof Error ? err.message : 'could not parse'}`] }
  }

  if (!Array.isArray(parsed?.crops)) {
    return { isValid: false, errors: ['Metadata must have a "crops" array.'] }
  }

  const errors: string[] = []
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
    const sample =
      expectedFilenames.find((name): name is string => typeof name === 'string' && name.length > 0) ?? ''
    const expectedStem = stemOfExportedName(sample, slug)
    const expectedPage = pageNumberOf(expectedStem)

    // Page stem only — see the note above. A drifted suffix still points at
    // this page and is harmless; another page's stem can collide with that
    // page's real output.
    const wrongPage: string[] = []

    parsed.crops.forEach((entry: any, index: number) => {
      const actual = entry?.exportedFilename
      if (typeof actual !== 'string' || !actual.trim()) return
      if (!expectedPage) return

      const actualStem = stemOfExportedName(actual, slug)
      const actualPage = pageNumberOf(actualStem)
      // Compared as numbers, so "page_7" and "page_007" agree. A name with no
      // page number at all is left alone rather than guessed at.
      if (!actualPage || actualPage === expectedPage) return

      const label = typeof entry?.id === 'string' && entry.id.trim() ? entry.id : `entry ${index + 1}`
      wrongPage.push(`${label} -> ${actualStem}`)
    })

    // One line, not one per crop: a wrong-page paste is always a whole bad
    // batch, and per-crop lines overflow the toast and truncate mid-filename.
    if (wrongPage.length > 0) {
      errors.push(
        `${wrongPage.length} crop(s) name a different source page — this image is "${expectedStem}": ${wrongPage.join(', ')}.`
      )
    }
  }

  return { isValid: errors.length === 0, errors }
}
