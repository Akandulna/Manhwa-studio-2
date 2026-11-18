import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

let root: string
let previousRoot: string | undefined
let configured = true
let r2Fails = false
let transactionFails = false
let aligning = 0
let chapter: any
let sections: any[]
let audioFiles: any[]
let analyses: any[]
let timelines: any[]
let settings: Map<string, string>
const sent: { name: string; input: any }[] = []
const requestPhoneUpdate = vi.fn(async () => ({}))
const matches = (where: any) => (row: any) => row.chapterId === where.chapterId && row.language === where.language
const table = (rows: () => any[], set: (next: any[]) => void) => ({
  findMany: async ({ where }: any) => rows().filter(matches(where)),
  deleteMany: async ({ where }: any) => { set(rows().filter(row => !matches(where)(row))) }
})
const database: any = {
  chapter: { findUnique: async () => chapter },
  audioSection: table(() => sections, next => { sections = next }),
  audioFile: table(() => audioFiles, next => { audioFiles = next }),
  audioAnalysis: table(() => analyses, next => { analyses = next }),
  editor2Timeline: {
    findUnique: async ({ where }: any) => timelines.find(matches(where.chapterId_language)) ?? null,
    update: async ({ where, data }: any) => Object.assign(timelines.find(matches(where.chapterId_language)), data)
  },
  setting: {
    upsert: async ({ where, update }: any) => { settings.set(where.key, update.value) },
    findMany: async ({ where }: any) => where.key.in.filter((key: string) => settings.has(key)).map((key: string) => ({ key, value: settings.get(key) }))
  },
  $transaction: async (work: (tx: any) => Promise<void>) => {
    const saved = structuredClone({ sections, audioFiles, analyses, timelines, settings })
    try { await work(database); if (transactionFails) throw new Error('Transaction failed') }
    catch (error) { ({ sections, audioFiles, analyses, timelines, settings } = saved); throw error }
  }
}
vi.mock('../../index.js', () => ({ prisma: database }))
vi.mock('../alignment/alignmentService.js', () => ({ pendingAlignments: () => aligning }))
vi.mock('../seriesProcess.js', () => ({ notifySeriesProcessChanged: vi.fn() }))
vi.mock('../seriesRestartGuard.js', () => ({ requireSeriesRestartReady: async () => null }))
vi.mock('../seriesActivity.js', () => ({ withSeriesMutation: (_folder: string, work: () => Promise<unknown>) => work() }))
vi.mock('../phoneVoiceoverImport.js', () => ({ VOICEOVER_FOLDER: 'voiceover/' }))
vi.mock('../r2Service.js', () => ({
  getR2Config: () => configured ? { bucket: 'test', prefix: 'Phone/' } : null,
  requestPhoneUpdate,
  createClient: () => ({ send: async (command: any) => {
    if (r2Fails) throw new Error('Offline')
    sent.push({ name: command.constructor.name, input: command.input })
    return {}
  } })
}))
const { resetChapterVoiceover, voiceoverResetAt, VoiceoverResetError } = await import('../voiceoverReset.js')
const dir = () => path.join(root, 'Hero/Chapter 004')
const write = async (name: string, text: string) => { const file = path.join(dir(), name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text) }
const read = (file: string) => fs.readFile(file, 'utf-8').catch(() => null)

beforeEach(async () => {
  previousRoot = process.env.DOWNLOAD_ROOT
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'voiceover-reset-'))
  process.env.DOWNLOAD_ROOT = root
  configured = true; r2Fails = false; transactionFails = false; aligning = 0; sent.length = 0
  requestPhoneUpdate.mockClear()
  settings = new Map()
  chapter = { id: 'c4', number: 4, completedAt: null, folderPath: 'Hero/Chapter 004', series: { rootFolder: '/lib/Hero' } }
  sections = ['en', 'hi'].map(language => ({ chapterId: 'c4', language, text: 'section' }))
  audioFiles = ['en', 'hi'].map(language => ({ chapterId: 'c4', language, filePath: 'audio' }))
  analyses = ['en', 'hi'].map(language => ({ chapterId: 'c4', language, verdict: 'consistent' }))
  timelines = ['en', 'hi'].map(language => ({ chapterId: 'c4', language, json: '{"old":true}', processedJson: '{"old":true}', updatedAt: new Date(0) }))
  await write('script.hi.md', 'स्क्रिप्ट।\n')
  await write('audio_hi/section_01.wav', 'Hindi audio')
  await write('audio_hi/.r2-voiceover.json', '{"etag":"abc"}')
  await write('script-timeline.hi.md', 'Hindi alignment')
  await write('audio/section_01.wav', 'English audio')
  await write('script-timeline.md', 'English alignment')
})
afterEach(async () => {
  if (previousRoot === undefined) delete process.env.DOWNLOAD_ROOT
  else process.env.DOWNLOAD_ROOT = previousRoot
  await fs.rm(root, { recursive: true, force: true })
})

describe('voiceover reset', () => {
  it('clears R2 first, then only this language here, backing it up and remembering when', async () => {
    const result = await resetChapterVoiceover('c4', 'hi')

    const deletes = sent.filter(c => c.name === 'DeleteObjectsCommand').map(c => c.input.Delete.Objects.map((o: any) => o.Key))
    expect(deletes).toEqual([
      ['Phone/voiceover/Hero/Chapter 004.hi.zip', 'Phone/voiceover/Hero/Chapter 004.hi.zip.status.json'],
      ['voiceover/Hero/Chapter 004.hi.zip', 'voiceover/Hero/Chapter 004.hi.zip.status.json']
    ])
    const markers = sent.filter(c => c.name === 'PutObjectCommand')
    expect(markers.map(c => c.input.Key)).toEqual(['Phone/voiceover/Hero/Chapter 004.hi.zip.reset.json', 'voiceover/Hero/Chapter 004.hi.zip.reset.json'])
    expect(JSON.parse(markers[0].input.Body)).toMatchObject({ schema: 'studio-voiceover-reset/1', series: 'Hero', chapter: 'Chapter 004', language: 'hi', resetAt: result.resetAt })

    expect(sections.map(s => s.language)).toEqual(['en'])
    expect(audioFiles.map(s => s.language)).toEqual(['en'])
    expect(analyses.map(s => s.language)).toEqual(['en'])
    expect(timelines.find(t => t.language === 'hi')).toMatchObject({ json: '', processedJson: null })
    expect(timelines.find(t => t.language === 'en').json).toBe('{"old":true}')

    expect(await read(path.join(dir(), 'audio_hi/section_01.wav'))).toBeNull()
    expect(await read(path.join(dir(), 'script-timeline.hi.md'))).toBeNull()
    expect(await read(path.join(dir(), 'script.hi.md'))).toBe('स्क्रिप्ट।\n')
    expect(await read(path.join(dir(), 'audio/section_01.wav'))).toBe('English audio')
    expect(await read(path.join(dir(), 'script-timeline.md'))).toBe('English alignment')
    expect(await read(path.join(result.backupPath!, 'audio_hi/section_01.wav'))).toBe('Hindi audio')
    expect(await read(path.join(result.backupPath!, 'script-timeline.hi.md'))).toBe('Hindi alignment')
    expect(JSON.parse((await read(path.join(result.backupPath!, 'state.json')))!).sections).toHaveLength(1)

    expect((await voiceoverResetAt(['c4', 'c5'], 'hi')).get('c4')).toBe(Date.parse(result.resetAt))
    expect((await voiceoverResetAt(['c4'], 'en')).size).toBe(0)
    expect(result).toMatchObject({ r2: { folders: ['Phone/voiceover/Hero/', 'voiceover/Hero/'] }, phonesAsked: true })
    expect(requestPhoneUpdate).toHaveBeenCalledWith('sync')
  })

  it('changes nothing here when R2 refuses', async () => {
    r2Fails = true
    await expect(resetChapterVoiceover('c4', 'hi')).rejects.toThrow('Offline')
    expect(sections).toHaveLength(2)
    expect(await read(path.join(dir(), 'audio_hi/section_01.wav'))).toBe('Hindi audio')
    expect(settings.size).toBe(0)
  })

  it('puts the files back when the database step fails', async () => {
    transactionFails = true
    await expect(resetChapterVoiceover('c4', 'hi')).rejects.toThrow('Transaction failed')
    expect(sections).toHaveLength(2)
    expect(await read(path.join(dir(), 'audio_hi/section_01.wav'))).toBe('Hindi audio')
    expect(await read(path.join(dir(), 'script-timeline.hi.md'))).toBe('Hindi alignment')
  })

  it('works locally without R2 and does not ask the phones', async () => {
    configured = false
    const result = await resetChapterVoiceover('c4', 'en')
    expect(result).toMatchObject({ r2: null, phonesAsked: false })
    expect(sent).toEqual([])
    expect(sections.map(s => s.language)).toEqual(['hi'])
    expect(requestPhoneUpdate).not.toHaveBeenCalled()
  })

  it('refuses while the chapter is aligning or completed', async () => {
    aligning = 1
    await expect(resetChapterVoiceover('c4', 'hi')).rejects.toBeInstanceOf(VoiceoverResetError)
    aligning = 0
    chapter.completedAt = new Date()
    await expect(resetChapterVoiceover('c4', 'hi')).rejects.toThrow('completed')
    expect(sent).toEqual([])
  })
})
