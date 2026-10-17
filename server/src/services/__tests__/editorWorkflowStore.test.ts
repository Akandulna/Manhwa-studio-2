import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'editor-stages-'))
let timeline = '## Section 1\n00:00.00 - 00:05.00: "A woman summons a spirit."'
const metadata = JSON.stringify({ crops: [{ exportedFilename: 'crop.png', description: 'A woman summons a spirit.' }] })
vi.mock('../../index.js', () => ({ prisma: {
  chapter: { findUnique: async () => ({ folderPath: folder }) },
  audioSection: { findMany: async () => [{ index: 0, audioFile: { durationMs: 5000 } }] }
} }))
vi.mock('../clipper3/perImageStore.js', () => ({ getOutputDir: () => path.join(folder, 'crops3'), getSourceFolderPath: () => folder }))
vi.mock('../videoEditor2Service.js', () => ({
  getChapterTimelineBundle: async () => ({ text: timeline }),
  getChapterCropMetadataBundle: async () => ({ text: metadata }), getChapterBlockers: async () => []
}))
const { editorWorkflowSession } = await import('../editorWorkflowStore.js')
beforeEach(async () => {
  await fs.rm(folder, { force: true, recursive: true }); await fs.mkdir(path.join(folder, 'crops3'), { recursive: true }); await fs.writeFile(path.join(folder, 'crops3', 'crop.png'), '')
  timeline = '## Section 1\n00:00.00 - 00:05.00: "A woman summons a spirit."'
})
afterAll(() => fs.rm(folder, { force: true, recursive: true }))
const indexReply = JSON.stringify({ summary: 'Woman summons spirit', labels: { C001: 'Woman summons spirit' } })

describe('chapter staged checkpoints', () => {
  it('GET is read-only; accepted visual work is durable and shared between languages', async () => {
    const initial = await editorWorkflowSession('chapter', 'en')
    expect(await fs.readdir(folder)).toEqual(['crops3'])
    await editorWorkflowSession('chapter', 'en', { taskId: initial.task!.id, fingerprint: initial.task!.fingerprint, reply: indexReply })
    expect((await editorWorkflowSession('chapter', 'en')).task?.stage).toBe('route')
    expect((await editorWorkflowSession('chapter', 'hi')).task?.stage).toBe('route')
    expect(await fs.readFile(path.join(folder, '.editor-stages.en.json'), 'utf8')).toContain('Woman summons spirit')
  })
  it('serializes simultaneous replies so the second cannot overwrite the first checkpoint', async () => {
    const initial = await editorWorkflowSession('chapter', 'en')
    const action = { taskId: initial.task!.id, fingerprint: initial.task!.fingerprint, reply: indexReply }
    const results = await Promise.allSettled([editorWorkflowSession('chapter', 'en', action), editorWorkflowSession('chapter', 'en', action)])
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected'])
    expect((results[1] as PromiseRejectedResult).reason.message).toMatch(/stale/)
  })
  it('invalidates changed narration while keeping the visual index and never stores a timeline row', async () => {
    const initial = await editorWorkflowSession('chapter', 'en')
    const routed = await editorWorkflowSession('chapter', 'en', { taskId: initial.task!.id, fingerprint: initial.task!.fingerprint, reply: indexReply })
    const oldFingerprint = routed.task!.fingerprint
    timeline = timeline.replace('summons a spirit', 'leaves')
    const changed = await editorWorkflowSession('chapter', 'en')
    expect(changed.task?.stage).toBe('route'); expect(changed.task?.fingerprint).not.toBe(oldFingerprint)
    expect(changed.json).toBeNull()
    const reset = await editorWorkflowSession('chapter', 'en', { reset: changed.revision })
    expect(reset.task?.stage).toBe('route')
  })
  it('reports damaged checkpoint files instead of silently losing accepted work', async () => {
    await fs.writeFile(path.join(folder, '.editor-stages.en.json'), '{broken')
    await expect(editorWorkflowSession('chapter', 'en')).rejects.toThrow('damaged checkpoint')
  })
  it('retains rejected routing replies and correction guidance until that same batch succeeds', async () => {
    const initial = await editorWorkflowSession('chapter', 'hi')
    const routed = await editorWorkflowSession('chapter', 'hi', { taskId: initial.task!.id, fingerprint: initial.task!.fingerprint, reply: indexReply })
    const task = routed.task!
    const rejected = JSON.stringify({ routes: {}, uncertain: [] })
    await expect(editorWorkflowSession('chapter', 'hi', { taskId: task.id, fingerprint: task.fingerprint, reply: rejected })).rejects.toThrow('Missing: S01-B01')
    const reopened = await editorWorkflowSession('chapter', 'hi')
    expect(reopened.completed).toBe(1)
    expect(reopened.task!.id).toBe(task.id)
    expect(reopened.rejection?.reply).toBe(rejected)
    expect(reopened.rejection?.repairPrompt).toContain('Missing: S01-B01')
    const accepted = await editorWorkflowSession('chapter', 'hi', { taskId: task.id, fingerprint: task.fingerprint, reply: JSON.stringify({ routes: { 'S01-B01': ['V001'] }, uncertain: [] }) })
    expect(accepted.task?.stage).toBe('select')
    expect(accepted.rejection).toBeNull()
    await expect(fs.access(path.join(folder, '.editor-stages.hi.rejection.json'))).rejects.toThrow()
  })
})
