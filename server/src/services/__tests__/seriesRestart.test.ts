import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

const state = vi.hoisted(() => ({ settings: new Map<string,string>(), rows: [] as any[], control: { folder:'Hero', restart:{at:123,deviceId:'nord',done:true} }, cloud: new Map<string,any>(), deletes: [] as string[], changed: [] as string[], busy:false, ackFails:false, copyFails:false }))
const db: any = {
  setting: {
    findUnique: async ({where}:any) => state.settings.has(where.key) ? {value:state.settings.get(where.key)} : null,
    upsert: async ({where,create,update}:any) => { state.settings.set(where.key,state.settings.has(where.key)?update.value:create.value) },
    deleteMany: vi.fn()
  },
  series: { findMany: async()=>state.rows,update:vi.fn() },
  chapter: { updateMany:vi.fn() },
  audioFile:{deleteMany:vi.fn()},audioSection:{deleteMany:vi.fn()},audioAnalysis:{deleteMany:vi.fn()},chapterScript:{deleteMany:vi.fn()},videoProject:{deleteMany:vi.fn()},
  editor2Timeline:{ findMany:async()=>[{chapterId:'c1',language:'en',json:'old timeline',updatedAt:new Date(0)}],upsert:vi.fn() },
  $transaction:async(work:any)=>work(db)
}
vi.mock('../../index.js',()=>({prisma:db}))
vi.mock('../libraryControls.js',()=>({libraryControls:async()=>[state.control],libraryControl:async(folder:string)=>folder==='Hero'?state.control:{folder}}))
vi.mock('../alignment/alignmentService.js',()=>({pendingAlignments:()=>0}))
vi.mock('../seriesActivity.js',()=>({seriesMutationBusy:()=>state.busy}))
vi.mock('../scriptReplacement.js',()=>({scriptReplacementBusy:()=>false}))
vi.mock('../seriesProcess.js',()=>({notifySeriesProcessChanged:vi.fn()}))
vi.mock('../productionAutomation.js',()=>({productionAutomation:{get:async()=>({job:null})}}))
vi.mock('../editor2Export.js',()=>({stopSeriesExports:()=>true}))
vi.mock('../r2Service.js',()=>({
  getR2Config:()=>({prefix:'Phone/',bucket:'test'}),phoneFolders:async()=>['Phone/'],invalidateStorage:vi.fn(),
  createClient:()=>({destroy:vi.fn(),send:async(command:any)=>{
    const input=command.input,kind=command.constructor.name
    if(kind==='ListObjectsV2Command') return {Contents:[...state.cloud].filter(([key])=>key.startsWith(input.Prefix)).map(([Key,v])=>({Key,ETag:v.etag,Size:Buffer.byteLength(v.body)}))}
    if(kind==='HeadObjectCommand') {
      const item=state.cloud.get(input.Key)
      if(!item)throw Object.assign(new Error('NotFound'),{$metadata:{httpStatusCode:404}})
      return {ContentLength:Buffer.byteLength(item.body),Metadata:item.metadata}
    }
    if(kind==='CopyObjectCommand') {
      if(state.copyFails)throw new Error('Backup copy failed')
      const source=decodeURIComponent(input.CopySource.slice('test/'.length)),item=state.cloud.get(source)
      if(!item||item.etag!==input.CopySourceIfMatch)throw new Error('Changed source')
      state.cloud.set(input.Key,{...item,metadata:input.Metadata});return {}
    }
    if(kind==='DeleteObjectCommand') {
      const item=state.cloud.get(input.Key)
      if(item&&item.etag!==input.IfMatch)throw Object.assign(new Error('Changed'),{$metadata:{httpStatusCode:412}})
      state.deletes.push(input.Key);state.cloud.delete(input.Key);return {}
    }
    if(kind==='PutObjectCommand') {
      if(input.ContentType==='application/x-series-restart-tombstone') {
        const item=state.cloud.get(input.Key)
        if(item?.etag!==input.IfMatch)throw Object.assign(new Error('Changed'),{$metadata:{httpStatusCode:412}})
        state.deletes.push(input.Key);state.cloud.set(input.Key,{etag:'"tombstone"',body:'',metadata:input.Metadata});return {}
      }
      if(state.ackFails)throw new Error('Acknowledgement failed')
      expect(state.settings.get('libraryRestartPhase:Hero:123-nord')).toBe('cloud')
      state.cloud.set(input.Key,{etag:'ack',body:input.Body});return {}
    }
    throw new Error(kind)
  }})
}))
const {applySeriesRestarts}=await import('../seriesRestart.js')
const {requireSeriesRestartReady}=await import('../seriesRestartGuard.js')
let root:string,previousRoot:string|undefined
const write=async(rel:string,text=rel)=>{const file=path.join(root,rel);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text)}
beforeEach(async()=>{
  vi.clearAllMocks();state.settings.clear();state.cloud.clear();state.deletes=[];state.busy=false;state.ackFails=false;state.copyFails=false
  state.rows=[{id:'s1',rootFolder:'Hero',aboutSummary:'old summary',videoProjects:[],chapters:[{id:'c1',folderPath:'Hero/Chapter 001',scripts:[],audioSections:[],audioFiles:[],audioAnalyses:[]}]}]
  previousRoot=process.env.DOWNLOAD_ROOT;root=await fs.mkdtemp(path.join(os.tmpdir(),'restart-service-'));process.env.DOWNLOAD_ROOT=root
  await write('Hero/Chapter 001/script.md');await write('Hero/Chapter 001/script.hi.md');await write('Hero/Chapter 001/page_001.jpg');await write('Hero/Chapter 001/crops3/crop.jpg')
  for(const key of ['Phone/scripts/Hero/Hero.zip','Phone/voiceover/Hero/Chapter 001.hi.zip','Phone/editor/Hero/Chapter 001.timeline.json','Phone/shared/scripts/Hero/Chapter 001.script.json','Phone/manhwa/Hero/Chapter 001.zip','Phone/crops/Hero/Chapter 001.zip','Phone/scripts/Hero 2/Hero 2.zip'])state.cloud.set(key,{etag:'"original"',body:key})
})
afterEach(async()=>{await fs.rm(root,{recursive:true,force:true});if(previousRoot===undefined)delete process.env.DOWNLOAD_ROOT;else process.env.DOWNLOAD_ROOT=previousRoot})
describe('coordinated restart',()=>{
 it('backs up and clears both languages and database alignment before acknowledging, leaving source and crops intact',async()=>{
  await expect(requireSeriesRestartReady('Hero')).rejects.toThrow('synchronizing')
  await applySeriesRestarts()
  expect(db.audioFile.deleteMany).toHaveBeenCalledWith({where:{chapterId:{in:['c1']}}})
  expect(db.chapterScript.deleteMany).toHaveBeenCalledOnce()
  expect(db.editor2Timeline.upsert).toHaveBeenCalledTimes(2)
  expect(db.chapter.updateMany).toHaveBeenCalledWith(expect.objectContaining({data:{completedAt:null,completedPart:null}}))
  expect(await fs.readFile(path.join(root,'.restarts/123-nord/Hero/files/Hero/Chapter 001/script.hi.md'),'utf8')).toBe('Hero/Chapter 001/script.hi.md')
  expect(await fs.readFile(path.join(root,'Hero/Chapter 001/crops3/crop.jpg'),'utf8')).toBe('Hero/Chapter 001/crops3/crop.jpg')
  for(const key of ['Phone/manhwa/Hero/Chapter 001.zip','Phone/crops/Hero/Chapter 001.zip','Phone/scripts/Hero 2/Hero 2.zip'])expect(state.cloud.has(key)).toBe(true)
  expect(state.deletes).toHaveLength(4)
  expect(state.cloud.has('Phone/restarts/Hero/123-nord/cloud/Phone/scripts/Hero/Hero.zip')).toBe(true)
  expect(JSON.parse(state.cloud.get('Phone/restarts/Hero/123-nord/ready.json').body).revision).toBe('123-nord')
  await expect(requireSeriesRestartReady('Hero','old-generation',true)).rejects.toThrow('earlier')
  expect(await requireSeriesRestartReady('Hero','123-nord',true)).toBe('123-nord')
  await write('Hero/Chapter 001/script.md','new script');await applySeriesRestarts()
  expect(db.chapterScript.deleteMany).toHaveBeenCalledOnce()
  expect(await fs.readFile(path.join(root,'Hero/Chapter 001/script.md'),'utf8')).toBe('new script')
 })
 it('waits for an in-flight import before moving any local work',async()=>{
  state.busy=true
  await expect(applySeriesRestarts()).rejects.toThrow('active desktop work')
  expect(await fs.readFile(path.join(root,'Hero/Chapter 001/script.md'),'utf8')).toBe('Hero/Chapter 001/script.md')
  expect(db.chapterScript.deleteMany).not.toHaveBeenCalled();expect(state.deletes).toEqual([])
 })
 it('never deletes a cloud object when its backup copy failed',async()=>{
  state.copyFails=true
  await expect(applySeriesRestarts()).rejects.toThrow('Backup copy failed')
  expect(state.deletes).toEqual([])
  expect(state.settings.has('libraryRestartReady:Hero')).toBe(false)
  state.copyFails=false;await applySeriesRestarts()
  expect(db.chapterScript.deleteMany).toHaveBeenCalledOnce()
 })
 it('retries a lost acknowledgement without clearing newly created files or repeating the cloud archive',async()=>{
  state.ackFails=true
  await expect(applySeriesRestarts()).rejects.toThrow('Acknowledgement failed')
  expect(state.settings.get('libraryRestartPhase:Hero:123-nord')).toBe('cloud')
  await write('Hero/Chapter 001/script.md','fresh')
  state.cloud.set('Phone/scripts/Hero/Hero.zip',{etag:'"new"',body:'fresh cloud script'})
  state.ackFails=false;await applySeriesRestarts()
  expect(db.chapterScript.deleteMany).toHaveBeenCalledOnce()
  expect(await fs.readFile(path.join(root,'Hero/Chapter 001/script.md'),'utf8')).toBe('fresh')
  expect(state.cloud.get('Phone/scripts/Hero/Hero.zip').body).toBe('fresh cloud script')
 })
})
