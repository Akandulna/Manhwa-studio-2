import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// A throwaway library: audio files and alignment documents are real files, so
// the checklist's on-disk checks run for real.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'editor2-checklist-'))
process.env.DOWNLOAD_ROOT = root

interface Section { timelineScript: string | null; audioFile: { status: string; filePath: string } | null }
let sections: Section[] = []
let storedJson: string | null = null
// What Clipper 3.0 reports for the chapter's crops3/.
let emptyPage = false
let crops = { complete: true, metadataStems: ['page_001'] }

vi.mock('../../index.js', () => ({
  prisma: {
    series: { findUnique: async () => ({ title: 'Demo' }) },
    chapter: {
      findMany: async () => [
        { id: 'c1', number: 1, title: null, folderPath: 'Demo/Chapter 001', audioSections: sections, scripts: [] }
      ]
    },
    editor2Timeline: {
      findMany: async () => (storedJson === null ? [] : [{ chapterId: 'c1', json: storedJson }])
    }
  }
}))

vi.mock('../chapterManifest.js', () => ({
  getChapterManifest: async () => ({ images: [{ filename: 'page_001.webp' }] })
}))

vi.mock('../clipper3/perImageStore.js', () => ({
  listPointedImageStems: async () => new Set(['page_001']),
  listMetadataImageStems: async () => new Set(crops.metadataStems),
  readImagePoints: async () => ({ file: {} }),
  extractCrops: () => emptyPage ? [] : [{ id: 'a', reason: null }],
  hasNoCrops: () => emptyPage,
  readImageMetadata: async () => '{}',
  expectedExportedFilenames: () => ['demo_page_001_01.png'],
  validateMetadata: () => ({ isValid: true, errors: [] }),
  stemOf: (name: string) => name.replace(/\.[^.]+$/, ''),
  chapterCropOutputs: async () => ({ complete: crops.complete, files: 1, missing: crops.complete ? 0 : 1, extra: 0, changed: 0 })
}))

const { getEditableChapters2 } = await import('../videoEditor2Service.js')

const chapterDir = path.join(root, 'Demo/Chapter 001')

function audioFile(name: string, body = 'RIFF'): { status: string; filePath: string } {
  const file = path.join(chapterDir, 'audio', name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
  return { status: 'done', filePath: file }
}

async function chapter() {
  return (await getEditableChapters2('s1', 'en'))[0]
}

beforeEach(() => {
  fs.rmSync(chapterDir, { recursive: true, force: true })
  fs.mkdirSync(chapterDir, { recursive: true })
  sections = []
  emptyPage = false
  storedJson = null
  crops = { complete: true, metadataStems: ['page_001'] }
})

afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

describe('Editor 2.0 checklist', () => {
  it('is ready when audio, alignment file, timeline JSON and crops are all there', async () => {
    sections = [{ timelineScript: null, audioFile: audioFile('s1.wav') }]
    fs.writeFileSync(path.join(chapterDir, 'script-timeline.md'), '## Section 1\n\n00:00.00 - 00:02.00: "Hi."')
    storedJson = '{"sections":[]}'
    const ch = await chapter()
    expect(ch.ready).toBe(true)
    expect(ch.missing).toEqual([])
    expect(ch.checklist.alignment.detail).toMatch(/script-timeline\.md is on disk/)
  })

  it('accepts pages with an explicitly empty crop list', async () => {
    emptyPage = true
    sections = [{ timelineScript: 'aligned', audioFile: audioFile('s1.wav') }]
    storedJson = '{}'
    expect((await chapter()).ready).toBe(true)
  })

  it('needs every section audio file on disk, not just a done row', async () => {
    sections = [
      { timelineScript: 'x', audioFile: audioFile('s1.wav') },
      { timelineScript: 'y', audioFile: { status: 'done', filePath: path.join(chapterDir, 'audio', 'gone.wav') } }
    ]
    storedJson = '{}'
    const ch = await chapter()
    expect(ch.checklist.audio).toEqual({ ok: false, detail: '1/2 sections have audio on disk' })
    expect(ch.missing).toEqual(['Voiceover audio'])
    expect(ch.ready).toBe(false)
  })

  it('accepts a full set of database scripts with timeline when the alignment file is missing', async () => {
    sections = [{ timelineScript: '00:00.00 - 00:02.00: "Hi."', audioFile: audioFile('s1.wav') }]
    const ch = await chapter()
    expect(ch.checklist.alignment.ok).toBe(true)
    expect(ch.checklist.alignment.detail).toMatch(/not on disk.*database/)
  })

  it('fails alignment when sections are only partly aligned and there is no file', async () => {
    sections = [
      { timelineScript: 'x', audioFile: audioFile('s1.wav') },
      { timelineScript: '  ', audioFile: audioFile('s2.wav') }
    ]
    const ch = await chapter()
    expect(ch.checklist.alignment.ok).toBe(false)
    expect(ch.checklist.alignment.detail).toMatch(/1\/2 sections aligned/)
    // Some alignment text and crop metadata exist, so Copy All still works.
    expect(ch.canCopy).toBe(true)
  })

  it('lets Copy All through without a timeline JSON, but not Preview', async () => {
    sections = [{ timelineScript: 'x', audioFile: audioFile('s1.wav') }]
    const ch = await chapter()
    expect(ch.inputsReady).toBe(true)
    expect(ch.canCopy).toBe(true)
    expect(ch.ready).toBe(false)
    expect(ch.missing).toEqual(['Timeline JSON'])
  })

  it('blocks Copy All with a reason when there is no alignment text or crop metadata', async () => {
    crops = { complete: false, metadataStems: [] }
    const ch = await chapter()
    expect(ch.canCopy).toBe(false)
    expect(ch.copyBlockedReason).toMatch(/alignment.*crop metadata/)
    expect(ch.missing).toEqual(['Voiceover audio', 'Alignment', 'Timeline JSON', 'Cropped images'])
  })

  it('fails cropped images when crops3 does not match the done pages', async () => {
    sections = [{ timelineScript: 'x', audioFile: audioFile('s1.wav') }]
    storedJson = '{}'
    crops = { complete: false, metadataStems: ['page_001'] }
    const ch = await chapter()
    expect(ch.checklist.crops.ok).toBe(false)
    expect(ch.checklist.crops.detail).toMatch(/1 missing/)
    expect(ch.inputsReady).toBe(false)
  })
})
