/**
 * Version history for the browser-local Settings documents.
 *
 * Four documents in Settings live only in this browser's localStorage — the
 * Crop 3.0 guideline file, metadata template and prompt, and the Editor 2.0
 * prompt (see Settings.tsx). Until now each save overwrote the previous text
 * with no way back, so a prompt that used to produce good crops was gone the
 * moment it was replaced. This module keeps the superseded versions so the
 * document that produced a given run can always be recovered.
 *
 * Storage shape — one extra localStorage key per document, `<docKey>.history`,
 * holding `{ v, entries }` with entries newest-first. The document's own key is
 * left exactly as it was, so nothing that reads the active document needs to
 * know history exists, and an install with no history simply shows an empty
 * timeline.
 *
 * Append-only: restoring an old version pushes the *current* text onto the
 * history and makes the old text current, so a restore is itself undoable and
 * no version is ever destroyed by a restore.
 *
 * Budget — localStorage is ~5MB for the whole origin and these documents share
 * it with the uploaded guideline/template files, so history is capped on three
 * axes (count, per-version size, total bytes) and the oldest versions are
 * dropped first. Losing the oldest version is strictly better than a quota
 * error that breaks saving the document itself.
 */

/** Newest-first, and trimmed from the tail when any cap is exceeded. */
export const MAX_VERSIONS = 20

/** A single version larger than this is recorded as metadata only (see `truncated`). */
export const MAX_VERSION_BYTES = 256 * 1024

/** Total budget for one document's history, across all its versions. */
export const MAX_HISTORY_BYTES = 1024 * 1024

const HISTORY_SCHEMA_VERSION = 1

export interface DocVersion {
  /** Stable id, unique within a document's history. */
  id: string
  /** ISO timestamp of the save that *created* this text. */
  savedAt: string
  /** ISO timestamp of the save that superseded it, i.e. when it was archived. */
  archivedAt: string
  /** Original file name, for the upload-backed documents. */
  name?: string
  /** The superseded text. Empty when `truncated` — see MAX_VERSION_BYTES. */
  content: string
  /** Byte length of the original content, even when the body was dropped. */
  size: number
  /** sha256 of the original content, so a version is identifiable when truncated. */
  sha256: string
  /** True when the body was too large to keep; the row is metadata only. */
  truncated?: boolean
  /** Set when this version was archived by a restore rather than an ordinary edit. */
  restoredFrom?: string
}

interface HistoryFile {
  v: number
  entries: DocVersion[]
}

/** The history key for a document, derived so callers only pass the doc key. */
export function historyKeyFor(docKey: string): string {
  return `${docKey}.history`
}

/** UTF-8 byte length — `String.length` counts UTF-16 units and undercounts emoji/CJK. */
export function byteLength(text: string): number {
  try {
    return new TextEncoder().encode(text).length
  } catch {
    return text.length
  }
}

/**
 * sha256 over the text, hex encoded.
 *
 * `crypto.subtle` is async and unavailable on insecure origins, and a version
 * row has to be written synchronously inside the same save that produces it, so
 * this is a small synchronous implementation rather than a WebCrypto call. The
 * digest is only ever compared against other digests produced here.
 */
export function sha256Hex(text: string): string {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]

  const bytes = Array.from(new TextEncoder().encode(text))
  const bitLen = bytes.length * 8
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  // 64-bit big-endian length; the high word is safe to split this way because
  // a localStorage document never approaches 2^32 bits.
  const hi = Math.floor(bitLen / 0x100000000)
  bytes.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff)
  bytes.push((bitLen >>> 24) & 0xff, (bitLen >>> 16) & 0xff, (bitLen >>> 8) & 0xff, bitLen & 0xff)

  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const w = new Uint32Array(64)
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))

  for (let i = 0; i < bytes.length; i += 64) {
    for (let t = 0; t < 16; t++) {
      w[t] = (bytes[i + t * 4] << 24) | (bytes[i + t * 4 + 1] << 16) | (bytes[i + t * 4 + 2] << 8) | bytes[i + t * 4 + 3]
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3)
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10)
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0
    }

    let [a, b, c, d, e, f, g, h] = H
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + S1 + ch + K[t] + w[t]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (S0 + maj) >>> 0
      h = g; g = f; f = e
      e = (d + temp1) >>> 0
      d = c; c = b; b = a
      a = (temp1 + temp2) >>> 0
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0
  }

  return H.map(x => x.toString(16).padStart(8, '0')).join('')
}

/** Read a document's history. Returns [] for missing or corrupt state. */
export function readHistory(docKey: string): DocVersion[] {
  try {
    const raw = localStorage.getItem(historyKeyFor(docKey))
    if (!raw) return []
    const parsed = JSON.parse(raw) as HistoryFile
    if (!parsed || !Array.isArray(parsed.entries)) return []
    return parsed.entries
  } catch {
    // Corrupt history must never block reading or saving the document itself.
    return []
  }
}

function writeHistory(docKey: string, entries: DocVersion[]): void {
  const file: HistoryFile = { v: HISTORY_SCHEMA_VERSION, entries }
  localStorage.setItem(historyKeyFor(docKey), JSON.stringify(file))
}

/** Drop oldest-first until the list fits both the count and the byte budget. */
function applyCaps(entries: DocVersion[]): DocVersion[] {
  const capped = entries.slice(0, MAX_VERSIONS)
  let total = 0
  const kept: DocVersion[] = []
  for (const entry of capped) {
    total += byteLength(entry.content)
    if (kept.length > 0 && total > MAX_HISTORY_BYTES) break
    kept.push(entry)
  }
  return kept
}

export interface ArchiveInput {
  /** The text being replaced — the version to preserve. */
  content: string
  /** When that text was saved, if known; defaults to now. */
  savedAt?: string | null
  /** File name for the upload-backed documents. */
  name?: string
  /** Set when this archive is part of restoring version `restoredFrom`. */
  restoredFrom?: string
}

/**
 * Archive the outgoing version of a document, newest-first.
 *
 * Called with the text that is about to be replaced, *before* the new text is
 * written. Returns the resulting history so a caller can update its state
 * without a re-read.
 *
 * No-ops on empty content (there was no previous version to keep) and on text
 * identical to the newest entry, so re-saving a document unchanged does not
 * fill the timeline with duplicates.
 */
export function archiveVersion(docKey: string, input: ArchiveInput): DocVersion[] {
  const existing = readHistory(docKey)
  if (!input.content) return existing

  const sha = sha256Hex(input.content)
  if (existing[0]?.sha256 === sha) return existing

  const size = byteLength(input.content)
  const tooLarge = size > MAX_VERSION_BYTES
  const entry: DocVersion = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    savedAt: input.savedAt ?? new Date().toISOString(),
    archivedAt: new Date().toISOString(),
    name: input.name,
    // A version over the per-version cap keeps its metadata but not its body:
    // the timeline stays honest about what existed without blowing the budget.
    content: tooLarge ? '' : input.content,
    size,
    sha256: sha,
    ...(tooLarge ? { truncated: true } : {}),
    ...(input.restoredFrom ? { restoredFrom: input.restoredFrom } : {})
  }

  const next = applyCaps([entry, ...existing])
  try {
    writeHistory(docKey, next)
  } catch {
    // Out of quota: shed to the newest few and retry once. If that still
    // fails, the document's own save must proceed regardless — history is
    // strictly secondary to the live document.
    try {
      writeHistory(docKey, [entry])
      return [entry]
    } catch {
      return existing
    }
  }
  return next
}

/** Remove one version. Used by the per-row delete in the history dialog. */
export function deleteVersion(docKey: string, id: string): DocVersion[] {
  const next = readHistory(docKey).filter(e => e.id !== id)
  try {
    writeHistory(docKey, next)
  } catch {
    return readHistory(docKey)
  }
  return next
}

/** Drop a document's entire history. */
export function clearHistory(docKey: string): void {
  try {
    localStorage.removeItem(historyKeyFor(docKey))
  } catch {
    /* nothing useful to do — the caller re-reads and shows what is there */
  }
}

/** Human-readable size for the timeline rows. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
