import {createRequire} from 'node:module'
import {afterEach,describe,expect,it} from 'vitest'
import {TaskAuthority,type TaskSql} from '../../relay/src/taskAuthority.js'
import {retainedInventory} from '../../relay/src/retainedInventory.js'
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite')
const opened:any[]=[]
afterEach(()=>{for(const db of opened.splice(0))db.close()})
const studio={role:'studio'} as const,phone={role:'phone',deviceId:'phone'} as const
function fixture(){
 const db=new DatabaseSync(':memory:');opened.push(db)
 const sql:TaskSql={exec(q,...args){const rows=db.prepare(q).all(...args);return {toArray:()=>rows}}}
 const tx=<T>(work:()=>T)=>{db.exec('BEGIN');try{const result=work();db.exec('COMMIT');return result}catch(e){db.exec('ROLLBACK');throw e}}
 let n=0;const a=new TaskAuthority(sql,tx,()=>new Date(1792714000000).toISOString(),()=>`id-${++n}`)
 a.enroll(studio,'enroll','phone','profile',['managed-task/1','attempt-fencing/1','command-journal/1','artifact-publication/1'])
 const plan=(i:number)=>a.plan(studio,'plan-'+i,{workspaceId:'workspace',seriesId:'series',chapterId:'chapter',pageId:'page-'+i},{version:'crop-page/1',provider:'chatgpt',product:'web',model:'explicit',settings:{mode:'Chat',effort:null},pageRevision:'r1',promptVersion:'p1',validatorVersion:'v1',dependencies:[{id:'page-'+i,revision:'r1',sha256:'a'.repeat(64)}]})
 return {db,sql,a,plan}
}
describe('relay active inventory and immutable archival',()=>{
 it('processes more than 1000 retired tasks while retaining original timelines and receipts',async()=>{
  const e=fixture();let first:any
  for(let i=0;i<1005;i++){
   const task=await e.plan(i);first??=task
   e.a.stop(studio,'stop-'+i,task.id,true)
  }
  await e.plan(1005)
  expect(e.db.prepare('SELECT COUNT(*) AS n FROM managed_task_archive').get().n).toBe(1005)
  expect(e.db.prepare('SELECT COUNT(*) AS n FROM managed_tasks').get().n).toBe(1006)
  expect(e.a.timeline(studio,first.id).task.state).toBe('cancelled')
  expect((await e.plan(0)).state).toBe('queued') // Immutable original plan receipt, not a new task.
  expect(e.a.timeline(studio,first.id).task.state).toBe('cancelled')
  expect(e.db.prepare('SELECT id FROM managed_events WHERE id=?').get('stop-0')).toBeDefined()
 },15000)
 it('releases staged upload capacity after publication, exceeding the old 256-upload lifetime cap',async()=>{
  const e=fixture();let first:any,firstClaim:any
  for(let i=0;i<260;i++){
   const task=await e.plan(i),claim=e.a.claim(studio,'claim-'+i,task.id,'phone','profile',null),attempt=claim.attempt
   first??=task;firstClaim??=claim
   for(const phase of ['accepted','started','submission_intent','result_saved'] as const)e.a.checkpoint(phone,`checkpoint-${i}-${phase}`,task.id,attempt.id,1,task.fingerprint,phase,phase==='result_saved'?'checkpoint/'+i:null,attempt.activeCommandId)
   const artifact='artifact-'+i,ref=`managed/workspace/${task.id.slice(12)}/${attempt.id}/${artifact}`
   e.a.reserveArtifact(phone,task.id,attempt.id,1,task.fingerprint,artifact,ref,'b'.repeat(64),500)
   expect(e.db.prepare('SELECT bytes,slots FROM managed_artifact_budget').get()).toEqual({bytes:500,slots:1})
   e.a.stage(phone,'stage-'+i,task.id,attempt.id,1,task.fingerprint,artifact,ref,'b'.repeat(64))
   e.a.publish(studio,'publish-'+i,task.id,attempt.id,1,task.fingerprint,artifact,'b'.repeat(64),'validation/v'+i)
   expect(e.db.prepare('SELECT bytes,slots FROM managed_artifact_budget').get()).toEqual({bytes:0,slots:0})
  }
  expect(e.a.productionClaim(studio,first.id,'claim-0')).toMatchObject({status:'recorded',attemptId:firstClaim.attempt.id})
  expect(e.a.timeline(studio,first.id).task.state).toBe('verified_complete')
  const slot=JSON.parse(e.db.prepare('SELECT body FROM managed_uploads WHERE id=?').get(first.id).body)
  e.a.reserveArtifact(phone,slot.taskId,slot.attemptId,slot.generation,slot.fingerprint,slot.artifactId,slot.ref,slot.sha256,slot.bytes)
  expect(e.db.prepare('SELECT bytes,slots FROM managed_artifact_budget').get()).toEqual({bytes:0,slots:0})
 },15000)
 it('keeps unresolved tasks live and refuses a full active inventory',async()=>{
  const e=fixture(),task=await e.plan(0)
  for(let i=1;i<1000;i++){const id='task:sha256:'+i.toString(16).padStart(64,'0');e.db.prepare('INSERT INTO managed_tasks (id,body) VALUES (?,?)').run(id,JSON.stringify({...task,id,pageId:'pending-'+i}))}
  await expect(e.plan(1001)).rejects.toThrow('task bound')
  expect(e.db.prepare('SELECT COUNT(*) AS n FROM managed_task_archive').get().n).toBe(0)
 })
 it.each(['unit','fence.unit','fence','challenge.unit','intent.unit','parent','root','context.unit','task'])('excludes archived %s histories from active limits without deleting evidence',async location=>{
  const e=fixture(),task=await e.plan(0);e.a.stop(studio,'cancel',task.id,true);await e.plan(1)
  e.db.exec('CREATE TABLE managed_retention_fixture (id TEXT PRIMARY KEY,body TEXT NOT NULL)')
  let body:any=location==='task'?{taskId:task.id}:{};let node=body
  if(location!=='task'){const parts=location.split('.');for(const part of parts)node=node[part]={};node.taskId=task.id}
  for(let i=0;i<140;i++)e.db.prepare('INSERT INTO managed_retention_fixture VALUES (?,?)').run('history-'+i,JSON.stringify(body))
  expect(retainedInventory(e.sql,'managed_retention_fixture',128)).toBe(0)
  expect(e.db.prepare('SELECT COUNT(*) AS n FROM managed_retention_fixture').get().n).toBe(140)
 })
})

it('does not let unresolved cancelled tasks starve archival of safely retired tasks',async()=>{
 const e=fixture(),template=await e.plan(0)
 for(let i=1;i<=64;i++){const id='task:sha256:'+i.toString(16).padStart(64,'0');e.db.prepare('INSERT INTO managed_tasks VALUES (?,?)').run(id,JSON.stringify({...template,id,state:'cancelled',attemptId:'missing-'+i}))}
 e.a.stop(studio,'safe_cancel',template.id,true);await e.plan(100)
 expect(e.db.prepare('SELECT id FROM managed_task_archive WHERE id=?').get(template.id)).toBeDefined()
 expect(e.db.prepare('SELECT COUNT(*) AS n FROM managed_task_archive').get().n).toBe(1)
})

it('keeps unresolved recovery actions counted even when their provider task is archived',async()=>{
 const e=fixture(),task=await e.plan(0);e.a.stop(studio,'cancel',task.id,true);await e.plan(1)
 e.db.exec('CREATE TABLE managed_retention_fixture (id TEXT PRIMARY KEY,body TEXT NOT NULL)')
 for(const phase of ['reserved','executing','unknown','prepared','verified'])e.db.prepare('INSERT INTO managed_retention_fixture VALUES (?,?)').run(phase,JSON.stringify({unit:{taskId:task.id},actions:[{phase}]}))
 expect(retainedInventory(e.sql,'managed_retention_fixture',128)).toBe(4)
})
