import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3'

const { syncPhone } = vi.hoisted(() => ({ syncPhone: vi.fn() }))
let finalCropRevision = 'review-a'
vi.mock('../editorFinalCrops.js', () => ({ editorFinalCrops: async () => ({ schema: 'studio-final-editor-crops/1', revision: finalCropRevision }) }))

// The bucket, as key → body.
const bucket = new Map<string, string>()
const modifiedAt = new Map<string, Date>()
const settings = new Map<string, string>()
let failPromptUpload = false
let failTimelineUpload = false
let phonePrefixes = ['Phone/']
let stagedFixtures = false
let groupedAlignment = false
let restartVersion: string | null = null
let storyLinksReady = true
let retainedReady = false
vi.mock('../retainedMetadata.js', () => ({ retainedMetadataApproval: async (c: {folderPath: string}) => retainedReady && c.folderPath.endsWith('001') ? {schema:'retained-story-links/1',currentEnglishScriptSha256:'b'.repeat(64),sourceScriptSha256:'a'.repeat(64)} : null }))
let claimed: { chapterId: string; language: string }[] = []
vi.mock('../editorClaims.js', () => ({ activeEditorClaims: async () => claimed }))
vi.mock('../seriesRestartGuard.js', () => ({ requireSeriesRestartReady: async () => restartVersion }))
vi.mock('../seriesRestartFiles.js', () => ({ chapterStoryLinksCurrent: async () => storyLinksReady }))

interface TimelineRow { model?: string | null; chapterId: string; language: string; json: string; processedJson: string | null; updatedAt: Date }
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
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) => settings.has(where.key) ? { key: where.key, value: settings.get(where.key)! } : null,
      upsert: async ({ where, create, update }: { where: { key: string }; create: { value: string }; update: { value: string } }) => {
        settings.set(where.key, settings.has(where.key) ? update.value : create.value)
      }
    },
    chapter: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const chapter = chapters.find(c => c.id === where.id)
        return chapter ? { ...chapter, series: { rootFolder: '/library/Demo' } } : null
      },
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
  phoneFolders: async () => phonePrefixes,
  requestPhoneUpdate: syncPhone,
  createClient: () => ({
    send: async (command: unknown) => {
      if (command instanceof PutObjectCommand) {
        if (failTimelineUpload && command.input.Key?.endsWith('.timeline.json')) throw new Error('R2 offline')
        if (failPromptUpload && command.input.Key?.endsWith('_prompt.json')) throw new Error('R2 offline')
        bucket.set(command.input.Key!, String(command.input.Body))
        return {}
      }
      if (command instanceof ListObjectsV2Command) {
        const prefix = command.input.Prefix ?? ''
        return { Contents: [...bucket.keys()].filter(k => k.startsWith(prefix)).map(Key => ({ Key, LastModified: modifiedAt.get(Key) })), IsTruncated: false }
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
  getChapterTimelineBundle: async (id: string) => ({ text: id === 'c3' ? '' : stagedFixtures ? (groupedAlignment ? '## Section 1\n00:00.00 - 00:02.00: "One."\n00:02.00 - 00:05.00: "More."\n## Section 2\n00:00.00 - 00:04.50: "Two."' : '## Section 1\n00:00.00 - 00:05.00: "One."\n## Section 2\n00:00.00 - 00:04.50: "Two."') : `## Section 1\n\ntimeline of ${id}` }),
  getChapterCropMetadataBundle: async (id: string) => ({ text: stagedFixtures ? JSON.stringify({ crops: [{ exportedFilename: 'crop.png', description: 'A woman summons a spirit.' }] }) : `## page_001.webp\n\nmetadata of ${id}` }),
  getChapterBlockers: async (id: string) => blockers[id] ?? []
}))

vi.mock('../clipper3/perImageStore.js', () => ({
  getOutputDir: () => stagedFixtures ? path.join(folders, 'staged-crops') : '/nowhere/crops3',
  getSourceFolderPath: (folderPath: string) => path.join(folders, folderPath)
}))

vi.mock('../clipper3/chapterReview.js', () => ({
  readEffectiveReview: async (folderPath: string) => ({ reviewed: !unreviewed.has(folderPath) })
}))

const { captureEditorTimelineSource, copyAllText, editorWaitingChapters, fetchPhoneTimelines, getEditorPrompt, publishReadyEditorPackages, publishSavedEditorTimelines, publishEditorTimelineResets, saveEditorPrompt, sendEditorPackages } = await import('../phoneEditor.js')

function timelineBody(chapter: string, timeline: string, madeAt: string, language = 'en') {
  return JSON.stringify({ schema: 'sleeper-cell-editor-timeline/1', series: 'Demo', chapter, language, madeAt, review: [], timeline })
}

beforeEach(() => {
  claimed = []
  bucket.clear()
  modifiedAt.clear()
  settings.clear()
  failPromptUpload = false
  finalCropRevision = 'review-a'
  syncPhone.mockReset().mockResolvedValue({})
  failTimelineUpload = false
  phonePrefixes = ['Phone/']
  stagedFixtures = false
  groupedAlignment = false
  restartVersion = null
  storyLinksReady = true
  retainedReady = false
  rows = []
  blockers = {}
  unreviewed = new Set()
  for (const c of chapters) fs.rmSync(path.join(folders, c.folderPath, '.editor2-phone.json'), { force: true })
  for (const c of chapters) for (const dir of ['audio', 'audio_hi']) fs.rmSync(path.join(folders, c.folderPath, dir), { recursive: true, force: true })
})

describe('sendEditorPackages', () => {
  it('imports grouped beats with their exact audio tail without changing scene timing or bypassing input guards', async () => {
    stagedFixtures = groupedAlignment = true
    fs.mkdirSync(path.join(folders, 'staged-crops'), { recursive: true })
    fs.writeFileSync(path.join(folders, 'staged-crops', 'crop.png'), '')
    await sendEditorPackages('s1', 'hi', ['c1'], '', 'staged')
    const pkg = JSON.parse(bucket.get('Phone/editor/Demo/Chapter 001.hi.package.json')!)
    expect(pkg.workflow.beats).toHaveLength(3)
    const json = JSON.stringify({ sections: [
      { section: 'Section 1', timelines: [{ timeline: '00:00.00 - 00:05.20', selectedImages: ['crop.png'] }] },
      { section: 'Section 2', timelines: [{ timeline: '00:00.00 - 00:04.50', selectedImages: ['crop.png'] }] }
    ] })
    const hash = createHash('sha256').update(`${pkg.timeline}\u0000${pkg.metadata}\u0000${pkg.workflow.sourceHash}`).digest('hex')
    const body = { ...JSON.parse(timelineBody('Chapter 001', json, new Date().toISOString(), 'hi')), workflowHash: pkg.workflow.sourceHash, packageSha256: hash }
    const key = 'Phone/editor/Demo/Chapter 001.hi.timeline.json'
    bucket.set(key, JSON.stringify(body))
    expect((await fetchPhoneTimelines('s1', 'hi')).imported).toHaveLength(1)
    expect(rows[0].json).toBe(json)
    expect((await fetchPhoneTimelines('s1', 'hi')).upToDate).toBe(1)
    bucket.set(key, JSON.stringify({ ...body, timeline: json.replaceAll('crop.png', 'old-crop.png') }))
    expect((await fetchPhoneTimelines('s1', 'hi')).failed[0].error).toMatch(/crop filenames/)
    // A different timeline from old prompts/inputs is refused...
    const other = json.replace('00:05.20', '00:05.10')
    bucket.set(key, JSON.stringify({ ...body, timeline: other, workflowHash: 'old-prompts' }))
    expect((await fetchPhoneTimelines('s1', 'hi')).failed[0].error).toMatch(/inputs or prompts changed/)
    bucket.set(key, JSON.stringify({ ...body, timeline: other, packageSha256: 'old-inputs' }))
    expect((await fetchPhoneTimelines('s1', 'hi')).failed[0].error).toMatch(/inputs or prompts changed/)
    expect(rows[0].json).toBe(json)
    // ...but the exact timeline already held here is simply up to date, not a failure.
    bucket.set(key, JSON.stringify({ ...body, workflowHash: 'old-prompts' }))
    expect(await fetchPhoneTimelines('s1', 'hi')).toMatchObject({ upToDate: 1, failed: [] })
  })
  it('imports only staged results with current input/prompt hashes and every original timestamp', async () => {
    stagedFixtures = true
    fs.mkdirSync(path.join(folders, 'staged-crops'), { recursive: true })
    fs.writeFileSync(path.join(folders, 'staged-crops', 'crop.png'), '')
    await sendEditorPackages('s1', 'hi', ['c1'], '', 'staged')
    const pkg = JSON.parse(bucket.get('Phone/editor/Demo/Chapter 001.hi.package.json')!)
    const json = JSON.stringify({ sections: [1, 2].map(number => ({ section: `Section ${number}`, timelines: pkg.workflow.beats.filter((b: any) => b.section === number).map((b: any) => ({ timeline: b.range, selectedImages: ['crop.png'] })) })) })
    const hash = createHash('sha256').update(`${pkg.timeline}\u0000${pkg.metadata}\u0000${pkg.workflow.sourceHash}`).digest('hex')
    const body = { ...JSON.parse(timelineBody('Chapter 001', json, new Date().toISOString(), 'hi')), workflowHash: pkg.workflow.sourceHash, packageSha256: hash }
    const key = 'Phone/editor/Demo/Chapter 001.hi.timeline.json'
    bucket.set(key, JSON.stringify(body))
    expect((await fetchPhoneTimelines('s1', 'hi')).imported).toHaveLength(1)
    bucket.set(key, JSON.stringify({ ...body, timeline: json.replace('00:05.00', '00:05.01') }))
    expect((await fetchPhoneTimelines('s1', 'hi')).failed[0].error).toMatch(/timestamp/)
    expect(rows[0].json).toBe(json)
    bucket.set(key, JSON.stringify({ ...body, timeline: json.replace('crop.png', 'crop.png", "crop.png'), workflowHash: 'old-prompts' }))
    expect((await fetchPhoneTimelines('s1', 'hi')).failed[0].error).toMatch(/inputs or prompts changed/)
  })
  it('sends a versioned staged package with built-in instructions, preserving the mode on automatic republish', async () => {
    stagedFixtures = true
    fs.mkdirSync(path.join(folders, 'staged-crops'), { recursive: true })
    fs.writeFileSync(path.join(folders, 'staged-crops', 'crop.png'), '')
    const result = await sendEditorPackages('s1', 'hi', ['c1'], '', 'staged')
    expect(result.sent).toHaveLength(1)
    const key = 'Phone/editor/Demo/Chapter 001.hi.package.json'
    const body = JSON.parse(bucket.get(key)!)
    expect(body.schema).toBe('manhwa-studio-editor-package/3')
    expect(body.workflow.beats).toHaveLength(2)
    expect(body.workflow.crops[0]).toMatchObject({ id: 'C001', filename: 'crop.png' })
    expect(bucket.has('Phone/editor/_prompt.json')).toBe(false)
    bucket.delete(key)
    await publishReadyEditorPackages(['c1'])
    expect(JSON.parse(bucket.get(key)!).schema).toBe('manhwa-studio-editor-package/3')
  })
  it('includes the fetched audio script hash so a replacement phone waits for the right revision', async () => {
    const dir = path.join(folders, chapters[0].folderPath, 'audio_hi')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.r2-voiceover.json'), JSON.stringify({ scriptSha256: 'a'.repeat(64) }))
    await sendEditorPackages('s1', 'hi', ['c1'], 'PROMPT')
    const body = JSON.parse(bucket.get('Phone/editor/Demo/Chapter 001.hi.package.json')!)
    expect(body.scriptSha256).toBe('a'.repeat(64))
  })

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
  it('refreshes each ready reviewed package in both languages, including chapters with saved timelines', async () => {
    blockers = { c2: ['Crops'] }
    rows.push({ chapterId: 'c1', language: 'en', json: '{"made":1}', processedJson: null, updatedAt: new Date() })
    const result = await publishReadyEditorPackages(null)
    // c1's saved English JSON does not suppress its package refresh; c2 isn't cut.
    expect(result.sent.map(s => `${s.chapterId}:${s.language}`)).toEqual(['c1:en', 'c1:hi'])
    expect([...bucket.keys()]).toEqual(['Phone/editor/Demo/Chapter 001.package.json', 'Phone/editor/Demo/Chapter 001.hi.package.json'])
    expect(rows[0].json).toBe('{"made":1}')
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

describe('automatic reviewed package delivery', () => {
  it('upgrades old publication receipts even when the narration and crop metadata hash is unchanged', async () => {
    await publishReadyEditorPackages(['c1'])
    const recordFile = path.join(folders, chapters[0].folderPath, '.editor2-phone.json')
    const previous = JSON.parse(fs.readFileSync(recordFile, 'utf-8'))
    const source = await captureEditorTimelineSource('c1', 'en')
    for (const language of ['en', 'hi']) delete previous[language].deliverySha256
    fs.writeFileSync(recordFile, JSON.stringify(previous))
    for (const [key, body] of bucket) {
      const document = JSON.parse(body); delete document.finalCropAuthority
      bucket.set(key, JSON.stringify(document))
    }
    expect((await publishReadyEditorPackages(['c1'])).sent).toHaveLength(2)
    expect(JSON.parse(bucket.get('Phone/editor/Demo/Chapter 001.package.json')!).finalCropAuthority.revision).toBe('review-a')
    expect(await captureEditorTimelineSource('c1', 'en')).toBe(source)
    expect((await publishReadyEditorPackages(['c1'])).sent).toEqual([])
  })

  it('publishes changed final review provenance without rebinding or overwriting a saved timeline', async () => {
    const json = '{"sections":[1]}'
    rows.push({ chapterId: 'c1', language: 'en', json, processedJson: json, updatedAt: new Date('2026-10-31T01:00:00Z') })
    const row = JSON.stringify(rows[0])
    const key = 'Phone/editor/Demo/Chapter 001.timeline.json'
    bucket.set(key, timelineBody('Chapter 001', json, '2026-10-31T01:00:00Z'))
    const timeline = bucket.get(key)
    const binding = await captureEditorTimelineSource('c1', 'en')
    await publishReadyEditorPackages(['c1'])
    syncPhone.mockClear()
    finalCropRevision = 'review-b'
    expect((await publishReadyEditorPackages(['c1'])).sent).toHaveLength(2)
    expect(syncPhone).toHaveBeenCalledTimes(1)
    expect(syncPhone).toHaveBeenCalledWith('sync')
    expect(JSON.parse(bucket.get('Phone/editor/Demo/Chapter 001.package.json')!).finalCropAuthority.revision).toBe('review-b')
    expect(await captureEditorTimelineSource('c1', 'en')).toBe(binding)
    expect(JSON.stringify(rows[0])).toBe(row)
    expect(bucket.get(key)).toBe(timeline)
  })

  it('retries package delivery when upload succeeded but the sync request failed', async () => {
    syncPhone.mockRejectedValueOnce(new Error('relay unavailable'))
    const first = await publishReadyEditorPackages(['c1'])
    expect(first.sent).toEqual([])
    expect(first.failed).toEqual(['en', 'hi'].map(language => ({ chapterId: 'c1', language, error: 'Could not request device sync' })))
    expect(bucket.has('Phone/editor/Demo/Chapter 001.package.json')).toBe(true)
    expect((await publishReadyEditorPackages(['c1'])).sent).toHaveLength(2)
    expect((await publishReadyEditorPackages(['c1'])).sent).toEqual([])
    expect(syncPhone).toHaveBeenCalledTimes(2)
  })

  it('delivers reviewed packages to every known phone prefix and requests a single sync', async () => {
    phonePrefixes = ['Nord/', 'Redmi/']
    expect((await publishReadyEditorPackages(['c1'])).sent).toHaveLength(2)
    for (const prefix of phonePrefixes) for (const suffix of ['', '.hi']) {
      expect(JSON.parse(bucket.get(`${prefix}editor/Demo/Chapter 001${suffix}.package.json`)!).finalCropAuthority).toBeDefined()
    }
    expect(syncPhone).toHaveBeenCalledTimes(1)
  })

  it('waits for the remaining audio, alignment or crop prerequisites, then sends without a manual send', async () => {
    blockers.c1 = ['Alignment']
    expect((await publishReadyEditorPackages(['c1'])).sent).toEqual([])
    expect(syncPhone).not.toHaveBeenCalled()
    delete blockers.c1
    expect((await publishReadyEditorPackages(['c1'])).sent).toHaveLength(2)
  })
})

describe('Studio reset propagation', () => {
  const revision = '2026-10-31T06:06:36.950Z'
  function reset() {
    settings.set('editor2-phone-timeline-reset:c1:en', JSON.stringify({ schema: 'editor2-timeline-reset/1', revision }))
    rows.push({ chapterId: 'c1', language: 'en', json: '', processedJson: null, updatedAt: new Date(revision) })
  }
  it('sends an explicit reset before replacement assets are ready, retrying a failed sync request', async () => {
    reset(); blockers.c1 = ['Audio', 'Crops']; phonePrefixes = ['Nord/', 'Note/']
    expect((await publishReadyEditorPackages(['c1'])).sent).toEqual([])
    syncPhone.mockRejectedValueOnce(new Error('offline'))
    expect((await publishEditorTimelineResets(['c1'])).failed).toHaveLength(1)
    for (const prefix of phonePrefixes) {
      const document = JSON.parse(bucket.get(`${prefix}editor/Demo/Chapter 001.reset.json`)!)
      expect(document).toMatchObject({ chapterId: 'c1', language: 'en', revision })
      expect(bucket.has(`${prefix}editor/Demo/Chapter 001.hi.reset.json`)).toBe(false)
    }
    expect((await publishEditorTimelineResets(['c1'])).sent).toHaveLength(1)
    expect((await publishEditorTimelineResets(['c1'])).sent).toEqual([])
  })
  it('republishes an already-delivered package with a reset binding only in the selected language', async () => {
    await publishReadyEditorPackages(['c1'])
    const originalHi = bucket.get('Phone/editor/Demo/Chapter 001.hi.package.json')
    const source = await captureEditorTimelineSource('c1', 'en')
    reset()
    expect((await publishReadyEditorPackages(['c1'])).sent.map(item => item.language)).toEqual(['en'])
    expect(JSON.parse(bucket.get('Phone/editor/Demo/Chapter 001.package.json')!).timelineResetRevision).toBe(revision)
    expect(bucket.get('Phone/editor/Demo/Chapter 001.hi.package.json')).toBe(originalHi)
    expect(await captureEditorTimelineSource('c1', 'en')).not.toBe(source)
    expect(rows[0].json).toBe('')
    expect((await publishReadyEditorPackages(['c1'])).sent).toEqual([])
  })
  it('backfills already-saved reset intents without another reset or manual send', async () => {
    settings.set('editor2-phone-timeline-edit:c1:en', JSON.stringify({ jsonSha256: createHash('sha256').update('').digest('hex'), madeAt: revision, sourceSha256: null }))
    await publishReadyEditorPackages(['c1'])
    expect(JSON.parse(bucket.get('Phone/editor/Demo/Chapter 001.package.json')!).timelineResetRevision).toBe(revision)
    expect(JSON.parse(bucket.get('Phone/editor/Demo/Chapter 001.hi.package.json')!).timelineResetRevision).toBeUndefined()
  })
  it('rejects old uploads and accepts only a new result bound to the reset package', async () => {
    reset()
    const key = 'Phone/editor/Demo/Chapter 001.timeline.json'
    const body = JSON.parse(timelineBody('Chapter 001', '{"sections":[1]}', '2026-10-31T06:07:00.000Z'))
    bucket.set(key, JSON.stringify(body))
    expect((await fetchPhoneTimelines('s1', 'en')).failed[0].error).toMatch(/before the Studio reset/)
    expect(rows[0].json).toBe('')
    body.timelineResetRevision = revision
    body.packageSha256 = 'old-inputs'
    bucket.set(key, JSON.stringify(body))
    expect((await fetchPhoneTimelines('s1', 'en')).failed[0].error).toMatch(/before the Studio reset/)
    body.packageSha256 = '00f789e06705732a95603ce61a20b24d62087149842eddad7b69d6b535da4d33'
    bucket.set(key, JSON.stringify(body))
    expect((await fetchPhoneTimelines('s1', 'en')).imported).toHaveLength(1)
    expect(rows[0].json).toBe(body.timeline)
  })
  it('includes the reset revision and the shared mobile hash in a newly saved Studio timeline', async () => {
    reset()
    const json = '{"sections":[{"section":"Section 1"}]}'
    rows[0].json = json
    const source = await captureEditorTimelineSource('c1', 'en')
    settings.set('editor2-phone-timeline-edit:c1:en', JSON.stringify({ jsonSha256: createHash('sha256').update(json).digest('hex'), madeAt: '2026-10-31T06:07:00.000Z', sourceSha256: source }))
    expect((await publishSavedEditorTimelines(['c1'])).failed).toEqual([])
    const body = JSON.parse(bucket.get('Phone/editor/Demo/Chapter 001.timeline.json')!)
    expect(body.timelineResetRevision).toBe(revision)
    expect(body.packageSha256).toBe('00f789e06705732a95603ce61a20b24d62087149842eddad7b69d6b535da4d33')
  })
})

describe('saveEditorPrompt', () => {
  it('recovers the original desktop setting even without any browser-local prompt', async () => {
    settings.set('editor2Prompt', '  Original instructions: make a section-wise timeline.  ')
    expect(await getEditorPrompt()).toEqual({ content: 'Original instructions: make a section-wise timeline.' })
  })

  it('keeps the desktop prompt when the phone upload fails', async () => {
    failPromptUpload = true
    await expect(saveEditorPrompt('Latest custom instructions')).rejects.toThrow('R2 offline')
    expect(await getEditorPrompt()).toEqual({ content: 'Latest custom instructions' })
  })

  it('reports an absent prompt without inventing instructions', async () => {
    expect(await getEditorPrompt()).toEqual({ content: '' })
  })

  it('replaces the prompt in R2 and nudges the phone', async () => {
    await saveEditorPrompt('first')
    const result = await saveEditorPrompt('  second  ')
    expect(JSON.parse(bucket.get('Phone/editor/_prompt.json')!).content).toBe('second')
    expect(result.phoneNotified).toBe(true)
    expect(await getEditorPrompt()).toEqual({ content: 'second' })
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
  it('rejects an old phone timeline after replacement audio and accepts one made from the new package', async () => {
    const dir = path.join(folders, chapters[0].folderPath, 'audio_hi')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.r2-voiceover.json'), JSON.stringify({ scriptSha256: 'a'.repeat(64) }))
    const clearedAt = new Date('2026-10-09T10:00:00Z')
    rows.push({ chapterId: 'c1', language: 'hi', json: '', processedJson: null, updatedAt: clearedAt })
    const key = 'Phone/editor/Demo/Chapter 001.hi.timeline.json'
    const old = JSON.parse(timelineBody('Chapter 001', '{"old":1}', '2026-10-09T09:00:00Z', 'hi'))
    old.packageSha256 = 'old-package'
    bucket.set(key, JSON.stringify(old))
    const stale = await fetchPhoneTimelines('s1', 'hi')
    expect(stale.imported).toEqual([])
    expect(stale.failed[0].error).toMatch(/before the voiceover replacement/)
    expect(rows[0].json).toBe('')
    const fresh = { ...old, timeline: '{"fresh":1}', madeAt: '2026-10-09T11:00:00Z',
      packageSha256: createHash('sha256').update('## Section 1\n\ntimeline of c1\u0000## page_001.webp\n\nmetadata of c1\u0000' + 'a'.repeat(64)).digest('hex') }
    bucket.set(key, JSON.stringify(fresh))
    const result = await fetchPhoneTimelines('s1', 'hi')
    expect(result.failed).toEqual([])
    expect(result.imported.map(c => c.chapterId)).toEqual(['c1'])
    expect(rows[0].json).toBe('{"fresh":1}')
  })

  it('keeps a replacement chapter in the Editor queue while its old timeline remains in R2', async () => {
    rows.push({ chapterId: 'c1', language: 'hi', json: '', processedJson: null, updatedAt: new Date() })
    bucket.set('Phone/editor/Demo/Chapter 001.hi.package.json', '{}')
    bucket.set('Phone/editor/Demo/Chapter 001.hi.timeline.json', timelineBody('Chapter 001', '{"old":1}', '2020-01-01T00:00:00Z', 'hi'))
    expect(await editorWaitingChapters('s1', 'hi')).toEqual(['Chapter 001'])
  })

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

  it('retains the actual AI model and backfills identical timelines without clearing processing', async () => {
    const json = '{"sections":[1]}'
    const body = JSON.parse(timelineBody('Chapter 001', json, '2026-10-09T10:00:00Z'))
    body.model = 'GPT-6 Astra'
    bucket.set('Phone/editor/Demo/Chapter 001.timeline.json', JSON.stringify(body))
    await fetchPhoneTimelines('s1', 'en')
    expect(rows[0].model).toBe('GPT-6 Astra')
    rows[0].model = null
    rows[0].processedJson = json
    const result = await fetchPhoneTimelines('s1', 'en')
    expect(result.upToDate).toBe(1)
    expect(rows[0].model).toBe('GPT-6 Astra')
    expect(rows[0].processedJson).toBe(json)
  })

  it('replaces an older paste', async () => {
    bucket.set('Phone/editor/Demo/Chapter 001.timeline.json', timelineBody('Chapter 001', '{"new":1}', '2026-10-09T10:00:00Z'))
    rows.push({ chapterId: 'c1', language: 'en', json: '{"old":1}', processedJson: '{"old":1}', updatedAt: new Date('2026-10-09T09:00:00Z') })
    const result = await fetchPhoneTimelines('s1', 'en')
    expect(result.imported).toHaveLength(1)
    expect(rows[0].json).toBe('{"new":1}')
    expect(rows[0].processedJson).toBeNull()
  })

  it('never replaces a timeline made in Studio (paste, edit or AntiGravity), even an older one', async () => {
    bucket.set('Phone/editor/Demo/Chapter 001.timeline.json', timelineBody('Chapter 001', '{"phone":1}', '2026-10-09T10:00:00Z'))
    rows.push({ chapterId: 'c1', language: 'en', json: '{"studio":1}', processedJson: null, updatedAt: new Date('2026-10-09T09:00:00Z') })
    settings.set('editor2-phone-timeline-edit:c1:en', JSON.stringify({ jsonSha256: createHash('sha256').update('{"studio":1}').digest('hex'), madeAt: '2026-10-09T09:00:00Z', sourceSha256: null }))
    const result = await fetchPhoneTimelines('s1', 'en')
    expect(result.imported).toHaveLength(0)
    expect(result.kept.map(k => k.chapterId)).toEqual(['c1'])
    expect(rows[0].json).toBe('{"studio":1}')
  })

  it('does not take a phone timeline while an AntiGravity Timeline job is making that chapter', async () => {
    bucket.set('Phone/editor/Demo/Chapter 001.timeline.json', timelineBody('Chapter 001', '{"phone":1}', '2026-10-09T10:00:00Z'))
    claimed = [{ chapterId: 'c1', language: 'en' }]
    const result = await fetchPhoneTimelines('s1', 'en')
    expect(result.imported).toHaveLength(0)
    expect(result.inProgress.map(k => k.chapterId)).toEqual(['c1'])
    expect(rows).toHaveLength(0)
    claimed = [{ chapterId: 'c1', language: 'hi' }]
    expect((await fetchPhoneTimelines('s1', 'en')).imported).toHaveLength(1)
  })

  it('finds new chapters across every prefix and imports the latest copy of a modified timeline', async () => {
    const oldKey = 'Phone/editor/Demo/Chapter 001.timeline.json'
    const newKey = 'Manhwa/editor/Demo/Chapter 001.timeline.json'
    bucket.set(oldKey, timelineBody('Chapter 001', '{"old":1}', '2026-10-09T09:00:00Z'))
    bucket.set(newKey, timelineBody('Chapter 001', '{"new":1}', '2026-10-09T11:00:00Z'))
    modifiedAt.set(oldKey, new Date('2026-10-09T09:00:00Z'))
    modifiedAt.set(newKey, new Date('2026-10-09T11:00:00Z'))
    bucket.set('editor/Demo/Chapter 002.timeline.json', timelineBody('Chapter 002', '{"new":2}', '2026-10-09T11:00:00Z'))
    rows.push({ chapterId: 'c1', language: 'en', json: '{"old":1}', processedJson: '{"old":1}', updatedAt: new Date('2026-10-09T10:00:00Z') })

    const result = await fetchPhoneTimelines('s1', 'en')
    expect(result.found).toBe(2)
    expect(result.imported.map(i => i.chapterId)).toEqual(['c1', 'c2'])
    expect(result.failed).toEqual([])
    expect(rows[0]).toMatchObject({ json: '{"new":1}', processedJson: null })
    expect(rows[1].json).toBe('{"new":2}')
  })
})


describe('restart publication diagnostics', () => {
  it('delivers explicitly retained originals with a current-narration approval while other stale chapters stay blocked', async () => {
    restartVersion = '123-nord'; storyLinksReady = false; retainedReady = true
    const result = await publishReadyEditorPackages(['c1', 'c2'])
    expect(result.sent.some(c => c.chapterId === 'c1')).toBe(true)
    expect(result.failed.some(c => c.chapterId === 'c2')).toBe(true)
    const pkg = JSON.parse(bucket.get('Phone/editor/Demo/Chapter 001.package.json')!)
    expect(pkg.finalCropAuthority.retainedStoryLinks).toMatchObject({schema:'retained-story-links/1',sourceScriptSha256:'a'.repeat(64)})
    expect(pkg.timeline).toContain('timeline of c1')
  })

  it('reports the source-link blocker for each language instead of silently sending zero packages', async () => {
    restartVersion = '123-nord'; storyLinksReady = false
    const result = await publishReadyEditorPackages(['c1'])
    expect(result.sent).toEqual([])
    expect(result.failed).toEqual(['en', 'hi'].map(language => ({ chapterId: 'c1', language,
      error: 'link crop metadata to the current English script first' })))
    expect([...bucket.keys()]).toEqual([])
    storyLinksReady = true
    expect((await publishReadyEditorPackages(['c1'])).sent).toHaveLength(2)
  })
})


describe('publishing Studio timeline edits to devices', () => {
  const json = JSON.stringify({ sections: [{ section: 'Section 1', timelines: [{ timeline: '00:00.00 - 00:05.00', selectedImages: ['crop.png'] }] }] })
  async function mark(language = 'en') {
    const row = rows.find(r => r.language === language)!
    settings.set(`editor2-phone-timeline-edit:c1:${language}`, JSON.stringify({ jsonSha256: createHash('sha256').update(row.json).digest('hex'), madeAt: row.updatedAt.toISOString(), sourceSha256: await captureEditorTimelineSource('c1', language as 'en' | 'hi') }))
  }
  async function saved(language = 'en') {
    rows.push({ chapterId: 'c1', language, json, model: null, processedJson: null, updatedAt: new Date('2026-10-29T10:00:00Z') })
    await mark(language)
  }
  it('publishes a matching package and timeline, notifies devices and skips unchanged saves', async () => {
    await saved()
    const { requestPhoneUpdate } = await import('../r2Service.js')
    vi.mocked(requestPhoneUpdate).mockClear()
    const result = await publishSavedEditorTimelines(['c1'])
    expect(result.failed).toEqual([])
    expect(result.sent).toEqual([{ chapterId: 'c1', number: 1, language: 'en' }])
    const pkg = JSON.parse(bucket.get('Phone/editor/Demo/Chapter 001.package.json')!)
    const timeline = JSON.parse(bucket.get('Phone/editor/Demo/Chapter 001.timeline.json')!)
    expect(timeline).toMatchObject({ schema: 'sleeper-cell-editor-timeline/1', deviceId: 'manhwa-studio', madeAt: rows[0].updatedAt.toISOString(), timeline: json })
    expect(timeline.packageSha256).toBe(createHash('sha256').update(`${pkg.timeline}\u0000${pkg.metadata}`).digest('hex'))
    expect(requestPhoneUpdate).toHaveBeenCalledWith('sync')
    expect((await publishSavedEditorTimelines(null)).sent).toEqual([])
    expect(requestPhoneUpdate).toHaveBeenCalledTimes(1)
    rows[0].json = json.replace('crop.png', 'new.png')
    rows[0].updatedAt = new Date('2026-10-29T11:00:00Z')
    await mark()
    expect((await publishSavedEditorTimelines(['c1'])).sent).toHaveLength(1)
    expect(JSON.parse(bucket.get('Phone/editor/Demo/Chapter 001.timeline.json')!).timeline).toContain('new.png')
  })
  it('uses separate Hinglish keys and the matching policy accepted by phones', async () => {
    await saved('hi')
    await publishSavedEditorTimelines(['c1'])
    expect(JSON.parse(bucket.get('Phone/editor/Demo/Chapter 001.hi.timeline.json')!)).toMatchObject({ language: 'hi', matchingPolicy: 'hinglish-direct-crops/1' })
    expect(bucket.has('Phone/editor/Demo/Chapter 001.timeline.json')).toBe(false)
  })
  it('retries an upload after notification fails, including a startup scan', async () => {
    await saved()
    const { requestPhoneUpdate } = await import('../r2Service.js')
    vi.mocked(requestPhoneUpdate).mockRejectedValueOnce(new Error('relay offline'))
    expect((await publishSavedEditorTimelines(['c1'])).failed).toHaveLength(1)
    expect(settings.has('editor2-phone-timeline:c1:en')).toBe(false)
    expect((await publishSavedEditorTimelines(null)).sent).toHaveLength(1)
    expect(settings.has('editor2-phone-timeline:c1:en')).toBe(true)
  })
  it('retries failed R2 writes to every known phone prefix', async () => {
    await saved()
    phonePrefixes = ['Phone/', 'Other/']
    failTimelineUpload = true
    expect((await publishSavedEditorTimelines(['c1'])).failed).toHaveLength(1)
    expect(settings.has('editor2-phone-timeline:c1:en')).toBe(false)
    failTimelineUpload = false
    expect((await publishSavedEditorTimelines(null)).sent).toHaveLength(1)
    for (const prefix of phonePrefixes) expect(JSON.parse(bucket.get(`${prefix}editor/Demo/Chapter 001.timeline.json`)!).timeline).toBe(json)
  })
  it('keeps newer phone work already in shared storage', async () => {
    await saved()
    const key = 'Phone/editor/Demo/Chapter 001.timeline.json'
    const remote = timelineBody('Chapter 001', json.replace('crop.png', 'phone.png'), '2026-10-29T12:00:00Z')
    bucket.set(key, remote)
    expect((await publishSavedEditorTimelines(['c1'])).failed[0].error).toMatch(/newer device timeline/)
    expect(bucket.get(key)).toBe(remote)
    expect(bucket.size).toBe(1)
  })
  it('does not distribute invalid drafts or cleared timelines', async () => {
    await saved()
    rows[0].json = '{invalid'
    await mark()
    expect((await publishSavedEditorTimelines(['c1'])).failed).toHaveLength(1)
    expect(bucket.size).toBe(0)
    rows[0].json = ''
    expect((await publishSavedEditorTimelines(['c1'])).failed).toHaveLength(0)
    expect(bucket.size).toBe(0)
  })
  it('preserves restart revisions and rejects chapters whose current story links are not ready', async () => {
    restartVersion = 'restart-2'
    await saved()
    await publishSavedEditorTimelines(['c1'])
    expect(JSON.parse(bucket.get('Phone/editor/Demo/Chapter 001.timeline.json')!)).toMatchObject({ restartRevision: 'restart-2' })
    bucket.clear(); storyLinksReady = false
    expect((await publishSavedEditorTimelines(['c1'])).failed[0].error).toMatch(/current English script/)
    expect(bucket.size).toBe(0)
  })
  it('never rebinds a saved edit to replacement audio on a retry', async () => {
    await saved()
    const dir = path.join(folders, chapters[0].folderPath, 'audio')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.r2-voiceover.json'), JSON.stringify({ scriptSha256: 'b'.repeat(64) }))
    expect((await publishSavedEditorTimelines(['c1'])).failed[0].error).toMatch(/inputs changed/)
    expect(bucket.size).toBe(0)
  })
  it('does not broadcast historical imports or overwrite a later phone import', async () => {
    await saved()
    settings.clear()
    expect((await publishSavedEditorTimelines(null)).sent).toHaveLength(0)
    await mark()
    rows[0].json = json.replace('crop.png', 'phone-new.png')
    expect((await publishSavedEditorTimelines(null)).sent).toHaveLength(0)
    expect(bucket.size).toBe(0)
  })
  it('validates staged results before publishing their workflow hash', async () => {
    stagedFixtures = true
    fs.mkdirSync(path.join(folders, 'staged-crops'), { recursive: true })
    fs.writeFileSync(path.join(folders, 'staged-crops', 'crop.png'), '')
    await sendEditorPackages('s1', 'hi', ['c1'], '', 'staged')
    const pkg = JSON.parse(bucket.get('Phone/editor/Demo/Chapter 001.hi.package.json')!)
    await saved('hi')
    rows[0].json = JSON.stringify({ sections: [1, 2].map(number => ({ section: `Section ${number}`, timelines: pkg.workflow.beats.filter((b: any) => b.section === number).map((b: any) => ({ timeline: b.range, selectedImages: ['crop.png'] })) })) })
    await mark('hi')
    expect((await publishSavedEditorTimelines(['c1'])).sent).toHaveLength(1)
    expect(JSON.parse(bucket.get('Phone/editor/Demo/Chapter 001.hi.timeline.json')!).workflowHash).toBe(pkg.workflow.sourceHash)
    rows[0].json = rows[0].json.replace('00:05.00', '00:05.01')
    rows[0].updatedAt = new Date('2026-10-29T12:00:00Z')
    await mark('hi')
    expect((await publishSavedEditorTimelines(['c1'])).failed[0].error).toMatch(/timestamp/)
  })
})
