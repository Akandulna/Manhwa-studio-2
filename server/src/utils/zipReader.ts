/**
 * Minimal in-memory zip reader for phone archives, with caller-specific limits.
 *
 * Reads the central directory, so entries written with data descriptors (as
 * java.util.zip.ZipOutputStream does) are sized correctly. Handles stored and
 * deflated entries; zip64, encryption and multi-disk archives are refused.
 */

import zlib from 'zlib'

export interface ZipEntry {
  /** Path inside the archive, '/'-separated. */
  name: string
  data: Buffer
}

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

/** Refuse any single entry bigger than this once inflated. */
const MAX_ENTRY_BYTES = 32 * 1024 * 1024

export interface ZipReadLimits {
  /** Maximum expanded size of one file; defaults to 32 MiB for script/crop imports. */
  maxEntryBytes?: number
  /** Maximum combined expanded size of all files. */
  maxTotalBytes?: number
}

function findEndOfCentralDirectory(buf: Buffer): number {
  // The EOCD record is 22 bytes plus a comment of up to 65535.
  const stop = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  throw new Error('Not a zip file')
}

/** Every file entry in the archive (directories are left out). */
export function readZip(buf: Buffer, { maxEntryBytes = MAX_ENTRY_BYTES, maxTotalBytes = Infinity }: ZipReadLimits = {}): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buf)
  const count = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('Zip64 archives are not supported')

  const entries: ZipEntry[] = []
  let totalBytes = 0
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG) throw new Error('Corrupt zip central directory')
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const compressedSize = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/')
    p += 46 + nameLen + extraLen + commentLen

    if (name.endsWith('/')) continue
    if (flags & 0x1) throw new Error(`${name} is encrypted`)
    if (size > maxEntryBytes) throw new Error(`${name} is too large (${size} bytes; limit ${maxEntryBytes} bytes)`)
    if (size > maxTotalBytes - totalBytes) throw new Error(`The expanded zip is too large (limit ${maxTotalBytes} bytes)`)

    if (buf.readUInt32LE(localOffset) !== LOCAL_SIG) throw new Error(`Corrupt zip entry ${name}`)
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28)
    const raw = buf.subarray(dataStart, dataStart + compressedSize)

    let data: Buffer
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, size) })
    else throw new Error(`${name} uses unsupported compression method ${method}`)
    if (data.length !== size) throw new Error(`Corrupt zip entry ${name}: expanded size does not match`)
    totalBytes += data.length
    entries.push({ name, data })
  }
  return entries
}
