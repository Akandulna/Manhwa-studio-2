/**
 * Crop Studio (hybrid ChatGPT loop) — the identity of ONE original page.
 *
 * Every later stage keys off what this module measures: the handoff manifest
 * echoes the hash to ChatGPT, the importer compares the reply against it, and
 * a page whose bytes change afterwards is recognised as stale rather than
 * silently re-used against coordinates measured on the old pixels.
 *
 * The file is read ONCE into memory and everything — hash, header, full decode
 * — is taken from that same buffer, so the fingerprint and the dimensions can
 * never describe two different versions of a file that changed mid-read.
 *
 * Canonical representation: the page's STORED pixel orientation, which is what
 * sharp reads when `.rotate()` is not called and what the slicer and cutter
 * already use. A page carrying a non-identity EXIF orientation would display
 * rotated in a browser while every coordinate is measured unrotated, so it is
 * blocked instead of being transformed behind the user's back.
 */

import crypto from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import sharp from 'sharp'

export type SourceIssueCode =
  | 'ORIGINAL_NOT_FOUND'
  | 'ORIGINAL_DECODE_FAILED'
  | 'UNSUPPORTED_FORMAT'
  | 'MULTI_FRAME_UNSUPPORTED'
  | 'ORIENTATION_UNRESOLVED'
  | 'EXTENSION_MISMATCH'
  | 'MEMORY_LIMIT'

export interface SourceIssue {
  code: SourceIssueCode
  /** `error` blocks the page; `warning` is reported and does not. */
  severity: 'error' | 'warning'
  message: string
}

export interface OriginalPage {
  filename: string
  /** Detected from the bytes, never from the extension. */
  format: string
  width: number
  height: number
  channels: number
  hasAlpha: boolean
  /** EXIF orientation tag, or null when the file carries none. */
  orientation: number | null
  frames: number
  bytes: number
  sha256: string
}

export interface SourceInspection {
  page: OriginalPage | null
  issues: SourceIssue[]
  /** True when no issue is an error: the page may be packaged. */
  ready: boolean
}

/** Decoded pixels in stored orientation, row-major, `channels` bytes per pixel. */
export interface DecodedPixels {
  data: Buffer
  width: number
  height: number
  channels: number
}

const SUPPORTED_FORMATS = new Set(['jpeg', 'png', 'webp'])

const FORMAT_BY_EXTENSION: Record<string, string> = {
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.png': 'png',
  '.webp': 'webp'
}

/**
 * The decoded-pixel ceiling. sharp's own default (~16384²) is kept unless the
 * env var lowers or raises it; hitting it is reported as MEMORY_LIMIT rather
 * than surfacing as a bare libvips error.
 */
function maxInputPixels(): number {
  const configured = Number(process.env.CROP_STUDIO_MAX_PIXELS)
  return Number.isFinite(configured) && configured > 0 ? configured : 268402689
}

export function sha256Hex(buffer: Buffer | string): string {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

export async function sha256OfFile(filePath: string): Promise<string> {
  return sha256Hex(await fs.readFile(filePath))
}

function blocked(issues: SourceIssue[]): boolean {
  return issues.some(issue => issue.severity === 'error')
}

/**
 * Reads, fingerprints and fully decodes one original page.
 *
 * `pixels` is only returned when the page is ready, so a caller can verify
 * slices against the very pixels that were fingerprinted without decoding a
 * second time.
 */
export async function loadOriginal(
  sourcePath: string
): Promise<SourceInspection & { pixels: DecodedPixels | null }> {
  const filename = path.basename(sourcePath)
  const issues: SourceIssue[] = []

  let buffer: Buffer
  try {
    buffer = await fs.readFile(sourcePath)
  } catch {
    issues.push({ code: 'ORIGINAL_NOT_FOUND', severity: 'error', message: `${filename} could not be read from disk` })
    return { page: null, issues, ready: false, pixels: null }
  }

  const limitInputPixels = maxInputPixels()

  let meta: sharp.Metadata
  try {
    meta = await sharp(buffer, { limitInputPixels: false }).metadata()
  } catch (err) {
    issues.push({
      code: 'ORIGINAL_DECODE_FAILED',
      severity: 'error',
      message: `${filename} is not a readable image: ${err instanceof Error ? err.message : String(err)}`
    })
    return { page: null, issues, ready: false, pixels: null }
  }

  const format = meta.format ?? 'unknown'
  const width = meta.width ?? 0
  const height = meta.height ?? 0
  const frames = meta.pages ?? 1
  const orientation = meta.orientation ?? null

  const page: OriginalPage = {
    filename,
    format,
    width,
    height,
    channels: meta.channels ?? 0,
    hasAlpha: meta.hasAlpha ?? false,
    orientation,
    frames,
    bytes: buffer.length,
    sha256: sha256Hex(buffer)
  }

  if (!SUPPORTED_FORMATS.has(format)) {
    issues.push({
      code: 'UNSUPPORTED_FORMAT',
      severity: 'error',
      message: `${filename} is ${format}; only JPEG, PNG and still WebP pages are supported`
    })
  }

  const expected = FORMAT_BY_EXTENSION[path.extname(filename).toLowerCase()]
  if (SUPPORTED_FORMATS.has(format) && expected !== format) {
    issues.push({
      code: 'EXTENSION_MISMATCH',
      severity: 'warning',
      message: `${filename} contains ${format} data despite its extension; its bytes are what is used`
    })
  }

  if (frames > 1) {
    issues.push({
      code: 'MULTI_FRAME_UNSUPPORTED',
      severity: 'error',
      message: `${filename} has ${frames} frames; convert it to a single still page first`
    })
  }

  if (orientation !== null && orientation !== 1) {
    issues.push({
      code: 'ORIENTATION_UNRESOLVED',
      severity: 'error',
      message:
        `${filename} carries EXIF orientation ${orientation}, so it displays rotated while ` +
        'its pixels are stored unrotated. Re-save the page upright (orientation 1) to continue.'
    })
  }

  if (width < 1 || height < 1) {
    issues.push({ code: 'ORIGINAL_DECODE_FAILED', severity: 'error', message: `${filename} reports no usable dimensions` })
  } else if (width * height > limitInputPixels) {
    issues.push({
      code: 'MEMORY_LIMIT',
      severity: 'error',
      message: `${filename} is ${width}×${height} (${width * height} px), over the ${limitInputPixels} px limit (CROP_STUDIO_MAX_PIXELS)`
    })
  }

  if (blocked(issues)) return { page, issues, ready: false, pixels: null }

  // A header can parse while the body is truncated or corrupt, so the whole
  // page is decoded. sharp's default failOn ('warning') matches what the
  // slicer and cutter already tolerate, so a page that passes here slices.
  try {
    const { data, info } = await sharp(buffer, { limitInputPixels })
      .raw()
      .toBuffer({ resolveWithObject: true })
    if (info.width !== width || info.height !== height) {
      issues.push({
        code: 'ORIGINAL_DECODE_FAILED',
        severity: 'error',
        message: `${filename} decoded to ${info.width}×${info.height} but its header says ${width}×${height}`
      })
      return { page, issues, ready: false, pixels: null }
    }
    return {
      page,
      issues,
      ready: true,
      pixels: { data, width: info.width, height: info.height, channels: info.channels }
    }
  } catch (err) {
    issues.push({
      code: 'ORIGINAL_DECODE_FAILED',
      severity: 'error',
      message: `${filename} did not fully decode: ${err instanceof Error ? err.message : String(err)}`
    })
    return { page, issues, ready: false, pixels: null }
  }
}

/** loadOriginal without holding on to the decoded pixels. */
export async function inspectOriginal(sourcePath: string): Promise<SourceInspection> {
  const { pixels: _pixels, ...inspection } = await loadOriginal(sourcePath)
  return inspection
}
