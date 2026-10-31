import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {promises as fs} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const state=vi.hoisted(()=>({images:vi.fn(),download:vi.fn(),store:vi.fn(),note:vi.fn(),update:vi.fn(),updateMany:vi.fn(),pageUpdate:vi.fn()}))
vi.mock('../src/index.js',()=>({prisma:{chapter:{update:state.update,updateMany:state.updateMany},page:{upsert:vi.fn(async()=>({})),findUnique:vi.fn(async()=>null),update:state.pageUpdate,count:vi.fn(async()=>0)}}}))
vi.mock('../src/services/scraper.js',()=>({getChapterImages:state.images}))
vi.mock('../src/services/imageDownload.js',()=>({downloadImage:state.download}))
vi.mock('../src/services/pageImageStore.js',()=>({storePageImage:state.store}))
vi.mock('../src/services/phoneSend.js',()=>({flushAutoSend:vi.fn(),noteChapterDownloaded:state.note}))
vi.mock('../src/services/seriesProcess.js',()=>({notifySeriesProcessChanged:vi.fn()}))
import {DownloadManager} from '../src/services/downloadManager.js'
let directory:string,previousRoot:string|undefined
beforeEach(async()=>{
 vi.clearAllMocks();directory=await fs.mkdtemp(path.join(os.tmpdir(),'download-manager-owner-'));previousRoot=process.env.DOWNLOAD_ROOT;process.env.DOWNLOAD_ROOT=directory
 state.update.mockResolvedValue({});state.updateMany.mockResolvedValue({count:1});state.pageUpdate.mockResolvedValue({})
 state.images.mockResolvedValue({images:[{src:'https://fixture.invalid/image.png'}]})
 state.store.mockResolvedValue({path:path.join(directory,'series/chapter/page_001.webp'),bytes:5})
 state.download.mockResolvedValue(5)
})
afterEach(async()=>{if(previousRoot===undefined)delete process.env.DOWNLOAD_ROOT;else process.env.DOWNLOAD_ROOT=previousRoot;await fs.rm(directory,{recursive:true,force:true})})
const task={chapterId:'chapter',seriesId:'series',chapterNumber:1,sourceUrl:'https://fixture.invalid/chapter',folderPath:'series/chapter',seriesTitle:'Fixture'}
const manager=()=>new DownloadManager({emit:vi.fn()} as any)
describe('production download manager cancellation owns the request signal',()=>{
 it('cancelSeries aborts the active request and skips failure/import/completion work',async()=>{
  const m=manager();let started!:()=>void;const ready=new Promise<void>(resolve=>started=resolve);let signal:AbortSignal|undefined
  state.download.mockImplementation(async(_u,_d,_r,options)=>{signal=options.signal;started();await new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>{const e=new Error('cancelled');e.name='AbortError';reject(e)},{once:true}))})
  const running=(m as any).downloadChapter(task);await ready;await m.cancelSeries('series');await running
  expect(signal?.aborted).toBe(true);expect(state.pageUpdate).not.toHaveBeenCalled();expect(state.store).not.toHaveBeenCalled();expect(state.note).not.toHaveBeenCalled()
  expect(state.updateMany).toHaveBeenCalledWith({where:{id:'chapter'},data:{status:'skipped'}})
 })
 it('shutdown aborts active I/O and preserves pending status instead of marking a cancelled page failed',async()=>{
  const m=manager();let started!:()=>void;const ready=new Promise<void>(resolve=>started=resolve)
  state.download.mockImplementation(async(_u,_d,_r,options)=>{started();await new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}))})
  const running=(m as any).downloadChapter(task);await ready;await m.shutdown();await running
  expect(state.pageUpdate).not.toHaveBeenCalled();expect(state.note).not.toHaveBeenCalled()
  expect(state.updateMany).toHaveBeenCalledWith({where:{status:{in:['downloading','queued']}},data:{status:'pending'}})
 })
 it('cancellation while scraping prevents the subsequent download request',async()=>{
  const m=manager();let scraped!:(value:any)=>void;state.images.mockImplementation(()=>new Promise(resolve=>scraped=resolve))
  const running=(m as any).downloadChapter(task)
  await vi.waitFor(()=>expect(state.images).toHaveBeenCalled())
  const cancelling=m.cancelSeries('series');scraped({images:[{src:'https://fixture.invalid/image'}]});await Promise.all([running,cancelling])
  expect(state.download).not.toHaveBeenCalled();expect(state.note).not.toHaveBeenCalled()
 })
 it('shutdown during initial status persistence does not start scraping afterwards',async()=>{
  const m=manager();let finish!:(value:any)=>void
  state.update.mockImplementationOnce(()=>new Promise(resolve=>finish=resolve))
  const running=(m as any).downloadChapter(task);await vi.waitFor(()=>expect(state.update).toHaveBeenCalled())
  await m.shutdown();finish({});await running
  expect(state.images).not.toHaveBeenCalled();expect(state.download).not.toHaveBeenCalled();expect(state.note).not.toHaveBeenCalled()
 })
 it('cancellation during image conversion prevents subsequent page/completion publication',async()=>{
  const m=manager();let finish!:(value:any)=>void
  state.store.mockImplementationOnce(()=>new Promise(resolve=>finish=resolve))
  const running=(m as any).downloadChapter(task);await vi.waitFor(()=>expect(state.store).toHaveBeenCalled())
  const cancelling=m.cancelSeries('series');finish({path:'fixture.webp',bytes:5});await Promise.all([running,cancelling])
  expect(state.pageUpdate).not.toHaveBeenCalled();expect(state.note).not.toHaveBeenCalled()
 })
 it('cancellation during final chapter persistence cannot start completion autosend afterwards',async()=>{
  const m=manager();let finish!:(value:any)=>void
  state.update.mockImplementation(async operation=>{
   if(operation.data.status==='done')return new Promise(resolve=>finish=resolve)
   return {}
  })
  const running=(m as any).downloadChapter(task);await vi.waitFor(()=>expect(finish).toBeTypeOf('function'))
  const cancelling=m.cancelSeries('series');finish({});await Promise.all([running,cancelling])
  expect(state.note).not.toHaveBeenCalled();expect(m.getQueueStatus().completed).toBe(0)
 })
 it('retains ordinary successful chapter storage and completion behavior',async()=>{
  const m=manager();await (m as any).downloadChapter(task)
  expect(state.download).toHaveBeenCalledWith('https://fixture.invalid/image.png',expect.any(String),task.sourceUrl,{signal:expect.any(AbortSignal)})
  expect(state.store).toHaveBeenCalledTimes(1);expect(state.note).toHaveBeenCalledWith('series')
  expect(state.update).toHaveBeenLastCalledWith({where:{id:'chapter'},data:{status:'done',downloadedCount:1,error:null}})
 })
})
