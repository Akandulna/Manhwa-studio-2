import { describe, expect, it, vi } from 'vitest'
import archiver from 'archiver'
import { PassThrough } from 'stream'

vi.mock('../../index.js', () => ({ prisma: {} }))

const { parseScriptsZip, scriptsZipKey } = await import('../phoneScriptImport.js')

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
