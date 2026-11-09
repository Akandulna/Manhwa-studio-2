import { describe, expect, it, vi } from 'vitest'
import archiver from 'archiver'
import { PassThrough } from 'stream'

vi.mock('../../index.js', () => ({ prisma: {} }))

const { parseScriptsZip, parseSharedScripts, scriptsZipKey } = await import('../phoneScriptImport.js')

/** Builds a zip the way the phone does: deflated entries under one series folder. */
async function makeZip(files: Record<string, string>, store = false): Promise<Buffer> {
  const archive = archiver('zip', { store })
  const out = new PassThrough()
  const chunks: Buffer[] = []
  out.on('data', c => chunks.push(c))
  const done = new Promise(resolve => out.on('end', resolve))
  archive.pipe(out)
  for (const [name, text] of Object.entries(files)) archive.append(text, { name })
  await archive.finalize()
  await done
  return Buffer.concat(chunks)
}

describe('parseScriptsZip', () => {
  it('reads about, scripts and continuity per chapter folder', async () => {
    const zip = await makeZip({
      'Solo Hero/about.md': 'A hero alone.\n',
      'Solo Hero/Chapter 010/script.md': 'Ten — the fight begins.\n',
      'Solo Hero/Chapter 010/continuity.json': JSON.stringify({
        summary: 'Up to ten.',
        closing: 'He stood.',
        savedAt: '2026-09-29T10:00:00Z'
      }),
      'Solo Hero/Chapter 002/script.md': 'Two.',
      'Solo Hero/Chapter 002/continuity.json': '{"summary":"","closing":"End two."}'
    })
    const parsed = parseScriptsZip(zip)
    expect(parsed.about).toBe('A hero alone.')
    expect(parsed.chapters.map(c => c.folder)).toEqual(['Chapter 002', 'Chapter 010'])
    expect(parsed.chapters[1]).toEqual({
      folder: 'Chapter 010',
      script: 'Ten — the fight begins.',
      summary: 'Up to ten.',
      closing: 'He stood.',
      savedAt: '2026-09-29T10:00:00Z',
      sourceSha256: null,
      review: null
    })
    expect(parsed.chapters[0].summary).toBeNull()
    expect(parsed.chapters[0].closing).toBe('End two.')
  })

  it('reads stored entries, skips chapters without a script and survives bad continuity', async () => {
    const zip = await makeZip(
      {
        'S/Chapter 1/script.md': 'One.',
        'S/Chapter 1/continuity.json': 'not json',
        'S/Chapter 2/continuity.json': '{"summary":"x"}'
      },
      true
    )
    const parsed = parseScriptsZip(zip)
    expect(parsed.about).toBeNull()
    expect(parsed.chapters).toHaveLength(1)
    expect(parsed.chapters[0]).toMatchObject({ folder: 'Chapter 1', script: 'One.', summary: null })
  })

  it('reads the Hinglish zip: script.hi.md and continuity.hi.json, no about', async () => {
    const zip = await makeZip({
      'Solo Hero/about.md': 'Ignored for Hinglish.',
      'Solo Hero/Chapter 001/script.md': 'English, not this zip\'s.',
      'Solo Hero/Chapter 001/script.hi.md': 'वह आगे बढ़ा।\n\nदरवाज़ा खुला था।\n',
      'Solo Hero/Chapter 001/continuity.hi.json': JSON.stringify({
        summary: 'अब तक।',
        closing: 'दरवाज़ा खुला था।',
        savedAt: '2026-10-04T10:00:00Z',
        sourceSha256: 'abc123',
        review: ['Missing paragraphs: P7', '']
      }),
      'Solo Hero/Chapter 002/script.hi.md': 'दो।',
      'Solo Hero/Chapter 002/continuity.hi.json': JSON.stringify({ summary: 's', closing: 'दो।', sourceSha256: 'def' })
    })
    const parsed = parseScriptsZip(zip, 'hi')
    expect(parsed.about).toBeNull()
    expect(parsed.chapters).toEqual([
      {
        folder: 'Chapter 001',
        script: 'वह आगे बढ़ा।\n\nदरवाज़ा खुला था।',
        summary: 'अब तक।',
        closing: 'दरवाज़ा खुला था।',
        savedAt: '2026-10-04T10:00:00Z',
        sourceSha256: 'abc123',
        review: ['Missing paragraphs: P7']
      },
      { folder: 'Chapter 002', script: 'दो।', summary: 's', closing: 'दो।', savedAt: null, sourceSha256: 'def', review: null }
    ])
    // The English zip never picks up the Hinglish files.
    expect(parseScriptsZip(zip).chapters.map(c => [c.folder, c.script])).toEqual([['Chapter 001', 'English, not this zip\'s.']])
  })

  it('names each language\'s zip', () => {
    expect(scriptsZipKey('Solo Hero', 'en')).toBe('scripts/Solo Hero/Solo Hero.zip')
    expect(scriptsZipKey('Solo Hero', 'hi')).toBe('scripts/Solo Hero/Solo Hero.hi.zip')
  })

  it('rejects something that is not a zip', () => {
    expect(() => parseScriptsZip(Buffer.from('hello'))).toThrow('Not a zip file')
  })
})

describe('parseSharedScripts', () => {
  const chapter = (folder: string, files: Record<string, string>, extra: Record<string, unknown> = {}) => ({
    key: `phone/shared/scripts/Hero/${folder}.script.json`,
    etag: `${folder}-etag`,
    lastModified: '2026-11-03T18:00:00.000Z',
    text: JSON.stringify({ schema: 'sleeper-cell-shared-script/1', series: 'Hero', chapter: folder, device: 'Nord', files, ...extra })
  })
  const english = (script: string, savedAt: string, extra: Record<string, string> = {}) => ({
    'script.md': `${script}\n`,
    'continuity.json': JSON.stringify({ summary: `Up to ${script}`, closing: `${script} ends.`, savedAt }),
    ...extra
  })

  it('takes finished chapters with their image review and skips drafts', () => {
    const review = '{"scriptSha256":"abc","paragraphs":[]}'
    const parsed = parseSharedScripts([
      chapter('Chapter 001', english('One', '2026-11-03T10:00:00Z', { 'script.review.json': review })),
      chapter('Chapter 002', { 'script.md': 'Draft without summary', 'continuity.json': '{"savedAt":"2026-11-03T11:00:00Z"}' }),
      chapter('Chapter 003', english('Three', '2026-11-03T12:00:00Z'))
    ], 'Hero', 'en', null)
    expect(parsed.chapters.map(c => c.folder)).toEqual(['Chapter 001', 'Chapter 003'])
    expect(parsed.chapters[0]).toMatchObject({ script: 'One', summary: 'Up to One', reviewJson: review, device: 'Nord' })
    expect(parsed.chapters[1].reviewJson).toBeNull()
  })

  it('prefers the phone that saved a chapter last and drops chapters saved before an earlier one', () => {
    const older = chapter('Chapter 002', english('Old two', '2026-11-03T09:00:00Z'))
    const newer = { ...chapter('Chapter 002', english('New two', '2026-11-03T13:00:00Z')), key: 'other/shared/scripts/Hero/Chapter 002.script.json' }
    const parsed = parseSharedScripts([
      chapter('Chapter 001', english('One', '2026-11-03T10:00:00Z')),
      older, newer,
      // Saved before chapter 2 was: stale, as the phone would show it.
      chapter('Chapter 003', english('Three', '2026-11-03T11:00:00Z'))
    ], 'Hero', 'en', null)
    expect(parsed.chapters.map(c => [c.folder, c.script])).toEqual([['Chapter 001', 'One'], ['Chapter 002', 'New two']])
  })

  it('reads Hinglish only with its English source and without failed checks', () => {
    const hinglish = (from: string, review?: string[]) => ({
      ...english('One', '2026-11-03T10:00:00Z'),
      'script.hi.md': 'Ek\n',
      'continuity.hi.json': JSON.stringify({ summary: 's', closing: 'c', savedAt: '2026-11-03T10:30:00Z', sourceSha256: from, ...(review ? { review } : {}) })
    })
    const parsed = parseSharedScripts([
      chapter('Chapter 001', hinglish('sha-one')),
      chapter('Chapter 002', hinglish('sha-two', ['Missing paragraphs: P3'])),
      chapter('Chapter 003', english('Three', '2026-11-03T12:00:00Z'))
    ], 'Hero', 'hi', null)
    expect(parsed.chapters.map(c => [c.folder, c.script, c.sourceSha256])).toEqual([['Chapter 001', 'Ek', 'sha-one']])
  })

  it('ignores other series, other restarts and bad files, and reads the newest about', () => {
    const series = (about: string, sharedAt: string, key = 'phone/shared/scripts/Hero/_series.json') =>
      ({ key, etag: about, lastModified: null, text: JSON.stringify({ schema: 'sleeper-cell-shared-series/1', series: 'Hero', about, sharedAt }) })
    const parsed = parseSharedScripts([
      chapter('Chapter 001', english('One', '2026-11-03T10:00:00Z'), { restartRevision: 'r2' }),
      chapter('Chapter 002', english('Two', '2026-11-03T11:00:00Z'), { restartRevision: 'r1' }),
      { ...chapter('Chapter 003', english('Three', '2026-11-03T12:00:00Z')), text: '{not json' },
      { ...chapter('Chapter 004', english('Four', '2026-11-03T13:00:00Z')), text: JSON.stringify({ schema: 'sleeper-cell-shared-script/1', series: 'Villain', chapter: 'Chapter 004', files: english('Four', '2026-11-03T13:00:00Z') }) },
      series('Old about', '2026-11-01T00:00:00Z'),
      series('New about', '2026-11-03T00:00:00Z', 'other/shared/scripts/Hero/_series.json')
    ], 'Hero', 'en', 'r2')
    expect(parsed.chapters.map(c => c.folder)).toEqual(['Chapter 001'])
    // _series.json from these phones carries no restart: only the current restart's about counts.
    expect(parseSharedScripts([series('Old about', '2026-11-01T00:00:00Z'), series('New about', '2026-11-03T00:00:00Z', 'b/_series.json')], 'Hero', 'en', null).about).toBe('New about')
  })
})
