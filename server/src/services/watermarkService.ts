/**
 * Watermark Service — Module 3: Image Clipper
 *
 * Per-series watermark templates + OpenCV auto-detection, used to white-fill
 * site watermarks during crop export. Mirrors the Python-sidecar spawn pattern
 * used by aiCropService / voiceAnalysisService.
 *
 * Pipeline role:
 *   1. The user identifies a watermark by selecting a region on a page → we save
 *      that region as a template PNG (createTemplateFromRegion).
 *   2. On export, detectChapterWatermarkRects() runs template matching across the
 *      chapter's source pages and returns canvas-space rectangles.
 *   3. clipperService.executeCrop() white-fills (applyWhiteFill) any rect that
 *      falls inside a crop.
 */

import sharp from 'sharp'
import fs from 'fs/promises'
import path from 'path'
import { spawn } from 'child_process'
import { v4 as uuidv4 } from 'uuid'
import { prisma } from '../index.js'
import {
  getChapterManifest,
  renderCanvasRegionBuffer,
  type ImageManifest,
  type CropRect
} from './clipperService.js'

// ============ Paths ============

function getPythonPath(): string {
  return process.env.PYTHON_PATH || path.join(process.cwd(), 'ml', 'venv', 'bin', 'python3')
}

function getScriptPath(): string {
  return path.join(process.cwd(), 'ml', 'watermark.py')
}

function getFullFolderPath(relativePath: string): string {
  const downloadRoot = process.env.DOWNLOAD_ROOT || './downloads'
  return path.join(downloadRoot, relativePath)
}

function getWatermarksDir(): string {
  const downloadRoot = process.env.DOWNLOAD_ROOT || './downloads'
  return path.join(downloadRoot, '_watermarks')
}

// ============ Types ============

export interface WatermarkMatch {
  filename: string
  templateId: string
  x: number
  y: number
  w: number
  h: number
  score: number
}

// ============ Sidecar bridge ============

/** Report whether the Python detection sidecar (cv2 + numpy) is available. */
export async function checkWatermarkSidecarAvailable(): Promise<{ available: boolean; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn(getPythonPath(), [getScriptPath(), '--check'])
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d) => { stdout += d.toString() })
    proc.stderr.on('data', (d) => { stderr += d.toString() })
    proc.on('close', (code) => {
      if (code === 0 && stdout.includes('ok')) resolve({ available: true })
      else resolve({ available: false, error: stderr.trim() || 'Watermark sidecar unavailable. Run `npm run ml:setup`.' })
    })
    proc.on('error', () => resolve({ available: false, error: 'Python not found. Run `npm run ml:setup`.' }))
    setTimeout(() => { proc.kill(); resolve({ available: false, error: 'Watermark check timed out' }) }, 10000)
  })
}

/** Run template matching for a set of pages + templates. Returns page-local matches. */
async function runDetect(
  pages: { filename: string; path: string }[],
  templates: { id: string; path: string; threshold: number }[]
): Promise<WatermarkMatch[]> {
  if (pages.length === 0 || templates.length === 0) return []

  return new Promise((resolve) => {
    const proc = spawn(getPythonPath(), [getScriptPath(), '--detect'])
    let stdout = ''
    let stderr = ''
    proc.stdin.write(JSON.stringify({ pages, templates }))
    proc.stdin.end()
    proc.stdout.on('data', (d) => { stdout += d.toString() })
    proc.stderr.on('data', (d) => { stderr += d.toString() })
    proc.on('close', () => {
      try {
        const parsed = JSON.parse(stdout)
        if (parsed.ok) resolve(parsed.matches as WatermarkMatch[])
        else { console.error('Watermark detect error:', parsed.error || stderr); resolve([]) }
      } catch (e) {
        console.error('Failed to parse watermark detect output:', e, stderr)
        resolve([])
      }
    })
    proc.on('error', (e) => { console.error('Watermark detect process error:', e); resolve([]) })
    // Generous timeout — a chapter can have 50-150 pages.
    setTimeout(() => { proc.kill(); resolve([]) }, 120000)
  })
}

// ============ Detection → canvas-space rects ============

/**
 * Detect all enabled-template watermarks across a chapter's pages and return
 * their rectangles in the chapter's virtual-canvas coordinate space.
 */
export async function detectChapterWatermarkRects(
  folderPath: string,
  seriesId: string,
  manifest: ImageManifest
): Promise<CropRect[]> {
  const templates = await prisma.watermarkTemplate.findMany({
    where: { seriesId, enabled: true }
  })
  if (templates.length === 0) return []

  const fullFolder = getFullFolderPath(folderPath)
  const pages = manifest.images.map(img => ({
    filename: img.filename,
    path: path.join(fullFolder, img.filename)
  }))
  const tpls = templates.map(t => ({ id: t.id, path: t.imagePath, threshold: t.threshold }))

  const matches = await runDetect(pages, tpls)

  // Map each page-local match to canvas space. The matcher works on the source file,
  // so its rect is in SOURCE pixels and every extent has to be scaled onto the canvas
  // — not just offset by canvasY. On a slice narrower than the reference width an
  // unscaled rect would white-fill the wrong region, and would be too small.
  const byFilename = new Map(manifest.images.map(img => [img.filename, img]))
  const rects: CropRect[] = []
  for (const m of matches) {
    const img = byFilename.get(m.filename)
    if (!img) continue
    const scale = img.scale > 0 ? img.scale : 1
    rects.push({
      canvasX: m.x * scale,
      canvasY: img.canvasY + m.y * scale,
      canvasW: m.w * scale,
      canvasH: m.h * scale
    })
  }
  return rects
}

/** Convenience wrapper used by the preview endpoint (resolves chapter → folder/series). */
export async function detectChapterWatermarksPreview(chapterId: string): Promise<{
  rects: CropRect[]
  manifest: ImageManifest
}> {
  const chapter = await prisma.chapter.findUnique({ where: { id: chapterId } })
  if (!chapter) throw new Error('Chapter not found')
  const manifest = await getChapterManifest(chapter.folderPath)
  const rects = await detectChapterWatermarkRects(chapter.folderPath, chapter.seriesId, manifest)
  return { rects, manifest }
}

// ============ White-fill primitive (sharp) ============

/**
 * Composite opaque white rectangles over a crop buffer. Rectangles are in the
 * buffer's own pixel space; out-of-bounds parts are clipped. Returns a PNG buffer.
 */
export async function applyWhiteFill(
  buffer: Buffer,
  rects: { x: number; y: number; w: number; h: number }[]
): Promise<Buffer> {
  if (rects.length === 0) return buffer

  const meta = await sharp(buffer).metadata()
  const W = meta.width || 0
  const H = meta.height || 0
  if (W === 0 || H === 0) return buffer

  const overlays: sharp.OverlayOptions[] = []
  for (const r of rects) {
    const left = Math.max(0, Math.floor(r.x))
    const top = Math.max(0, Math.floor(r.y))
    const right = Math.min(W, Math.ceil(r.x + r.w))
    const bottom = Math.min(H, Math.ceil(r.y + r.h))
    const width = right - left
    const height = bottom - top
    if (width <= 0 || height <= 0) continue

    const white = await sharp({
      create: { width, height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } }
    }).png().toBuffer()
    overlays.push({ input: white, top, left })
  }

  if (overlays.length === 0) return buffer
  return sharp(buffer).composite(overlays).png().toBuffer()
}

/**
 * Convert canvas-space watermark rects into a crop's local pixel space.
 * (The crop buffer's origin is the crop's top-left in canvas space, and—for
 * single-file crops—canvas pixels map 1:1 to buffer pixels.)
 */
export function watermarkRectsForCrop(
  crop: CropRect,
  watermarkRects: CropRect[]
): { x: number; y: number; w: number; h: number }[] {
  const out: { x: number; y: number; w: number; h: number }[] = []
  for (const wr of watermarkRects) {
    const x = wr.canvasX - crop.canvasX
    const y = wr.canvasY - crop.canvasY
    // Skip rects entirely outside the crop.
    if (x + wr.canvasW <= 0 || y + wr.canvasH <= 0 || x >= crop.canvasW || y >= crop.canvasH) continue
    out.push({ x, y, w: wr.canvasW, h: wr.canvasH })
  }
  return out
}

// ============ Template CRUD ============

/**
 * Create a watermark template for a series from a canvas-space region of one of
 * its chapters. Extracts the region pixels and saves them as a template PNG.
 */
export async function createTemplateFromRegion(opts: {
  seriesId: string
  chapterId: string
  rect: CropRect
  label?: string
}): Promise<{ id: string; label: string; width: number; height: number; threshold: number; enabled: boolean }> {
  const chapter = await prisma.chapter.findUnique({ where: { id: opts.chapterId } })
  if (!chapter) throw new Error('Chapter not found')
  if (chapter.seriesId !== opts.seriesId) throw new Error('Chapter does not belong to series')

  const manifest = await getChapterManifest(chapter.folderPath)
  const buffer = await renderCanvasRegionBuffer(opts.rect, manifest, chapter.folderPath)
  const meta = await sharp(buffer).metadata()

  const dir = path.join(getWatermarksDir(), opts.seriesId)
  await fs.mkdir(dir, { recursive: true })
  const id = uuidv4()
  const imagePath = path.join(dir, `${id}.png`)
  await fs.writeFile(imagePath, buffer)

  const record = await prisma.watermarkTemplate.create({
    data: {
      id,
      seriesId: opts.seriesId,
      label: opts.label?.trim() || 'Watermark',
      imagePath,
      width: meta.width || Math.round(opts.rect.canvasW),
      height: meta.height || Math.round(opts.rect.canvasH)
    }
  })

  return {
    id: record.id,
    label: record.label,
    width: record.width,
    height: record.height,
    threshold: record.threshold,
    enabled: record.enabled
  }
}

export async function listTemplates(seriesId: string) {
  const rows = await prisma.watermarkTemplate.findMany({
    where: { seriesId },
    orderBy: { createdAt: 'asc' }
  })
  return rows.map(r => ({
    id: r.id,
    seriesId: r.seriesId,
    label: r.label,
    width: r.width,
    height: r.height,
    threshold: r.threshold,
    enabled: r.enabled,
    createdAt: r.createdAt.toISOString()
  }))
}

export async function updateTemplate(
  id: string,
  data: { label?: string; threshold?: number; enabled?: boolean }
) {
  const patch: Record<string, unknown> = {}
  if (typeof data.label === 'string') patch.label = data.label.trim() || 'Watermark'
  if (typeof data.threshold === 'number') patch.threshold = Math.min(1, Math.max(0, data.threshold))
  if (typeof data.enabled === 'boolean') patch.enabled = data.enabled
  return prisma.watermarkTemplate.update({ where: { id }, data: patch })
}

export async function deleteTemplate(id: string): Promise<void> {
  const tpl = await prisma.watermarkTemplate.findUnique({ where: { id } })
  if (!tpl) return
  await prisma.watermarkTemplate.delete({ where: { id } })
  // Best-effort cleanup of the on-disk template image.
  try { await fs.unlink(tpl.imagePath) } catch { /* already gone */ }
}

export async function getTemplateFilePath(id: string): Promise<string | null> {
  const tpl = await prisma.watermarkTemplate.findUnique({ where: { id } })
  return tpl?.imagePath ?? null
}
