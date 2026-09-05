/**
 * Video AI Assist — Module 4, Part 6 (zero-shot, no training required).
 *
 * - suggestImagesForPart (6b): given a part's script text + the chapter's crops,
 *   ask the vision model which contiguous run of crops illustrates the part.
 *   Exploits monotonic alignment (manhwa/script/crops all run top-to-bottom in
 *   story order) by asking for a single start/end crop range, optionally
 *   constrained to start after the previous part's range (forward-only).
 * - suggestAnchorForImage (6c): given an image + the part text, ask for the
 *   normalized (x,y) the text is "talking about" to seed focus mode.
 *
 * Self-contained (own Gemini client) so Module 2's scripting path is untouched.
 * Note on 6a: capturing the script→crop mapping at generation time isn't viable
 * here because crops don't exist until Module 3 (after scripting) and the
 * editor's parts are derived from voiceover AudioSections, not script parts —
 * so this zero-shot range alignment is the reliable mechanism and effectively
 * subsumes 6a for this pipeline.
 */

import { GoogleGenAI } from '@google/genai'
import sharp from 'sharp'
import { prisma } from '../index.js'
import { getChapterCrops, type ChapterCrop } from './videoEditorService.js'
import { clampSuggestionRange } from './videoMath.js'

const MAX_CROPS_PER_CALL = 40

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

/** Whether AI assist is usable (Gemini key present). */
export function isAiAssistAvailable(): boolean {
  return !!process.env.GEMINI_API_KEY
}

async function callGemini(parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }>): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured — AI assist is unavailable')
  const client = new GoogleGenAI({ apiKey })
  const model = process.env.AI_MODEL || 'gemini-3.5-flash'
  const result = await client.models.generateContent({
    model,
    contents: [{ role: 'user', parts }],
    config: { maxOutputTokens: 512 }
  })
  return result.text || ''
}

/** Extract the first JSON object from a model response (tolerates code fences). */
function parseJsonObject(text: string): any {
  const fenced = text.replace(/```json|```/g, '')
  const match = fenced.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('AI did not return JSON')
  return JSON.parse(match[0])
}

async function thumb(filePath: string, width: number): Promise<string> {
  const buf = await sharp(filePath).resize({ width, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer()
  return buf.toString('base64')
}

async function getPartScriptText(audioSectionId: string | null): Promise<string> {
  if (!audioSectionId) return ''
  const section = await prisma.audioSection.findUnique({ where: { id: audioSectionId }, select: { text: true } })
  return section?.text ?? ''
}

// ============ 6b: image range suggestion ============

export interface ImageSuggestion {
  suggested: ChapterCrop[]
  range: { start: number; end: number } | null
}

export async function suggestImagesForPart(partId: string, minSequence = 0): Promise<ImageSuggestion> {
  const part = await prisma.videoPartEdit.findUnique({ where: { id: partId } })
  if (!part) throw new Error('Part not found')
  if (part.isOutro) throw new Error('The outro part has no images')

  const scriptText = await getPartScriptText(part.audioSectionId)
  const crops = await getChapterCrops(part.chapterId)
  const cropSeqById = new Map(crops.map(c => [c.id, c.sequence]))

  // All non-outro parts of this chapter, in story order — used to keep
  // suggestions monotonic (forward-only) and to reserve crops for later parts.
  const chapterParts = await prisma.videoPartEdit.findMany({
    where: { chapterId: part.chapterId, isOutro: false },
    select: { id: true, orderIndex: true }
  })
  const earlierPartIds = chapterParts.filter(p => p.orderIndex < part.orderIndex).map(p => p.id)
  const laterPartCount = chapterParts.filter(p => p.orderIndex > part.orderIndex).length

  // Forward-only floor: when the caller doesn't pin one, start just after the
  // highest crop already used by earlier parts so ranges don't overlap or all
  // restart at #1 (which starved later parts down to a single crop).
  if (minSequence <= 0 && earlierPartIds.length > 0) {
    const used = await prisma.videoPartImage.findMany({
      where: { partEditId: { in: earlierPartIds }, cropId: { not: null } },
      select: { cropId: true }
    })
    const usedSeqs = used
      .map(u => cropSeqById.get(u.cropId!))
      .filter((s): s is number => typeof s === 'number')
    if (usedSeqs.length > 0) minSequence = Math.max(...usedSeqs)
  }

  const candidates = crops.filter(c => c.sequence > minSequence)
  if (candidates.length === 0) return { suggested: [], range: null }

  const capped = candidates.slice(0, MAX_CROPS_PER_CALL)
  const first = capped[0].sequence
  const last = capped[capped.length - 1].sequence

  // Reserve at least one crop per later part so this part can't grab the whole
  // remaining pool. The model still chooses a tight range within this window.
  const reserve = Math.min(laterPartCount, capped.length - 1)
  const effectiveLast = capped[capped.length - 1 - reserve].sequence

  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = []
  parts.push({
    text:
      'You align a narration passage to the manga/manhwa panels (crops) it describes. ' +
      'The crops below are in story order (top to bottom). A passage maps to a SINGLE ' +
      'contiguous run of crops. Choose the start and end crop numbers that the passage ' +
      'illustrates. Prefer a tight, accurate range. Respond with ONLY JSON: ' +
      '{"startSeq": <number>, "endSeq": <number>}.'
  })
  for (const c of capped) {
    parts.push({ text: `Crop #${c.sequence}:` })
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: await thumb(c.imagePath, 256) } })
  }
  parts.push({
    text:
      `Narration passage:\n"""${scriptText}"""\n\n` +
      `Choose a contiguous range starting at or after crop #${first}` +
      (effectiveLast < last ? `, ending at or before crop #${effectiveLast} (later crops belong to following passages)` : ` and within #${last}`) +
      '. Keep it tight — only the crops this passage actually describes. JSON only.'
  })

  let range = { start: first, end: first }
  try {
    const json = parseJsonObject(await callGemini(parts))
    range = clampSuggestionRange(json.startSeq, json.endSeq, first, effectiveLast)
  } catch (err) {
    console.error('suggestImagesForPart parse error:', err)
  }

  const suggested = crops.filter(c => c.sequence >= range.start && c.sequence <= range.end)
  return { suggested, range }
}

// ============ 6d: duration auto-fit ============

const MIN_SLOT = 0.3 // seconds — keep in sync with the editor's slot minimum

export interface DurationSuggestion {
  /** Seconds per image in slot order; sums exactly to the part's audioDuration. */
  durations: number[]
}

/**
 * Spread `total` seconds across weighted slots so each slot is ≥ `min` and the
 * sum is exactly `total`. Rounding drift is absorbed into the last slot.
 */
function allocateDurations(weights: number[], total: number, min: number): number[] {
  const n = weights.length
  if (n === 0) return []
  if (min * n >= total) return weights.map(() => total / n)

  let positive = weights.map(w => (Number.isFinite(w) && w > 0 ? w : 0))
  if (!positive.some(w => w > 0)) positive = positive.map(() => 1) // all-zero → equal
  const sum = positive.reduce((a, b) => a + b, 0)
  const extra = total - min * n

  const out = positive.map(w => min + (w / sum) * extra)
  const summedExceptLast = out.slice(0, -1).reduce((a, b) => a + b, 0)
  out[n - 1] = Math.max(min, total - summedExceptLast)
  return out
}

/**
 * Estimate per-image durations for a part by asking the vision model how the
 * narration time should be split across the part's panels (panels that cover
 * more of the passage get more screen time). This is a text/vision-proportional
 * approximation — not a literal audio-waveform alignment, which would require a
 * speech-to-text/forced-alignment step the pipeline doesn't have.
 */
export async function suggestDurationsForPart(partId: string): Promise<DurationSuggestion> {
  const part = await prisma.videoPartEdit.findUnique({
    where: { id: partId },
    include: { images: { orderBy: { slotIndex: 'asc' } } }
  })
  if (!part) throw new Error('Part not found')
  if (part.isOutro) throw new Error('The outro part has no images to time')

  const images = part.images
  if (images.length === 0) throw new Error('This part has no images yet')
  const total = part.audioDuration
  if (images.length === 1) return { durations: [total] }

  const scriptText = await getPartScriptText(part.audioSectionId)
  const crops = await getChapterCrops(part.chapterId)
  const cropById = new Map(crops.map(c => [c.id, c]))
  const cropImages = images.filter(im => !im.isFiller && im.cropId && cropById.has(im.cropId))

  const weightByImage = new Map<string, number>()

  if (scriptText.trim() && cropImages.length >= 1) {
    const capped = cropImages.slice(0, MAX_CROPS_PER_CALL)
    const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = []
    parts.push({
      text:
        'You time a narration passage across the manga/manhwa panels it describes. ' +
        'The panels below are in the order they appear on screen. Estimate how the ' +
        'narration time should be split: give each panel a weight proportional to how ' +
        'much of the passage is spoken while that panel is on screen — panels that ' +
        'illustrate more of the text get larger weights. Respond with ONLY JSON: ' +
        `{"weights": [<numbers>]} with exactly ${capped.length} positive numbers in panel order.`
    })
    for (let i = 0; i < capped.length; i++) {
      const c = cropById.get(capped[i].cropId!)!
      parts.push({ text: `Panel ${i + 1} (crop #${c.sequence}):` })
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: await thumb(c.imagePath, 256) } })
    }
    parts.push({
      text: `Narration passage:\n"""${scriptText}"""\n\nReturn exactly ${capped.length} weights. JSON only.`
    })

    try {
      const json = parseJsonObject(await callGemini(parts))
      const w: unknown[] = Array.isArray(json.weights) ? json.weights : []
      capped.forEach((im, idx) => {
        const val = Number(w[idx])
        weightByImage.set(im.id, Number.isFinite(val) && val > 0 ? val : 1)
      })
    } catch (err) {
      console.error('suggestDurationsForPart parse error:', err)
    }
  }

  // Fillers / un-weighted images take the average weight so they get a fair slice.
  const known = [...weightByImage.values()]
  const avg = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1
  const weights = images.map(im => weightByImage.get(im.id) ?? avg)

  return { durations: allocateDurations(weights, total, MIN_SLOT) }
}

// ============ 6c: anchor suggestion ============

export interface AnchorSuggestion {
  anchorX: number
  anchorY: number
}

export async function suggestAnchorForImage(imageId: string): Promise<AnchorSuggestion> {
  const image = await prisma.videoPartImage.findUnique({ where: { id: imageId } })
  if (!image?.cropId) throw new Error('This image has no crop to analyze')
  const crop = await prisma.crop.findUnique({ where: { id: image.cropId } })
  if (!crop?.exportPath) throw new Error('Crop image not found')

  const part = await prisma.videoPartEdit.findUnique({ where: { id: image.partEditId } })
  const scriptText = await getPartScriptText(part?.audioSectionId ?? null)

  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    {
      text:
        'Identify the single most important focal point in this image for the narration ' +
        'passage below — what the viewer should look at. Respond with ONLY JSON giving ' +
        'normalized coordinates (0–1, origin top-left): {"x": <0-1>, "y": <0-1>}.'
    },
    { inlineData: { mimeType: 'image/jpeg', data: await thumb(crop.exportPath, 384) } },
    { text: `Narration passage:\n"""${scriptText}"""\n\nJSON only.` }
  ]

  const json = parseJsonObject(await callGemini(parts))
  return { anchorX: clamp01(Number(json.x)), anchorY: clamp01(Number(json.y)) }
}
