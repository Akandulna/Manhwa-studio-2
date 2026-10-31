/**
 * Video render building blocks shared by Editor 2.0's export.
 *
 * - getVideoCapabilities: which FFmpeg features this machine has (cached).
 * - RESOLUTIONS: the 16:9 output sizes on offer.
 * - buildImageFilterChunk: the filter_complex sub-graph for one still image —
 *   blurred cover background plus a gently moving foreground.
 */

import { execSync } from 'child_process'

// zoompan truncates its x/y/zoom to integers every frame, so panning/zooming a
// display-sized image steps a whole pixel at a time → visible judder, and zoom-in
// upscales an already-downscaled image → soft. We render the foreground motion at
// SUPERSAMPLE× the display size (high-quality lanczos), then downscale: motion
// becomes sub-pixel-smooth and zoom samples real detail.
// zoompan is the render's bottleneck and its cost climbs steeply with buffer
// size: 2× rendered ~1.75× slower than 1.5×, while 1.5× still steps motion in
// ⅔-pixel increments — smooth enough for the slow drifts used here.
const FG_SUPERSAMPLE = 1.5
const SCALE_FLAGS = 'lanczos'

/** 16:9 output resolutions the editor offers. */
export const RESOLUTIONS: Record<string, { w: number; h: number }> = {
  '1920x1080': { w: 1920, h: 1080 },
  '1280x720': { w: 1280, h: 720 },
  '854x480': { w: 854, h: 480 }
}

const GENTLE_EFFECTS = ['zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'pan-up', 'pan-down'] as const

function getFfmpegPath(): string {
  return process.env.FFMPEG_PATH || 'ffmpeg'
}

// ---------- Capability detection (Part 2e) ----------

export interface VideoCapabilities {
  ffmpegAvailable: boolean
  ffmpegVersion?: string
  hasZoompan: boolean
  blurFilter: 'gblur' | 'boxblur' | null // preferred blur, null if neither
  /** Apple's hardware H.264 encoder — frees the CPU for the filter graph. */
  hasVideoToolbox: boolean
  error?: string
}

let capabilitiesCache: VideoCapabilities | null = null

/**
 * Detect FFmpeg + the filters this engine needs. Cached after first run.
 * Degrades gracefully: gblur → boxblur; missing zoompan disables motion later.
 */
export function getVideoCapabilities(force = false): VideoCapabilities {
  if (capabilitiesCache && !force) return capabilitiesCache

  try {
    const versionOut = execSync(`${getFfmpegPath()} -version`, { encoding: 'utf-8', timeout: 5000 })
    const version = versionOut.match(/ffmpeg version ([^\s]+)/)?.[1]

    const filtersOut = execSync(`${getFfmpegPath()} -hide_banner -filters`, { encoding: 'utf-8', timeout: 5000 })
    const has = (name: string) => new RegExp(`\\s${name}\\s`).test(filtersOut)

    const hasGblur = has('gblur')
    const hasBoxblur = has('boxblur')

    const encodersOut = execSync(`${getFfmpegPath()} -hide_banner -encoders`, { encoding: 'utf-8', timeout: 5000 })

    capabilitiesCache = {
      ffmpegAvailable: true,
      ffmpegVersion: version,
      hasZoompan: has('zoompan'),
      blurFilter: hasGblur ? 'gblur' : hasBoxblur ? 'boxblur' : null,
      hasVideoToolbox: /\sh264_videotoolbox\s/.test(encodersOut)
    }
  } catch (error) {
    capabilitiesCache = {
      ffmpegAvailable: false,
      hasZoompan: false,
      blurFilter: null,
      hasVideoToolbox: false,
      error: error instanceof Error ? error.message : 'FFmpeg not found on PATH'
    }
  }

  return capabilitiesCache
}

// ---------- Small probe + math helpers ----------

/** Even integer ≥ 2 (x264 requires even dimensions). */
function even(n: number): number {
  const r = Math.max(2, Math.round(n))
  return r % 2 === 0 ? r : r + 1
}

// ---------- Per-image filter chunk ----------

export interface ImageRenderSpec {
  inputIndex: number          // ffmpeg input index within the part's render call
  frameW: number
  frameH: number
  fps: number
  durationFrames: number
  isFiller: boolean
  imgW?: number               // source pixel dims (omitted for filler)
  imgH?: number
  motionEffect: string        // one of the gentle drift set
  motionIntensity: number
  blurFilter: 'gblur' | 'boxblur' | null
  hasZoompan: boolean
}

/**
 * Build the filter_complex sub-graph for ONE image, consuming [{idx}:v] and
 * producing a labeled [v{idx}] segment of exactly durationFrames frames:
 *   - background: same image, cover-zoomed, blurred, 20% black overlay, no motion
 *   - foreground: image fit to frame height, centered, gentle drift motion
 * Filler images pass through a black frame.
 *
 * Returns the sub-graph string (each stage ';'-terminated) and the out label.
 */
export function buildImageFilterChunk(spec: ImageRenderSpec): { filter: string; outLabel: string } {
  const { inputIndex: i, frameW: W, frameH: H, fps, durationFrames: frames } = spec
  const outLabel = `[v${i}]`

  // Filler: the lavfi color input is already W×H for the right duration.
  if (spec.isFiller) {
    return { filter: `[${i}:v]setsar=1,fps=${fps}${outLabel};`, outLabel }
  }

  const f1 = Math.max(1, frames - 1) // denominator for linear interpolation
  const blur = spec.blurFilter === 'boxblur' ? 'boxblur=20:1' : spec.blurFilter === 'gblur' ? 'gblur=sigma=20' : null

  // Foreground size: fit frame height (a 4:3 crop → ~75% of a 16:9 frame).
  const imgW = spec.imgW || W
  const imgH = spec.imgH || H
  const fgH = even(H)
  const fgW = even(fgH * (imgW / imgH))

  // --- Background sub-graph (cover 1.15×, blur, darken, hold for `frames`) ---
  const bgScale = `scale=${even(W * 1.15)}:${even(H * 1.15)}:force_original_aspect_ratio=increase:flags=${SCALE_FLAGS},crop=${W}:${H}`
  const bgStages = [bgScale]
  if (blur) bgStages.push(blur)
  bgStages.push(`drawbox=x=0:y=0:w=${W}:h=${H}:color=black@0.2:t=fill`, 'setsar=1')
  // Hold the still for the full duration. zoompan z=1 duplicates frames; without
  // zoompan, loop the single frame instead.
  const bgHold = spec.hasZoompan
    ? `zoompan=z=1:d=${frames}:s=${W}x${H}:fps=${fps}`
    : `loop=loop=${frames - 1}:size=1:start=0,fps=${fps}`
  bgStages.push(bgHold)

  // --- Foreground sub-graph (fit height, gentle drift motion) ---
  // Supersample the motion buffer so zoompan's per-frame integer rounding lands
  // on sub-pixels of the final frame (smooth drift) and zoom-in samples detail.
  const ss = spec.hasZoompan ? FG_SUPERSAMPLE : 1
  const fgWss = even(fgW * ss)
  const fgHss = even(fgH * ss)
  const fgScale = `scale=${fgWss}:${fgHss}:flags=${SCALE_FLAGS}`
  let fgMotion: string
  let fgDownscale = ''
  if (spec.hasZoompan) {
    fgMotion = `zoompan=${motionExpr(spec, f1)}:d=${frames}:s=${fgWss}x${fgHss}:fps=${fps}`
    if (ss > 1) fgDownscale = `,scale=${fgW}:${fgH}:flags=${SCALE_FLAGS}`
  } else {
    // No zoompan available → static hold (graceful degradation).
    fgMotion = `loop=loop=${frames - 1}:size=1:start=0,fps=${fps}`
  }

  // Overlay centered.
  const overlayX = '(W-w)/2'
  const overlayY = '(H-h)/2'

  const filter =
    `[${i}:v]split=2[bs${i}][fs${i}];` +
    `[bs${i}]${bgStages.join(',')}[bg${i}];` +
    `[fs${i}]${fgScale},${fgMotion}${fgDownscale},setsar=1[fg${i}];` +
    `[bg${i}][fg${i}]overlay=x=${overlayX}:y=${overlayY}:eof_action=pass${outLabel};`

  return { filter, outLabel }
}

/** zoompan z/x/y expression for the gentle drift motion of one image. */
function motionExpr(spec: ImageRenderSpec, f1: number): string {
  const k = Math.max(0, spec.motionIntensity)
  const effect = GENTLE_EFFECTS.includes(spec.motionEffect as any) ? spec.motionEffect : 'zoom-in'

  const centerX = `iw/2-(iw/zoom/2)`
  const centerY = `ih/2-(ih/zoom/2)`
  switch (effect) {
    case 'zoom-out':
      return `z='1+${k}*(1-on/${f1})':x='${centerX}':y='${centerY}'`
    case 'pan-left':
      return `z='${1 + k}':x='(iw-iw/zoom)*(1-on/${f1})':y='${centerY}'`
    case 'pan-right':
      return `z='${1 + k}':x='(iw-iw/zoom)*on/${f1}':y='${centerY}'`
    case 'pan-up':
      return `z='${1 + k}':x='${centerX}':y='(ih-ih/zoom)*(1-on/${f1})'`
    case 'pan-down':
      return `z='${1 + k}':x='${centerX}':y='(ih-ih/zoom)*on/${f1}'`
    case 'zoom-in':
    default:
      return `z='1+${k}*on/${f1}':x='${centerX}':y='${centerY}'`
  }
}
