import { describe, expect, it } from 'vitest'
import { buildEditorWorkflow } from '../editorWorkflow.js'
import { validateDeliveredWorkflowTimeline as validate } from '../editorTimelineImport.js'

const input = buildEditorWorkflow(
  '## Section 1\n00:00.00 - 00:03.00: "One."\n00:03.00 - 00:06.00: "Two."\n00:06.00 - 00:09.00: "Three."\n## Section 2\n00:00.00 - 00:04.00: "Four."',
  JSON.stringify({ crops: [{ exportedFilename: 'crop.png', description: 'A person.' }] }), ['crop.png'])
const audio = [{ number: 1, durationSec: 9.24 }, { number: 2, durationSec: 4 }]
const document = (ranges = ['00:00.00 - 00:06.00', '00:06.00 - 00:09.24']) => ({
  sections: [ranges, ['00:00.00 - 00:04.00']].map((ranges, index) => ({
    section: `Section ${index + 1}`, timelines: ranges.map(timeline => ({ timeline, selectedImages: ['crop.png'] }))
  }))
})

describe('delivered grouped timeline validation', () => {
  it('preserves grouped beat scenes and the exact short audio tail', () => {
    const value = document(), json = JSON.stringify(value)
    expect(() => validate(input, json, audio)).not.toThrow()
    expect(JSON.stringify(value)).toBe(json)
    expect(() => validate(input, JSON.stringify(document(['00:00.00 - 00:09.00'])))).not.toThrow()
  })
  it('keeps ordinary one-slot-per-beat results valid', () => {
    expect(() => validate(input, JSON.stringify(document(['00:00.00 - 00:03.00', '00:03.00 - 00:06.00', '00:06.00 - 00:09.00'])))).not.toThrow()
  })
  it.each([
    ['00:00.00 - 00:03.00', '00:06.00 - 00:09.24'],
    ['00:00.00 - 00:06.00', '00:03.00 - 00:09.24'],
    ['00:00.00 - 00:05.99', '00:06.00 - 00:09.24'],
    ['00:00.00 - 00:06.00'],
    ['00:00.00 - 00:06.00', '00:06.00 - 00:09.23'],
    ['00:00.00 - 00:06.00', '00:06.00 - 00:09.25'],
    ['00:00.00 - 00:06.00 - 00:09.00'],
    ['00:00.00 - 00:00.00'],
  ])('rejects omitted, overlapping, partial or retimed beats: %j', (...ranges) => {
    expect(() => validate(input, JSON.stringify(document(ranges)), audio)).toThrow()
  })
  it('requires current audio evidence and limits the final tail to half a second', () => {
    expect(() => validate(input, JSON.stringify(document()))).toThrow('timestamp')
    expect(() => validate(input, JSON.stringify(document(['00:00.00 - 00:09.60'])), [{ number: 1, durationSec: 9.6 }])).toThrow('timestamp')
  })
  it('rejects missing, reordered or repeated sections', () => {
    const value = document()
    value.sections.reverse()
    expect(() => validate(input, JSON.stringify(value), audio)).toThrow('every beat')
    value.sections.pop()
    expect(() => validate(input, JSON.stringify(value), audio)).toThrow('exactly')
  })
  it.each([[], ['missing.png'], ['crop.png', 'crop.png'], ['crop.png', 42]])('rejects invalid images: %j', (...names) => {
    const value = document() as any
    value.sections[0].timelines[0].selectedImages = names
    expect(() => validate(input, JSON.stringify(value), audio)).toThrow('crop filenames')
  })
})
