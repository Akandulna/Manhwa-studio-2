import fs from 'fs/promises'
import path from 'path'

/** Preserve scripts/timelines and videos; metadata text inside crop folders is disposable. */
function keepFile(name: string, parents: string[]): boolean {
  if (/\.(mp4|mov|mkv|webm|m4v|avi)$/i.test(name)) return true
  return /\.(md|txt)$/i.test(name) && !parents.some(p => /^(crop|audio|processed|slices)/i.test(p))
}

/** Preview and deletion use the same traversal. Never follow symlinks. */
export async function workingFiles(folder: string, remove = false): Promise<number> {
  const configuredRoot = path.resolve(process.env.DOWNLOAD_ROOT || './downloads')
  const root = await fs.realpath(configuredRoot)
  const requested = path.resolve(folder)
  if (!requested.startsWith(configuredRoot + path.sep)) throw new Error('Working folder is outside the download root')
  const base = path.join(root, path.relative(configuredRoot, requested))
  // Reject symlinks in any parent, including links within the download root.
  let parent = root
  for (const segment of path.relative(root, base).split(path.sep)) {
    parent = path.join(parent, segment)
    const stat = await fs.lstat(parent).catch(() => null)
    if (!stat) return 0
    if (!stat.isDirectory()) throw new Error('Working folder must be a real directory')
  }
  async function walk(dir: string, parents: string[]): Promise<number> {
    let bytes = 0
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        bytes += await walk(full, [...parents, entry.name])
        if (remove && (await fs.readdir(full)).length === 0) await fs.rmdir(full)
      } else if (entry.isFile() && !keepFile(entry.name, parents)) {
        bytes += (await fs.lstat(full)).size
        if (remove) await fs.unlink(full)
      }
    }
    return bytes
  }
  return walk(base, [])
}
