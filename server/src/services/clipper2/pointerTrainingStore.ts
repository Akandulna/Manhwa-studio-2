/**
 * Image Clipper 2.0 Training — disk I/O.
 *
 * Manual crops drawn in the Training tab are exported as real PNGs into
 * `crops_training/`, a sibling of production's `crop_points/` and `crops2/`
 * that neither of those paths ever reads. Cutting itself is done by
 * clipperService.executeCrop — the same function Module 3 v1 uses — so a
 * training export is pixel-identical to a real crop; only the destination
 * folder (and the fact that nothing here touches CropPointSet/Crop/CropSession)
 * keeps it from affecting the real crop/video pipeline.
 */

import fs from 'fs/promises'
import path from 'path'

function getFullFolderPath(relativePath: string): string {
  const downloadRoot = process.env.DOWNLOAD_ROOT || './downloads'
  return path.join(downloadRoot, relativePath)
}

export function getTrainingExportDir(folderPath: string): string {
  return path.join(getFullFolderPath(folderPath), 'crops_training')
}

function isMissing(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Natural-sorted so train_002 precedes train_010. Empty (not an error) when never exported. */
export async function listTrainingOutputs(folderPath: string): Promise<{ filename: string; bytes: number }[]> {
  const dir = getTrainingExportDir(folderPath)

  let entries: string[]
  try {
    const dirents = await fs.readdir(dir, { withFileTypes: true })
    entries = dirents
      .filter(d => d.isFile() && path.extname(d.name).toLowerCase() === '.png')
      .map(d => d.name)
  } catch (err) {
    if (isMissing(err)) return []
    throw err
  }

  entries.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

  const outputs: { filename: string; bytes: number }[] = []
  for (const filename of entries) {
    try {
      const stat = await fs.stat(path.join(dir, filename))
      outputs.push({ filename, bytes: stat.size })
    } catch (err) {
      if (!isMissing(err)) throw err
    }
  }
  return outputs
}

/** Wipes the training export dir so re-exporting never leaves stale files from a larger previous batch. */
export async function clearTrainingOutputs(folderPath: string): Promise<void> {
  await fs.rm(getTrainingExportDir(folderPath), { recursive: true, force: true })
}
