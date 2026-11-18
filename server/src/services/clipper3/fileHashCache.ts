import { createHash } from 'crypto'
import { createReadStream, type Stats } from 'fs'
import fs from 'fs/promises'

/**
 * SHA-256 of a file on disk, remembered while the file is unchanged.
 *
 * Editor 2.0's readiness check proves a Metadata chapter's source pages and
 * crops3 files are byte-for-byte what was cut. Hashing them on every open
 * cost seconds per series (gigabytes of reads), so a hash is reused until the
 * file's size, modification/change time or inode moves — any rewrite moves at
 * least one of those. Memory only: a server restart re-hashes once.
 *
 * Hashing streams the file in chunks, so a large page never blocks the event
 * loop for longer than one chunk.
 */
type Entry = { size: number; mtimeMs: number; ctimeMs: number; ino: number; sha256: string }

const MAX_ENTRIES = 50_000
const cache = new Map<string, Entry>()
const inFlight = new Map<string, Promise<{ sha256: string; bytes: number }>>()

const sameFile = (a: Entry, s: Stats) =>
  a.size === s.size && a.mtimeMs === s.mtimeMs && a.ctimeMs === s.ctimeMs && a.ino === s.ino

function streamSha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file, { highWaterMark: 1 << 20 })
      .on('data', chunk => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

async function hashAndRemember(file: string, attempt = 1): Promise<{ sha256: string; bytes: number }> {
  const before = await fs.stat(file)
  const sha256 = await streamSha256(file)
  const after = await fs.stat(file)
  const entry: Entry = { size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, ino: after.ino, sha256 }
  // Written to while being read: the hash may mix old and new bytes, so it is
  // neither trusted nor kept.
  if (!sameFile(entry, before)) {
    if (attempt < 3) return hashAndRemember(file, attempt + 1)
    throw new Error(`File kept changing while it was checked: ${file}`)
  }
  cache.delete(file)
  cache.set(file, entry)
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!)
  return { sha256, bytes: after.size }
}

/** The file's SHA-256 (hex) and byte length. Throws as fs.stat does when it is missing. */
export async function fileSha256(file: string): Promise<{ sha256: string; bytes: number }> {
  const stats = await fs.stat(file)
  const hit = cache.get(file)
  if (hit && sameFile(hit, stats)) {
    cache.delete(file)
    cache.set(file, hit)
    return { sha256: hit.sha256, bytes: hit.size }
  }
  let pending = inFlight.get(file)
  if (!pending) {
    pending = hashAndRemember(file).finally(() => inFlight.delete(file))
    inFlight.set(file, pending)
  }
  return pending
}

/** Test hook: forget every remembered hash. */
export function clearFileHashCache() {
  cache.clear()
}
