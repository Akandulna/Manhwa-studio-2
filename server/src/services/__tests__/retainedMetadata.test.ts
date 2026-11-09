import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import {createHash} from 'crypto'
import {beforeEach, afterAll, describe, expect, it, vi} from 'vitest'
const fixture = vi.hoisted(() => ({dir: '', points: '{"crops":[]}', split: false}))
vi.mock('../clipper3/perImageStore.js', () => ({getSourceFolderPath: () => fixture.dir,
  readImagePoints: async () => ({text: fixture.points, file: {crops: [], ...(fixture.split ? {workflow: 'clipper-geometry/1'} : {})}})}))
const {retainedMetadataApproval, RETAINED_METADATA_FILE} = await import('../retainedMetadata.js')
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const originalHash = 'a'.repeat(64)
const text = `## page_001.jpg\n\n${JSON.stringify({storyLinking: {scriptSha256: originalHash}, crops: []})}`
const chapter = {folderPath: 'Series/Chapter 001'}
let record: Record<string, unknown>
const dirs: string[] = []
beforeEach(async () => {
  fixture.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'retained-metadata-')); dirs.push(fixture.dir)
  fixture.points = '{"crops":[]}'; fixture.split = false
  await fs.writeFile(path.join(fixture.dir, 'script.md'), 'New English narration\n')
  record = {schema: 'retained-crop-metadata/1', restartRevision: '1-phone', approvedAt: '2026-11-02T00:00:00Z',
    currentEnglishScriptSha256: sha('New English narration'), sourceScriptSha256: originalHash,
    metadataSha256: sha(text), pointers: {'page_001.jpg': sha(fixture.points)}}
  await fs.writeFile(path.join(fixture.dir, RETAINED_METADATA_FILE), JSON.stringify(record))
})
afterAll(async () => {for(const dir of dirs) await fs.rm(dir, {recursive: true, force: true})})
describe('explicit retained metadata approval', () => {
  it('preserves the historical reference index while binding to the current narration', async () => {
    expect(await retainedMetadataApproval(chapter, '1-phone', text)).toEqual({schema: 'retained-story-links/1',
      currentEnglishScriptSha256: sha('New English narration'), sourceScriptSha256: originalHash})
    expect(await fs.readFile(path.join(fixture.dir, 'script.md'), 'utf8')).toBe('New English narration\n')
  })
  it('requires an explicit approval for this restart and unchanged metadata', async () => {
    expect(await retainedMetadataApproval(chapter, '2-phone', text)).toBeNull()
    expect(await retainedMetadataApproval(chapter, '1-phone', text + ' ')).toBeNull()
    await fs.unlink(path.join(fixture.dir, RETAINED_METADATA_FILE))
    expect(await retainedMetadataApproval(chapter, '1-phone', text)).toBeNull()
  })
  it('rejects a changed current script or crop geometry', async () => {
    fixture.points += ' '
    expect(await retainedMetadataApproval(chapter, '1-phone', text)).toBeNull()
    fixture.points = '{"crops":[]}'
    await fs.writeFile(path.join(fixture.dir, 'script.md'), 'Another narration')
    expect(await retainedMetadataApproval(chapter, '1-phone', text)).toBeNull()
  })
  it('does not let new split jobs use a legacy approval', async () => {
    fixture.split = true
    expect(await retainedMetadataApproval(chapter, '1-phone', text)).toBeNull()
  })
})
