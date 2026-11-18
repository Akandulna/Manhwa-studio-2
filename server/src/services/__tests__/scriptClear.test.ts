import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

let root: string
let previousRoot: string | undefined
let aligning = 0
let transactionFails = false
let chapters: any[]
let rows: Record<'chapterScript' | 'audioSection' | 'audioFile' | 'audioAnalysis' | 'editor2Timeline', any[]>
let settings: Map<string, string>

const forChapter = (where: any) => (row: any) => row.chapterId === where.chapterId
const table = (name: keyof typeof rows) => ({
  findMany: async ({ where }: any) => rows[name].filter(forChapter(where)),
  deleteMany: async ({ where }: any) => { rows[name] = rows[name].filter(row => !forChapter(where)(row)) }
})
const database: any = {
  series: { findUnique: async () => ({ rootFolder: 'Solo Hero' }) },
  chapter: { findMany: async ({ where }: any) => chapters.filter(c => where.id.in.includes(c.id) && c.seriesId === where.seriesId) },
  chapterScript: table('chapterScript'),
  audioSection: table('audioSection'),
  audioFile: table('audioFile'),
  audioAnalysis: table('audioAnalysis'),
  editor2Timeline: {
    ...table('editor2Timeline'),
    update: async ({ where, data }: any) => Object.assign(rows.editor2Timeline.find(t =>
      t.chapterId === where.chapterId_language.chapterId && t.language === where.chapterId_language.language), data)
  },
  setting: {
    findMany: async ({ where }: any) => [...settings].filter(([key]) => where.key.in.includes(key)).map(([key, value]) => ({ key, value })),
    deleteMany: async ({ where }: any) => { for (const key of where.key.in) settings.delete(key) },
    upsert: async ({ where, create }: any) => { settings.set(where.key, create.value) }
  },
  $transaction: async (work: (tx: any) => Promise<void>) => {
    const saved = structuredClone({ rows, settings })
    try { await work(database); if (transactionFails) throw new Error('Transaction failed') }
    catch (error) { ({ rows, settings } = saved); throw error }
  }
}
vi.mock('../../index.js', () => ({ prisma: database }))
vi.mock('../alignment/alignmentService.js', () => ({ pendingAlignments: () => aligning }))
vi.mock('../seriesProcess.js', () => ({ notifySeriesProcessChanged: vi.fn() }))
vi.mock('../seriesRestartGuard.js', () => ({ requireSeriesRestartReady: async () => null }))
vi.mock('../seriesActivity.js', () => ({ withSeriesMutation: (_folder: string, work: () => Promise<unknown>) => work() }))
vi.mock('../r2Service.js', () => ({}))

const { clearChapterScripts, savedBeforeClear, scriptsClearedAt } = await import('../scriptClear.js')
const { scriptReplacementBusy } = await import('../scriptReplacement.js')

const dir = () => path.join(root, 'Solo Hero', 'Chapter 009')
const read = (name: string) => fs.readFile(path.join(dir(), name), 'utf-8').catch(() => null)

beforeEach(async () => {
  previousRoot = process.env.DOWNLOAD_ROOT
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'script-clear-'))
  process.env.DOWNLOAD_ROOT = root
  aligning = 0
  transactionFails = false
  chapters = [
    { id: 'c9', seriesId: 's', number: 9, folderPath: 'Solo Hero/Chapter 009', status: 'done', completedAt: null },
    { id: 'c1', seriesId: 's', number: 1, folderPath: 'Solo Hero/Chapter 001', status: 'done', completedAt: new Date() }
  ]
  rows = {
    chapterScript: [{ chapterId: 'c9', language: 'en', status: 'done' }, { chapterId: 'c9', language: 'hi', status: 'edited' }, { chapterId: 'c10', language: 'en', status: 'done' }],
    audioSection: [{ chapterId: 'c9', language: 'en', index: 0 }],
    audioFile: [{ chapterId: 'c9', language: 'hi', filePath: 'x' }],
    audioAnalysis: [],
    editor2Timeline: [{ chapterId: 'c9', language: 'en', json: '{"a":1}', processedJson: '{}', updatedAt: new Date(Date.now() + 60_000) }]
  }
  settings = new Map([['phoneScriptKeep:c9:hi', 'abc']])
  await fs.mkdir(path.join(dir(), 'audio_hi'), { recursive: true })
  await fs.writeFile(path.join(dir(), 'script.md'), 'English\n')
  await fs.writeFile(path.join(dir(), 'script.hi.md'), 'Hinglish\n')
  await fs.writeFile(path.join(dir(), 'script.review.json'), '{}\n')
  await fs.writeFile(path.join(dir(), '.script-replacement.hi.json'), '{"sha256":"old"}')
  await fs.writeFile(path.join(dir(), 'audio_hi', 'section_01.wav'), 'audio')
  await fs.writeFile(path.join(dir(), 'page_001.jpg'), 'page')
})

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.DOWNLOAD_ROOT
  else process.env.DOWNLOAD_ROOT = previousRoot
  await fs.rm(root, { recursive: true, force: true })
})

describe('savedBeforeClear', () => {
  it('ignores only what a phone saved before the clear (or at an unknown time)', () => {
    const at = Date.parse('2026-11-12T12:00:00Z')
    expect(savedBeforeClear(undefined, '2020-01-01T00:00:00Z')).toBe(false)
    expect(savedBeforeClear(at, '2026-11-12T11:59:59.999999Z')).toBe(true)
    expect(savedBeforeClear(at, '2026-11-12T12:00:00Z')).toBe(true)
    expect(savedBeforeClear(at, '2026-11-12T12:00:01Z')).toBe(false)
    expect(savedBeforeClear(at, null)).toBe(true)
  })
})

describe('clearChapterScripts', () => {
  it('backs up and removes both languages\' scripts and results, keeps pages, and remembers the clear', async () => {
    const before = Date.now()
    const result = await clearChapterScripts('s', ['c9'])

    expect(result.cleared).toEqual([expect.objectContaining({ chapterId: 'c9', number: 9 })])
    for (const name of ['script.md', 'script.hi.md', 'script.review.json', '.script-replacement.hi.json']) expect(await read(name)).toBeNull()
    await expect(fs.stat(path.join(dir(), 'audio_hi'))).rejects.toThrow()
    expect(await read('page_001.jpg')).toBe('page')
    expect(rows.chapterScript).toEqual([{ chapterId: 'c10', language: 'en', status: 'done' }])
    expect(rows.audioSection).toEqual([])
    expect(rows.audioFile).toEqual([])
    expect(rows.editor2Timeline[0]).toMatchObject({ json: '', processedJson: null })
    expect(settings.has('phoneScriptKeep:c9:hi')).toBe(false)
    expect((await scriptsClearedAt(['c9', 'c10'])).get('c9')).toBeGreaterThanOrEqual(before)
    expect((await scriptsClearedAt(['c9', 'c10'])).has('c10')).toBe(false)

    const backup = result.cleared[0].backupPath
    expect(await fs.readFile(path.join(backup, 'script.hi.md'), 'utf-8')).toBe('Hinglish\n')
    expect(await fs.readFile(path.join(backup, 'audio_hi', 'section_01.wav'), 'utf-8')).toBe('audio')
    const state = JSON.parse(await fs.readFile(path.join(backup, 'state.json'), 'utf-8'))
    expect(state.scripts).toHaveLength(2)
    expect(scriptReplacementBusy('c9')).toBe(false)
  })

  it('puts the files and rows back when the database step fails', async () => {
    transactionFails = true
    await expect(clearChapterScripts('s', ['c9'])).rejects.toThrow('Transaction failed')
    expect(await read('script.hi.md')).toBe('Hinglish\n')
    expect(await fs.readFile(path.join(dir(), 'audio_hi', 'section_01.wav'), 'utf-8')).toBe('audio')
    expect(rows.chapterScript).toHaveLength(3)
    expect((await scriptsClearedAt(['c9'])).has('c9')).toBe(false)
    expect(scriptReplacementBusy('c9')).toBe(false)
  })

  it('refuses completed chapters, other series, an empty choice and running alignment without touching anything', async () => {
    await expect(clearChapterScripts('s', ['c1'])).rejects.toThrow('Chapter 1 is not a downloaded, unarchived chapter')
    await expect(clearChapterScripts('s', ['elsewhere'])).rejects.toThrow('not in this series')
    await expect(clearChapterScripts('s', [])).rejects.toThrow('Tick at least one chapter')
    aligning = 1
    await expect(clearChapterScripts('s', ['c9'])).rejects.toThrow('alignment')
    expect(await read('script.md')).toBe('English\n')
    expect(rows.chapterScript).toHaveLength(3)
  })
})
