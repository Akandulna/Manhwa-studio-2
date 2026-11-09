import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import express from 'express'
import { createServer, type Server } from 'node:http'
import { YouTubeStore } from '../youtubeStore.js'
import { parseDescriptionResponse, parseDescriptionPair, validateDescription, validateHinglishDescription, assertDescriptionOmitsSeriesNames } from '../youtubeDescriptions.js'
import { createYouTubeRouter } from '../../routes/youtube.js'
import type { YouTubeWorkspace } from '../youtubeTypes.js'
let root: string
let store: YouTubeStore
let server: Server | undefined
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-descriptions-')); store = new YouTubeStore(root) })
afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined } await fs.rm(root, { recursive: true, force: true }) })
async function selected() {
 const s = await store.openWorkspace('a')
 return store.selectTitle('a', { title: 'A Hunter Returns With a Secret', seriesName: 'Test Hunter', expectedRevision: s.titles.revision })
}
function payload(s: YouTubeWorkspace, text = 'A hunter returns with a secret advantage.\n\nFollow his journey in this English manhwa recap.') {
 const req = s.descriptions.requests.at(-1)!
 return { schemaVersion: 1, seriesId: s.seriesId, requestId: req.id, title: req.title, language: 'en', status: 'ok', description: text, hinglishDescription: 'Discover a hunter whose hidden advantage changes every encounter in this manhwa recap in Hindi.' }
}
async function imported() { const s = await selected(); return store.importDescription('a', { requestId: s.descriptions.requests[0].id, response: JSON.stringify(payload(s)), expectedRevision: s.titles.revision }) }

describe('description workflow', () => {
 it('prepares a prompt on title selection with canonical series name, exact title and instruction snapshot', async () => {
  const s = await selected();const req = s.descriptions.requests[0]
  expect(req.seriesName).toBe('Test Hunter');expect(req.title).toBe(s.selectedTitle);expect(req.prompt).toContain('Test Hunter');expect(req.prompt).toContain('shared across all parts');expect(req.prompt).toContain(req.guidelineSha256)
  const reused = await store.prepareDescription('a', 'Test Hunter', { expectedRevision: s.titles.revision, reuse: true });expect(reused).toEqual(s)
  const docs = await store.guidelines();await store.replace('description', Buffer.from('Write short factual English descriptions. Avoid invented timestamps.'), 'instructions.txt', docs.description.id)
  const updated = await store.prepareDescription('a', 'Test Hunter', { expectedRevision: s.titles.revision, reuse: true });expect(updated.descriptions.requests).toHaveLength(2);expect(updated.descriptions.requests[0].prompt).toBe(req.prompt)
 })
 it('prepares two distinct English-worded descriptions with a natural in Hindi mention', async () => {
  const s = await selected();const req = s.descriptions.requests[0]
  expect(req.outputVersion).toBe(2);expect(req.prompt).toContain('hinglishDescription');expect(req.prompt).toContain('Both descriptions are written in English');expect(req.prompt).toContain('in Hindi');expect(req.prompt).toContain(`${req.title} - Hindi`)
  const parsed = parseDescriptionPair(JSON.stringify(payload(s)),req,'a');expect(parsed.english).toBe(payload(s).description);expect(parsed.hinglish).toBe(payload(s).hinglishDescription)
  for (const value of [undefined,'No language mention here.',payload(s).description + ' in Hindi']) expect(() => validateHinglishDescription(value,payload(s).description)).toThrow()
 })
 it('saves both descriptions atomically and compares both fields for idempotent replay', async () => {
  const s = await selected();const req = s.descriptions.requests[0];const response = payload(s)
  await expect(store.importDescription('a',{requestId:req.id,response:JSON.stringify({...response,hinglishDescription:'Missing language phrase'}),expectedRevision:s.titles.revision})).rejects.toThrow('in Hindi')
  expect((await store.openWorkspace('a')).description).toBeNull()
  const next = await store.importDescription('a',{requestId:req.id,response:JSON.stringify(response),expectedRevision:s.titles.revision})
  expect(next.description).toBe(response.description);expect(next.hinglishDescription).toBe(response.hinglishDescription);expect(next.descriptions.versions[0].hinglishText).toBe(response.hinglishDescription)
  expect((await new YouTubeStore(root).openWorkspace('a')).hinglishDescription).toBe(response.hinglishDescription)
  expect(await store.importDescription('a',{requestId:req.id,response:JSON.stringify(response),expectedRevision:0})).toEqual(next)
  await expect(store.importDescription('a',{requestId:req.id,response:JSON.stringify({...response,hinglishDescription:'A different journey unfolds in Hindi.'}),expectedRevision:next.titles.revision})).rejects.toMatchObject({status:409})
 })
 it('edits either description independently, restores paired history and marks both stale after a title change', async () => {
  let s = await imported();const first = s.descriptions.versions[0];const english = s.description
  s = await store.saveDescription('a',{title:s.selectedTitle,text:'Uncover the hunter’s unusual advantage in Hindi.',variant:'hinglish',expectedRevision:s.titles.revision})
  expect(s.description).toBe(english);expect(s.hinglishDescription).toContain('Uncover');expect(s.descriptions.versions.at(-1)?.text).toBe(english)
  s = await store.saveDescription('a',{title:s.selectedTitle,text:'A completely rewritten English story introduction.',expectedRevision:s.titles.revision});expect(s.hinglishDescription).toContain('Uncover')
  s = await store.restoreDescription('a',{versionId:first.id,expectedRevision:s.titles.revision});expect(s.description).toBe(first.text);expect(s.hinglishDescription).toBe(first.hinglishText)
  s = await store.selectTitle('a',{title:'A New Title For Both Versions',expectedRevision:s.titles.revision});expect(s.descriptionNeedsUpdate).toBe(true);expect(s.hinglishDescriptionNeedsUpdate).toBe(true)
  s = await store.saveDescription('a',{title:s.selectedTitle,text:'Another revised opening for the Hindi recap in Hindi.',variant:'hinglish',expectedRevision:s.titles.revision});expect(s.hinglishDescriptionNeedsUpdate).toBe(false);expect(s.descriptionNeedsUpdate).toBe(true)
  s = await store.selectTitle('a',{title:'A Temporary Different Title',expectedRevision:s.titles.revision});s = await store.selectTitle('a',{title:'A New Title For Both Versions',expectedRevision:s.titles.revision});expect(s.descriptionNeedsUpdate).toBe(true)
 })
 it('keeps earlier English-only requests usable and prepares a new paired prompt instead of reusing them', async () => {
  let s = await selected();const oldId = s.descriptions.requests[0].id
  delete s.descriptions.requests[0].outputVersion
  const file=path.join(root,'workspaces',createHash('sha256').update('a').digest('hex')+'.json');await fs.writeFile(file,JSON.stringify(s))
  const legacy = payload(s) as any;delete legacy.hinglishDescription
  s = await store.importDescription('a',{requestId:oldId,response:JSON.stringify(legacy),expectedRevision:s.titles.revision});expect(s.description).toBe(legacy.description);expect(s.hinglishDescription).toBeNull()
  s = await store.prepareDescription('a','Test Hunter',{reuse:true,expectedRevision:s.titles.revision});expect(s.descriptions.requests.at(-1)?.outputVersion).toBe(2)
 })

 it('uses research belonging to the selected suggestion, not a newer unrelated batch', async () => {
  let s = await store.openWorkspace('a');s = await store.prepareTitles('a', 'Test Hunter', s.titles.revision)
  const req = s.titles.requests[0]
  const titles = ['Hunter Learns One Secret','A Hunter Returns Home','The Academy Rejects Its Best Hunter','One Forgotten Skill Changes Everything','A Rookie Discovers a Hidden Advantage']
  s = await store.importTitles('a', req.id, JSON.stringify({schemaVersion:1,seriesId:'a',requestId:req.id,language:'en',status:'ok',titles,research:{resolvedTitle:'Test Hunter',summary:'Verified hunter premise for this selected batch.',sources:[{title:'Official',url:'https://webtoons.com/story'},{title:'Other',url:'https://tapas.io/story'}]}}), s.titles.revision)
  s = await store.selectTitle('a',{suggestionId:s.titles.suggestions[0].id,seriesName:'Test Hunter',expectedRevision:s.titles.revision})
  expect(s.descriptions.requests[0].research?.summary).toContain('selected batch');expect(s.descriptions.requests[0].prompt).toContain('Verified hunter premise')
 })
 it('imports formatted JSON, stores history and idempotently handles the same response', async () => {
  const s = await selected();const req = s.descriptions.requests[0];const raw = JSON.stringify(payload(s),null,2).replace(/\n/g,'\\\n').replace(/^  /gm,'&#x20; ')
  const next = await store.importDescription('a',{requestId:req.id,response:raw,expectedRevision:s.titles.revision})
  expect(next.description).toContain('\n\n');expect(next.descriptions.versions).toHaveLength(1);expect(next.descriptionNeedsUpdate).toBe(false)
  expect(await store.importDescription('a',{requestId:req.id,response:raw,expectedRevision:s.titles.revision})).toEqual(next)
  await expect(store.importDescription('a',{requestId:req.id,response:JSON.stringify(payload(s,'Changed response')),expectedRevision:next.titles.revision})).rejects.toMatchObject({status:409})
  expect(await new YouTubeStore(root).openWorkspace('a')).toEqual(next)
 })
 it('retains edits, supports regeneration feedback and restores old versions without deleting newer ones', async () => {
  let s = await imported();const old = s.descriptions.versions[0]
  s = await store.saveDescription('a',{title:s.selectedTitle,text:'A revised English description.',expectedRevision:s.titles.revision});expect(s.descriptions.versions).toHaveLength(2)
  s = await store.prepareDescription('a','Test Hunter',{feedback:'Shorter opening',expectedRevision:s.titles.revision});expect(s.descriptions.requests.at(-1)?.prompt).toContain('Shorter opening');expect(s.descriptions.requests.at(-1)?.prompt).toContain('A revised English description.')
  expect(s.description).toBe('A revised English description.')
  s = await store.restoreDescription('a',{versionId:old.id,expectedRevision:s.titles.revision});expect(s.description).toBe(old.text);expect(s.descriptions.versions).toHaveLength(2)
 })
 it('preserves descriptions when title changes and rejects old-title import and stale edits', async () => {
  let s = await imported();s = await store.prepareDescription('a','Test Hunter',{expectedRevision:s.titles.revision});const old=s;const req=old.descriptions.requests.at(-1)!
  s = await store.selectTitle('a',{title:'A Different Title',seriesName:'Test Hunter',expectedRevision:s.titles.revision});expect(s.description).toBe(old.description);expect(s.descriptionNeedsUpdate).toBe(true)
  await expect(store.importDescription('a',{requestId:req.id,response:JSON.stringify(payload(old)),expectedRevision:s.titles.revision})).rejects.toThrow('selected title changed')
  await expect(store.saveDescription('a',{title:old.selectedTitle,text:'Stale text',expectedRevision:s.titles.revision})).rejects.toThrow('selected title changed')
  await expect(store.saveDescription('a',{title:s.selectedTitle,text:'Stale revision',expectedRevision:old.titles.revision})).rejects.toMatchObject({status:409})
  const revised=await store.saveDescription('a',{title:s.selectedTitle,text:s.description,expectedRevision:s.titles.revision});expect(revised.descriptionNeedsUpdate).toBe(false)
 })
 it('keeps foreign requests and versions isolated and validates response identity', async () => {
  const a=await imported();const b=await store.openWorkspace('b');const req=a.descriptions.requests[0]
  await expect(store.restoreDescription('b',{versionId:a.descriptions.versions[0].id,expectedRevision:b.titles.revision})).rejects.toMatchObject({status:404})
  await expect(store.importDescription('b',{requestId:req.id,response:JSON.stringify(payload(a)),expectedRevision:b.titles.revision})).rejects.toMatchObject({status:404})
  expect(()=>parseDescriptionResponse(JSON.stringify({...payload(a),title:'Other title'}),req,'a')).toThrow('another prompt, series, or title')
  expect(()=>parseDescriptionResponse(JSON.stringify({...payload(a),status:'unavailable',message:'Web search unavailable'}),req,'a')).toThrow('Web search unavailable')
 })
 it('requires a selected title and validates text, feedback and JSON', async () => {
  const s=await store.openWorkspace('a');await expect(store.prepareDescription('a','Test',{expectedRevision:s.titles.revision})).rejects.toThrow('Choose a title')
  const next=await selected();await expect(store.prepareDescription('a','Test',{feedback:'X'.repeat(4001),expectedRevision:next.titles.revision})).rejects.toThrow('4,000')
  for(const input of ['', 'X'.repeat(5001),'<script>','bad\u0000text']) expect(()=>validateDescription(input)).toThrow()
  expect(validateDescription(' Hello\r\n\r\nWorld ')).toBe('Hello\n\nWorld')
  const req=next.descriptions.requests[0];expect(()=>parseDescriptionResponse('bad JSON',req,'a')).toThrow('valid JSON')
 })
 it('migrates legacy description without losing earlier text or title', async () => {
  const s=await selected();const legacy={...s,description:'An earlier saved description.'} as Partial<YouTubeWorkspace>;delete legacy.descriptions
  const file=path.join(root,'workspaces',createHash('sha256').update('a').digest('hex')+'.json');await fs.writeFile(file,JSON.stringify(legacy))
  const next=await store.openWorkspace('a');expect(next.description).toBe(legacy.description);expect(next.descriptions.versions[0].source).toBe('legacy');expect(next.descriptions.versions[0].title).toBe(s.selectedTitle)
 })
 it('exposes prepare, import, edit and restore routes with series checks', async () => {
  const app=express();app.use(express.json());app.use('/api/youtube',createYouTubeRouter({store,seriesExists:async id=>id==='a',seriesTitle:async()=> 'Test Hunter'}));server=createServer(app);await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(0,'127.0.0.1',resolve)})
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/youtube/series`;const post=(url:string,body:unknown,method='POST')=>fetch(url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
  expect((await post(`${base}/missing/descriptions/prepare`,{})).status).toBe(404)
  let s=await selected();let res=await post(`${base}/a/descriptions/prepare`,{expectedRevision:s.titles.revision});expect(res.status).toBe(200);s=await res.json()
  res=await post(`${base}/a/descriptions/import`,{requestId:s.descriptions.requests.at(-1)!.id,response:JSON.stringify(payload(s)),expectedRevision:s.titles.revision});expect(res.status).toBe(200);s=await res.json();const old=s.descriptions.versions[0]
  res=await post(`${base}/a/descriptions/current`,{title:s.selectedTitle,text:'User edited description.',expectedRevision:s.titles.revision},'PUT');expect(res.status).toBe(200);s=await res.json()
  res=await post(`${base}/a/descriptions/current`,{title:s.selectedTitle,text:'A fresh English version describing this story in Hindi.',variant:'hinglish',expectedRevision:s.titles.revision},'PUT');expect(res.status).toBe(200);s=await res.json();expect(s.description).toBe('User edited description.');expect(s.hinglishDescription).toContain('in Hindi')
  res=await post(`${base}/a/descriptions/restore`,{versionId:old.id,expectedRevision:s.titles.revision});expect(res.status).toBe(200);expect((await res.json()).description).toBe(old.text)
 })
})


describe('no real series identity in publishable descriptions', () => {
 it('rejects names in prose, hashtags, translated titles, URLs and encoded text', () => {
  const names = ["I'm Gonna Annihilate This Land (Holy Hella's Ultimate End)", 'Test Hunter (테스트 헌터)']
  for (const text of [
    "Watch I'm Gonna Annihilate This Land today.", '#ImGonnaAnnihilateThisLand',
    'https://reader.test/holy-hellas-ultimate-end', 'Read 테스트 헌터 here.',
    '#ＴｅｓｔＨｕｎｔｅｒ', 'Test\u200b Hunter',
    'https://reader.test/%54%65%73%74-Hunter', "I&#39;m Gonna Annihilate This Land"
  ]) expect(() => assertDescriptionOmitsSeriesNames(text, names)).toThrow('real manhwa name')
  expect(() => assertDescriptionOmitsSeriesNames('A hunter faces impossible odds. #ManhwaRecap #Fantasy', names)).not.toThrow()
 })
 it('makes the identity rule mandatory in every new prompt and replaces reusable old prompts', async () => {
  let s = await selected();const request = s.descriptions.requests[0]
  expect(request.identityPolicy).toBe('no-series-name/1')
  expect(request.prompt).toContain('Never include the real manhwa/manhua name anywhere')
  expect(request.prompt).toContain('abbreviations');expect(request.prompt).toContain('URLs')
  delete request.identityPolicy
  const file = path.join(root, 'workspaces', createHash('sha256').update('a').digest('hex') + '.json')
  await fs.writeFile(file, JSON.stringify(s))
  s = await store.prepareDescription('a', 'Test Hunter', { reuse: true, expectedRevision: s.titles.revision })
  expect(s.descriptions.requests).toHaveLength(2)
  expect(s.descriptions.requests.at(-1)?.identityPolicy).toBe('no-series-name/1')
 })
 it('rejects a leak in either generated language without importing the other half', async () => {
  const s = await selected();const request = s.descriptions.requests[0]
  for (const response of [{ ...payload(s), description: 'Watch Test Hunter. #Manhwa' },
    { ...payload(s), hinglishDescription: 'Discover a secret in Hindi. #TestHunter' }]) {
    await expect(store.importDescription('a', { requestId: request.id, response: JSON.stringify(response), expectedRevision: s.titles.revision })).rejects.toThrow('real manhwa name')
    const unchanged = await store.openWorkspace('a')
    expect(unchanged.description).toBeNull();expect(unchanged.hinglishDescription).toBeNull()
    expect(unchanged.descriptions.versions).toHaveLength(0)
  }
 })
 it('checks the researched alternate name as well as the library name', async () => {
  const s = await selected();const request = s.descriptions.requests[0]
  request.research = { resolvedTitle: "Test Hunter (Hidden Hunter's Return)", summary: 'Verified hunter premise.', sources: [] }
  expect(() => parseDescriptionPair(JSON.stringify(payload(s, 'Watch #HiddenHuntersReturn.')), request, 'a')).toThrow('real manhwa name')
 })
 it('rejects manual edits and contaminated history restores while retaining current safe text', async () => {
  const s = await imported()
  for (const variant of ['en', 'hinglish'] as const) await expect(store.saveDescription('a', {
    title: s.selectedTitle, text: 'Follow Test Hunter in Hindi. #TestHunter', variant, expectedRevision: s.titles.revision
  })).rejects.toThrow('real manhwa name')
  const version = { ...s.descriptions.versions[0], id: 'old-leaking', text: 'Read Test Hunter.', hinglishText: 'Explore Test Hunter in Hindi.' }
  s.descriptions.versions.push(version)
  await fs.writeFile(path.join(root, 'workspaces', createHash('sha256').update('a').digest('hex') + '.json'), JSON.stringify(s))
  await expect(store.restoreDescription('a', { versionId: version.id, expectedRevision: s.titles.revision })).rejects.toThrow('real manhwa name')
  expect((await store.openWorkspace('a')).description).toBe(s.description)
 })
})
