/**
 * Verification pipeline for a pasted crop JSON in Image Clipper 3.0.
 *
 * Scope note, because this changed: 3.0 has NO stitched chapter canvas. Each
 * image carries its own JSON whose coordinates are normalized 0.0–1.0 against
 * that image alone, so there is deliberately no slice matching and no
 * local→global remapping here. An earlier version did remap, and a paste whose
 * JSON named no page would go unmapped and be read as spanning the whole
 * chapter — which marked every image done. Coordinates now pass through
 * untouched, and each artifact is validated on its own terms.
 *
 *   1. Syntax parsing       (JSON.parse)
 *   2. Structure detection  (single crop, `crops[]`, `pages[]`, or root array)
 *   3. Point cardinality    (exactly 4 points)
 *   4. Numeric/NaN check    (x/y must be real numbers)
 *   5. Normalization bounds (0.0 <= x, y <= 1.0 — warning, not an error)
 *   6. Crop mode resolution (rectangle vs. perspective)
 */

export type CropMode = 'rectangle' | 'perspective'

export interface CropPoint {
  id?: string
  x: number
  y: number
}

export interface ValidationResult {
  isValid: boolean
  errors: string[]
  warnings: string[]
}

export interface ParsedCropItem {
  name: string
  id?: string
  reason?: string
  mode: CropMode
  /** Normalized against the image this JSON belongs to. Never remapped. */
  points: [CropPoint, CropPoint, CropPoint, CropPoint]
  validation: ValidationResult
}

function formatCropName(rawName?: string, defaultIndex = 1): string {
  if (!rawName || typeof rawName !== 'string') return `Crop ${defaultIndex}`
  const cleaned = rawName.replace(/_/g, ' ').replace(/-/g, ' ').trim()
  if (!cleaned) return `Crop ${defaultIndex}`
  return cleaned
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

const FALLBACK_POINTS = (): [CropPoint, CropPoint, CropPoint, CropPoint] => [
  { id: 'P1', x: 0, y: 0 },
  { id: 'P2', x: 1, y: 0 },
  { id: 'P3', x: 1, y: 1 },
  { id: 'P4', x: 0, y: 1 }
]

/** Validates one crop object (the whole payload, or one entry from `crops`/`pages[].crops`). */
export function validateSingleCropObject(
  cropObj: any,
  globalMetadata: {
    format?: string
    version?: string
    coordinateSystem?: string
    name?: string
  }
): {
  mode: CropMode
  validation: ValidationResult
  name: string
  points: [CropPoint, CropPoint, CropPoint, CropPoint]
} {
  const errors: string[] = []
  const warnings: string[] = []

  // 1/2. Format + coordinate system (container shape resolved in parseCropJson).
  const format = globalMetadata.format || cropObj?.format || 'four-point-crop'
  if (format !== 'four-point-crop') {
    errors.push(`Unsupported crop format: "${format}". Expected "four-point-crop".`)
  }

  const version = globalMetadata.version || cropObj?.version || '1.0'
  if (parseFloat(version) > 1.0) {
    warnings.push(`Specification version ${version} is newer than supported 1.0.`)
  }

  const coordinateSystem = globalMetadata.coordinateSystem || cropObj?.coordinateSystem || 'normalized'
  if (coordinateSystem !== 'normalized' && coordinateSystem !== 'pixels') {
    errors.push(`Unsupported coordinateSystem "${coordinateSystem}". Expected "normalized".`)
  }

  const targetCrop = cropObj?.crop || cropObj
  // 6. Mode resolution.
  const mode: CropMode = targetCrop?.mode === 'perspective' ? 'perspective' : 'rectangle'

  // 3/4. Point cardinality + numeric/NaN checks.
  let rawPoints: CropPoint[] = []

  if (!targetCrop || typeof targetCrop !== 'object') {
    errors.push('Missing crop points definition object.')
    rawPoints = FALLBACK_POINTS()
  } else if (!Array.isArray(targetCrop.points)) {
    errors.push('Crop points must be an array of exactly 4 point objects.')
    rawPoints = FALLBACK_POINTS()
  } else {
    rawPoints = targetCrop.points.map((pt: any, index: number) => {
      const pNum = index + 1
      const xVal = typeof pt?.x === 'number' && !Number.isNaN(pt.x) ? pt.x : 0
      const yVal = typeof pt?.y === 'number' && !Number.isNaN(pt.y) ? pt.y : 0

      if (typeof pt?.x !== 'number' || Number.isNaN(pt.x)) {
        errors.push(`Point P${pNum} missing valid numeric "x" coordinate.`)
      }
      if (typeof pt?.y !== 'number' || Number.isNaN(pt.y)) {
        errors.push(`Point P${pNum} missing valid numeric "y" coordinate.`)
      }

      // 5. Normalization bounds — a warning, not a blocking error.
      if (xVal < 0 || xVal > 1.0 || yVal < 0 || yVal > 1.0) {
        warnings.push(`Point P${pNum} (${xVal}, ${yVal}) is outside standard 0.0–1.0 bounds.`)
      }

      return { id: pt?.id || `P${pNum}`, x: xVal, y: yVal }
    })

    if (rawPoints.length !== 4) {
      errors.push(`Crop points array contains ${rawPoints.length} points. Must contain exactly 4 points.`)
      // Padded/trimmed for safe recovery — the error above is what blocks it.
      while (rawPoints.length < 4) {
        rawPoints.push({ id: `P${rawPoints.length + 1}`, x: 0, y: 0 })
      }
      if (rawPoints.length > 4) rawPoints = rawPoints.slice(0, 4)
    }
  }

  const points: [CropPoint, CropPoint, CropPoint, CropPoint] = [
    rawPoints[0], rawPoints[1], rawPoints[2], rawPoints[3]
  ]

  const name = formatCropName(
    cropObj?.reason || cropObj?.name || cropObj?.label || cropObj?.id || globalMetadata.name
  )

  return {
    mode,
    validation: { isValid: errors.length === 0, errors, warnings },
    name,
    points
  }
}

function invalidItem(message: string, filename?: string): ParsedCropItem[] {
  return [{
    name: filename ? filename.replace(/\.[^/.]+$/, '') : 'Invalid Crop',
    mode: 'rectangle',
    points: FALLBACK_POINTS(),
    validation: { isValid: false, errors: [message], warnings: [] }
  }]
}

/**
 * Parses + validates one image's crop JSON.
 *
 * `filename` is the image this paste belongs to, used only for naming — never
 * to remap coordinates, since they already belong to that image.
 */
export function parseCropJson(
  rawText: string,
  _unusedManifest?: unknown,
  filename?: string
): ParsedCropItem[] {
  let rawJson: unknown
  try {
    rawJson = JSON.parse(rawText)
  } catch {
    return invalidItem('Invalid JSON syntax.', filename)
  }

  if (!rawJson || typeof rawJson !== 'object') {
    return invalidItem('Invalid JSON or empty content.', filename)
  }

  const data = rawJson as Record<string, any>

  // Case A: root-level array of crop objects.
  if (Array.isArray(data)) {
    return data.map((item, index) => {
      const res = validateSingleCropObject(item, {})
      return {
        name: formatCropName(item?.reason || item?.name || item?.label || item?.id, index + 1),
        id: item?.id,
        reason: item?.reason,
        mode: res.mode,
        points: res.points,
        validation: res.validation
      }
    })
  }

  const globalMeta = {
    format: data.format,
    version: data.version,
    coordinateSystem: data.coordinateSystem,
    name: data.name
  }

  // Case B1: `pages` array. Accepted because an external AI may answer in that
  // shape, but every crop still belongs to THIS image — 3.0 pastes one image at
  // a time, so the page grouping is flattened rather than used to place crops.
  if (Array.isArray(data.pages) && data.pages.length > 0) {
    const all: ParsedCropItem[] = []
    let index = 1

    data.pages.forEach((pageItem: any) => {
      if (!Array.isArray(pageItem?.crops)) return
      pageItem.crops.forEach((cropItem: any) => {
        const res = validateSingleCropObject(cropItem, globalMeta)
        all.push({
          name: formatCropName(
            cropItem?.reason || cropItem?.name || cropItem?.label || cropItem?.id,
            index
          ),
          id: cropItem?.id,
          reason: cropItem?.reason,
          mode: res.mode,
          points: res.points,
          validation: res.validation
        })
        index++
      })
    })

    if (all.length > 0) return all
  }

  // Case B2: top-level `crops` array.
  if (Array.isArray(data.crops) && data.crops.length > 0) {
    return data.crops.map((item: any, index: number) => {
      const res = validateSingleCropObject(item, globalMeta)
      return {
        name: formatCropName(item?.reason || item?.name || item?.label || item?.id, index + 1),
        id: item?.id,
        reason: item?.reason,
        mode: res.mode,
        points: res.points,
        validation: res.validation
      }
    })
  }

  // Case C: single-crop object.
  const fallbackName = filename ? filename.replace(/\.[^/.]+$/, '').replace(/_/g, ' ') : undefined
  const single = validateSingleCropObject(data, globalMeta)

  return [{
    name: formatCropName(data.name || single.name || fallbackName, 1),
    id: data.id,
    reason: data.reason,
    mode: single.mode,
    points: single.points,
    validation: single.validation
  }]
}

/** True when every parsed crop passed validation. Warnings do not block. */
export function isFullyValid(items: ParsedCropItem[]): boolean {
  return items.length > 0 && items.every(item => item.validation.isValid)
}
