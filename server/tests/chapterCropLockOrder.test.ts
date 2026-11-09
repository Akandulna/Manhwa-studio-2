import {afterEach,expect,it,vi} from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
const state=vi.hoisted(()=>({capture:async():Promise<null>=>null}))
vi.mock('../src/index.js',()=>({prisma:{}}))
vi.mock('../src/services/clipper3/metadataSplit.js',()=>({captureMetadataGeometry:()=>state.capture(),recordMetadataCut:vi.fn()}))
vi.mock('../src/services/clipper3/perImageStore.js',async importOriginal=>({...await importOriginal<any>(),removeStaleOutputs:async()=>[],findUnresolvedMetadataNames:async()=>[]}))
vi.mock('../src/services/chapterPageReplacement.js',async importOriginal=>({...await importOriginal<any>(),pageReplacementActive:()=>false}))
import {runChapterCrop} from '../src/services/clipper3/chapterCrop.js'
import {withManagedChapterLock,withManagedCropWorkspaceLock,withUnmanagedCropChapter} from '../src/services/managedCropProjection.js'
let root:string|undefined
const previousRoot=process.env.DOWNLOAD_ROOT
afterEach(async()=>{if(previousRoot===undefined)delete process.env.DOWNLOAD_ROOT;else process.env.DOWNLOAD_ROOT=previousRoot;if(root)await fs.rm(root,{recursive:true,force:true})})
it('finishes a legacy cut when Editor publication reads the same chapter concurrently',async()=>{
 root=await fs.mkdtemp(path.join(os.tmpdir(),'chapter-crop-lock-'));process.env.DOWNLOAD_ROOT=root
 const folder='Fixture/Chapter 001'
 let entered!:()=>void,release!:()=>void
 const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r)
 state.capture=async()=>{entered();await gate;return withManagedCropWorkspaceLock(async()=>null)}
 const emit=vi.fn()
 const cut=runChapterCrop({emit} as any,{id:'fixture',number:1,seriesId:'fixture-series',folderPath:folder,series:{title:'Fixture'}},[])
 await started
 const publication=withManagedCropWorkspaceLock(()=>withManagedChapterLock(folder,async()=> 'published'))
 await new Promise<void>(r=>setImmediate(r))
 release()
 let timer:ReturnType<typeof setTimeout>|undefined
 try {
  const finished=await Promise.race([Promise.all([cut,publication]),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Crop/publication lock inversion')),1000)})])
  expect(finished).toEqual([undefined,'published'])
  expect(emit).toHaveBeenCalledWith('clipper3:crop-complete',expect.not.objectContaining({error:expect.anything()}))
 }finally{clearTimeout(timer)}
})

it('finishes a legacy metadata import when publication reads the same chapter concurrently',async()=>{
 root=await fs.mkdtemp(path.join(os.tmpdir(),'metadata-import-lock-'));process.env.DOWNLOAD_ROOT=root
 const folder='Fixture/Chapter 002'
 let entered!:()=>void,release!:()=>void
 const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r)
 const importing=withUnmanagedCropChapter(folder,async()=>{entered();await gate;return withManagedCropWorkspaceLock(async()=> 'imported')})
 await started
 const publication=withManagedCropWorkspaceLock(()=>withManagedChapterLock(folder,async()=> 'published'))
 await new Promise<void>(r=>setImmediate(r));release()
 let timer:ReturnType<typeof setTimeout>|undefined
 try {
  const finished=await Promise.race([Promise.all([importing,publication]),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Metadata/publication lock inversion')),1000)})])
  expect(finished).toEqual(['imported','published'])
 }finally{clearTimeout(timer)}
})
