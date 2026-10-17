import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { filterReplacedCropFacts, newPageReplacement, readPageReplacement, resetChapterClipping } from '../chapterPageReplacement.js'

let root: string
let previousRoot: string | undefined
beforeEach(async () => {
  previousRoot = process.env.DOWNLOAD_ROOT
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'page-replacement-'))
  process.env.DOWNLOAD_ROOT = root
})
afterEach(async () => {
  if (previousRoot === undefined) delete process.env.DOWNLOAD_ROOT
  else process.env.DOWNLOAD_ROOT = previousRoot
  await fs.rm(root, { recursive: true, force: true })
})
async function write(relative: string, text = relative) {
  const file = path.join(root, relative)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}

describe('page replacement clipping reset', () => {
  it('backs up crop artifacts and leaves chapter images, both scripts, audio and alignment intact', async () => {
    const folder = 'Demo/Chapter 001'
    const artifacts = [
      `${folder}/crop_points3/page_001.json`, `${folder}/crop_metadata3/page_001.txt`, `${folder}/crops3/panel.png`,
      `${folder}/.clipper3-review.json`, 'Demo/Processed/Chapter 001/page_001/crop-pointers.json',
      'Demo/Demo/Chapter 001/slices3/page_001/slice.webp'
    ]
    const kept = ['page_001.jpg', 'script.md', 'script.hi.md', 'audio/s1.wav', 'audio_hi/s1.wav', 'script-timeline.md', 'script-timeline.hi.md']
    for (const file of [...artifacts, ...kept.map(name => `${folder}/${name}`), 'Demo/Chapter 002/crops3/other.png']) await write(file)
    const replacement = newPageReplacement()
    await resetChapterClipping(folder, replacement)
    expect(await readPageReplacement(folder)).toEqual(replacement)
    for (const file of artifacts) await expect(fs.access(path.join(root, file))).rejects.toThrow()
    for (const name of kept) expect(await fs.readFile(path.join(root, folder, name), 'utf-8')).toBe(`${folder}/${name}`)
    expect(await fs.readFile(path.join(root, 'Demo/Chapter 002/crops3/other.png'), 'utf-8')).toContain('Chapter 002')
    const backup = path.join(root, folder, '.page-replacements', replacement.revision)
    expect((await fs.readdir(backup)).sort()).toEqual(['crops', 'metadata', 'points', 'processed', 'review', 'slices'])
    expect(await fs.readFile(path.join(backup, 'points/page_001.json'), 'utf-8')).toBe(artifacts[0])

    // Replaying a completed revision must not remove crops made since that reset.
    await write(`${folder}/crop_points3/page_001.json`, 'new crops')
    await resetChapterClipping(folder, replacement)
    expect(await fs.readFile(path.join(root, folder, 'crop_points3/page_001.json'), 'utf-8')).toBe('new crops')
  })

  it('ignores old crop receipts while preserving voiceover/account data and new-revision crop facts', async () => {
    const replacement = newPageReplacement()
    await resetChapterClipping('Demo/Chapter 001', replacement)
    const chapter = { total: 2, done: 2, pages: { 'page_001.jpg': 'done', 'page_002.jpg': 'done' }, zip: { etag: 'old' } }
    const body = { profiles: ['account'], speech: { today: 4 }, series: { Demo: { total: 4, done: 4, chapters: { 'Chapter 001': chapter, 'Chapter 002': chapter } } } }
    const filtered = await filterReplacedCropFacts(body)
    expect(filtered.profiles).toEqual(['account'])
    expect(filtered.speech).toEqual({ today: 4 })
    expect(filtered.series.Demo.done).toBe(2)
    expect(filtered.series.Demo.chapters['Chapter 001']).toEqual({ total: 2, done: 0, pages: {}, pageRevision: replacement.revision })
    expect(body.series.Demo.chapters['Chapter 001'].done).toBe(2)
    const current = { series: { Demo: { chapters: { 'Chapter 001': { ...chapter, pageRevision: replacement.revision } } } } }
    expect(await filterReplacedCropFacts(current)).toBe(current)
  })
})
