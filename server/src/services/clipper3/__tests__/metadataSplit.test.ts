import {describe,it,expect,beforeEach,afterEach,vi} from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import sharp from 'sharp'
import {syncChapterProcessed,getProcessedDir} from '../processedSync.js'
import {readImagePoints,readImageMetadata,writeImagePoints,getSourceFolderPath} from '../perImageStore.js'
import {readChapterCropState} from '../chapterCrop.js'
import {cutImageCrops} from '../perImageCrop.js'
import {setDesktopReview} from '../chapterReview.js'
import {recordMetadataCut,captureMetadataGeometry,currentMetadataJobs,pixelBounds,validateMetadataResult,importMetadataResult,requireCurrentSplitMetadata} from '../metadataSplit.js'
import {sha256} from '../studioCropAuthorityModel.js'

vi.mock('../../seriesRestartGuard.js',()=>({requireSeriesRestartReady:async()=>null}))
vi.mock('../../chapterPageReplacement.js',()=>({readPageReplacement:async()=>null,pageReplacementActive:()=>false}))
vi.mock('../../editorAutoPublish.js',()=>({queueEditorPublish:vi.fn()}))

let root:string,old:string|undefined
const folder='Series/Chapter 001',page='page_001.png'
const chapter={id:'c1',number:1,folderPath:folder,seriesId:'s1',series:{title:'Series'}}
const crop={id:'crop-01',reason:'panel',crop:{mode:'rectangle' as const,points:[{id:'P1',x:0,y:0},{id:'P2',x:1,y:0},{id:'P3',x:1,y:0.5},{id:'P4',x:0,y:0.5}]}}
async function pointers(){return {format:'four-point-crop',version:'1.0',coordinateSystem:'normalized',image:{filename:page,width:100,height:200},crops:[crop],workflow:'clipper-geometry/1' as const,sourceSha256:sha256(await fs.readFile(path.join(root,folder,page)))}}
beforeEach(async()=>{old=process.env.DOWNLOAD_ROOT;root=await fs.mkdtemp(path.join(os.tmpdir(),'metadata-split-'));process.env.DOWNLOAD_ROOT=root
  await fs.mkdir(path.join(root,folder),{recursive:true});await sharp({create:{width:100,height:200,channels:3,background:'#336699'}}).png().toFile(path.join(root,folder,page))
  await fs.writeFile(path.join(root,folder,'script.md'),'The traveller finds a sword.')})
afterEach(async()=>{if(old===undefined)delete process.env.DOWNLOAD_ROOT;else process.env.DOWNLOAD_ROOT=old;await fs.rm(root,{recursive:true,force:true})})

describe('pointer-only clipping and approved Metadata handoff',()=>{
 it('imports geometry without metadata and makes it cuttable without claiming metadata readiness',async()=>{
  const dir=path.join(getProcessedDir(folder),'page_001');await fs.mkdir(dir,{recursive:true})
  await fs.writeFile(path.join(dir,'crop-pointers-ch001-p001.json'),JSON.stringify(await pointers()))
  const result=await syncChapterProcessed({chapterId:'c1',chapterNumber:1,folderPath:folder,seriesSlug:'series',images:[{filename:page,width:100,height:200}]})
  expect(result.imported).toBe(1);expect(await readImageMetadata(folder,page)).toBeNull()
  expect((await readChapterCropState(chapter)).targets).toHaveLength(1)
  await expect(currentMetadataJobs(chapter,{restartRevision:null,pageRevision:null})).rejects.toThrow(/review/i)
 })
 it('creates only JSON jobs after explicit review and verified cut and rejects changed cut bytes',async()=>{
  await writeImagePoints(folder,page,await pointers());await setDesktopReview(folder,true)
  const baseline=await captureMetadataGeometry(chapter)
  await cutImageCrops({folderPath:folder,imageFilename:page,crops:[crop],slug:'series'})
  await recordMetadataCut(chapter,baseline)
  const result=await currentMetadataJobs(chapter,{restartRevision:null,pageRevision:null})
  const job=result.jobs[0],payload=JSON.parse(job.payloadText)
  expect(payload.crops[0].bounds).toEqual({x0:0,y0:0,x1:100,y1:100})
  expect(payload.expectedPages).toEqual([page]);expect(job.revision).toBe(sha256(job.payloadText))
  expect(payload).not.toHaveProperty('images');expect(payload).not.toHaveProperty('metadataText')
  await fs.appendFile(path.join(getSourceFolderPath(folder),'crops3',payload.crops[0].exportedFilename),'tamper')
  await expect(currentMetadataJobs(chapter,{restartRevision:null,pageRevision:null})).rejects.toThrow(/bytes changed/)
 })
 it('rejects approval/geometry changes after the cut and matches minmax rounding for perspective points',async()=>{
  await writeImagePoints(folder,page,await pointers());await setDesktopReview(folder,true)
  const baseline=await captureMetadataGeometry(chapter)
  await cutImageCrops({folderPath:folder,imageFilename:page,crops:[crop],slug:'series'})
  await recordMetadataCut(chapter,baseline)
  const p=await pointers();p.crops[0]={...crop,reason:'changed'};await writeImagePoints(folder,page,p)
  await expect(currentMetadataJobs(chapter,{restartRevision:null,pageRevision:null})).rejects.toThrow(/review|changed/)
  await expect(recordMetadataCut(chapter)).rejects.toThrow(/review/)
  expect(pixelBounds({...crop,crop:{mode:'perspective',points:[{id:'a',x:-0.1,y:0.2},{id:'b',x:0.9,y:0.3},{id:'c',x:0.8,y:0.8},{id:'d',x:0.1,y:0.7}]}},100,200)).toEqual({x0:0,y0:40,x1:90,y1:160})
 })
})

async function reviewedJob(empty=false) {
  const points=await pointers();if(empty)points.crops=[]
  await writeImagePoints(folder,page,points);await setDesktopReview(folder,true)
  const baseline=await captureMetadataGeometry(chapter)
  await cutImageCrops({folderPath:folder,imageFilename:page,crops:points.crops,slug:'series'})
  await recordMetadataCut(chapter,baseline)
  return (await currentMetadataJobs(chapter,{restartRevision:null,pageRevision:null})).jobs[0]
}
function result(job:{revision:string;payloadText:string}) {
  const p=JSON.parse(job.payloadText)
  return JSON.stringify({metadataJob:{schema:'sleeper-cell-metadata/1',revision:job.revision,cutRevision:p.cutRevision},
    storyLinking:{schema_version:'crop-script-links/1',inputRevision:job.revision,sourceSha256:p.sourceSha256,scriptSha256:p.scriptSha256,scriptSegments:[{id:'P0001',text:'The traveller finds a sword.'}]},
    crops:p.crops.map((c:any)=>({id:c.id,exportedFilename:c.exportedFilename,description:'A traveller holds a sword.',storyContext:'Finding the sword.',scriptRefs:['P0001'],matchType:'direct',evidence:'The sword is visible.',reviewReason:''}))})
}
describe('Metadata-only return',()=>{
 it('attaches idempotently without changing approved pointers, review or crop bytes',async()=>{
  const job=await reviewedJob(),p=JSON.parse(job.payloadText)
  const points=JSON.stringify(await readImagePoints(folder,page))
  const review=await fs.readFile(path.join(root,folder,'.clipper3-review.json'),'utf8')
  const file=path.join(root,folder,'crops3',p.crops[0].exportedFilename),bytes=await fs.readFile(file)
  expect(await importMetadataResult(chapter,page,result(job))).toBe(true)
  expect(await importMetadataResult(chapter,page,result(job))).toBe(false)
  expect(JSON.stringify(await readImagePoints(folder,page))).toBe(points)
  expect(await fs.readFile(path.join(root,folder,'.clipper3-review.json'),'utf8')).toBe(review)
  expect(await fs.readFile(file)).toEqual(bytes)
  expect(await requireCurrentSplitMetadata(chapter)).toBe(true)
  await fs.writeFile(path.join(root,folder,'script.md'),'The chapter script changed.')
  await expect(importMetadataResult(chapter,page,result(job))).rejects.toThrow(/Stale/)
  await expect(requireCurrentSplitMetadata(chapter)).rejects.toThrow(/Stale/)
 })
 it('rejects changed inventory and fabricated script references',async()=>{
  const job=await reviewedJob(),script='The traveller finds a sword.'
  const wrong=JSON.parse(result(job));wrong.crops[0].exportedFilename='invented.png'
  expect(()=>validateMetadataResult(JSON.stringify(wrong),job,script)).toThrow(/inventory/)
  const invented=JSON.parse(result(job));invented.crops[0].scriptRefs=['P9999']
  expect(()=>validateMetadataResult(JSON.stringify(invented),job,script)).toThrow(/associations/)
  await setDesktopReview(folder,false)
  await expect(importMetadataResult(chapter,page,result(job))).rejects.toThrow(/review/)
 })
 it('handles reviewed empty pages without inventing image or metadata entries',async()=>{
  const job=await reviewedJob(true),payload=JSON.parse(job.payloadText)
  expect(payload.crops).toEqual([])
  expect(validateMetadataResult(result(job),job,'The traveller finds a sword.').crops).toEqual([])
  expect(await importMetadataResult(chapter,page,result(job))).toBe(true)
 })
})
