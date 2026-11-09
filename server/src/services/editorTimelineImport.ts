import type { EditorWorkflow } from './editorWorkflow.js'

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const timestamp = (value: string): number => {
  if (!/^\d{1,3}:\d{2}(?:\.\d+)?$/.test(value)) return NaN
  const [minutes, seconds] = value.split(':').map(Number)
  return seconds < 60 ? minutes * 60 + seconds : NaN
}
const range = (value: unknown): number[] => typeof value === 'string'
  ? value.split(' - ').map(timestamp) : []
const same = (a: number, b: number) => Math.abs(a - b) < 0.000001

/** Phone scenes may span consecutive aligned beats. Preserve their image timing,
 * while requiring each beat exactly once and keeping current crop/input guards. */
export function validateDeliveredWorkflowTimeline(input: EditorWorkflow, json: string,
  audio: { number: number; durationSec: number | null }[] = []): void {
  const value: unknown = JSON.parse(json)
  const numbers = [...new Set(input.beats.map(beat => beat.section))]
  const images = new Set(input.crops.map(crop => crop.filename))
  if (!record(value) || !Array.isArray(value.sections) || value.sections.length !== numbers.length) {
    throw new Error('Staged timeline must cover exactly the aligned sections')
  }
  for (const [index, number] of numbers.entries()) {
    const section: unknown = value.sections[index]
    const beats = input.beats.filter(beat => beat.section === number)
    if (!record(section) || section.section !== `Section ${number}` ||
      !Array.isArray(section.timelines) || !section.timelines.length) {
      throw new Error(`Staged timeline must cover every beat of Section ${number}`)
    }
    // Report stale crop inventories before their secondary timing differences.
    for (const slot of section.timelines) {
      if (!record(slot) || !Array.isArray(slot.selectedImages) ||
        slot.selectedImages.length < 1 || slot.selectedImages.length > 3 ||
        new Set(slot.selectedImages).size !== slot.selectedImages.length ||
        slot.selectedImages.some(name => typeof name !== 'string' || !images.has(name))) {
        throw new Error(`Staged timeline has invalid crop filenames in Section ${number}; refresh or remake it from the current Editor package`)
      }
    }
    let next = 0
    for (const slot of section.timelines) {
      const [start, end, extra] = range(slot.timeline)
      const expected = beats[next]
      if (!expected || extra !== undefined || !Number.isFinite(start) || !Number.isFinite(end) ||
        end <= start || !same(start, range(expected.range)[0])) {
        throw new Error(`Staged timeline changed a timestamp or repeated a beat in Section ${number}`)
      }
      const lastEnd = range(beats[beats.length - 1].range)[1]
      const duration = audio.find(section => section.number === number)?.durationSec
      // A final hold may cover the exact, short unvoiced audio tail. Do not
      // permit arbitrary end changes or extend beyond the current audio file.
      const audioTail = duration != null && duration >= lastEnd && duration - lastEnd <= 0.5 && same(end, duration)
      const last = audioTail ? beats.length - 1
        : beats.findIndex((beat, i) => i >= next && same(range(beat.range)[1], end))
      if (last < next) throw new Error(`Staged timeline changed a timestamp in Section ${number}`)
      next = last + 1
    }
    if (next !== beats.length) throw new Error(`Staged timeline must cover every beat of Section ${number}`)
  }
}
