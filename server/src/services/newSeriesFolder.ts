import { randomUUID } from 'node:crypto'
import { sanitizeTitle } from '../utils/urlPattern.js'
import { safeSegment } from './libraryManifest.js'

/** A deleted folder remains tombstoned on offline peers. Re-add under a fresh identity. */
export async function newSeriesFolder(
  title: string,
  deleted: (folder: string) => Promise<boolean>,
  reserved: (folder: string) => Promise<boolean>,
  freshId: () => string = randomUUID,
): Promise<string> {
  const base = sanitizeTitle(title)
  if (!safeSegment(base)) throw new Error('Give the series a valid title')
  if (!await deleted(base)) return base
  for (let attempt = 0; attempt < 10; attempt++) {
    const folder = `${base} (${freshId()})`
    if (!await reserved(folder)) return folder
  }
  throw new Error('Could not choose a fresh series folder. Please try again.')
}
