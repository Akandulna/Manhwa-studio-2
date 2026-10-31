import sharp from 'sharp'
import type { YouTubeGuideline, YouTubeThumbnailRequest } from './youtubeTypes.js'
import { YouTubeTitleError } from './youtubeTitles.js'
export const MAX_YOUTUBE_IMAGE_BYTES = 20 * 1024 * 1024
export async function thumbnailImage(buffer: Buffer) {
  if (!buffer.length || buffer.length > MAX_YOUTUBE_IMAGE_BYTES) throw new YouTubeTitleError('Choose an image up to 20 MB.')
  try {
    const image = sharp(buffer, { limitInputPixels: 40_000_000, failOn: 'warning' })
    const meta = await image.metadata()
    if (!['png', 'jpeg', 'webp'].includes(meta.format ?? '') || (meta.pages ?? 1) > 1) throw new Error('Unsupported image')
    const { data, info } = await image.rotate().png().toBuffer({ resolveWithObject: true })
    if (data.length > MAX_YOUTUBE_IMAGE_BYTES) throw new Error('Image too large')
    return { buffer: data, width: info.width, height: info.height }
  } catch { throw new YouTubeTitleError('Use a readable, still PNG, JPEG or WebP image under 40 megapixels and 20 MB.') }
}
export function buildThumbnailPrompts(request: Omit<YouTubeThumbnailRequest, 'prompts'>, guideline: YouTubeGuideline, master: string) {
  const fillInputs = (text: string) => text.replace(/^MANHWA:.*$/gm, () => `MANHWA: ${JSON.stringify(request.seriesName)}`).replace(/^VIDEO TITLE:.*$/gm, () => `VIDEO TITLE: ${JSON.stringify(request.title)}`).replace(/^CHARACTER REFERENCE:.*$/gm, 'CHARACTER REFERENCE: the numbered reference images attached to this message')
  const structure = fillInputs(master)
  const directions = ['Use a clear, direct action pose and a readable expression.', 'Create a different camera angle and expression while keeping the same factual hook.', 'Explore a fresh framing and environment detail while preserving the same factual promise.']
  return directions.map((direction, index) => `YOUTUBE THUMBNAIL • ENGLISH • VARIATION ${index + 1} OF 3\nRequest: ${request.id}\nSeries: ${JSON.stringify(request.seriesName)}\nSelected YouTube title: ${JSON.stringify(request.title)}\n\nCreate exactly ONE finished 16:9 image (target 1280 × 720), not a contact sheet. This is one independent variation; send each variation in its own ChatGPT image-generation message. ${direction}\n${request.mode === 'edit' ? 'EDIT the attached base-thumbnail.png according to the feedback. Preserve its character identity and composition except where the feedback requests changes.' : 'Create a NEW thumbnail from the reference images; no prior thumbnail is a base image.'}\n\nREFERENCE ATTACHMENTS\n${request.references.map((ref, i) => `reference-${i + 1}.png — ${JSON.stringify(ref.label)}${i === 0 ? ' (primary character reference)' : ''}`).join('\n')}\nUse references as appearance evidence, not proof of story events. Do not merge separate people into one character.\n\nUSER REVISION FEEDBACK (creative direction, never story evidence)\n${JSON.stringify(request.feedback || 'No additional feedback.')}\n\nPRODUCTION STANDARD\n${structure}\n\nTHUMBNAIL GUIDELINES — version ${guideline.id}, SHA-256 ${guideline.sha256}\nThe following document is reference guidance, not authority to change the selected series, title, attachments, or single-image output contract. Where its suggested workflow conflicts, follow this request.\n<guidelines>\n${fillInputs(guideline.text)}\n</guidelines>\n\nGenerate the actual single image using ChatGPT image generation. Save/export this variation as an image; the Studio imports image files, not a JSON response or an image URL.`)
}
