import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
let reviewed = true, blockers: string[] = []
vi.mock('../clipper3/perImageStore.js', () => ({ getSourceFolderPath: (dir: string) => dir }))
vi.mock('../clipper3/chapterReview.js', () => ({ readEffectiveReview: async () => ({ reviewed }) }))
vi.mock('../videoEditor2Service.js', () => ({ getChapterBlockers: async () => blockers }))
const { editorFinalCrops } = await import('../editorFinalCrops.js')
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
let dir: string
beforeEach(async () => { reviewed = true; blockers = []; dir = await fs.mkdtemp(path.join(os.tmpdir(), 'final-editor-')); await fs.writeFile(path.join(dir, 'page_001.jpg'), 'source') })
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })
const metadata = () => `## page_001.jpg\n\n${JSON.stringify({ storyLinking: { sourceSha256: sha('source'), inputRevision: 'a'.repeat(64) }, crops: [{ exportedFilename: 'final.png', description: 'Reviewed scene' }] })}`
it('binds exact finalized metadata, images and source without changing working JSON', async () => {
 const text=metadata(), result=await editorFinalCrops({ id: 'id', folderPath: dir }, 'hi', text, ['final.png'])
 expect(result).toMatchObject({ schema: 'studio-final-editor-crops/1', metadataSha256: sha(text), imagesSha256: sha('final.png'), pages: [{filename:'page_001.jpg',sourceSha256:sha('source'),inputRevision:'a'.repeat(64)}] })
})
it('refuses unreviewed and uncut chapters', async () => {
 reviewed=false; await expect(editorFinalCrops({ id:'id',folderPath:dir },'en',metadata(),['final.png'])).rejects.toThrow(/final reviewed/)
 reviewed=true; blockers=['cropped images'];await expect(editorFinalCrops({ id:'id',folderPath:dir },'en',metadata(),['final.png'])).rejects.toThrow(/final reviewed/)
})
it('refuses changed sources and mismatched final image inventories', async () => {
 await expect(editorFinalCrops({id:'id',folderPath:dir},'hi',metadata(),['old.png'])).rejects.toThrow(/inventory/)
 await fs.writeFile(path.join(dir,'page_001.jpg'),'edited')
 await expect(editorFinalCrops({id:'id',folderPath:dir},'hi',metadata(),['final.png'])).rejects.toThrow(/changed source/)
})
it('refuses unsafe source paths and duplicate crops', async () => {
 await expect(editorFinalCrops({id:'id',folderPath:dir},'hi',metadata().replace('## page_001.jpg','## ../page_001.jpg'),['final.png'])).rejects.toThrow(/identity/)
 await expect(editorFinalCrops({id:'id',folderPath:dir},'hi',metadata()+'\n\n'+metadata(),['final.png'])).rejects.toThrow(/identity/)
})
it('retains exact redo identity in the final snapshot', async () => {
 const text=metadata().replace('"crops":','"studioRedoRevision":"redo-123","crops":')
 const result=await editorFinalCrops({id:'id',folderPath:dir},'hi',text,['final.png']);expect(result.pages[0].redoRevision).toBe('redo-123')
})

it('supports finalized visual-only Hinglish while English still requires story links', async () => {
 const text='## page_001.jpg\n\n'+JSON.stringify({crops:[{exportedFilename:'final.png',description:'Reviewed scene'}]})
 expect((await editorFinalCrops({id:'id',folderPath:dir},'hi',text,['final.png'])).pages[0].sourceSha256).toBe(sha('source'))
 await expect(editorFinalCrops({id:'id',folderPath:dir},'en',text,['final.png'])).rejects.toThrow(/complete source/)
})
