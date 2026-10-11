/**
 * Storage format for downloaded chapter pages.
 *
 * Goal: smallest file with zero quality loss.
 *  - Lossless sources (PNG, GIF, TIFF, BMP) are re-encoded as *lossless* WebP:
 *    pixel-identical, typically ~55% smaller than PNG.
 *  - Lossy sources (JPEG, AVIF) are kept byte-for-byte. Their detail is already
 *    gone; lossless WebP of a JPEG is ~4-5x bigger, and lossy WebP would add a
 *    second generation of loss, so the original is both the smallest and the
 *    only lossless option.
 *  - WebP is kept as-is.
 *
 * The ICC profile is carried over so colours render the same, and EXIF
 * orientation is baked into the pixels since the EXIF block is not.
 */

import sharp from 'sharp'
import * as fs from 'fs'
import * as path from 'path'

/** libwebp cannot encode an image wider or taller than this. */
export const WEBP_MAX_DIMENSION = 16383

/** Formats whose pixels are exact, so lossless WebP loses nothing. */
const LOSSLESS_SOURCES = new Set(['png', 'gif', 'tiff', 'bmp'])

const EXT_FOR_FORMAT: Record<string, string> = {
  webp: '.webp',
  jpeg: '.jpg',
  png: '.png',
  gif: '.gif',
  heif: '.avif',
  tiff: '.tiff',
  bmp: '.bmp',
}

export interface StoredPage {
  /** Path of the final file: `destBase` plus the chosen extension. */
  path: string
  bytes: number
  /** True when the source was re-encoded to WebP. */
  converted: boolean
}

/**
 * Store the image at `srcPath` as `<destBase>.<ext>` in its best lossless form
 * (see module comment). The source file is removed once the final file is in
 * place, unless they are the same path. The format is detected from the bytes,
 * not the extension, because CDNs routinely mislabel images.
 */
export async function storePageImage(srcPath: string, destBase: string): Promise<StoredPage> {
  // Read into memory rather than handing sharp the path: libvips caches by
  // filename, and the same temp path is reused across re-downloads.
  const input = await fs.promises.readFile(srcPath)
  const meta = await sharp(input).metadata()
  const format = meta.format ?? ''
  const keepExt = EXT_FOR_FORMAT[format] ?? (path.extname(srcPath) || '.img')

  const width = meta.width ?? 0
  const height = meta.pageHeight ?? meta.height ?? 0
  const fitsWebp = width <= WEBP_MAX_DIMENSION && height <= WEBP_MAX_DIMENSION
  // WebP is 8 bits per channel; a 16-bit PNG would lose precision
  const eightBit = meta.depth === 'uchar'

  if (LOSSLESS_SOURCES.has(format) && fitsWebp && eightBit) {
    const output = await sharp(input, { animated: (meta.pages ?? 1) > 1 })
      .rotate()
      .keepIccProfile()
      .webp({ lossless: true })
      .toBuffer()

    // Rare, but some tiny/flat PNGs are already tighter than WebP
    if (output.length < input.length) {
      const finalPath = `${destBase}.webp`
      const tmpPath = `${finalPath}.tmp`
      await fs.promises.writeFile(tmpPath, output)
      await fs.promises.rename(tmpPath, finalPath)
      if (path.resolve(srcPath) !== path.resolve(finalPath)) {
        await fs.promises.unlink(srcPath).catch(() => {})
      }
      return { path: finalPath, bytes: output.length, converted: true }
    }
  } else if (LOSSLESS_SOURCES.has(format)) {
    const why = eightBit
      ? `${width}x${height}, over the WebP limit of ${WEBP_MAX_DIMENSION}px`
      : `${meta.depth} depth, more than WebP's 8 bits per channel`
    console.warn(`[page-image] ${path.basename(destBase)} is ${why} — kept as ${keepExt}`)
  }

  const finalPath = `${destBase}${keepExt}`
  if (path.resolve(srcPath) !== path.resolve(finalPath)) {
    await fs.promises.rename(srcPath, finalPath)
  }
  return { path: finalPath, bytes: input.length, converted: false }
}
