import fs from 'node:fs/promises'
import path from 'node:path'
import {constants} from 'node:fs'
import {randomUUID} from 'node:crypto'
import {TaskConflict,canonicalJson} from './managedTaskProtocol.js'

export interface Boundary {id:string;left:number;top:number;right:number;bottom:number}
export interface BoundaryFeedback {schema:'managed-boundary-feedback/1';id:string;previousId:string|null;taskId:string;revision:string;savedAt:string;note:string;bounds:Boundary[];changes:{cropId:string;before:Boundary;after:Boundary|null}[]}
export function cropBounds(pointers:any):Boundary[] {
 return pointers.crops.map((c:any)=>({id:c.id,left:Math.min(...c.crop.points.map((p:any)=>p.x)),top:Math.min(...c.crop.points.map((p:any)=>p.y)),right:Math.max(...c.crop.points.map((p:any)=>p.x)),bottom:Math.max(...c.crop.points.map((p:any)=>p.y))}))
}
/** Accept only existing crop IDs and nonempty source pixel rectangles; removals are explicit. */
export function boundaryChanges(pointers:any,value:unknown) {
 const original=cropBounds(pointers),ids=new Set(original.map(b=>b.id))
 if(!Array.isArray(value)||value.length>original.length)throw new TaskConflict('Choose boundaries for existing crops only')
 const bounds:Boundary[]=[],seen=new Set<string>()
 for(const b of value){
  if(!b||Object.keys(b).sort().join(',')!=='bottom,id,left,right,top'||!ids.has(b.id)||seen.has(b.id)||!['left','top','right','bottom'].every(k=>typeof b[k]==='number'&&Number.isFinite(b[k])&&b[k]>=0&&b[k]<=1)||b.left>=b.right||b.top>=b.bottom||Math.round(b.left*pointers.image.width)>=Math.round(b.right*pointers.image.width)||Math.round(b.top*pointers.image.height)>=Math.round(b.bottom*pointers.image.height))throw new TaskConflict('Invalid or empty crop boundary')
  seen.add(b.id);bounds.push({id:b.id,left:b.left,top:b.top,right:b.right,bottom:b.bottom})
 }
 const ordered=original.filter(b=>seen.has(b.id)).map(b=>bounds.find(v=>v.id===b.id)!)
 const changes=original.flatMap(before=>{const after=ordered.find(b=>b.id===before.id)??null;return canonicalJson(before)===canonicalJson(after)?[]:[{cropId:before.id,before,after}]})
 return {bounds:ordered,changes}
}
export async function readBoundaryFeedback(directory:string):Promise<BoundaryFeedback|null> {
 let h
 try{h=await fs.open(path.join(directory,'boundary-feedback-v1.json'),constants.O_RDONLY|constants.O_NOFOLLOW)}catch(e:any){if(e.code==='ENOENT')return null;throw e}
 try{const st=await h.stat();if(!st.isFile()||st.size>512000)throw new TaskConflict('Invalid boundary feedback file');const v=JSON.parse(await h.readFile('utf8'));if(v?.schema!=='managed-boundary-feedback/1'||typeof v.id!=='string'||!Array.isArray(v.changes)||!Array.isArray(v.bounds))throw new TaskConflict('Invalid boundary feedback');return v}finally{await h.close()}
}
export async function assertNoBoundaryChanges(directory:string,revision:string) {
 const f=await readBoundaryFeedback(directory)
 if(f&&f.revision===revision&&f.changes.length)throw new TaskConflict('Manual boundary feedback is pending. Apply and review the adjusted crops before approving or cutting.')
}
/** Caller holds the same workspace/chapter lock as review/cut. History never overwrites provider artifacts. */
export async function saveBoundaryFeedback(directory:string,input:{revision:string;taskId:string;pointers:any},expectedId:unknown,value:unknown,note:unknown) {
 const previous=await readBoundaryFeedback(directory)
 if(expectedId!==(previous?.id??null))throw new TaskConflict('Boundary feedback changed; reopen it before saving')
 if(typeof note!=='string'||note.length>4000)throw new TaskConflict('Boundary note must be at most 4000 characters')
 const edits=boundaryChanges(input.pointers,value)
 const record:BoundaryFeedback={schema:'managed-boundary-feedback/1',id:randomUUID(),previousId:previous?.id??null,taskId:input.taskId,revision:input.revision,savedAt:new Date().toISOString(),note,...edits}
 const bytes=JSON.stringify(record)+'\n',history=path.join(directory,'boundary-feedback-'+record.id+'.json'),temporary=path.join(directory,'.boundary-feedback-'+record.id)
 async function write(file:string){const h=await fs.open(file,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);try{await h.writeFile(bytes);await h.sync()}finally{await h.close()}}
 try{await write(history);await write(temporary);await fs.rename(temporary,path.join(directory,'boundary-feedback-v1.json'));const h=await fs.open(directory,constants.O_RDONLY);try{await h.sync()}finally{await h.close()}}finally{await fs.rm(temporary,{force:true})}
 return record
}

export interface BoundaryApplication {schema:'managed-boundary-application/1';feedbackId:string;taskId:string;baseRevision:string;bounds:Boundary[];appliedAt:string}
export async function readBoundaryApplication(directory:string,input:{taskId:string;revision:string;pointers:any}):Promise<BoundaryApplication|null> {
 let h
 try{h=await fs.open(path.join(directory,'boundary-application-v1.json'),constants.O_RDONLY|constants.O_NOFOLLOW)}catch(e:any){if(e.code==='ENOENT')return null;throw e}
 try {
  const st=await h.stat();if(!st.isFile()||st.size>512000)throw new TaskConflict('Invalid boundary application')
  const a=JSON.parse(await h.readFile('utf8')) as BoundaryApplication
  if(!a||Object.keys(a).sort().join(',')!=='appliedAt,baseRevision,bounds,feedbackId,schema,taskId'||a.schema!=='managed-boundary-application/1'||a.taskId!==input.taskId||a.baseRevision!==input.revision||typeof a.feedbackId!=='string'||typeof a.appliedAt!=='string'||!Number.isFinite(Date.parse(a.appliedAt)))throw new TaskConflict('Boundary application revision mismatch')
  boundaryChanges(input.pointers,a.bounds)
  const feedback=await readBoundaryFeedback(directory)
  if(!feedback||feedback.id!==a.feedbackId||feedback.taskId!==a.taskId||feedback.revision!==a.baseRevision||canonicalJson(feedback.bounds)!==canonicalJson(a.bounds))throw new TaskConflict('Applied boundary feedback changed; reopen review')
  return a
 }finally{await h.close()}
}
export async function applyBoundaryFeedback(directory:string,input:{taskId:string;revision:string;pointers:any},feedbackId:string) {
 const prior=await readBoundaryApplication(directory,input)
 if(prior){if(prior.feedbackId!==feedbackId)throw new TaskConflict('Different boundaries already applied');return prior}
 const feedback=await readBoundaryFeedback(directory)
 if(!feedback||feedback.id!==feedbackId||feedback.taskId!==input.taskId||feedback.revision!==input.revision)throw new TaskConflict('Saved feedback changed; refresh before applying')
 const validated=boundaryChanges(input.pointers,feedback.bounds)
 if(!validated.changes.length)throw new TaskConflict('No boundary corrections to apply')
 const application:BoundaryApplication={schema:'managed-boundary-application/1',feedbackId,taskId:input.taskId,baseRevision:input.revision,bounds:validated.bounds,appliedAt:new Date().toISOString()}
 const temporary=path.join(directory,'.boundary-application-'+randomUUID()),target=path.join(directory,'boundary-application-v1.json')
 try{const h=await fs.open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);try{await h.writeFile(JSON.stringify(application)+'\n');await h.sync()}finally{await h.close()};await fs.rename(temporary,target);const d=await fs.open(directory,constants.O_RDONLY);try{await d.sync()}finally{await d.close()}}finally{await fs.rm(temporary,{force:true})}
 return application
}
export function applyBoundaryPointers(pointers:any,bounds:Boundary[]) {
 boundaryChanges(pointers,bounds)
 return {...pointers,crops:pointers.crops.filter((c:any)=>bounds.some(b=>b.id===c.id)).map((c:any)=>{const b=bounds.find(b=>b.id===c.id)!;return {...c,crop:{mode:'rectangle',points:[{id:'P1',x:b.left,y:b.top},{id:'P2',x:b.right,y:b.top},{id:'P3',x:b.right,y:b.bottom},{id:'P4',x:b.left,y:b.bottom}]}}})}
}
