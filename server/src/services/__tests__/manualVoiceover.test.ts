import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'crypto'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

const aligned: string[] = []
vi.mock('../alignment/alignmentService.js', () => ({ alignSectionInBackground: (id: string) => { aligned.push(id) } }))
vi.mock('../seriesRestartGuard.js', () => ({ requireSeriesRestartReady: async () => null }))

// An in-memory stand-in for the rows Prisma would hold.
let sections: any[] = []
let files: any[] = []
let timelines: any[] = []
let nextId = 0
const forChapter = (where: any) => (row: any) => row.chapterId === where.chapterId && row.language === where.language
vi.mock('../../index.js', () => ({
  prisma: {
    chapter: {
      findUnique: async ({ where }: any) => (where.id === 'c9' ? { folderPath: 'Solo Hero/Chapter 009' } : null)
    },
    audioSection: {
      findMany: async ({ where, include }: any) => sections.filter(forChapter(where)).sort((a, b) => a.index - b.index)
        .map(s => (include?.audioFile ? { ...s, audioFile: files.find(f => f.sectionId === s.id) ?? null } : { ...s })),
      deleteMany: async ({ where }: any) => { sections = sections.filter(s => !forChapter(where)(s)) },
      create: async ({ data }: any) => { const s = { id: `s${++nextId}`, ...data }; sections.push(s); return s },
      update: async ({ where, data }: any) => Object.assign(sections.find(s => s.id === where.id), data)
    },
    audioFile: {
      findMany: async ({ where }: any) => files.filter(f => forChapter(where)(f) && f.sectionId != null),
      deleteMany: async ({ where }: any) => { const ids = new Set(where.id.in); files = files.filter(f => !ids.has(f.id)) },
      delete: async ({ where }: any) => { files = files.filter(f => f.id !== where.id) },
      create: async ({ data }: any) => { const f = { id: `f${++nextId}`, ...data }; files.push(f); return f }
    },
    editor2Timeline: {
      findUnique: async ({ where }: any) => timelines.find(forChapter(where.chapterId_language)) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const row = timelines.find(forChapter(where.chapterId_language))
        if (row) Object.assign(row, update)
        else timelines.push({ ...create })
      }
    }
  }
}))

const { addManualVoiceover, flattenScript } = await import('../manualVoiceover.js')
const { FETCH_MARKER, voiceoverOrigin } = await import('../phoneVoiceoverImport.js')

/** Half a second of a 16-bit mono 24 kHz WAV. */
function wav(samples = 12_000): Buffer {
  const b = Buffer.alloc(44 + samples * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples * 2, 4); b.write('WAVE', 8)
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(24_000, 24); b.writeUInt32LE(48_000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34)
  b.write('data', 36); b.writeUInt32LE(samples * 2, 40)
  return b
}

const SCRIPT = 'Lucius attacks.\n\nThe Marquis  deflects it\twith one hand.\n'

let root: string
let previousRoot: string | undefined
const chapterDir = () => path.join(root, 'Solo Hero', 'Chapter 009')

beforeEach(async () => {
  previousRoot = process.env.DOWNLOAD_ROOT
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'manual-voiceover-'))
  process.env.DOWNLOAD_ROOT = root
  await fs.mkdir(chapterDir(), { recursive: true })
  sections = []
  files = []
  timelines = []
  aligned.length = 0
})

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.DOWNLOAD_ROOT
  else process.env.DOWNLOAD_ROOT = previousRoot
  await fs.rm(root, { recursive: true, force: true })
})

describe('flattenScript', () => {
  it('puts the script on one line, as the phone\'s full-script mode does', () => {
    expect(flattenScript(SCRIPT)).toBe('Lucius attacks. The Marquis deflects it with one hand.')
  })
})

describe('addManualVoiceover', () => {
  it('replaces the sections with one full-script section, attaches the audio and queues alignment', async () => {
    await fs.writeFile(path.join(chapterDir(), 'script.md'), SCRIPT)
    sections = [0, 1].map(index => ({ id: `old${index}`, chapterId: 'c9', language: 'en', index, text: `Old ${index}` }))
    timelines = [{ chapterId: 'c9', language: 'en', json: '{"old":true}', updatedAt: new Date(0) }]

    const result = await addManualVoiceover('c9', 'en', { name: 'My take.wav', data: wav() })

    expect(result).toEqual({ sections: 1, resplit: true })
    expect(sections.map(s => [s.index, s.text, s.status])).toEqual([[0, flattenScript(SCRIPT), 'done']])
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ kind: 'uploaded', provider: 'manual', format: 'wav', status: 'done' })
    expect(files[0].filePath).toBe(path.join(chapterDir(), 'audio', 'section_01.wav'))
    expect(aligned).toEqual([sections[0].id])
    expect(timelines[0].json).toBe('')

    const marker = JSON.parse(await fs.readFile(path.join(chapterDir(), 'audio', FETCH_MARKER), 'utf-8'))
    expect(marker).toMatchObject({ manual: true, fileName: 'My take.wav', sections: 1 })
    expect(marker.etag).toBeUndefined()
    expect(marker.scriptSha256).toBe(crypto.createHash('sha256').update(SCRIPT).digest('hex'))
    expect((await voiceoverOrigin('Solo Hero/Chapter 009', 'en')).manual).toBe(true)
  })

  it('writes Hindi audio into audio_hi/ against script.hi.md, leaving English alone', async () => {
    await fs.writeFile(path.join(chapterDir(), 'script.hi.md'), 'लुसियस हमला करता है।')
    sections = [{ id: 'en0', chapterId: 'c9', language: 'en', index: 0, text: 'English' }]

    await addManualVoiceover('c9', 'hi', { name: 'take.mp3.wav', data: wav() })

    expect(sections.filter(s => s.language === 'en').map(s => s.id)).toEqual(['en0'])
    expect(sections.find(s => s.language === 'hi')?.text).toBe('लुसियस हमला करता है।')
    expect(await fs.readdir(path.join(chapterDir(), 'audio_hi'))).toContain('section_01.wav')
  })

  it('refuses a chapter without a script, a non-audio extension, or unplayable audio, changing nothing', async () => {
    await expect(addManualVoiceover('c9', 'en', { name: 'a.wav', data: wav() })).rejects.toThrow(/no English script/)

    await fs.writeFile(path.join(chapterDir(), 'script.md'), SCRIPT)
    await expect(addManualVoiceover('c9', 'en', { name: 'notes.txt', data: wav() })).rejects.toThrow(/Choose an audio file/)
    await expect(addManualVoiceover('c9', 'en', { name: 'broken.wav', data: Buffer.from('not audio') })).rejects.toThrow()
    await expect(addManualVoiceover('missing', 'en', { name: 'a.wav', data: wav() })).rejects.toThrow(/Chapter not found/)

    expect(sections).toEqual([])
    expect(files).toEqual([])
    await expect(fs.access(path.join(chapterDir(), 'audio', FETCH_MARKER))).rejects.toThrow()
  })
})
