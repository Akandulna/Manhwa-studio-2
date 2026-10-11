import fs from 'fs'
import os from 'os'
import path from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3'

// The bucket, as key → body.
const bucket = new Map<string, string>()

interface TimelineRow { chapterId: string; language: string; json: string; processedJson: string | null; updatedAt: Date }
let rows: TimelineRow[] = []

const chapters = [
  { id: 'c1', number: 1, title: null, folderPath: 'Demo/Chapter 001' },
  { id: 'c2', number: 2, title: null, folderPath: 'Demo/Chapter 002' },
  { id: 'c3', number: 3, title: null, folderPath: 'Demo/Chapter 003' }
]

// Each chapter's folder, where the automatic send keeps what it last sent.
const folders = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-editor-'))
for (const c of chapters) fs.mkdirSync(path.join(folders, c.folderPath), { recursive: true })

// The automatic send's view of each chapter: what still blocks it and whether it's reviewed.
let blockers: Record<string, string[]> = {}
let unreviewed = new Set<string>()

vi.mock('../../index.js', () => ({
  prisma: {
    chapter: {
      findMany: async ({ where }: { where: { id?: { in: string[] } } }) =>
        chapters.filter(c => !where.id || where.id.in.includes(c.id)).map(c => ({ ...c, series: { rootFolder: '/library/Demo' } }))
    },
    series: {
      findUnique: async ({ select }: { select: { chapters: { where?: { id: { in: string[] } } } } }) => ({
        title: 'Demo',
        rootFolder: '/library/Demo',
        chapters: chapters.filter(c => !select.chapters.where || select.chapters.where.id.in.includes(c.id))
      })
    },
    audioSection: {
      findMany: async () => [
        { index: 0, timelineScript: '00:00.00 - 00:05.00: "One."', audioFile: { durationMs: 5200 } },
        { index: 1, timelineScript: '00:00.00 - 00:04.50: "Two."', audioFile: null }
      ]
    },
    editor2Timeline: {
      findMany: async ({ where }: { where: { language: string } }) => rows.filter(r => r.language === where.language),
      findUnique: async ({ where }: { where: { chapterId_language: { chapterId: string; language: string } } }) =>
        rows.find(r => r.chapterId === where.chapterId_language.chapterId && r.language === where.chapterId_language.language) ?? null,
      upsert: async ({ where, create, update }: { where: { chapterId_language: { chapterId: string; language: string } }; create: TimelineRow; update: Partial<TimelineRow> }) => {
        const found = rows.find(r => r.chapterId === where.chapterId_language.chapterId && r.language === where.chapterId_language.language)
        if (found) Object.assign(found, update)
        else rows.push({ ...create })
      }
    }
  }
}))

vi.mock('../r2Service.js', () => ({
  getR2Config: () => ({ bucket: 'b', prefix: 'Manhwa/' }),
  phoneFolders: async () => ['Phone/'],
  requestPhoneUpdate: vi.fn(async () => ({})),
  createClient: () => ({
    send: async (command: unknown) => {
      if (command instanceof PutObjectCommand) {
        bucket.set(command.input.Key!, String(command.input.Body))
        return {}
      }
      if (command instanceof ListObjectsV2Command) {
        const prefix = command.input.Prefix ?? ''
        return { Contents: [...bucket.keys()].filter(k => k.startsWith(prefix)).map(Key => ({ Key })), IsTruncated: false }
      }
      if (command instanceof GetObjectCommand) {
        const body = bucket.get(command.input.Key!)
        if (body === undefined) throw new Error('NoSuchKey')
        return { Body: { transformToString: async () => body } }
      }
      throw new Error('unexpected command')
    }
  })
}))

vi.mock('../videoEditor2Service.js', () => ({
  getChapterTimelineBundle: async (id: string) => ({ text: id === 'c3' ? '' : `## Section 1\n\ntimeline of ${id}` }),
  getChapterCropMetadataBundle: async (id: string) => ({ text: `## page_001.webp\n\nmetadata of ${id}` }),
  getChapterBlockers: async (id: string) => blockers[id] ?? []
}))

vi.mock('../clipper3/perImageStore.js', () => ({
  getOutputDir: () => '/nowhere/crops3',
  getSourceFolderPath: (folderPath: string) => path.join(folders, folderPath)
}))

vi.mock('../clipper3/chapterReview.js', () => ({
  readEffectiveReview: async (folderPath: string) => ({ reviewed: !unreviewed.has(folderPath) })
}))

const { copyAllText, fetchPhoneTimelines, publishReadyEditorPackages, saveEditorPrompt, sendEditorPackages } = await import('../phoneEditor.js')

function timelineBody(chapter: string, timeline: string, madeAt: string, language = 'en') {
  return JSON.stringify({ schema: 'sleeper-cell-editor-timeline/1', series: 'Demo', chapter, language, madeAt, review: [], timeline })
}

beforeEach(() => {
  bucket.clear()
  rows = []
  blockers = {}
  unreviewed = new Set()
  for (const c of chapters) fs.rmSync(path.join(folders, c.folderPath, '.editor2-phone.json'), { force: true })
})

describe('sendEditorPackages', () => {
  it('writes the prompt, and each chapter\'s parts and sections, to the phone folder, skipping chapters without a timeline', async () => {
    const result = await sendEditorPackages('s1', 'en', ['c1', 'c3'], 'THE PROMPT')
    expect(result.sent.map(s => s.chapterId)).toEqual(['c1'])
    expect(result.skipped).toEqual([{ chapterId: 'c3', number: 3, reason: 'no script with timeline' }])
    const body = JSON.parse(bucket.get('Phone/editor/Demo/Chapter 001.package.json')!)
    expect(body.schema).toBe('manhwa-studio-editor-package/2')
    expect(body.timeline).toBe('## Section 1\n\ntimeline of c1')
    expect(body.metadata).toBe('## page_001.webp\n\nmetadata of c1')
    expect(body.text).toBeUndefined()
    const prompt = JSON.parse(bucket.get('Phone/editor/_prompt.json')!)
    expect(prompt).toMatchObject({ schema: 'manhwa-studio-editor-prompt/1', content: 'THE PROMPT' })
    expect(body.sections).toEqual([{ number: 1, durationSec: 5.2 }, { number: 2, durationSec: 4.5 }])
    expect(result.phoneNotified).toBe(true)
  })

  it('puts Hinglish in its own file', async () => {
    await sendEditorPackages('s1', 'hi', ['c1'], 'P')
    expect([...bucket.keys()].sort()).toEqual(['Phone/editor/Demo/Chapter 001.hi.package.json', 'Phone/editor/_prompt.json'])
  })

  it('needs the prompt', async () => {
    await expect(sendEditorPackages('s1', 'en', ['c1'], '  ')).rejects.toThrow(/prompt/)
  })
})

describe('publishReadyEditorPackages', () => {
  it('sends each ready, reviewed chapter without a timeline JSON, in each language', async () => {
    blockers = { c2: ['Crops'] }
    rows.push({ chapterId: 'c1', language: 'en', json: '{"made":1}', processedJson: null, updatedAt: new Date() })
    const result = await publishReadyEditorPackages(null)
    // c1 has its English JSON, c2 isn't cut, c3 has no script with timeline.
    expect(result.sent.map(s => `${s.chapterId}:${s.language}`)).toEqual(['c1:hi'])
    expect([...bucket.keys()]).toEqual(['Phone/editor/Demo/Chapter 001.hi.package.json'])
    expect(JSON.parse(bucket.get('Phone/editor/Demo/Chapter 001.hi.package.json')!).schema).toBe('manhwa-studio-editor-package/2')
  })

  it('leaves out a chapter whose crops aren\'t reviewed', async () => {
    unreviewed.add('Demo/Chapter 001')
    expect((await publishReadyEditorPackages(['c1'])).sent).toEqual([])
  })

  it('sends an unchanged package once, and again only when it\'s gone from R2', async () => {
    expect((await publishReadyEditorPackages(['c1'])).sent).toHaveLength(2)
    expect((await publishReadyEditorPackages(['c1'])).sent).toHaveLength(0)
    bucket.delete('Phone/editor/Demo/Chapter 001.package.json')
    expect((await publishReadyEditorPackages(['c1'])).sent.map(s => s.language)).toEqual(['en'])
  })

  it('counts a Send to phone as sent', async () => {
    await sendEditorPackages('s1', 'en', ['c1'], 'P')
    expect((await publishReadyEditorPackages(['c1'])).sent.map(s => s.language)).toEqual(['hi'])
  })
})

describe('saveEditorPrompt', () => {
  it('replaces the prompt in R2 and nudges the phone', async () => {
    await saveEditorPrompt('first')
    const result = await saveEditorPrompt('  second  ')
    expect(JSON.parse(bucket.get('Phone/editor/_prompt.json')!).content).toBe('second')
    expect(result.phoneNotified).toBe(true)
  })

  it('refuses an empty prompt', async () => {
    await expect(saveEditorPrompt(' ')).rejects.toThrow(/empty/)
  })
})

describe('copyAllText', () => {
  it('is the Copy All text, which EditorPackage.copyAllText on the phone builds too', () => {
    expect(copyAllText('P', 'T', 'M')).toBe('# Prompt\n\nP\n\n# Script with Timeline\n\nT\n\n# Crop Metadata\n\nM')
  })
})

describe('fetchPhoneTimelines', () => {
  it('stores new timelines unprocessed, leaves the same one alone and keeps a newer paste', async () => {
    bucket.set('Phone/editor/Demo/Chapter 001.timeline.json', timelineBody('Chapter 001', '{"sections":[1]}', '2026-10-09T10:00:00Z'))
    bucket.set('Phone/editor/Demo/Chapter 002.timeline.json', timelineBody('Chapter 002', '{"sections":[2]}', '2026-10-09T10:00:00Z'))
    bucket.set('Phone/editor/Demo/Chapter 003.timeline.json', timelineBody('Chapter 003', '{"sections":[3]}', '2026-10-09T10:00:00Z'))
    bucket.set('Phone/editor/Demo/Chapter 001.hi.timeline.json', timelineBody('Chapter 001', '{"hi":1}', '2026-10-09T10:00:00Z', 'hi'))
    bucket.set('Phone/editor/Demo/Chapter 009.timeline.json', timelineBody('Chapter 009', '{}', '2026-10-09T10:00:00Z'))
    rows.push({ chapterId: 'c2', language: 'en', json: '{"sections":[2]}', processedJson: '{"sections":[2]}', updatedAt: new Date('2026-10-08') })
    rows.push({ chapterId: 'c3', language: 'en', json: '{"mine":3}', processedJson: null, updatedAt: new Date('2026-10-09T11:00:00Z') })

    const result = await fetchPhoneTimelines('s1', 'en')

    expect(result.found).toBe(4)
    expect(result.imported.map(i => i.chapterId)).toEqual(['c1'])
    expect(result.upToDate).toBe(1)
    expect(result.kept.map(k => k.chapterId)).toEqual(['c3'])
    expect(result.unmatched).toEqual(['Chapter 009'])
    const c1 = rows.find(r => r.chapterId === 'c1')!
    expect(c1.json).toBe('{"sections":[1]}')
    expect(c1.processedJson).toBeNull()
    expect(rows.find(r => r.chapterId === 'c2')!.processedJson).toBe('{"sections":[2]}')
    expect(rows.find(r => r.chapterId === 'c3')!.json).toBe('{"mine":3}')
  })

  it('replaces an older paste', async () => {
    bucket.set('Phone/editor/Demo/Chapter 001.timeline.json', timelineBody('Chapter 001', '{"new":1}', '2026-10-09T10:00:00Z'))
    rows.push({ chapterId: 'c1', language: 'en', json: '{"old":1}', processedJson: '{"old":1}', updatedAt: new Date('2026-10-09T09:00:00Z') })
    const result = await fetchPhoneTimelines('s1', 'en')
    expect(result.imported).toHaveLength(1)
    expect(rows[0].json).toBe('{"new":1}')
    expect(rows[0].processedJson).toBeNull()
  })
})
