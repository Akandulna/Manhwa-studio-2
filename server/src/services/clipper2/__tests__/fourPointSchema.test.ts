/**
 * Tests for the Image Clipper 2.0 `four-point-crop` schema:
 * - byte-for-byte round trip of the §14.7 canonical reference file
 * - validation rejects (pixel coords, bad geometry, bad identity fields)
 * - validation warnings (OUT-07 / OUT-08 / OUT-09 / OUT-13 conventions)
 * - deterministic repair (edge snapping, sliver drop, sort + renumber)
 * - normalized ↔ canvas-pixel conversion and band de-duplication
 */

import { describe, it, expect } from 'vitest'
import {
  formatRatio,
  boundsOf,
  pointsFromBounds,
  cropIdFor,
  toSnakeCaseReason,
  emptyCropFile,
  rectFromEntry,
  entryFromCanvasRect,
  verticalIoU,
  dedupeEntries,
  validateCropFile,
  normalizeCropFile,
  parseCropFile,
  serializeCropFile
} from '../fourPointSchema.js'
import type { CropEntry, FourPointCropFile, ValidationIssue } from '../fourPointTypes.js'

// The canonical reference file from server/ml/CROP_POINT_GUIDELINES.default.md
// §14.7, verbatim (no trailing newline — serializeCropFile adds exactly one).
const REFERENCE_147 = `{
  "format": "four-point-crop",
  "version": "1.0",
  "image": {
    "filename": "page_001.jpg",
    "width": 246,
    "height": 2048
  },
  "coordinateSystem": "normalized",
  "crops": [
    {
      "id": "crop-01",
      "reason": "full_width_forest_scene",
      "crop": {
        "mode": "rectangle",
        "points": [
          {
            "id": "P1",
            "x": 0.0,
            "y": 0.244140625
          },
          {
            "id": "P2",
            "x": 1.0,
            "y": 0.244140625
          },
          {
            "id": "P3",
            "x": 1.0,
            "y": 0.604980469
          },
          {
            "id": "P4",
            "x": 0.0,
            "y": 0.604980469
          }
        ]
      }
    },
    {
      "id": "crop-02",
      "reason": "framed_hand_scene",
      "crop": {
        "mode": "rectangle",
        "points": [
          {
            "id": "P1",
            "x": 0.06504065,
            "y": 0.6796875
          },
          {
            "id": "P2",
            "x": 0.727642276,
            "y": 0.6796875
          },
          {
            "id": "P3",
            "x": 0.727642276,
            "y": 0.842285156
          },
          {
            "id": "P4",
            "x": 0.06504065,
            "y": 0.842285156
          }
        ]
      }
    }
  ]
}`

const codesOf = (issues: ValidationIssue[]) => issues.map(i => i.code)

function rectCrop(id: string, reason: string, left: number, top: number, right: number, bottom: number): CropEntry {
  return {
    id,
    reason,
    crop: {
      mode: 'rectangle',
      points: [
        { id: 'P1', x: left, y: top },
        { id: 'P2', x: right, y: top },
        { id: 'P3', x: right, y: bottom },
        { id: 'P4', x: left, y: bottom }
      ]
    }
  }
}

function fileWith(crops: unknown[]): Record<string, unknown> {
  return {
    format: 'four-point-crop',
    version: '1.0',
    image: { filename: 'page_001.jpg', width: 246, height: 2048 },
    coordinateSystem: 'normalized',
    crops
  }
}

describe('§14.7 canonical round trip', () => {
  it('parses the reference file as valid, with no warnings', () => {
    const { file, report } = parseCropFile(REFERENCE_147)
    expect(report.errors).toEqual([])
    expect(report.warnings).toEqual([])
    expect(report.valid).toBe(true)
    expect(file?.crops).toHaveLength(2)
  })

  it('re-serializes it byte-for-byte (key order, indentation, expanded points)', () => {
    const { file } = parseCropFile(REFERENCE_147)
    expect(file).not.toBeNull()
    expect(serializeCropFile(file as FourPointCropFile)).toBe(`${REFERENCE_147}\n`)
  })

  it('keeps exact ratios unrounded (OUT-10) and exact bounds as 0.0 / 1.0 (OUT-11)', () => {
    const { file } = parseCropFile(REFERENCE_147)
    const text = serializeCropFile(file as FourPointCropFile)
    expect(text).toContain('"y": 0.244140625')
    expect(text).toContain('"x": 0.06504065')
    expect(text).toContain('"x": 0.727642276')
    expect(text).toContain('"x": 0.0,')
    expect(text).toContain('"x": 1.0,')
    expect(text).not.toContain('"x": 0,')
    expect(text).not.toContain('"x": 1,')
    expect(text.endsWith('}\n')).toBe(true)
  })

  it('survives a normalize pass unchanged (the reference is already canonical)', () => {
    const { file } = parseCropFile(REFERENCE_147)
    const { file: normalized, repairs } = normalizeCropFile(file as FourPointCropFile)
    expect(repairs).toEqual([])
    expect(serializeCropFile(normalized)).toBe(`${REFERENCE_147}\n`)
  })
})

describe('validateCropFile — rejects', () => {
  it('rejects a non-object and a non-array crops field', () => {
    expect(codesOf(validateCropFile('nope').errors)).toContain('not_an_object')
    expect(codesOf(validateCropFile(null).errors)).toContain('not_an_object')
    const bad = fileWith([])
    bad.crops = { '0': 'x' }
    expect(codesOf(validateCropFile(bad).errors)).toContain('crops_not_array')
  })

  it('rejects pixel coordinates and names OUT-04', () => {
    const crop = rectCrop('crop-01', 'top_scene', 0, 0.1, 1, 0.2) as unknown as Record<string, any>
    crop.crop.points[2].y = 500
    crop.crop.points[3].y = 500
    const report = validateCropFile(fileWith([crop]))
    expect(report.valid).toBe(false)
    expect(codesOf(report.errors)).toContain('coordinate_out_of_range')
    expect(report.errors.find(e => e.code === 'coordinate_out_of_range')?.message).toMatch(/OUT-04/)
    expect(report.file).toBeNull()
  })

  it('rejects a negative coordinate without the pixel hint', () => {
    const crop = rectCrop('crop-01', 'top_scene', -0.2, 0.1, 1, 0.2)
    const report = validateCropFile(fileWith([crop]))
    const issue = report.errors.find(e => e.code === 'coordinate_out_of_range')
    expect(issue).toBeDefined()
    expect(issue?.message).not.toMatch(/OUT-04/)
  })

  it('rejects a 3-point crop', () => {
    const crop = rectCrop('crop-01', 'top_scene', 0, 0.1, 1, 0.2)
    crop.crop.points = crop.crop.points.slice(0, 3)
    expect(codesOf(validateCropFile(fileWith([crop])).errors)).toContain('points_not_four')
  })

  it('rejects mode "polygon" (OUT-06 / AN-02)', () => {
    const crop = rectCrop('crop-01', 'top_scene', 0, 0.1, 1, 0.2) as unknown as Record<string, any>
    crop.crop.mode = 'polygon'
    expect(codesOf(validateCropFile(fileWith([crop])).errors)).toContain('bad_crop_mode')
  })

  it('rejects non-rectangular points, even by a hair (§13.1 is exact)', () => {
    const crop = rectCrop('crop-01', 'top_scene', 0.1, 0.1, 0.9, 0.2)
    crop.crop.points[3].x = 0.1001
    expect(codesOf(validateCropFile(fileWith([crop])).errors)).toContain('points_not_rectangular')
  })

  it('rejects out-of-order point ids', () => {
    const crop = rectCrop('crop-01', 'top_scene', 0.1, 0.1, 0.9, 0.2)
    const points = crop.crop.points
    crop.crop.points = [points[1], points[0], points[2], points[3]]
    expect(codesOf(validateCropFile(fileWith([crop])).errors)).toContain('point_ids_out_of_order')
  })

  it('rejects duplicate crop ids', () => {
    const crops = [
      rectCrop('crop-01', 'top_scene', 0, 0.1, 1, 0.2),
      rectCrop('crop-01', 'lower_scene', 0.1, 0.3, 0.9, 0.4)
    ]
    expect(codesOf(validateCropFile(fileWith(crops)).errors)).toContain('duplicate_crop_id')
  })

  it('rejects zero and negative area', () => {
    const flat = rectCrop('crop-01', 'top_scene', 0.2, 0.5, 0.2, 0.5)
    expect(codesOf(validateCropFile(fileWith([flat])).errors)).toContain('degenerate_area')
  })

  it('rejects a wrong format string and a wrong coordinateSystem', () => {
    const bad = fileWith([rectCrop('crop-01', 'top_scene', 0, 0.1, 1, 0.2)])
    bad.format = 'four-point-crops'
    bad.coordinateSystem = 'pixels'
    const report = validateCropFile(bad)
    expect(codesOf(report.errors)).toContain('bad_format')
    expect(codesOf(report.errors)).toContain('bad_coordinate_system')
  })

  it('rejects missing identity and image metadata (OUT-14)', () => {
    const bad = fileWith([{ reason: 'top_scene' }])
    delete bad.version
    bad.image = { filename: '', width: 0, height: 2048 }
    const report = validateCropFile(bad)
    expect(codesOf(report.errors)).toEqual(expect.arrayContaining([
      'missing_version',
      'bad_image_filename',
      'bad_image_dimensions',
      'missing_crop_id',
      'missing_crop_geometry'
    ]))
  })
})

describe('validateCropFile — convention warnings', () => {
  it('warns when crops are not in top-to-bottom order (OUT-07)', () => {
    const crops = [
      rectCrop('crop-01', 'lower_scene', 0.0, 0.5, 1.0, 0.6),
      rectCrop('crop-02', 'upper_scene', 0.1, 0.1, 0.9, 0.2)
    ]
    const report = validateCropFile(fileWith(crops))
    expect(report.valid).toBe(true)
    expect(codesOf(report.warnings)).toContain('crops_not_sorted')
  })

  it('warns when ids are not contiguous (OUT-08)', () => {
    const crops = [
      rectCrop('crop-01', 'upper_scene', 0.0, 0.1, 1.0, 0.2),
      rectCrop('crop-03', 'lower_scene', 0.1, 0.3, 0.9, 0.4)
    ]
    expect(codesOf(validateCropFile(fileWith(crops)).warnings)).toContain('ids_not_contiguous')
  })

  it('warns when every crop shares the same x pair (OUT-13 / IX-01)', () => {
    const crops = [
      rectCrop('crop-01', 'upper_scene', 0.1, 0.1, 0.99, 0.2),
      rectCrop('crop-02', 'middle_scene', 0.1, 0.3, 0.99, 0.4),
      rectCrop('crop-03', 'lower_scene', 0.1, 0.5, 0.99, 0.6)
    ]
    const report = validateCropFile(fileWith(crops))
    expect(report.valid).toBe(true)
    expect(codesOf(report.warnings)).toContain('identical_x_across_crops')
  })

  it('does not warn about x when the file mixes full-width and inset crops', () => {
    const crops = [
      rectCrop('crop-01', 'full_width_forest_scene', 0.0, 0.1, 1.0, 0.2),
      rectCrop('crop-02', 'framed_hand_scene', 0.065, 0.3, 0.7276, 0.4)
    ]
    expect(codesOf(validateCropFile(fileWith(crops)).warnings)).toEqual([])
  })

  it('warns on a reason that is not snake_case (OUT-09)', () => {
    const crops = [rectCrop('crop-01', 'Top Character Scene', 0.0, 0.1, 1.0, 0.2)]
    const report = validateCropFile(fileWith(crops))
    expect(report.valid).toBe(true)
    const issue = report.warnings.find(w => w.code === 'reason_not_snake_case')
    expect(issue?.message).toContain('top_character_scene')
    expect(issue?.cropId).toBe('crop-01')
  })

  it('warns on a crop smaller than 0.05% of the page', () => {
    const crops = [rectCrop('crop-01', 'tiny_scene', 0.0, 0.1, 0.02, 0.11)]
    expect(codesOf(validateCropFile(fileWith(crops)).warnings)).toContain('crop_area_tiny')
  })
})

describe('normalizeCropFile', () => {
  const base = (crops: CropEntry[]): FourPointCropFile => ({
    format: 'four-point-crop',
    version: '1.0',
    image: { filename: 'page_001.jpg', width: 246, height: 2048 },
    coordinateSystem: 'normalized',
    crops
  })

  it('snaps a 0.0650 / 0.0651 edge pair to their mean', () => {
    const crop = rectCrop('crop-01', 'framed_hand_scene', 0.065, 0.6796875, 0.727642276, 0.842285156)
    crop.crop.points[3].x = 0.0651
    const { file, repairs } = normalizeCropFile(base([crop]))
    expect(codesOf(repairs)).toContain('edges_snapped')
    expect(file.crops[0].crop.points[0].x).toBeCloseTo(0.06505, 9)
    expect(file.crops[0].crop.points[3].x).toBe(file.crops[0].crop.points[0].x)
    expect(file.crops[0].crop.points[1].x).toBe(0.727642276)
  })

  it('never snaps 0.991453 up to 1.0 (IX-04 / §14.9)', () => {
    const crop = rectCrop('crop-01', 'top_scene', 0.0, 0.019531, 0.991453, 0.161621)
    const { file } = normalizeCropFile(base([crop]))
    expect(file.crops[0].crop.points[1].x).toBe(0.991453)
    expect(file.crops[0].crop.points[2].x).toBe(0.991453)
    expect(file.crops[0].crop.points[0].x).toBe(0)
  })

  it('drops a degenerate sliver and reports it', () => {
    const crops = [
      rectCrop('crop-01', 'real_scene', 0.0, 0.1, 1.0, 0.3),
      rectCrop('crop-02', 'sliver', 0.0, 0.5, 1.0, 0.5005)
    ]
    const { file, repairs } = normalizeCropFile(base(crops))
    expect(file.crops).toHaveLength(1)
    expect(file.crops[0].reason).toBe('real_scene')
    expect(repairs.find(r => r.code === 'crop_dropped_sliver')?.cropId).toBe('crop-02')
  })

  it('drops a crop narrower than minNormWidth', () => {
    const crops = [rectCrop('crop-01', 'hairline', 0.5, 0.1, 0.505, 0.4)]
    const { file, repairs } = normalizeCropFile(base(crops))
    expect(file.crops).toEqual([])
    expect(codesOf(repairs)).toContain('crop_dropped_sliver')
  })

  it('sorts by top, renumbers contiguously and normalizes reasons', () => {
    const crops = [
      rectCrop('crop-09', 'Lower Scene!', 0.1, 0.6, 0.9, 0.7),
      rectCrop('crop-05', '  Upper   Scene  ', 0.0, 0.1, 1.0, 0.2)
    ]
    const { file, repairs } = normalizeCropFile(base(crops))
    expect(file.crops.map(c => c.id)).toEqual(['crop-01', 'crop-02'])
    expect(file.crops.map(c => c.reason)).toEqual(['upper_scene', 'lower_scene'])
    expect(file.crops.map(c => c.crop.points[0].y)).toEqual([0.1, 0.6])
    expect(codesOf(repairs)).toEqual(expect.arrayContaining(['crops_reordered', 'id_renumbered', 'reason_normalized']))
    expect(validateCropFile(file).valid).toBe(true)
  })

  it('clamps out-of-range coordinates and keeps the file valid', () => {
    const crop = rectCrop('crop-01', 'top_scene', -0.4, 0.1, 1.6, 0.5)
    const { file, repairs } = normalizeCropFile(base([crop]))
    expect(codesOf(repairs)).toContain('coordinates_clamped')
    expect(file.crops[0].crop.points[0].x).toBe(0)
    expect(file.crops[0].crop.points[1].x).toBe(1)
    expect(validateCropFile(file).valid).toBe(true)
  })

  it('rebuilds canonical points from junk order and junk ids', () => {
    const crop: CropEntry = {
      id: 'crop-01',
      reason: 'scrambled_scene',
      crop: {
        mode: 'rectangle',
        points: [
          { id: 'P3', x: 0.9, y: 0.4 },
          { id: 'P1', x: 0.2, y: 0.2 },
          { id: 'P4', x: 0.2, y: 0.4 },
          { id: 'P2', x: 0.9, y: 0.2 }
        ]
      }
    }
    const { file } = normalizeCropFile(base([crop]))
    expect(file.crops[0].crop.points.map(p => p.id)).toEqual(['P1', 'P2', 'P3', 'P4'])
    expect(file.crops[0].crop.points.map(p => [p.x, p.y])).toEqual([
      [0.2, 0.2], [0.9, 0.2], [0.9, 0.4], [0.2, 0.4]
    ])
    expect(validateCropFile(file).valid).toBe(true)
  })

  it('reports missing image metadata rather than inventing it (OUT-14)', () => {
    const broken = { format: 'four-point-crop', version: '', crops: [] } as unknown as FourPointCropFile
    const { file, repairs } = normalizeCropFile(broken)
    expect(codesOf(repairs)).toEqual(expect.arrayContaining([
      'version_defaulted',
      'coordinate_system_corrected',
      'image_metadata_missing'
    ]))
    expect(file.image).toEqual({ filename: '', width: 0, height: 0 })
    expect(file.version).toBe('1.0')
  })
})

describe('canvas conversion', () => {
  const entry = rectCrop('crop-02', 'framed_hand_scene', 0.06504065, 0.6796875, 0.727642276, 0.842285156)

  it('resolves normalized bounds to canvas pixels', () => {
    const rect = rectFromEntry(entry, 246, 2048)
    expect(rect.canvasX).toBeCloseTo(16, 5)
    expect(rect.canvasY).toBeCloseTo(1392, 5)
    expect(rect.canvasW).toBeCloseTo(163, 4)
    expect(rect.canvasH).toBeCloseTo(333, 4)
  })

  it('round-trips normalized → canvas → normalized', () => {
    const rect = rectFromEntry(entry, 246, 2048)
    const back = entryFromCanvasRect(rect, 246, 2048, 'crop-02', 'framed_hand_scene')
    const a = boundsOf(entry)
    const b = boundsOf(back)
    expect(b.left).toBeCloseTo(a.left, 9)
    expect(b.right).toBeCloseTo(a.right, 9)
    expect(b.top).toBeCloseTo(a.top, 9)
    expect(b.bottom).toBeCloseTo(a.bottom, 9)
    expect(back.crop.points.map(p => p.id)).toEqual(['P1', 'P2', 'P3', 'P4'])
  })

  it('clamps an overhanging rect and snake_cases the reason', () => {
    const back = entryFromCanvasRect(
      { canvasX: -40, canvasY: -10, canvasW: 400, canvasH: 4000 },
      246,
      2048,
      'crop-01',
      'Full Width Forest Scene'
    )
    expect(boundsOf(back)).toEqual({ left: 0, top: 0, right: 1, bottom: 1 })
    expect(back.reason).toBe('full_width_forest_scene')
  })

  it('yields a zero rect for a degenerate canvas instead of NaN', () => {
    const back = entryFromCanvasRect({ canvasX: 10, canvasY: 10, canvasW: 10, canvasH: 10 }, 0, 0, 'crop-01', 'x')
    expect(boundsOf(back)).toEqual({ left: 0, top: 0, right: 0, bottom: 0 })
    expect(rectFromEntry(entry, NaN, NaN).canvasW).toBe(0)
  })
})

describe('verticalIoU / dedupeEntries', () => {
  it('scores vertical overlap only', () => {
    const a = { left: 0, right: 1, top: 0.1, bottom: 0.2 }
    const b = { left: 0.5, right: 0.6, top: 0.1, bottom: 0.2 }
    expect(verticalIoU(a, b)).toBe(1)
    expect(verticalIoU(a, { left: 0, right: 1, top: 0.3, bottom: 0.4 })).toBe(0)
    expect(verticalIoU(a, { left: 0, right: 1, top: 0.15, bottom: 0.25 })).toBeCloseTo(1 / 3, 9)
  })

  it('keeps the higher-confidence duplicate and preserves order', () => {
    const first = rectCrop('crop-01', 'seam_dup_low', 0.0, 0.10, 1.0, 0.50)
    const second = rectCrop('crop-02', 'seam_dup_high', 0.0, 0.11, 1.0, 0.51)
    const third = rectCrop('crop-03', 'other_scene', 0.0, 0.70, 1.0, 0.90)
    const score: Record<string, number> = { 'crop-01': 0.4, 'crop-02': 0.9, 'crop-03': 0.8 }
    const { kept, dropped } = dedupeEntries([first, second, third], 0.6, e => score[e.id])
    expect(kept.map(k => k.id)).toEqual(['crop-02', 'crop-03'])
    expect(dropped.map(d => d.id)).toEqual(['crop-01'])
  })

  it('keeps the earlier entry when scores tie, and never merges disjoint bands', () => {
    const first = rectCrop('crop-01', 'a_scene', 0.0, 0.10, 1.0, 0.50)
    const second = rectCrop('crop-02', 'b_scene', 0.0, 0.11, 1.0, 0.51)
    expect(dedupeEntries([first, second], 0.6).kept.map(k => k.id)).toEqual(['crop-01'])

    const far = rectCrop('crop-03', 'c_scene', 0.0, 0.80, 1.0, 0.90)
    expect(dedupeEntries([first, far], 0).kept).toHaveLength(2)
  })
})

describe('pure helpers', () => {
  it('formatRatio keeps 9-dp exactness and strips trailing zeros (OUT-10)', () => {
    expect(formatRatio(0.244140625)).toBe(0.244140625)
    expect(formatRatio(0.06504065)).toBe(0.06504065)
    expect(formatRatio(16 / 246)).toBe(0.06504065)
    expect(formatRatio(0.5000000000001)).toBe(0.5)
    expect(formatRatio(1 / 3)).toBe(0.333333333)
    expect(formatRatio(-0)).toBe(0)
    expect(formatRatio(NaN)).toBe(0)
  })

  it('cropIdFor zero-pads to at least two digits (OUT-08)', () => {
    expect(cropIdFor(0)).toBe('crop-01')
    expect(cropIdFor(9)).toBe('crop-10')
    expect(cropIdFor(99)).toBe('crop-100')
  })

  it('toSnakeCaseReason collapses, trims and falls back (OUT-09)', () => {
    expect(toSnakeCaseReason('Top Character Scene')).toBe('top_character_scene')
    expect(toSnakeCaseReason('  Full-Width  Forest!! ')).toBe('full_width_forest')
    expect(toSnakeCaseReason('already_snake_case')).toBe('already_snake_case')
    expect(toSnakeCaseReason('???')).toBe('visual_section')
    expect(toSnakeCaseReason('')).toBe('visual_section')
  })

  it('boundsOf tolerates missing points; pointsFromBounds winds P1→P4', () => {
    expect(boundsOf({ id: 'crop-01', reason: 'x', crop: { mode: 'rectangle', points: [] } }))
      .toEqual({ left: 0, top: 0, right: 0, bottom: 0 })
    expect(pointsFromBounds({ left: 0.1, top: 0.2, right: 0.8, bottom: 0.9 })).toEqual([
      { id: 'P1', x: 0.1, y: 0.2 },
      { id: 'P2', x: 0.8, y: 0.2 },
      { id: 'P3', x: 0.8, y: 0.9 },
      { id: 'P4', x: 0.1, y: 0.9 }
    ])
  })

  it('emptyCropFile serializes to parseable text with an empty crops array (OUT-16)', () => {
    const text = serializeCropFile(emptyCropFile({ filename: '[stitched:12]', width: 800, height: 24000 }))
    expect(text).toContain('"crops": []')
    expect(text).toContain('"filename": "[stitched:12]"')
    expect(text.endsWith('\n')).toBe(true)
    const { file, report } = parseCropFile(text)
    expect(report.valid).toBe(true)
    expect(file?.crops).toEqual([])
    expect(serializeCropFile(file as FourPointCropFile)).toBe(text)
  })

  it('parseCropFile reports a syntax error instead of throwing', () => {
    const { file, report } = parseCropFile('{"format": "four-point-crop",')
    expect(file).toBeNull()
    expect(report.valid).toBe(false)
    expect(codesOf(report.errors)).toEqual(['invalid_json'])
  })
})
