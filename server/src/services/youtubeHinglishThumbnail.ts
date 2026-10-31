import sharp from 'sharp'
import { YouTubeTitleError } from './youtubeTitles.js'
import type { YouTubeHindiOverlay } from './youtubeTypes.js'
export const DEFAULT_HINDI_OVERLAY: YouTubeHindiOverlay = { template: 'outline', color: '#FFE44D', size: 34, x: 96, y: 96 }
export const HINDI_STAMP_WIDTH = 432
export const HINDI_STAMP_HEIGHT = 148
const templates = ['outline', 'shadow', 'italic', 'badge'] as const
export function parseHindiOverlay(input: unknown): YouTubeHindiOverlay {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new YouTubeTitleError('Choose a Hindi overlay style.')
  const value = input as Record<string, unknown>
  if (!templates.includes(value.template as typeof templates[number])) throw new YouTubeTitleError('Choose one of the four Hindi text templates.')
  if (typeof value.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(value.color)) throw new YouTubeTitleError('Choose a valid text color.')
  const number = (key: string, minimum: number, maximum: number) => {
    const raw = value[key]
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < minimum || raw > maximum) throw new YouTubeTitleError(`Overlay ${key} must be between ${minimum} and ${maximum}.`)
    return Math.round(raw * 100) / 100
  }
  return { template: value.template as YouTubeHindiOverlay['template'], color: value.color.toUpperCase(), size: number('size', 10, 60), x: number('x', 0, 100), y: number('y', 0, 100) }
}
export const hindiOverlayKey = (s: YouTubeHindiOverlay) => `${s.template}|${s.color}|${s.size}|${s.x}|${s.y}`

// Original extra-bold Latin lettering: H I N D I. Outlined glyphs make the
// preview and exported PNG identical without relying on an installed font.
const WORD = 'M0 0H24V37H64V0H88V100H64V62H24V100H0Z M106 0H134V100H106Z M152 100V0H176L214 56V0H238V100H214L176 44V100Z M256 0H295C328 0 346 19 346 50C346 81 328 100 295 100H256Z M281 24V76H294C310 76 321 67 321 50C321 33 310 24 294 24Z M364 0H392V100H364Z'
export function hindiStampSvg(input: unknown): string {
  const s = parseHindiOverlay(input)
  const rgb = [1, 3, 5].map(start => Number.parseInt(s.color.slice(start, start + 2), 16))
  const stroke = (rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114) < 80 ? '#FFFFFF' : '#08080A'
  const transform = s.template === 'italic' ? 'translate(28 16) skewX(-10)' : 'translate(20 16)'
  const shadow = s.template === 'shadow' || s.template === 'italic' ? `<path d="${WORD}" fill="#000000" stroke="#000000" stroke-width="10" stroke-linejoin="round" fill-rule="evenodd" transform="translate(9 10)"/>` : ''
  const badge = s.template === 'badge' ? '<rect x="3" y="3" width="426" height="138" rx="18" fill="#101014" fill-opacity="0.94" stroke="#FFFFFF" stroke-opacity="0.85" stroke-width="3"/>' : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="432" height="148" viewBox="0 0 432 148"><title>HINDI — Extra Bold</title>${badge}<g transform="${transform}">${shadow}<path d="${WORD}" fill="${s.color}" stroke="${stroke}" stroke-width="${s.template === 'badge' ? 3 : 10}" stroke-linejoin="round" paint-order="stroke fill" fill-rule="evenodd"/></g></svg>`
}
export function hindiOverlayGeometry(width: number, height: number, input: unknown) {
  const s = parseHindiOverlay(input)
  const w = Math.max(1, Math.min(width, Math.round(width * s.size / 100), Math.floor(height * HINDI_STAMP_WIDTH / HINDI_STAMP_HEIGHT)))
  const h = Math.max(1, Math.min(height, Math.round(w * HINDI_STAMP_HEIGHT / HINDI_STAMP_WIDTH)))
  return { width: w, height: h, left: Math.round((width - w) * s.x / 100), top: Math.round((height - h) * s.y / 100) }
}
export async function renderHinglishThumbnail(source: Buffer, input: unknown): Promise<Buffer> {
  const settings = parseHindiOverlay(input)
  const metadata = await sharp(source, { limitInputPixels: 40_000_000 }).metadata()
  if (!metadata.width || !metadata.height) throw new YouTubeTitleError('Could not read the selected thumbnail.')
  const box = hindiOverlayGeometry(metadata.width, metadata.height, settings)
  const stamp = await sharp(Buffer.from(hindiStampSvg(settings))).resize(box.width, box.height).png().toBuffer()
  return sharp(source, { limitInputPixels: 40_000_000 }).composite([{ input: stamp, left: box.left, top: box.top }]).png().toBuffer()
}
