import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
const db = vi.hoisted(() => ({ audioSection: { findFirst: vi.fn(), update: vi.fn() }, editor2Timeline: { findUnique: vi.fn(), upsert: vi.fn() }, $transaction: vi.fn() }))
vi.mock('../../index.js', () => ({ prisma: db }))
vi.mock('../alignment/alignmentDocument.js', () => ({ alignmentDocumentPath: (folder: string, language: string) => path.join(folder, `timeline.${language}.md`) }))
import { resetSectionAlignment } from '../alignment/resetAlignment.js'
let root: string
beforeEach(async () => {
  vi.resetAllMocks()
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'alignment-reset-'))
  for (const [file, text] of [['audio.wav', 'audio'], ['timeline.en.md', 'old document'], ['timeline.hi.md', 'other language']]) await fs.writeFile(path.join(root, file), text)
  db.audioSection.findFirst.mockResolvedValue({ id: 's10', timelineScript: 'old timestamps', chapter: { folderPath: root }, audioFile: { status: 'done', filePath: path.join(root, 'audio.wav') } })
  db.editor2Timeline.findUnique.mockResolvedValue({ json: 'old editor', processedJson: 'old processed', updatedAt: new Date() })
  db.$transaction.mockImplementation(async work => work(db))
})
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })
describe('targeted alignment reset', () => {
  it('backs up state, resets one section and preserves audio and the other language', async () => {
    await resetSectionAlignment('ch5', 's10', 'en')
    expect(db.audioSection.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 's10', chapterId: 'ch5', language: 'en' } }))
    expect(db.audioSection.update).toHaveBeenCalledTimes(1)
    expect(db.audioSection.update).toHaveBeenCalledWith({ where: { id: 's10' }, data: { timelineScript: null } })
    expect(db.editor2Timeline.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { chapterId_language: { chapterId: 'ch5', language: 'en' } }, update: expect.objectContaining({ json: '', processedJson: null }) }))
    const [backup] = await fs.readdir(path.join(root, '.alignment-resets'))
    const saved = JSON.parse(await fs.readFile(path.join(root, '.alignment-resets', backup, 'state.json'), 'utf8'))
    expect(saved.section.timelineScript).toBe('old timestamps')
    expect(saved.timeline.processedJson).toBe('old processed')
    expect(await fs.readFile(path.join(root, '.alignment-resets', backup, 'timeline.en.md'), 'utf8')).toBe('old document')
    await expect(fs.access(path.join(root, 'timeline.en.md'))).rejects.toThrow()
    expect(await fs.readFile(path.join(root, 'timeline.hi.md'), 'utf8')).toBe('other language')
    expect(await fs.readFile(path.join(root, 'audio.wav'), 'utf8')).toBe('audio')
  })
  it('rejects missing or foreign sections without mutations', async () => {
    db.audioSection.findFirst.mockResolvedValue(null)
    await expect(resetSectionAlignment('ch5', 'foreign', 'en')).rejects.toThrow('ready audio')
    expect(db.$transaction).not.toHaveBeenCalled()
    expect(await fs.readFile(path.join(root, 'timeline.en.md'), 'utf8')).toBe('old document')
  })
  it('restores the document after a database failure', async () => {
    db.$transaction.mockRejectedValue(new Error('DB failed'))
    await expect(resetSectionAlignment('ch5', 's10', 'en')).rejects.toThrow('DB failed')
    expect(await fs.readFile(path.join(root, 'timeline.en.md'), 'utf8')).toBe('old document')
  })
})
