import { describe, expect, it, vi } from 'vitest'
vi.mock('../../index.js', () => ({ prisma: {} }))
import { planVoiceoverCleanup, type CleanupChapter } from '../voiceoverCleanup.js'

const obj = (key: string, etag = 'e', size = 10, root = '') => ({ key, etag, size, root })
const ch = (done: boolean, importedEtag: CleanupChapter['importedEtag'] = {}): CleanupChapter => ({ folderPath: 'S/x', done, importedEtag })

describe('planVoiceoverCleanup', () => {
  const series = new Map([['Summon', new Map([
    ['Chapter 001', ch(true)],
    ['Chapter 021', ch(false, { en: 'aaa', hi: 'hhh' })],
    ['Chapter 022', ch(false)]
  ])]])

  it('deletes zips and sidecars of done Parts', () => {
    const plan = planVoiceoverCleanup([
      obj('voiceover/Summon/Chapter 001.zip'),
      obj('voiceover/Summon/Chapter 001.hi.zip.status.json')
    ], series)
    expect(plan.map(t => [t.key, t.reason])).toEqual([
      ['voiceover/Summon/Chapter 001.zip', 'part-done'],
      ['voiceover/Summon/Chapter 001.hi.zip.status.json', 'part-done']
    ])
  })

  it('deletes an imported zip only when its ETag matches, per language, and keeps its sidecar', () => {
    const plan = planVoiceoverCleanup([
      obj('voiceover/Summon/Chapter 021.zip', 'aaa'),
      obj('voiceover/Summon/Chapter 021.zip.status.json', 'zzz'),
      obj('voiceover/Summon/Chapter 021.hi.zip', 'newer'),
      obj('voiceover/Summon/Chapter 022.zip', 'aaa')
    ], series)
    expect(plan).toEqual([{ key: 'voiceover/Summon/Chapter 021.zip', bytes: 10, reason: 'imported' }])
  })

  it('never touches restart tombstones, unknown series or nested keys, and honours the root', () => {
    const plan = planVoiceoverCleanup([
      obj('voiceover/Summon/Chapter 001.zip', 'e', 0),
      obj('voiceover/Sword Saint/Chapter 001.zip'),
      obj('voiceover/Summon/old/Chapter 001.zip'),
      obj('Manhwa/voiceover/Summon/Chapter 001.zip', 'e', 5, 'Manhwa/')
    ], series)
    expect(plan.map(t => t.key)).toEqual(['Manhwa/voiceover/Summon/Chapter 001.zip'])
  })
})
