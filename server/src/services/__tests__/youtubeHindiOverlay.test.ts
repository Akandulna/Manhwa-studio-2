import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { createServer, type Server } from 'node:http'
import sharp from 'sharp'
import { YouTubeStore } from '../youtubeStore.js'
import { createYouTubeRouter } from '../../routes/youtube.js'
import { DEFAULT_HINDI_OVERLAY, parseHindiOverlay, hindiStampSvg, hindiOverlayGeometry, renderHinglishThumbnail, hindiOverlayKey } from '../youtubeHinglishThumbnail.js'
let root: string, store: YouTubeStore, server: Server | undefined
const png = () => sharp({ create: { width: 1280, height: 720, channels: 4, background: '#264967' } }).png().toBuffer()
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-hindi-overlay-'));store = new YouTubeStore(root) })
afterEach(async () => { if (server) { server.closeAllConnections();await new Promise<void>(resolve => server!.close(() => resolve()));server = undefined } await fs.rm(root, { recursive: true, force: true }) })
async function selected() {
 let w = await store.openWorkspace('a');w = await store.selectTitle('a',{title:'A Hunter Returns',expectedRevision:w.titles.revision})
 w = await store.changeReference('a',{expectedRevision:w.titles.revision},{chapterId:'chapter',cropId:'crop',label:'Hero',buffer:await png()})
 w = await store.prepareThumbnails('a','Test Hunter',{mode:'fresh',expectedRevision:w.titles.revision})
 w = await store.importThumbnail('a',{requestId:w.thumbnails.requests[0].id,slot:0,expectedRevision:w.titles.revision},await png())
 return store.selectThumbnail('a',{id:w.thumbnails.versions[0].id,expectedRevision:w.titles.revision})
}
describe('Hinglish thumbnail overlay', () => {
 it('validates style, color, size and placement and rejects SVG injection or non-finite coordinates', () => {
  expect(parseHindiOverlay({...DEFAULT_HINDI_OVERLAY,color:'#abcdef',x:12.345})).toEqual({...DEFAULT_HINDI_OVERLAY,color:'#ABCDEF',x:12.35})
  for (const change of [{template:'custom'}, {color:'red'}, {color:'#fff" onload="alert(1)'}, {size:9}, {size:61}, {x:-1}, {y:101}, {x:Infinity}, {size:'34'}]) expect(()=>parseHindiOverlay({...DEFAULT_HINDI_OVERLAY,...change})).toThrow()
 })
 it('provides four font-independent Extra Bold Latin HINDI templates with the requested color', async () => {
  const outputs = []
  for (const template of ['outline','shadow','italic','badge'] as const) {
   const svg = hindiStampSvg({...DEFAULT_HINDI_OVERLAY,template,color:'#FF2255'});expect(svg).toContain('HINDI');expect(svg).toContain('fill="#FF2255"');expect(svg).not.toContain('<text');expect(svg).not.toContain('href=')
   const data = await sharp(Buffer.from(svg)).png().toBuffer();expect((await sharp(data).metadata()).width).toBe(432);outputs.push(data.toString('base64'))
  }
  expect(new Set(outputs).size).toBe(4);expect(hindiStampSvg({...DEFAULT_HINDI_OVERLAY,color:'#000000'})).toContain('stroke="#FFFFFF"')
 })
 it('keeps every overlay inside the source image, even with extreme image ratios and edge positions', () => {
  for (const [width,height] of [[1280,720],[720,1280],[8000,100],[20,20]]) for (const x of [0,96,100]) for (const y of [0,96,100]) {
   const box = hindiOverlayGeometry(width,height,{...DEFAULT_HINDI_OVERLAY,size:60,x,y})
   expect(box.left).toBeGreaterThanOrEqual(0);expect(box.top).toBeGreaterThanOrEqual(0);expect(box.left+box.width).toBeLessThanOrEqual(width);expect(box.top+box.height).toBeLessThanOrEqual(height)
  }
 })
 it('composites onto the exact original dimensions while preserving all pixels outside the overlay rectangle', async () => {
  const source = await png();const result = await renderHinglishThumbnail(source,DEFAULT_HINDI_OVERLAY)
  expect((await sharp(result).metadata())).toMatchObject({width:1280,height:720,format:'png'})
  const box = hindiOverlayGeometry(1280,720,DEFAULT_HINDI_OVERLAY);const before = await sharp(source).raw().toBuffer();const after = await sharp(result).raw().toBuffer()
  let changed = 0
  for (let y=0;y<720;y++) for (let x=0;x<1280;x++) {const offset=(y*1280+x)*4;const same=before.subarray(offset,offset+4).equals(after.subarray(offset,offset+4));if(x<box.left||x>=box.left+box.width||y<box.top||y>=box.top+box.height) expect(same).toBe(true);else if(!same)changed++}
  expect(changed).toBeGreaterThan(1000)
 })
 it('renders the default without modifying saved work and persists edits with revision protection', async () => {
  let w = await selected();const original = w.thumbnails.versions[0];const before = await store.openWorkspace('a')
  expect((await sharp(await store.hinglishThumbnail('a',original.id,hindiOverlayKey(DEFAULT_HINDI_OVERLAY))).metadata()).width).toBe(1280)
  expect(await store.openWorkspace('a')).toEqual(before)
  const overlay = {...DEFAULT_HINDI_OVERLAY,template:'badge' as const,color:'#FFFFFF',x:15,y:20,size:25}
  w = await store.saveHindiOverlay('a',{imageId:original.id,overlay,expectedRevision:w.titles.revision});expect(w.hindiOverlay).toEqual(overlay)
  expect((await new YouTubeStore(root).openWorkspace('a')).hindiOverlay).toEqual(overlay);expect(w.thumbnails.versions).toEqual(before.thumbnails.versions)
  expect(await store.thumbnailMedia('a',original.id)).toEqual(await png())
  await expect(store.hinglishThumbnail('a',original.id,hindiOverlayKey(DEFAULT_HINDI_OVERLAY))).rejects.toMatchObject({status:409})
  await expect(store.saveHindiOverlay('a',{imageId:original.id,overlay,expectedRevision:before.titles.revision})).rejects.toMatchObject({status:409})
  await expect(store.saveHindiOverlay('a',{imageId:'other',overlay,expectedRevision:w.titles.revision})).rejects.toMatchObject({status:409})
 })
 it('follows replacement/selection of the English base and never burns an overlay into it', async () => {
  let w = await selected();const oldId = w.selectedThumbnail!;w = await store.saveHindiOverlay('a',{imageId:oldId,overlay:{...DEFAULT_HINDI_OVERLAY,template:'italic'},expectedRevision:w.titles.revision})
  w = await store.replaceThumbnail('a',{imageId:oldId,expectedRevision:w.titles.revision},await png());expect(w.hindiOverlay?.template).toBe('italic')
  expect(await store.thumbnailMedia('a',w.selectedThumbnail!)).toEqual(await png());await expect(store.hinglishThumbnail('a',oldId)).rejects.toMatchObject({status:409})
  expect((await sharp(await store.hinglishThumbnail('a',w.selectedThumbnail!)).metadata()).width).toBe(1280)
  await expect(store.hinglishThumbnail('b',w.selectedThumbnail!)).rejects.toMatchObject({status:409})
 })
 it('marks Hinglish Done when title, current description and a selected base are saved; stale base needs review', async () => {
  let w = await selected();w = await store.saveDescription('a',{title:w.selectedTitle,variant:'hinglish',text:'Discover the hunter’s journey in Hindi.',expectedRevision:w.titles.revision})
  expect((await store.libraryStatuses(['a'])).a.hinglish).toBe('done')
  w = await store.selectTitle('a',{title:'Another Title',expectedRevision:w.titles.revision});expect((await store.libraryStatuses(['a'])).a.hinglish).toBe('needs_update')
 })
 it('serves sanitized template SVGs and finished PNG downloads, and checks series and selected-image identities', async () => {
  const app=express();app.use(express.json());app.use('/api/youtube',createYouTubeRouter({store,seriesExists:async id=>id==='a'}));server=createServer(app);await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${(server.address() as any).port}/api/youtube`
  const svg=await fetch(base+'/thumbnail-overlay/stamp?template=shadow&color=%23FF2255');expect(svg.headers.get('content-type')).toContain('image/svg+xml');expect(await svg.text()).toContain('#FF2255')
  expect((await fetch(base+'/thumbnail-overlay/stamp?color=bad')).status).toBe(422)
  let w=await selected();const res=await fetch(`${base}/series/a/thumbnails/hindi-overlay`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({imageId:w.selectedThumbnail,overlay:DEFAULT_HINDI_OVERLAY,expectedRevision:w.titles.revision})});expect(res.status).toBe(200);w=await res.json()
  const download=await fetch(`${base}/series/a/thumbnails/hinglish/${w.selectedThumbnail}?download=1`);expect(download.headers.get('content-disposition')).toContain('youtube-thumbnail-hindi.png');expect((await sharp(Buffer.from(await download.arrayBuffer())).metadata()).width).toBe(1280)
  expect((await fetch(`${base}/series/missing/thumbnails/hinglish/${w.selectedThumbnail}`)).status).toBe(404)
 })
})
