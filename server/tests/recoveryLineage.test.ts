import {createRequire} from 'node:module'
import {mkdtempSync,rmSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {afterEach,describe,it,expect} from 'vitest'
import {TaskAuthority,type TaskSql} from '../../relay/src/taskAuthority.js'
import {sharedRecoveryBudget,assertRecoveryReservation,assertRecoveryControls} from '../../relay/src/recoveryBudget.js'
import {recoveryFamilyUnits,recordReleasedRecoveryLineage} from '../../relay/src/recoveryLineage.js'
import {parseRecoveryLineage,MAX_RECOVERY_FAMILY_UNITS} from '../src/services/recoveryLineageProtocol.js'
import {recoveryUnitKey,type RecoveryUnit} from '../src/services/automationRecoveryPolicy.js'
import {RecoveryStops} from '../../relay/src/recoveryStops.js'
import {AccountRecheckRecovery} from '../../relay/src/accountRecheckRecovery.js'
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite'),opened:any[]=[],temporary:string[]=[]
afterEach(()=>{for(const db of opened.splice(0))db.close();for(const dir of temporary.splice(0))rmSync(dir,{recursive:true,force:true})})
const studio={role:'studio'} as const,phone=(deviceId='one')=>({role:'phone',deviceId} as const)
const CAPS=['managed-task/1','attempt-fencing/1','command-journal/1','artifact-publication/1','worker-reconnect/1']
const spec={version:'crop-page/1' as const,provider:'chatgpt' as const,product:'chatgpt-web',model:'explicit-model',settings:{mode:'Chat',effort:null},pageRevision:'r1',promptVersion:'prompt-v1',validatorVersion:'crop-v1',dependencies:[{id:'page',revision:'r1',sha256:'a'.repeat(64)}]}
async function setup(file=':memory:'){
 let db=new DatabaseSync(file);opened.push(db);let now=1792714000000,seq=0,txseq=0
 const sql:TaskSql={exec:(q,...args)=>{const rows=db.prepare(q).all(...args);return {toArray:()=>rows as any}}}
 const tx=<T>(work:()=>T):T=>{const id='tx'+(++txseq);db.exec('SAVEPOINT '+id);try{const r=work();db.exec('RELEASE '+id);return r}catch(error){db.exec('ROLLBACK TO '+id);db.exec('RELEASE '+id);throw error}}
 let a=new TaskAuthority(sql,tx,()=>new Date(now).toISOString(),()=> 'id_'+(++seq));const event=()=> 'event_'+(++seq)
 for(const device of ['one','two']){a.registerPeer(phone(device),event(),['profile'],CAPS,'fixture');a.enroll(studio,event(),device,'profile',CAPS)}
 const task=await a.plan(studio,event(),{workspaceId:'workspace',seriesId:'series',chapterId:'chapter',pageId:'page'},spec),claim=a.claim(studio,event(),task.id,'one','profile',null)
 const unit=(attempt=a.timeline(studio,task.id).attempt!)=>({workspaceId:task.workspaceId,taskId:task.id,attemptId:attempt.id,generation:attempt.generation,fingerprint:task.fingerprint})
 const root=unit();const stop=()=>{const current=a.timeline(studio,task.id).attempt!,stopped=a.stop(studio,event(),task.id,false);a.checkpoint(phone(current.deviceId),event(),task.id,current.id,current.generation,task.fingerprint,'stop_confirmed',null,stopped.command!.id);return stopped.command!.id}
 const transfer=(eid=event())=>{const current=a.timeline(studio,task.id).attempt!;return a.transfer(studio,eid,task.id,current.id,current.generation,task.fingerprint,current.activeCommandId,current.deviceId==='one'?'two':'one','profile')}
 const dump=()=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((x:any)=>[x.name,db.prepare('SELECT * FROM '+x.name+' ORDER BY rowid').all()])
 function seed(u:RecoveryUnit,ids:string[],phase='safe_failure',cooldown=0){
  const r={schema:'saved-crop-import-recovery/1',fence:{...u,artifactId:'original_saved',sha256:'b'.repeat(64)},destinationId:'c'.repeat(64),revision:1,enabled:true,paused:false,cancelled:false,nextEligibleAt:cooldown,actions:ids.map(id=>({id,phase,at:now,finishedAt:['reserved','executing'].includes(phase)?null:now,evidenceRef:['reserved','executing'].includes(phase)?null:'evidence/'+id}))}
  db.prepare('INSERT INTO managed_recovery_episodes (id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(recoveryUnitKey(u),JSON.stringify(r))
 }
 function seedUi(u:RecoveryUnit,id:string){
  const current=JSON.parse(db.prepare('SELECT body FROM managed_attempts WHERE id=?').get(u.attemptId).body)
  const f={unit:u,commandId:'historical_start',deviceId:current.deviceId,profileId:'profile',bindingId:'original_view',sourceSha256:'a'.repeat(64),accountId:'original_account',policyRevision:1,repairId:'email-connector-not-now/1',uiChangeId:null,uiObservedAt:null}
  const session={schema:'managed-session-evidence/1',bindingId:f.bindingId,commandId:f.commandId,profileId:'profile',fingerprint:u.fingerprint,cachedSourceSha256:f.sourceSha256,observedAt:now,documentKind:'chatgpt_home',ready:true,composer:'empty',attachments:'none',response:'none',login:'unknown',exactView:true,currentProfile:true,cachedSourceVerified:true,untouched:true,context:'empty_unsent'}
  const r={schema:'known-ui-repair/1',fence:f,revision:1,enabled:true,paused:false,cancelled:false,nextEligibleAt:0,offer:{schema:'known-ui-repair-proof/1',observedAt:now,session,repairId:f.repairId,overlay:'present',control:'unique_enabled',composerAccessible:false},actions:[{id,phase:'safe_failure',at:now,finishedAt:now,evidenceRef:'ui-repair/'+id,before:null,after:null,effect:'not_touched'}]}
  db.prepare('INSERT INTO managed_ui_recovery_episodes (id,body) VALUES (?,?)').run(recoveryUnitKey(u),JSON.stringify(r))
 }
 function mutate(table:string,id:string,work:(r:any)=>void){const r=JSON.parse(db.prepare('SELECT body FROM '+table+' WHERE id=?').get(id).body);work(r);db.prepare('UPDATE '+table+' SET body=? WHERE id=?').run(JSON.stringify(r),id)}
 const stopFamily=(u:RecoveryUnit,mode:'pause'|'cancel'|'disable'|'reinspect',sequence=1)=>new RecoveryStops(sql,tx,a,new AccountRecheckRecovery(sql,tx,a,()=>now),()=>now).apply(studio,{schema:'recovery-stop/1',unit:u,eventId:event(),sequence,mode})
 return {get db(){return db},sql,tx,get a(){return a},task,claim,unit,root,event,stop,transfer,dump,seed,seedUi,mutate,stopFamily,now:()=>now,advance:(ms:number)=>now+=ms,reopen:()=>{opened.splice(opened.indexOf(db),1);db.close();db=new DatabaseSync(file);opened.push(db);a=new TaskAuthority(sql,tx,()=>new Date(now).toISOString(),()=> 'id_'+(++seq))}}
}
describe('immutable successor recovery budget lineage',()=>{
 it('records the exact real transfer atomically and preserves one effective family ceiling',async()=>{
  const e=await setup();e.seed(e.root,['first']);e.stop();const parent=e.a.timeline(studio,e.task.id),next=e.transfer(),child=e.unit(next.attempt)
  expect(recoveryFamilyUnits(e.sql,child)).toEqual([e.root,child]);expect(sharedRecoveryBudget(e.sql,child)).toMatchObject({used:1,pending:false,exhausted:false})
  const row=e.db.prepare('SELECT * FROM managed_recovery_lineage').get(),edge=parseRecoveryLineage(JSON.parse(row.body));expect(edge).toMatchObject({parent:e.root,successor:child,stopCommandId:parent.attempt!.activeCommandId,startCommandId:next.command.id})
  const before=e.dump();expect(sharedRecoveryBudget(e.sql,e.root).used).toBe(1);expect(e.dump()).toEqual(before)
  e.seed(child,['second','third']);for(const u of [e.root,child]){expect(sharedRecoveryBudget(e.sql,u)).toMatchObject({used:3,exhausted:true});expect(()=>assertRecoveryReservation(e.sql,u,'fourth',e.now())).toThrow('exhausted')}
 })
 it('counts descendants, cooldowns and duplicate action identities without copying old records',async()=>{
  const e=await setup();e.seed(e.root,['original']);e.stop();const child=e.unit(e.transfer().attempt);const original=e.db.prepare('SELECT body FROM managed_recovery_episodes WHERE id=?').get(recoveryUnitKey(e.root)).body
  e.seed(child,['successor'],'safe_failure',e.now()+5000)
  for(const u of [e.root,child]){expect(sharedRecoveryBudget(e.sql,u)).toMatchObject({used:2,nextEligibleAt:e.now()+5000});expect(()=>assertRecoveryReservation(e.sql,u,'later',e.now())).toThrow('cooldown')}
  expect(e.db.prepare('SELECT body FROM managed_recovery_episodes WHERE id=?').get(recoveryUnitKey(e.root)).body).toBe(original)
  e.seed(child,['original']);expect(()=>sharedRecoveryBudget(e.sql,child)).toThrow('Conflicting')
 })
 it('keeps the two-UI-cycle limit across three successive owners',async()=>{
  const e=await setup();e.seedUi(e.root,'ui_one');e.stop();const second=e.unit(e.transfer().attempt);e.seedUi(second,'ui_two');e.stop();const third=e.unit(e.transfer().attempt)
  expect(sharedRecoveryBudget(e.sql,third)).toMatchObject({used:2,uiUsed:2});e.seedUi(third,'ui_three');expect(()=>sharedRecoveryBudget(e.sql,third)).toThrow('Conflicting')
 })
 it.each(['reserved','executing','unknown'])('blocks a successor when original %s recovery is unresolved',async phase=>{
  const e=await setup();e.seed(e.root,['uncertain'],phase);e.stop();const before=e.dump();expect(()=>e.transfer()).toThrow('reconciliation');expect(e.dump()).toEqual(before)
 })
 it.each(['exhausted','cooldown'])('rolls back a transfer held by the original %s budget',async kind=>{
  const e=await setup();e.seed(e.root,kind==='exhausted'?['one','two','three']:['one'],'safe_failure',kind==='cooldown'?e.now()+5000:0);e.stop();const before=e.dump()
  expect(()=>e.transfer()).toThrow(kind);expect(e.dump()).toEqual(before)
 })
 it.each(['pause','cancel','disable'] as const)('preserves inherited %s controls in both directions',async mode=>{
  const e=await setup();e.stop();const child=e.unit(e.transfer().attempt);e.stopFamily(e.root,mode)
  for(const u of [e.root,child])expect(()=>assertRecoveryControls(e.sql,u)).toThrow()
  e.stop();const before=e.dump();expect(sharedRecoveryBudget(e.sql,child).used).toBe(0);expect(()=>e.transfer()).toThrow();expect(e.dump()).toEqual(before)
 })
 it('reinspection of the successor cannot clear a retained ancestor hold or revive a paused episode',async()=>{
  const e=await setup();e.seed(e.root,['first']);e.stop();const child=e.unit(e.transfer().attempt);e.stopFamily(e.root,'pause');e.stopFamily(child,'pause');e.stopFamily(child,'reinspect',2)
  expect(()=>assertRecoveryControls(e.sql,child)).toThrow();expect(sharedRecoveryBudget(e.sql,child).used).toBe(1)
 })
 it('inherits a later unknown outcome rather than reporting a fresh budget',async()=>{
  const e=await setup();e.stop();const child=e.unit(e.transfer().attempt);e.seed(e.root,['late_unknown'],'unknown')
  expect(sharedRecoveryBudget(e.sql,child)).toMatchObject({used:1,pending:true});expect(()=>assertRecoveryReservation(e.sql,child,'another',e.now())).toThrow('reconciliation')
 })
 it('replays the original transfer result without another link or counter change',async()=>{
  const e=await setup();e.seed(e.root,['first']);e.stop();const stop=e.a.timeline(studio,e.task.id).attempt!.activeCommandId,next=e.transfer('original_transfer'),before=e.dump()
  expect(e.a.transfer(studio,'original_transfer',e.task.id,e.root.attemptId,1,e.root.fingerprint,stop,'two','profile')).toEqual(next);expect(e.dump()).toEqual(before);expect(e.db.prepare('SELECT COUNT(*) AS n FROM managed_recovery_lineage').get().n).toBe(1)
 })
 it.each(['deleted','parent','parent_identity','child','command','key','cycle','extra','history_deleted','history_renamed','history_moved'])('fails closed on %s lineage without rewriting its records',async kind=>{
  const e=await setup();e.seed(e.root,['original_action']);e.stop();const child=e.unit(e.transfer().attempt),key=recoveryUnitKey(child)
  if(kind==='history_deleted')e.db.prepare('DELETE FROM managed_recovery_episodes').run()
  if(kind==='history_renamed')e.mutate('managed_recovery_episodes',recoveryUnitKey(e.root),r=>{r.actions[0].id='other_action'})
  if(kind==='history_moved')e.db.prepare('UPDATE managed_recovery_episodes SET id=?').run(recoveryUnitKey(child))
  if(kind==='deleted')e.db.prepare('DELETE FROM managed_recovery_lineage').run()
  if(kind==='parent_identity')e.mutate('managed_attempts',e.root.attemptId,r=>{r.id='different'})
  if(kind==='parent')e.db.prepare('DELETE FROM managed_attempts WHERE id=?').run(e.root.attemptId)
  if(kind==='child')e.db.prepare('DELETE FROM managed_attempts WHERE id=?').run(child.attemptId)
  if(kind==='command'){const edge=JSON.parse(e.db.prepare('SELECT body FROM managed_recovery_lineage').get().body);e.db.prepare('DELETE FROM managed_commands WHERE id=?').run(edge.stopCommandId)}
  if(kind==='key')e.db.prepare('UPDATE managed_recovery_lineage SET parent_id=? WHERE id=?').run('foreign_key',key)
  if(kind==='cycle')e.mutate('managed_recovery_lineage',key,r=>{r.parent=r.successor})
  if(kind==='extra')e.mutate('managed_recovery_lineage',key,r=>{r.executionAllowed=true})
  const before=e.dump();for(const u of [e.root,child])expect(()=>sharedRecoveryBudget(e.sql,u)).toThrow();expect(e.dump()).toEqual(before)
 })
 it('rolls back allocation, reservations, commands and receipt if lineage insertion fails',async()=>{
  const e=await setup();e.stop();e.db.exec("CREATE TRIGGER fail_lineage BEFORE INSERT ON managed_recovery_lineage BEGIN SELECT RAISE(ABORT,'lineage disk failure'); END;")
  const before=e.dump();expect(()=>e.transfer('failed_transaction')).toThrow('lineage disk failure');expect(e.dump()).toEqual(before);expect(e.db.prepare('SELECT id FROM managed_events WHERE id=?').get('failed_transaction')).toBeUndefined()
 })
 it('survives a file-backed database reopen and keeps exact original evidence',async()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'recovery-lineage-'));temporary.push(dir);const e=await setup(path.join(dir,'authority.db'));e.seed(e.root,['before_restart']);e.stop();const child=e.unit(e.transfer().attempt);e.seed(child,['after_transfer']);const before=e.dump();e.reopen();expect(e.dump()).toEqual(before);expect(sharedRecoveryBudget(e.sql,child).used).toBe(2)
 })
 it('bounds long transfer chains and rolls back an extra successor',async()=>{
  const e=await setup();for(let n=1;n<MAX_RECOVERY_FAMILY_UNITS;n++){e.stop();e.transfer()}
  expect(recoveryFamilyUnits(e.sql,e.unit())).toHaveLength(MAX_RECOVERY_FAMILY_UNITS);e.stop();const before=e.dump();expect(()=>e.transfer()).toThrow('bound');expect(e.dump()).toEqual(before)
 })
 it('rejects reparenting an immutable edge and an unstarted-owner mismatch',async()=>{
  const e=await setup();e.stop();const child=e.unit(e.transfer().attempt),row=JSON.parse(e.db.prepare('SELECT body FROM managed_recovery_lineage').get().body),before=e.dump()
  expect(()=>e.tx(()=>recordReleasedRecoveryLineage(e.sql,e.root,child,'different_event',row.stopCommandId,row.startCommandId,e.now()))).toThrow('Immutable');expect(e.dump()).toEqual(before)
  for(const patch of [{parent:{...e.root,workspaceId:'foreign'}},{successor:{...child,generation:3}},{kind:'automatic_fallback'},{createdAt:-1}])expect(()=>parseRecoveryLineage({...row,...patch})).toThrow()
 })
})
