import express from 'express'
import { createServer, type Server } from 'node:http'
import { createYouTubeRouter } from '../../routes/youtube.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { YouTubeAutomation, type YouTubeTransport, type YouTubeJob } from '../youtubeAutomation.js'
import { YouTubeStore } from '../youtubeStore.js'
let root:string,store:YouTubeStore,automation:YouTubeAutomation,transport:YouTubeTransport
let result:unknown|null
let http:Server|undefined
beforeEach(async()=>{
 root=await fs.mkdtemp(path.join(os.tmpdir(),'youtube-automation-test-'));store=new YouTubeStore(path.join(root,'workspace'));result=null
 transport={phones:vi.fn(async()=>[{id:'phone',name:'Test phone',ready:true,reason:'',prefix:'Manhwa/'}]),put:vi.fn(async()=>{}),get:vi.fn(async()=>result),start:vi.fn(async()=>{})}
 automation=new YouTubeAutomation(store,transport,path.join(root,'jobs'))
})
afterEach(async()=>{if(http){http.closeAllConnections();await new Promise<void>(resolve=>http!.close(()=>resolve()));http=undefined}vi.useRealTimers();await fs.rm(root,{recursive:true,force:true})})
async function prepared(id='series') {const w=await store.openWorkspace(id);return store.prepareTitles(id,'Test Hunter',w.titles.revision)}
async function titleJob(id='series') {const w=await prepared(id);const job=await automation.start(id,'titles',{device:'phone',requestId:w.titles.requests.at(-1)!.id,expectedRevision:w.titles.revision});return {w,job}}
function envelope(job:YouTubeJob,response:string) {return {schema:job.schema,id:job.id,seriesId:job.seriesId,requestId:job.requestId,kind:job.kind,device:job.device,status:'ok',response}}
function titles(job:YouTubeJob) {return JSON.stringify({schemaVersion:1,seriesId:job.seriesId,requestId:job.requestId,language:'en',status:'ok',research:{resolvedTitle:'Test Hunter',summary:'A rookie hunter discovers a secret talent that changes his life.',sources:[{title:'Publisher',url:'https://webtoons.com/test-hunter'},{title:'Second source',url:'https://tapas.io/test-hunter'}]},titles:['A Rookie Hunter Learns the Secret Behind His Hidden Talent','Everyone Ignored the Hunter Until His Hidden Power Awakened','His Rivals Never Knew He Could Copy Their Greatest Skills','The Academy’s Weakest Hunter Discovers a Forgotten Power','They Left Him Behind Until His Hidden Talent Changed Everything']})}
describe('YouTube phone automation',()=>{
 it('sends the exact prepared prompt once and retains all request identity',async()=>{
  const {w,job}=await titleJob();const repeat=await automation.start(w.seriesId,'titles',{device:'phone',requestId:job.requestId,expectedRevision:w.titles.revision})
  expect(repeat.id).toBe(job.id);expect(transport.start).toHaveBeenCalledTimes(1);expect(transport.put).toHaveBeenCalledWith(`Manhwa/youtube/jobs/${job.id}.json`,expect.objectContaining({prompt:w.titles.requests[0].prompt,device:'phone',requestId:job.requestId,kind:'titles'}))
 })
 it('returns validated five-title suggestions without selecting a title',async()=>{
  const {job}=await titleJob();result=envelope(job,titles(job));expect((await automation.check(job.seriesId,job.id)).status).toBe('done')
  const w=await store.openWorkspace(job.seriesId);expect(w.titles.suggestions).toHaveLength(5);expect(w.selectedTitle).toBeNull()
  await automation.check(job.seriesId,job.id);expect((await store.openWorkspace(job.seriesId)).titles.suggestions).toHaveLength(5)
 })
 it('generates and imports both descriptions for the exact selected title',async()=>{
  let w=await store.openWorkspace('series');w=await store.selectTitle('series',{title:'A Hunter Returns With a Secret',seriesName:'Test Hunter',expectedRevision:w.titles.revision})
  const req=w.descriptions.requests[0];const job=await automation.start('series','descriptions',{device:'phone',requestId:req.id,expectedRevision:w.titles.revision})
  result=envelope(job,JSON.stringify({schemaVersion:1,seriesId:w.seriesId,requestId:req.id,language:'en',status:'ok',title:req.title,description:'A hunter returns with a secret advantage. Follow his story in this English manhwa recap.',hinglishDescription:'Discover a hidden talent that transforms each encounter. Watch the hunter’s journey in Hindi.'}))
  expect((await automation.check('series',job.id)).status).toBe('done');w=await store.openWorkspace('series');expect(w.description).toContain('English manhwa');expect(w.hinglishDescription).toContain('in Hindi')
 })
 it('rejects cross-series jobs and wrong-device results before any import',async()=>{
  const {job}=await titleJob();await expect(automation.check('other',job.id)).rejects.toMatchObject({status:404})
  result={...envelope(job,titles(job)),device:'other'};expect((await automation.check(job.seriesId,job.id)).status).toBe('needs_attention');expect((await store.openWorkspace(job.seriesId)).titles.suggestions).toHaveLength(0)
 })
 it('keeps the response for manual import when the workspace changes',async()=>{
  const {job,w}=await titleJob();await store.selectTitle(w.seriesId,{title:'My chosen custom title',expectedRevision:w.titles.revision})
  result=envelope(job,titles(job));const checked=await automation.check(job.seriesId,job.id);expect(checked.status).toBe('needs_attention');expect(checked.response).toBe(titles(job));expect((await store.openWorkspace(job.seriesId)).selectedTitle).toBe('My chosen custom title')
 })
 it('blocks stale requests, unsupported phones and concurrent work on one phone',async()=>{
  const w=await prepared();await expect(automation.start('series','titles',{device:'phone',requestId:w.titles.requests[0].id,expectedRevision:0})).rejects.toMatchObject({status:409})
  vi.mocked(transport.phones).mockResolvedValueOnce([{id:'phone',name:'Old phone',ready:false,reason:'Update Sleeper Cell',prefix:''}]);await expect(automation.start('series','titles',{device:'phone',requestId:w.titles.requests[0].id,expectedRevision:w.titles.revision})).rejects.toThrow('Update Sleeper Cell')
  await automation.start('series','titles',{device:'phone',requestId:w.titles.requests[0].id,expectedRevision:w.titles.revision});const other=await prepared('other');await expect(automation.start('other','titles',{device:'phone',requestId:other.titles.requests[0].id,expectedRevision:other.titles.revision})).rejects.toThrow('already has')
 })
 it('retains uncertain delivery without silently resubmitting',async()=>{
  vi.mocked(transport.start).mockRejectedValueOnce(new Error('Connection lost'));const {w,job}=await titleJob();expect(job.status).toBe('needs_attention')
  await automation.start('series','titles',{device:'phone',requestId:job.requestId,expectedRevision:w.titles.revision});expect(transport.start).toHaveBeenCalledTimes(1)
 })
 it('survives service restart and bounds result polling',async()=>{
  const {job}=await titleJob();const restarted=new YouTubeAutomation(store,transport,path.join(root,'jobs'));expect((await restarted.latest('series','titles',job.requestId))?.id).toBe(job.id)
  await restarted.check('series',job.id);await restarted.check('series',job.id);expect(transport.get).toHaveBeenCalledTimes(1)
 })
 it('rejects invalid JSON without changing saved titles and exposes the returned text',async()=>{
  const {job}=await titleJob();result=envelope(job,'not valid JSON');const checked=await automation.check('series',job.id);expect(checked.status).toBe('needs_attention');expect(checked.response).toBe('not valid JSON');expect((await store.openWorkspace('series')).titles.suggestions).toHaveLength(0)
 })
 it('exposes series-scoped HTTP start, latest and result checks with phone selection',async()=>{
  const {job}=await titleJob();const app=express();app.use(express.json());app.use('/api/youtube',createYouTubeRouter({store,automation,seriesExists:async id=>id==='series'}));http=createServer(app)
  await new Promise<void>(resolve=>http!.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${(http.address() as {port:number}).port}/api/youtube`
  const phones=await(await fetch(base+'/automation/phones')).json();expect(phones).toEqual([{id:'phone',name:'Test phone',ready:true,reason:''}])
  expect((await fetch(base+`/series/other/automation/jobs/${job.id}/check`,{method:'POST'})).status).toBe(404)
  const latest=await(await fetch(base+`/series/series/automation/titles/latest?requestId=${job.requestId}`)).json();expect(latest.id).toBe(job.id)
  result=envelope(job,titles(job));const checked=await(await fetch(base+`/series/series/automation/jobs/${job.id}/check`,{method:'POST'})).json();expect(checked.status).toBe('done')
 })
 it('resumes importing a durably saved response after an interrupted check',async()=>{
  const {job}=await titleJob();job.response=titles(job);await fs.writeFile(path.join(root,'jobs',job.id+'.json'),JSON.stringify(job))
  const restarted=new YouTubeAutomation(store,transport,path.join(root,'jobs'));expect((await restarted.check('series',job.id)).status).toBe('done');expect(transport.get).not.toHaveBeenCalled()
 })

 it('allows a new prepared request after the phone explicitly reports an ended failure',async()=>{
  const {job,w}=await titleJob();result={...envelope(job,''),status:'error',error:'Prompt paste failed before Send'}
  expect((await automation.check('series',job.id)).phoneFailed).toBe(true)
  const next=await store.prepareTitles('series','Test Hunter',w.titles.revision)
  const fresh=await automation.start('series','titles',{device:'phone',requestId:next.titles.requests.at(-1)!.id,expectedRevision:next.titles.revision})
  expect(fresh.id).not.toBe(job.id);expect(transport.start).toHaveBeenCalledTimes(2)
 })

})
