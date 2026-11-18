/**
 * Tests for the "top one step too high" check behind Preview's Move top here:
 * - a top 256 or 512 px above its panel is found, at the panel's exact row
 * - a bubble in the strip above the panel does not hide the slip
 * - a top already on its panel border, an unframed shot, a strip full of
 *   artwork and a crop too short to cut are all left alone
 * - suggestions come back normalized against the page, keyed to the crop
 */

import { describe, it, expect } from 'vitest'
import type { LumaPage } from '../../antigravity/review/types.js'
import { suggestedTop, topSuggestions } from '../topSlip.js'

const WIDTH = 400
const HEIGHT = 3000

/** A white page; `paint` fills rectangles of luminance on it. */
function page(paint: (fill: (x0: number, y0: number, x1: number, y1: number, luma: number | ((x: number, y: number) => number)) => void) => void): LumaPage {
  const data = new Uint8Array(WIDTH * HEIGHT).fill(255)
  paint((x0, y0, x1, y1, luma) => {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) data[y * WIDTH + x] = typeof luma === 'number' ? luma : luma(x, y)
    }
  })
  return { width: WIDTH, height: HEIGHT, data }
}

/** Contrasty artwork that changes slowly down the page: plenty of ink, but no row that reads as a border. */
const art = (x: number, y: number) => 40 + ((x * 7 + (y >> 5) * 3) % 160)

describe('suggestedTop', () => {
  it('finds a top one step above its panel, at the panel row', () => {
    const p = page(fill => fill(0, 1000, WIDTH, 2200, art))
    expect(suggestedTop(p, { x0: 0, y0: 1000 - 256, x1: WIDTH, y1: 2200 })).toBe(1000)
  })

  it('finds the panel row when the slip is not exactly 256 px', () => {
    const p = page(fill => fill(0, 1000, WIDTH, 2200, art))
    expect(suggestedTop(p, { x0: 0, y0: 1000 - 270, x1: WIDTH, y1: 2200 })).toBe(1000)
  })

  it('finds a top two steps above its panel', () => {
    const p = page(fill => fill(0, 1200, WIDTH, 2400, art))
    expect(suggestedTop(p, { x0: 0, y0: 1200 - 512, x1: WIDTH, y1: 2400 })).toBe(1200)
  })

  it('still finds the slip when a speech bubble sits in the strip', () => {
    const p = page(fill => {
      fill(0, 1000, WIDTH, 2200, art)
      // A bubble outline and a few lines of lettering above the panel.
      fill(120, 800, 300, 804, 0)
      fill(120, 800, 124, 980, 0)
      fill(296, 800, 300, 980, 0)
      fill(150, 850, 270, 858, 0)
      fill(150, 890, 270, 898, 0)
    })
    expect(suggestedTop(p, { x0: 0, y0: 1000 - 256, x1: WIDTH, y1: 2200 })).toBe(1000)
  })

  it('leaves a top that is already on its panel border', () => {
    const p = page(fill => fill(0, 1000, WIDTH, 2200, art))
    expect(suggestedTop(p, { x0: 0, y0: 1000, x1: WIDTH, y1: 2200 })).toBeNull()
  })

  it('leaves a panel that happens to have a border-like line 256 px down inside it', () => {
    const p = page(fill => {
      fill(0, 1000, WIDTH, 2200, art)
      fill(0, 1256, WIDTH, 2200, (x, y) => 200 + ((x + y) % 30))
    })
    expect(suggestedTop(p, { x0: 0, y0: 1000, x1: WIDTH, y1: 2200 })).toBeNull()
  })

  it('leaves an unframed shot whose top is inside continuous artwork', () => {
    const p = page(fill => {
      fill(0, 500, WIDTH, 1000, art)
      fill(0, 1000, WIDTH, 2200, (x, y) => 20 + ((x * 3 + y * 5) % 40))
    })
    // The strip between the top and the line is artwork, not gutter.
    expect(suggestedTop(p, { x0: 0, y0: 1000 - 256, x1: WIDTH, y1: 2200 })).toBeNull()
  })

  it('leaves a top with no border a step below it', () => {
    const p = page(fill => fill(0, 1400, WIDTH, 2200, art))
    expect(suggestedTop(p, { x0: 0, y0: 1000, x1: WIDTH, y1: 2200 })).toBeNull()
  })

  it('never suggests cutting a crop down to a sliver', () => {
    const p = page(fill => fill(0, 1000, WIDTH, 1040, art))
    expect(suggestedTop(p, { x0: 0, y0: 1000 - 256, x1: WIDTH, y1: 1040 })).toBeNull()
  })

  it('looks only across the crop\'s own width', () => {
    const p = page(fill => {
      fill(0, 1000, 200, 2200, art)
      // A different panel beside it starts higher; it is not this crop's border.
      fill(220, 700, WIDTH, 2200, art)
    })
    expect(suggestedTop(p, { x0: 0, y0: 1000 - 256, x1: 200, y1: 2200 })).toBe(1000)
  })
})

describe('topSuggestions', () => {
  const crop = (id: string, top: number, bottom: number) => ({
    id,
    reason: 'illustrated_shot',
    crop: {
      mode: 'rectangle' as const,
      points: [
        { id: 'P1', x: 0, y: top / HEIGHT },
        { id: 'P2', x: 1, y: top / HEIGHT },
        { id: 'P3', x: 1, y: bottom / HEIGHT },
        { id: 'P4', x: 0, y: bottom / HEIGHT }
      ]
    }
  })

  it('returns only the slipped crop, normalized against the page', () => {
    const p = page(fill => {
      fill(0, 200, WIDTH, 500, art)
      fill(0, 1000, WIDTH, 2200, art)
    })
    const found = topSuggestions(p, [crop('crop-01', 200, 500), crop('crop-02', 1000 - 256, 2200)])
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ cropId: 'crop-02', left: 0, movePx: 256 })
    expect(found[0]!.top).toBeCloseTo((1000 - 256) / HEIGHT, 9)
    expect(found[0]!.suggestedTop).toBeCloseTo(1000 / HEIGHT, 9)
  })
})
