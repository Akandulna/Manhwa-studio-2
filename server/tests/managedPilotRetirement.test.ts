import {afterEach,describe,it,expect,vi} from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {createHash} from 'node:crypto'
const state=vi.hoisted(()=>({binding:null as any}))
vi.mock('../src/services/managedCropProjection.js',()=>({managedCropBinding:async()=>state.binding,withManagedCropWorkspaceLock:async(f:any)=>f(),withManagedChapterLock:async(_s:any,f:any)=>f()}))
vi.mock('../src/services/managedCropEvents.js',()=>({managedCropProjectionChanged:vi.fn()}))
import {retireUnsentPilot} from '../src/services/managedPilotRetirement.js'
let root:string
async function fixture(){
 root=await fs.mkdtemp(path.join(os.tmpdir(),'retire-pilot-'));process.env.DOWNLOAD_ROOT=root
 const dir=path.join(root,'Series/Chapter 001');await fs.mkdir(path.join(dir,'.managed-crops'),{recursive:true});await fs.writeFile(path.join(dir,'page.jpg'),'source')
 const hash=createHash('sha256').update('source').digest('hex')
 const task:any={id:'task',workspaceId:'w',seriesId:'s',chapterId:'c',pageId:'p',fingerprint:'f',state:'cancelled',canonical:null,attemptId:'a',generation:1,spec:{dependencies:[{sha256:hash}]}}
 state.binding={filename:'page.jpg',destination:'/private/artifacts',task}
 await fs.writeFile(path.join(dir,'.managed-crops/page.json'),JSON.stringify(state.binding))
 const timeline:any={task,artifactReady:false,attempt:{id:'a',taskId:'task',generation:1,phase:'stop_confirmed',submission:'unsent',checkpointRef:null,activeCommandId:'stop'},commands:[{id:'stop',action:'stop',phase:'stop_confirmed',taskId:'task',attemptId:'a',generation:1,fingerprint:'f'}]}
 const authority:any={timeline:vi.fn(async()=>timeline)}
 return {dir,timeline,authority,run:()=>retireUnsentPilot('Series/Chapter 001','page.jpg','task',authority)}
}
afterEach(async()=>{if(root)await fs.rm(root,{recursive:true,force:true});state.binding=null})
describe('unsent pilot retirement',()=>{
 it('retains binding and proof, preserves source and crops, and replays without dispatch',async()=>{
  const e=await fixture();await fs.mkdir(path.join(e.dir,'crops3'));await fs.writeFile(path.join(e.dir,'crops3/crop.png'),'crop')
  const receipt=await e.run();expect(receipt.taskId).toBe('task')
  expect(await fs.readFile(path.join(e.dir,'crops3/crop.png'),'utf8')).toBe('crop')
  expect(await fs.readFile(path.join(e.dir,'page.jpg'),'utf8')).toBe('source')
  expect(await fs.stat(path.join(e.dir,'.managed-crops/page.json')).catch(()=>null)).toBeNull()
  expect(JSON.parse(await fs.readFile(path.join(e.dir,'.managed-crops/retired/page.binding'),'utf8')).task.id).toBe('task')
  state.binding=null;expect(await e.run()).toEqual(receipt)
 })
 it.each(['paused','uncertain','verified_complete'])('rejects nonterminal owner %s',async status=>{const e=await fixture();e.timeline.task.state=status;await expect(e.run()).rejects.toThrow('Cancel and acknowledge');expect(await fs.stat(path.join(e.dir,'.managed-crops/page.json'))).toBeTruthy()})
 it.each(['unknown','submitted','saved'])('rejects %s provider outcomes',async submission=>{const e=await fixture();e.timeline.attempt.submission=submission;await expect(e.run()).rejects.toThrow()})
 it('rejects missing acknowledgment, retained artifacts, changed source and foreign binding',async()=>{
  const e=await fixture();e.timeline.commands[0].phase='queued';await expect(e.run()).rejects.toThrow('acknowledgment');e.timeline.commands[0].phase='stop_confirmed'
  e.timeline.artifactReady=true;await expect(e.run()).rejects.toThrow();e.timeline.artifactReady=false
  e.timeline.attempt.checkpointRef='checkpoint';await expect(e.run()).rejects.toThrow();e.timeline.attempt.checkpointRef=null
  await fs.writeFile(path.join(e.dir,'page.jpg'),'changed');await expect(e.run()).rejects.toThrow('Source changed')
  await expect(retireUnsentPilot('Series/Chapter 001','page.jpg','foreign',e.authority)).rejects.toThrow('binding changed')
 })
})
