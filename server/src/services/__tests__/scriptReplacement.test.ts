import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'

let root: string
let previousRoot: string | undefined
let configured = true
let uploadFails = false
let transactionFails = false
let aligning = 0
let chapter: any
let sections: any[]
let audioFiles: any[]
let timelines: any[]
const sent: any[] = []
const matches = (where: any) => (row: any) => row.chapterId === where.chapterId && row.language === where.language
const database: any = {
  chapter: { findUnique: async () => chapter },
  audioSection: {
    findMany: async ({ where }: any) => sections.filter(matches(where)),
    deleteMany: async ({ where }: any) => { sections = sections.filter(row => !matches(where)(row)) }
  },
  audioFile: {
    findMany: async ({ where }: any) => audioFiles.filter(matches(where)),
    deleteMany: async ({ where }: any) => { audioFiles = audioFiles.filter(row => !matches(where)(row)) }
  },
  chapterScript: { upsert: async ({ where, create, update }: any) => {
    const row = chapter.scripts.find((s: any) => s.language === where.chapterId_language.language)
    if (row) Object.assign(row, update)
    else chapter.scripts.push(create)
  } },
  editor2Timeline: {
    findUnique: async ({ where }: any) => timelines.find(matches(where.chapterId_language)) ?? null,
    upsert: async ({ where, create, update }: any) => {
      const row = timelines.find(matches(where.chapterId_language))
      if (row) Object.assign(row, update)
      else timelines.push(create)
    }
  },
  $transaction: async (work: (tx: any) => Promise<void>) => {
    const saved = structuredClone({ chapter, sections, audioFiles, timelines })
    try { await work(database); if (transactionFails) throw new Error('Transaction failed') }
    catch (error) { ({ chapter, sections, audioFiles, timelines } = saved); throw error }
  }
}
vi.mock('../../index.js', () => ({ prisma: database }))
vi.mock('../alignment/alignmentService.js', () => ({ pendingAlignments: () => aligning }))
vi.mock('../seriesProcess.js', () => ({ notifySeriesProcessChanged: vi.fn() }))
vi.mock('../r2Service.js', () => ({
  getR2Config: () => configured ? { bucket: 'test', prefix: 'Phone/' } : null,
  phoneFolders: async () => ['Phone/'],
  requestPhoneUpdate: vi.fn(async () => ({})),
  isNotFound: (error: any) => error.name === 'NoSuchKey',
  createClient: () => ({ send: async (command: any) => {
    if (uploadFails) throw new Error('Offline')
    if (command.constructor.name === 'GetObjectCommand') return { ETag: 'original', Body: { transformToString: async () => JSON.stringify({
      schema: 'sleeper-cell-shared-script/1', series: 'Hero', chapter: 'Chapter 004',
      files: { 'script.md': 'English source.\n', 'continuity.json': '{"summary":"keep original English metadata"}' }
    }) } }
    sent.push(command.input)
  } })
}))
const { getReplacementScript, replaceChapterScript } = await import('../scriptReplacement.js')
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const dir = () => path.join(root, 'Hero/Chapter 004')
const write = async (name: string, text: string) => { const file = path.join(dir(), name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text) }

beforeEach(async () => {
  previousRoot = process.env.DOWNLOAD_ROOT
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'script-replacement-'))
  process.env.DOWNLOAD_ROOT = root
  configured = true; uploadFails = false; transactionFails = false; aligning = 0; sent.length = 0
  chapter = { id: 'c4', number: 4, status: 'done', completedAt: null, folderPath: 'Hero/Chapter 004', series: { rootFolder: 'Hero' },
    scripts: [{ language: 'hi', rollingSummary: 'Story so far.', status: 'done' }, { language: 'en', rollingSummary: 'English summary.', status: 'done' }] }
  sections = ['en', 'hi'].map(language => ({ chapterId: 'c4', language, text: 'old section' }))
  audioFiles = ['en', 'hi'].map(language => ({ chapterId: 'c4', language, filePath: 'old audio' }))
  timelines = ['en', 'hi'].map(language => ({ chapterId: 'c4', language, json: '{"old":true}', processedJson: '{"old":true}', updatedAt: new Date(0) }))
  await write('script.md', 'English source.\n')
  await write('script.hi.md', 'पुराना।\n')
  await write('audio_hi/section_01.wav', 'old Hindi audio')
  await write('audio/section_01.wav', 'English audio')
  await write('script-timeline.hi.md', 'old alignment')
})
afterEach(async () => {
  if (previousRoot === undefined) delete process.env.DOWNLOAD_ROOT
  else process.env.DOWNLOAD_ROOT = previousRoot
  await fs.rm(root, { recursive: true, force: true })
})

describe('chapter script replacement', () => {
  it('backs up the old results, resets only Hinglish, and sends a replacement that the phone can apply', async () => {
    const text = 'नया टेक्स्ट।\n\nनया अंत।\n'
    const result = await replaceChapterScript('c4', 'hi', { text, expectedSha256: hash('पुराना।\n') })
    expect(result).toMatchObject({ phoneSent: true, unchanged: false, sha256: hash(text) })
    expect(await fs.readFile(path.join(dir(), 'script.hi.md'), 'utf-8')).toBe(text)
    expect(await fs.readFile(path.join(result.backupPath, 'script.hi.md'), 'utf-8')).toBe('पुराना।\n')
    expect(await fs.readFile(path.join(result.backupPath, 'audio_hi/section_01.wav'), 'utf-8')).toBe('old Hindi audio')
    expect(await fs.readFile(path.join(result.backupPath, 'script-timeline.hi.md'), 'utf-8')).toBe('old alignment')
    expect(await fs.stat(path.join(dir(), 'audio_hi')).catch(() => null)).toBeNull()
    expect(await fs.stat(path.join(dir(), 'script-timeline.hi.md')).catch(() => null)).toBeNull()
    expect(await fs.readFile(path.join(dir(), 'audio/section_01.wav'), 'utf-8')).toBe('English audio')
    expect(sections.map(s => s.language)).toEqual(['en'])
    expect(audioFiles.map(s => s.language)).toEqual(['en'])
    expect(timelines.find(t => t.language === 'hi')).toMatchObject({ json: '', processedJson: null })
    expect(timelines.find(t => t.language === 'en').json).toBe('{"old":true}')
    const payload = JSON.parse(sent[0].Body)
    expect(sent[0].Key).toBe('Phone/shared/scripts/Hero/Chapter 004.script.json')
    expect(payload.files['script.hi.md']).toBe(text)
    expect(payload.files['script.md']).toBe('English source.\n')
    expect(JSON.parse(payload.files['continuity.json']).summary).toBe('keep original English metadata')
    expect(sent[0].IfMatch).toBe('original')
    expect(JSON.parse(payload.files['continuity.hi.json'])).toMatchObject({ workspaceReplacement: true, summary: 'Story so far.', closing: 'नया अंत।', sourceSha256: hash('English source.') })
  })

  it('applies an edit already saved to disk and returns it to the dialog', async () => {
    await write('script.hi.md', 'Already edited.\n')
    const script = await getReplacementScript('c4', 'hi')
    expect(script).toMatchObject({ text: 'Already edited.\n', sha256: hash('Already edited.\n') })
    await replaceChapterScript('c4', 'hi', { text: script.text, expectedSha256: script.sha256, sendToPhones: false })
    expect(sections.map(s => s.language)).toEqual(['en'])
    expect(sent).toEqual([])
  })

  it('preserves the saved revision on upload failure and retries without resetting fresh results', async () => {
    uploadFails = true
    const first = await replaceChapterScript('c4', 'hi', { text: 'New.', expectedSha256: hash('पुराना।\n') })
    expect(first).toMatchObject({ phoneSent: false, phoneError: 'Offline' })
    await write('audio_hi/section_01.wav', 'newly fetched audio')
    uploadFails = false
    const retried = await replaceChapterScript('c4', 'hi', { text: 'New.', expectedSha256: hash('New.') })
    expect(retried).toMatchObject({ phoneSent: true, unchanged: true, backupPath: first.backupPath })
    expect(await fs.readFile(path.join(dir(), 'audio_hi/section_01.wav'), 'utf-8')).toBe('newly fetched audio')
    expect((await fs.readdir(path.join(dir(), '.script-replacements'))).length).toBe(1)
  })

  it('rolls back both the files and database if the transaction fails after writes', async () => {
    transactionFails = true
    await expect(replaceChapterScript('c4', 'hi', { text: 'New.', expectedSha256: hash('पुराना।\n') })).rejects.toThrow('Transaction failed')
    expect(await fs.readFile(path.join(dir(), 'script.hi.md'), 'utf-8')).toBe('पुराना।\n')
    expect(await fs.readFile(path.join(dir(), 'audio_hi/section_01.wav'), 'utf-8')).toBe('old Hindi audio')
    expect(await fs.readFile(path.join(dir(), 'script-timeline.hi.md'), 'utf-8')).toBe('old alignment')
    expect(sections.map(s => s.language)).toEqual(['en', 'hi'])
    expect(timelines.find(t => t.language === 'hi').json).toBe('{"old":true}')
    expect(sent).toEqual([])
  })

  it('rejects stale edits, blank scripts, archived chapters and active alignment without resetting anything', async () => {
    await expect(replaceChapterScript('c4', 'hi', { text: 'New.', expectedSha256: 'outdated' })).rejects.toThrow('local script changed')
    await expect(replaceChapterScript('c4', 'hi', { text: '  ', expectedSha256: null })).rejects.toThrow('nonempty')
    chapter.completedAt = new Date()
    await expect(replaceChapterScript('c4', 'hi', { text: 'New.', expectedSha256: hash('पुराना।\n') })).rejects.toThrow('unarchived')
    chapter.completedAt = null; aligning = 1
    await expect(replaceChapterScript('c4', 'hi', { text: 'New.', expectedSha256: hash('पुराना।\n') })).rejects.toThrow('alignment')
    expect(await fs.readFile(path.join(dir(), 'script.hi.md'), 'utf-8')).toBe('पुराना।\n')
    expect(sections).toHaveLength(2)
  })
})
