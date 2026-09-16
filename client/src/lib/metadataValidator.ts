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
 * It must ALSO name the right files. A describing pass once emitted crops for
 * page_007 and page_010 carrying `page_011` filenames — the ids all matched,
 * so the document validated and the image was marked done, and the wrong names
 * surfaced only much later downstream when nothing on disk answered to them.
 * Because such a name points at a real-but-different page, it can collide with
 * that page's own crops instead of simply 404ing, so it is caught at paste
 * time here and called out as a page mismatch.
 */

export interface MetadataValidationResult {
  isValid: boolean
  errors: string[]
}

/** The source-page stem encoded in an exported name, e.g. "page_007". */
function stemOfExportedName(filename: string): string {
  const match = /_(page_\d+)_\d{2}(?:_|\.)/.exec(filename)
  return match ? match[1] : ''
}

/**
 * `expectedFilenames` is positional alongside `expectedCropIds` — build it with
 * exportedFilenameFor() so it matches what the cutter will write. Omit it (or
 * leave an entry empty) where the true name isn't known; those aren't checked.
 */
export function validateMetadataJson(
  text: string,
  expectedCropIds: string[],
  expectedFilenames?: (string | null)[]
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

      if (expectedStem && actualStem && actualStem !== expectedStem) {
        errors.push(
          `Crop "${label}" names source page "${actualStem}" but this image is "${expectedStem}" — expected "${want}", got "${actual}".`
        )
      } else {
        errors.push(`Crop "${label}" has exportedFilename "${actual}" but the cutter will write "${want}".`)
      }
    })
  }

  return { isValid: errors.length === 0, errors }
}
