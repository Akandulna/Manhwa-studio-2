/**
 * One-time migration: raw-stacked canvas → reference-width scaled canvas.
 *
 * Before this change `getChapterManifest` stacked slices at their raw heights and
 * left narrower ones aligned to x=0, so a chapter mixing 713/800/968px pages had a
 * canvas ~21% shorter than the scaled layout and a ragged right edge. Coordinates
 * stored under that layout — v2 pointer files and v1 `Crop` rows alike — do not mean
 * the same thing under the new one.
 *
 * The fix is exact rather than approximate: both layouts are derived from the same
 * source dimensions, so a stored coordinate can be resolved back to the SOURCE PIXEL
 * it pointed at and re-expressed in the new space. Source pixels are the invariant.
 *
 *   old canvas y ──(raw offsets)──▶ page i, local source y ──(scaled offsets)──▶ new canvas y
 *   old canvas x ──(clamp to w_i)─▶ local source x        ──(× scale_i)────────▶ new canvas x
 *
 * Uniform-width chapters have every scale = 1, which makes the whole transform the
 * identity — they are detected and skipped rather than rewritten.
 *
 * Usage (from server/):
 *   npx tsx scripts/migrate-canvas-scaling.ts            # dry run, writes nothing
 *   npx tsx scripts/migrate-canvas-scaling.ts --apply    # writes, after backing up
 */

import fs from 'fs/promises'
import path from 'path'
import sharp from 'sharp'
import { prisma } from '../src/index.js'
import { parseCropFile, serializeCropFile, normalizeCropFile } from '../src/services/clipper2/fourPointSchema.js'
import type { CropEntry, FourPointCropFile } from '../src/services/clipper2/fourPointTypes.js'

const APPLY = process.argv.includes('--apply')
const DOWNLOAD_ROOT = process.env.DOWNLOAD_ROOT || './downloads'

interface Slice {
  filename: string
  width: number
  height: number
  /** Raw-stacked top offset (the OLD canvas). */
  oldY: number
  /** Scaled top offset (the NEW canvas). */
  newY: number
  scale: number
  canvasHeight: number
}

interface Layout {
  canvasWidth: number
  oldHeight: number
  newHeight: number
  slices: Slice[]
  uniform: boolean
}

async function measure(folderPath: string): Promise<Layout | null> {
  const dir = path.resolve(DOWNLOAD_ROOT, folderPath)
  let names: string[]
  try {
    names = (await fs.readdir(dir)).filter(f => /\.(jpe?g|png|webp)$/i.test(f)).sort()
  } catch {
    return null
  }
  if (names.length === 0) return null

  const measured: Array<{ filename: string; width: number; height: number }> = []
  for (const filename of names) {
    const m = await sharp(path.join(dir, filename)).metadata()
    if (!m.width || !m.height) return null
    measured.push({ filename, width: m.width, height: m.height })
  }

  const canvasWidth = Math.max(...measured.map(m => m.width))
  const slices: Slice[] = []
  let oldY = 0
  let newY = 0
  for (const m of measured) {
    const scale = canvasWidth / m.width
    const canvasHeight = m.height * scale
    slices.push({ ...m, oldY, newY, scale, canvasHeight })
    oldY += m.height // OLD: raw height
    newY += canvasHeight // NEW: scaled height
  }

  return {
    canvasWidth,
    oldHeight: oldY,
    newHeight: newY,
    slices,
    uniform: measured.every(m => m.width === canvasWidth)
  }
}

/** Which slice an OLD canvas y falls in. Clamped, so a stored value past the end still resolves. */
function sliceForOldY(layout: Layout, oldCanvasY: number): Slice {
  for (const s of layout.slices) {
    if (oldCanvasY < s.oldY + s.height) return s
  }
  return layout.slices[layout.slices.length - 1]
}

/** OLD canvas y → SOURCE pixel row → NEW canvas y. */
function remapY(layout: Layout, oldCanvasY: number): number {
  const s = sliceForOldY(layout, oldCanvasY)
  const localY = Math.max(0, Math.min(oldCanvasY - s.oldY, s.height))
  return s.newY + localY * s.scale
}

/**
 * OLD canvas x → NEW canvas x, via the slice the crop starts on.
 *
 * Under the old layout a narrow page's content only occupied x ∈ [0, w_i/W] of the
 * canvas; under the new one it fills the full width. So the same source column moves
 * to `x * scale_i`, capped at the canvas edge. A full-width crop (0 → W) stays
 * full-width under any scale, which is the overwhelming majority of real crops.
 */
function remapX(layout: Layout, oldCanvasX: number, slice: Slice): number {
  return Math.min(layout.canvasWidth, oldCanvasX * slice.scale)
}

// ============ v2: crop_points.json ============

function remapEntry(layout: Layout, entry: CropEntry): CropEntry {
  const pts = entry.crop.points
  const oldTopY = Math.min(...pts.map(p => p.y)) * layout.oldHeight
  const oldBottomY = Math.max(...pts.map(p => p.y)) * layout.oldHeight
  const oldLeftX = Math.min(...pts.map(p => p.x)) * layout.canvasWidth
  const oldRightX = Math.max(...pts.map(p => p.x)) * layout.canvasWidth

  const startSlice = sliceForOldY(layout, oldTopY)
  const newTop = remapY(layout, oldTopY) / layout.newHeight
  const newBottom = remapY(layout, oldBottomY) / layout.newHeight
  const newLeft = remapX(layout, oldLeftX, startSlice) / layout.canvasWidth
  const newRight = remapX(layout, oldRightX, startSlice) / layout.canvasWidth

  return {
    ...entry,
    crop: {
      ...entry.crop,
      points: [
        { id: 'P1', x: newLeft, y: newTop },
        { id: 'P2', x: newRight, y: newTop },
        { id: 'P3', x: newRight, y: newBottom },
        { id: 'P4', x: newLeft, y: newBottom }
      ]
    }
  }
}

async function migratePointsFile(folderPath: string, layout: Layout): Promise<number | null> {
  const file = path.resolve(DOWNLOAD_ROOT, folderPath, 'crop_points', 'crop_points.json')
  let text: string
  try {
    text = await fs.readFile(file, 'utf-8')
  } catch {
    return null
  }

  const { file: parsed } = parseCropFile(text)
  if (!parsed) {
    console.log(`    ! crop_points.json does not validate — left untouched`)
    return null
  }

  const migrated: FourPointCropFile = {
    ...parsed,
    image: { ...parsed.image, width: layout.canvasWidth, height: Math.round(layout.newHeight) },
    crops: parsed.crops.map(e => remapEntry(layout, e))
  }
  const { file: normalized } = normalizeCropFile(migrated)

  if (APPLY) {
    await fs.copyFile(file, `${file}.pre-scaling.bak`)
    await fs.chmod(file, 0o644).catch(() => {})
    await fs.writeFile(file, serializeCropFile(normalized), 'utf-8')
  }
  return normalized.crops.length
}

// ============ v1: Crop rows ============

async function migrateCropRows(chapterId: string, layout: Layout): Promise<number> {
  const session = await prisma.cropSession.findUnique({
    where: { chapterId },
    include: { crops: true }
  })
  if (!session || session.crops.length === 0) return 0

  for (const crop of session.crops) {
    const slice = sliceForOldY(layout, crop.canvasY)
    const newY = remapY(layout, crop.canvasY)
    const newBottom = remapY(layout, crop.canvasY + crop.canvasH)
    const newX = remapX(layout, crop.canvasX, slice)
    const newRight = remapX(layout, crop.canvasX + crop.canvasW, slice)

    const canvasY = newY
    const canvasH = Math.max(1, newBottom - newY)
    const canvasX = newX
    const canvasW = Math.max(1, newRight - newX)

    if (APPLY) {
      await prisma.crop.update({
        where: { id: crop.id },
        data: {
          canvasX,
          canvasY,
          canvasW,
          canvasH,
          normX: canvasX / layout.canvasWidth,
          normY: canvasY / layout.newHeight,
          normW: canvasW / layout.canvasWidth,
          normH: canvasH / layout.newHeight
        }
      })
    }
  }
  return session.crops.length
}

// ============ Main ============

async function main() {
  console.log(APPLY ? '=== APPLYING migration ===' : '=== DRY RUN (pass --apply to write) ===\n')

  const chapters = await prisma.chapter.findMany({
    select: { id: true, number: true, folderPath: true, series: { select: { title: true } } },
    orderBy: [{ seriesId: 'asc' }, { number: 'asc' }]
  })

  let affected = 0
  let skippedUniform = 0
  let totalPoints = 0
  let totalRows = 0

  for (const ch of chapters) {
    const layout = await measure(ch.folderPath!)
    if (!layout) continue

    if (layout.uniform) {
      skippedUniform++
      continue
    }

    affected++
    const widths = [...new Set(layout.slices.map(s => s.width))].sort((a, b) => a - b)
    console.log(
      `  ${ch.series.title.slice(0, 32).padEnd(33)} Ch ${String(ch.number).padStart(3)}  ` +
      `widths=[${widths.join(',')}]  H ${Math.round(layout.oldHeight)} → ${Math.round(layout.newHeight)}`
    )

    const points = await migratePointsFile(ch.folderPath!, layout)
    if (points !== null) {
      totalPoints += points
      console.log(`      crop_points.json: ${points} crop(s) remapped`)
    }

    const rows = await migrateCropRows(ch.id, layout)
    if (rows > 0) {
      totalRows += rows
      console.log(`      CropSession:      ${rows} Crop row(s) remapped`)
    }
  }

  console.log(
    `\n  ${affected} mixed-width chapter(s) ${APPLY ? 'migrated' : 'would be migrated'}, ` +
    `${skippedUniform} uniform-width skipped (identity transform).`
  )
  console.log(`  ${totalPoints} pointer crop(s), ${totalRows} v1 Crop row(s).`)
  if (!APPLY) console.log('\n  Nothing was written. Re-run with --apply.')

  await prisma.$disconnect()
  process.exit(0)
}

main().catch(async err => {
  console.error(err)
  await prisma.$disconnect()
  process.exit(1)
})
