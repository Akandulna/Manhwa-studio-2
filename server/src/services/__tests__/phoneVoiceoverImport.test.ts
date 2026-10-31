import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { PassThrough } from 'stream'
import archiver from 'archiver'

// Chapter zips as Sleeper-Cell's VoiceoverUpload.kt uploads them, at the bucket root (the phone's prefix differs).
const zips = new Map<string, Buffer>()
const etags = new Map<string, string>()
const send = vi.fn(async (command: { constructor: { name: string }; input: { Key?: string; Prefix?: string } }) => {
  if (command.constructor.name === 'ListObjectsV2Command') {
    const prefix = command.input.Prefix!
    const contents = [...zips].filter(([key]) => key.startsWith(prefix))
      .map(([key, body]) => ({ Key: key, ETag: `"${etags.get(key)}"`, Size: body.length }))
    return { Contents: contents, IsTruncated: false }
  }
  if (command.constructor.name === 'GetObjectCommand') {
    const body = zips.get(command.input.Key!)!
    return { ETag: `"${etags.get(command.input.Key!)}"`, Body: { transformToByteArray: async () => new Uint8Array(body) } }
  }
  throw new Error(`unexpected ${command.constructor.name}`)
})

vi.mock('@aws-sdk/client-s3', async importOriginal => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>()
  return { ...actual, S3Client: class { send = send } }
})
vi.mock('../r2Usage.js', () => ({ FREE_PLAN: {}, attachUsageCounter: () => {}, getMonthUsage: () => ({}), monthKey: () => '' }))
const aligned: string[] = []
vi.mock('../alignment/alignmentService.js', () => ({ alignSectionInBackground: (id: string) => { aligned.push(id) } }))

// An in-memory stand-in for the sections and audio files Prisma would hold.
let sections: any[] = []
let files: any[] = []
let timelines: any[] = []
let nextId = 0
const forChapter = (where: any) => (row: any) => row.chapterId === where.chapterId && row.language === where.language
vi.mock('../../index.js', () => ({
  prisma: {
    series: {
      findUnique: async () => ({
        rootFolder: 'Solo Hero',
        chapters: [
          { id: 'c9', number: 9, folderPath: 'Solo Hero/Chapter 009' },
          { id: 'c10', number: 10, folderPath: 'Solo Hero/Chapter 010' }
        ]
      })
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

Object.assign(process.env, { R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET: 'b', R2_PREFIX: 'Manhwa' })
const { fetchPhoneVoiceover, previewPhoneVoiceover, parseVoiceoverZip, zipChapter, FETCH_MARKER } = await import('../phoneVoiceoverImport.js')
const { readZip } = await import('../../utils/zipReader.js')

async function zipOf(entries: Record<string, string | Buffer>): Promise<Buffer> {
  const archive = archiver('zip', { store: true })
  const out = new PassThrough()
  const chunks: Buffer[] = []
  out.on('data', c => chunks.push(c))
  const done = new Promise(resolve => out.on('end', resolve))
  archive.pipe(out)
  for (const [name, data] of Object.entries(entries)) archive.append(data, { name })
  await archive.finalize()
  await done
  return Buffer.concat(chunks)
}

/** Half a second of a 16-bit mono 24 kHz WAV, as AI Studio makes them; [tone] tells files apart. */
function wav(tone = 0): Buffer {
  const samples = 12_000
  const b = Buffer.alloc(44 + samples * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples * 2, 4); b.write('WAVE', 8)
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(24_000, 24); b.writeUInt32LE(48_000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34)
  b.write('data', 36); b.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i++) b.writeInt16LE(tone ? Math.round(Math.sin(i / tone) * 3000) : 0, 44 + i * 2)
  return b
}

const manifest = (texts: string[], extra: object = {}) => JSON.stringify({
  schema_version: 'sleeper-cell-voiceover-chapter/1.0',
  series: 'Solo Hero',
  chapter: 'Chapter 009',
  language: 'en',
  target_length: 500,
  provider: 'aistudio',
  model: 'gemini-3.8-flash-tts',
  voice: 'Enzo',
  style: 'Friendly',
  sections: texts.map((text, index) => ({ index, text, file: `section_${String(index + 1).padStart(2, '0')}.wav`, format: 'wav' })),
  ...extra
})

const chapterZip = (chapter: string, texts: string[], tone = 0, extra: object = {}) => zipOf({
  [`Solo Hero/${chapter}/voiceover.json`]: manifest(texts, extra),
  ...Object.fromEntries(texts.map((_, i) => [`Solo Hero/${chapter}/section_${String(i + 1).padStart(2, '0')}.wav`, wav(tone)]))
})

let root: string
let previousRoot: string | undefined
const audioDir = (chapter: string, folder = 'audio') => path.join(root, 'Solo Hero', chapter, folder)

beforeEach(async () => {
  previousRoot = process.env.DOWNLOAD_ROOT
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'phone-voiceover-'))
  process.env.DOWNLOAD_ROOT = root
  zips.clear()
  etags.clear()
  send.mockClear()
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

describe('parseVoiceoverZip', () => {
  it('reads the splits and their audio', async () => {
    const voiceover = parseVoiceoverZip(readZip(await chapterZip('Chapter 009', ['One.', 'Two.'])))
    expect(voiceover).toMatchObject({ provider: 'aistudio', voice: 'Enzo', style: 'Friendly' })
    expect(voiceover.sections.map(s => [s.index, s.text, s.file, s.format])).toEqual([[0, 'One.', 'section_01.wav', 'wav'], [1, 'Two.', 'section_02.wav', 'wav']])
  })

  it('refuses a zip without a manifest, with misnumbered splits or missing audio', async () => {
    await expect(async () => parseVoiceoverZip(readZip(await zipOf({ 'a/b/section_01.wav': wav() })))).rejects.toThrow(/no voiceover.json/)
    const misnumbered = JSON.parse(manifest(['One.', 'Two.']))
    misnumbered.sections[1].index = 5
    await expect(async () => parseVoiceoverZip(readZip(await zipOf({
      'a/b/voiceover.json': JSON.stringify(misnumbered), 'a/b/section_01.wav': wav(), 'a/b/section_02.wav': wav()
    })))).rejects.toThrow(/numbered 5/)
    await expect(async () => parseVoiceoverZip(readZip(await zipOf({
      'a/b/voiceover.json': manifest(['One.', 'Two.']), 'a/b/section_01.wav': wav()
    })))).rejects.toThrow(/section_02.wav is missing/)
  })
})

describe('zipChapter', () => {
  const folders = new Set(['Chapter 009', 'Chapter 010', 'Extra.hi'])

  it('reads <Chapter>.hi as that chapter\'s Hinglish voiceover', () => {
    expect(zipChapter('Chapter 009', folders)).toEqual({ folder: 'Chapter 009', language: 'en' })
    expect(zipChapter('Chapter 009.hi', folders)).toEqual({ folder: 'Chapter 009', language: 'hi' })
    expect(zipChapter('Chapter 404.hi', folders)).toEqual({ folder: 'Chapter 404', language: 'hi' })
  })

  it('keeps a chapter folder that itself ends in .hi English', () => {
    expect(zipChapter('Extra.hi', folders)).toEqual({ folder: 'Extra.hi', language: 'en' })
    expect(zipChapter('Extra.hi.hi', folders)).toEqual({ folder: 'Extra.hi', language: 'hi' })
  })
})

describe('fetchPhoneVoiceover in Hinglish', () => {
  it('fetches only <Chapter>.hi.zip into the Hindi sections and audio_hi/, and English never sees it', async () => {
    zips.set('voiceover/Solo Hero/Chapter 009.zip', await chapterZip('Chapter 009', ['One.']))
    etags.set('voiceover/Solo Hero/Chapter 009.zip', 'en9')
    zips.set('voiceover/Solo Hero/Chapter 009.hi.zip', await chapterZip('Chapter 009', ['एक।', 'दो।'], 0, { language: 'hi' }))
    etags.set('voiceover/Solo Hero/Chapter 009.hi.zip', 'hi9')

    const hi = await fetchPhoneVoiceover('s3', undefined, null, 'hi')
    expect(hi).toMatchObject({ found: 1, upToDate: 0, unmatched: [], failed: [] })
    expect(hi.fetched.map(c => [c.folder, c.sections])).toEqual([['Chapter 009', 2]])
    expect(sections.map(s => [s.language, s.text])).toEqual([['hi', 'एक।'], ['hi', 'दो।']])
    expect(files.every(f => f.language === 'hi' && f.filePath.includes(`${path.sep}audio_hi${path.sep}`))).toBe(true)
    expect((await fs.readdir(audioDir('Chapter 009', 'audio_hi'))).sort()).toEqual([FETCH_MARKER, 'section_01.wav', 'section_02.wav'])

    // English: its own zip only, the Hinglish one is neither fetched nor "unmatched".
    const en = await fetchPhoneVoiceover('s3')
    expect(en).toMatchObject({ found: 1, unmatched: [], failed: [] })
    expect(sections.filter(s => s.language === 'en').map(s => s.text)).toEqual(['One.'])
    expect(sections.filter(s => s.language === 'hi')).toHaveLength(2)
  })

  it('refuses a zip whose manifest is for the other language', async () => {
    const english = readZip(await chapterZip('Chapter 009', ['One.']))
    expect(() => parseVoiceoverZip(english, 'hi')).toThrow(/Expected a Hindi voiceover, but this one is "en"/)
    const unlabelled = JSON.parse(manifest(['One.']))
    delete unlabelled.language
    const entries = readZip(await zipOf({ 'a/b/voiceover.json': JSON.stringify(unlabelled), 'a/b/section_01.wav': wav() }))
    expect(parseVoiceoverZip(entries).sections).toHaveLength(1)
    expect(() => parseVoiceoverZip(entries, 'hi')).toThrow(/this one is "undefined"/)
  })
})

describe('fetchPhoneVoiceover', () => {
  it('rejects stale phone audio after a local script replacement before changing sections', async () => {
    const chapter = path.join(root, 'Solo Hero/Chapter 009')
    await fs.mkdir(chapter, { recursive: true })
    await fs.writeFile(path.join(chapter, '.script-replacement.hi.json'), JSON.stringify({ sha256: 'replacement-script' }))
    zips.set('voiceover/Solo Hero/Chapter 009.hi.zip', await chapterZip('Chapter 009', ['पुराना।'], 0, { language: 'hi', script_sha256: 'old-script' }))
    etags.set('voiceover/Solo Hero/Chapter 009.hi.zip', 'old')
    const result = await fetchPhoneVoiceover('s1', ['c9'], null, 'hi')
    expect(result.fetched).toEqual([])
    expect(result.failed[0].reason).toMatch(/before the script replacement/)
    expect(sections).toEqual([])
    expect(files).toEqual([])
    expect(aligned).toEqual([])
  })

  it('backs up and clears only the replaced language timeline, leaving a newer cache invalidation', async () => {
    const previous = new Date(Date.now() + 10_000)
    timelines.push({ chapterId: 'c9', language: 'hi', json: '{"old":true}', processedJson: '{"old":true}', updatedAt: previous })
    timelines.push({ chapterId: 'c9', language: 'en', json: '{"english":true}', processedJson: '{"english":true}', updatedAt: previous })
    zips.set('voiceover/Solo Hero/Chapter 009.hi.zip', await chapterZip('Chapter 009', ['नया टेक्स्ट।'], 0, { language: 'hi', script_sha256: 'new-script-hash' }))
    etags.set('voiceover/Solo Hero/Chapter 009.hi.zip', 'replacement')
    const result = await fetchPhoneVoiceover('s1', ['c9'], null, 'hi')
    expect(result.failed).toEqual([])
    expect(timelines[0]).toMatchObject({ json: '', processedJson: null })
    expect(timelines[0].updatedAt.getTime()).toBeGreaterThan(previous.getTime())
    expect(timelines[1].json).toBe('{"english":true}')
    const backup = await fs.readdir(path.join(audioDir('Chapter 009', 'audio_hi'), 'backup'))
    expect(await fs.readFile(path.join(audioDir('Chapter 009', 'audio_hi'), 'backup', backup[0]), 'utf-8')).toBe('{"old":true}')
    const marker = JSON.parse(await fs.readFile(path.join(audioDir('Chapter 009', 'audio_hi'), FETCH_MARKER), 'utf-8'))
    expect(marker.scriptSha256).toBe('new-script-hash')
  })

  it('makes the phone\'s splits the sections, attaches their audio, then downloads only what changed', async () => {
    zips.set('voiceover/Solo Hero/Chapter 009.zip', await chapterZip('Chapter 009', ['One.', 'Two.']))
    etags.set('voiceover/Solo Hero/Chapter 009.zip', 'e9')
    zips.set('voiceover/Solo Hero/Chapter 404.zip', await chapterZip('Chapter 404', ['Lost.']))
    etags.set('voiceover/Solo Hero/Chapter 404.zip', 'e404')

    const first = await fetchPhoneVoiceover('s1')
    expect(first).toMatchObject({ configured: true, found: 2, upToDate: 0, unmatched: ['Chapter 404'], failed: [] })
    expect(first.fetched).toEqual([{ chapterId: 'c9', chapterNumber: 9, folder: 'Chapter 009', sections: 2, resplit: true, scriptMatches: null }])
    expect(sections.map(s => [s.index, s.text, s.status])).toEqual([[0, 'One.', 'done'], [1, 'Two.', 'done']])
    expect(files.map(f => [f.kind, f.provider, f.voice, path.basename(f.filePath), f.durationMs])).toEqual([
      ['generated', 'aistudio', 'Enzo', 'section_01.wav', 500],
      ['generated', 'aistudio', 'Enzo', 'section_02.wav', 500]
    ])
    expect(aligned).toEqual(sections.map(s => s.id))
    expect((await fs.readdir(audioDir('Chapter 009'))).sort()).toEqual([FETCH_MARKER, 'section_01.wav', 'section_02.wav'])

    // Same ETag: nothing downloaded, and the folder is remembered (one LIST).
    send.mockClear()
    expect(await fetchPhoneVoiceover('s1')).toMatchObject({ fetched: [], upToDate: 1 })
    expect(send.mock.calls.map(([c]) => c.constructor.name)).toEqual(['ListObjectsV2Command'])

    // Re-voiced with the same splits: the sections stay, the audio is replaced and the old kept in backup/.
    // The old timelines and the alignment document go with the old audio.
    const ids = sections.map(s => s.id)
    for (const s of sections) s.timelineScript = '00:00.00 - 00:00.50: "x"'
    const document = path.join(root, 'Solo Hero', 'Chapter 009', 'script-timeline.md')
    await fs.writeFile(document, 'old')
    zips.set('voiceover/Solo Hero/Chapter 009.zip', await chapterZip('Chapter 009', ['One.', 'Two.'], 7))
    etags.set('voiceover/Solo Hero/Chapter 009.zip', 'e9b')
    const third = await fetchPhoneVoiceover('s1')
    expect(third.fetched.map(c => c.resplit)).toEqual([false])
    expect(sections.map(s => s.id)).toEqual(ids)
    expect(sections.map(s => s.timelineScript)).toEqual([null, null])
    await expect(fs.access(document)).rejects.toThrow()
    expect(files).toHaveLength(2)
    expect((await fs.readdir(path.join(audioDir('Chapter 009'), 'backup'))).length).toBe(2)
    expect((await fs.readFile(path.join(audioDir('Chapter 009'), 'section_01.wav'))).equals(wav(7))).toBe(true)

    // Split differently on the phone: the sections are replaced.
    zips.set('voiceover/Solo Hero/Chapter 009.zip', await chapterZip('Chapter 009', ['One. Two.']))
    etags.set('voiceover/Solo Hero/Chapter 009.zip', 'e9c')
    const fourth = await fetchPhoneVoiceover('s1')
    expect(fourth.fetched.map(c => c.resplit)).toEqual([true])
    expect(sections.map(s => s.text)).toEqual(['One. Two.'])
    expect(files.map(f => path.basename(f.filePath))).toEqual(['section_01.wav'])
  })

  it('previews from the LIST alone: new, changed and already attached chapters', async () => {
    zips.set('voiceover/Solo Hero/Chapter 009.zip', await chapterZip('Chapter 009', ['One.']))
    etags.set('voiceover/Solo Hero/Chapter 009.zip', 'p9')
    zips.set('voiceover/Solo Hero/Chapter 404.zip', await chapterZip('Chapter 404', ['Lost.']))
    etags.set('voiceover/Solo Hero/Chapter 404.zip', 'p404')

    const before = await previewPhoneVoiceover('s4')
    expect(before.chapters.map(c => [c.number, c.state])).toEqual([[9, 'new']])
    expect(before.unmatched).toEqual(['Chapter 404'])
    expect(send.mock.calls.every(([c]) => c.constructor.name === 'ListObjectsV2Command')).toBe(true)

    await fetchPhoneVoiceover('s4', ['c9'])
    expect((await previewPhoneVoiceover('s4')).chapters.map(c => c.state)).toEqual(['same'])
    etags.set('voiceover/Solo Hero/Chapter 009.zip', 'p9b')
    expect((await previewPhoneVoiceover('s4')).chapters.map(c => c.state)).toEqual(['changed'])
  })

  it('leaves the chapter as it was when a file isn\'t audio', async () => {
    const zip = await zipOf({
      'Solo Hero/Chapter 010/voiceover.json': manifest(['One.']),
      'Solo Hero/Chapter 010/section_01.wav': Buffer.from('not audio')
    })
    zips.set('Manhwa/voiceover/Solo Hero/Chapter 010.zip', zip)
    etags.set('Manhwa/voiceover/Solo Hero/Chapter 010.zip', 'x')
    const result = await fetchPhoneVoiceover('s2', ['c10'])
    expect(result.fetched).toEqual([])
    expect(result.failed.map(f => f.folder)).toEqual(['Chapter 010'])
    expect(sections).toEqual([])
    expect(await fs.readdir(audioDir('Chapter 010'))).toEqual([])
  })
})
