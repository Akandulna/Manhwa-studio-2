import fs from 'fs/promises'
import path from 'path'

/** Completion survives deletion of the optional originals/undo backup. */
export const STITCH_COMPLETION_FILE = '.stitch-complete.json'

export interface StitchCompletion {
  version: 1
  /** Unknown when restoring status after a legacy backup was already deleted. */
  originalPages: number | null
  stitchedPages: number
  stitchedAt: string | null
  recoveredAt?: string
}

function completionPath(folderPath: string): string {
  return path.join(process.env.DOWNLOAD_ROOT || './downloads', folderPath, STITCH_COMPLETION_FILE)
}

export function completionFromRecord(record: {
  originals: string[]; outputs: unknown[]; stitchedAt: string
}): StitchCompletion {
  return {
    version: 1,
    originalPages: record.originals.length,
    stitchedPages: record.outputs.length,
    stitchedAt: record.stitchedAt
  }
}

export async function readStitchCompletion(folderPath: string): Promise<StitchCompletion | null> {
  try {
    const value = JSON.parse(await fs.readFile(completionPath(folderPath), 'utf8'))
    if (value?.version === 1 && Number.isInteger(value.stitchedPages) && value.stitchedPages > 0 &&
        (value.originalPages === null || (Number.isInteger(value.originalPages) && value.originalPages > 0)) &&
        (value.stitchedAt === null || (typeof value.stitchedAt === 'string' && Number.isFinite(Date.parse(value.stitchedAt))))) {
      return value
    }
  } catch { /* Older stitches only have the backup record. */ }
  try {
    const file = path.join(process.env.DOWNLOAD_ROOT || './downloads', folderPath, '.stitch-originals/stitch.json')
    const record = JSON.parse(await fs.readFile(file, 'utf8'))
    if (record?.version === 1 && Array.isArray(record.originals) && record.originals.length > 0 &&
        Array.isArray(record.outputs) && record.outputs.length > 0 &&
        typeof record.stitchedAt === 'string' && Number.isFinite(Date.parse(record.stitchedAt))) {
      return completionFromRecord(record)
    }
  } catch { /* No completed stitch. */ }
  return null
}

export async function saveStitchCompletion(folderPath: string, completion: StitchCompletion): Promise<void> {
  const file = completionPath(folderPath)
  // Finish the durable status write before any originals can be removed.
  const temp = `${file}.tmp`
  try {
    await fs.writeFile(temp, JSON.stringify(completion, null, 2))
    await fs.rename(temp, file)
  } finally {
    await fs.rm(temp, { force: true })
  }
}

export async function clearStitchCompletion(folderPath: string): Promise<void> {
  await fs.rm(completionPath(folderPath), { force: true })
}
