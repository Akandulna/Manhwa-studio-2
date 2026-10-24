import {afterEach,describe,it,expect,vi} from 'vitest'
import {AccountRecheckRecoveryBridge} from '../src/services/accountRecheckRecoveryBridge.js'
import {accountRecheckTransport,type AccountRecheckView} from '../src/services/accountRecheckRecoveryTransport.js'
import {AutomationRecovery} from '../src/services/automationRecovery.js'
import {RelayDeliveryPause} from '../src/services/relayDeliveryPause.js'
import {ACCOUNT_RECHECK_SCHEMA} from '../src/services/accountRecheckRecoveryProtocol.js'
import type {ProductionStoreDatabase} from '../src/services/productionJobStore.js'
const now=1792714000000,unit={workspaceId:'fixture',taskId:'task:sha256:'+'a'.repeat(64),attemptId:'attempt',generation:1,fingerprint:'b'.repeat(64)}
const fence={unit,deviceId:'phone',profileId:'profile',accountId:'confirmed',candidate:'openai:'+'c'.repeat(64),scope:{provider:'openai' as const,product:'chatgpt' as const,model:'*',project:null,feature:'crop_json'},quotaObservedAt:now-2000,recheckAt:now-1000,policyRevision:1}
function memory():ProductionStoreDatabase{const rows=new Map<string,string>();return {transaction:async work=>work({get:async k=>rows.get(k)??null,list:async p=>[...rows].filter(([k])=>k.startsWith(p)).map(([key,value])=>({key,value})),insert:async(k,v)=>{rows.set(k,v)},replace:async(k,old,v)=>{if(rows.get(k)!==old)return false;rows.set(k,v);return true}})}}
function fixture(){
 const diagnoses=new AutomationRecovery(memory(),()=>now,new Set(['account_recheck'])),calls:string[]=[]
 const view:AccountRecheckView={globalEnabled:true,targets:[fence],record:null,budget:{used:0,uiUsed:0,nextEligibleAt:0,pending:false,exhausted:false},quotaState:'blocked',profileAudit:null}
 let changed=false,resolves=0,lost=false
 const bridge=new AccountRecheckRecoveryBridge({diagnoses,enabled:()=>true,now:()=>now,resolve:async()=>{resolves++;return {unit:changed&&resolves>1?{...unit,generation:2}:unit,outcome:'saved',canonical:true,pageLabel:'page.png'}},transport:{singleAttempt:true,call:async(action,_f,details)=>{calls.push(action);if(action==='control'){view.record={schema:ACCOUNT_RECHECK_SCHEMA,fence,revision:(view.record?.revision??0)+1,enabled:!!details.enabled,paused:!!details.paused,cancelled:!!details.cancelled,nextEligibleAt:0,actions:view.record?.actions??[]}}if(action==='request'){if(view.budget!.pending)throw new Error('Original request retained');view.record!.revision++;view.record!.actions.push({id:String(details.actionId),at:now,phase:'executing',auditId:null,checkedAt:null,result:null,evidenceRef:null});view.budget!.used=1;view.budget!.pending=true;if(lost)throw new Error('Lost acknowledgment')}return structuredClone(view)}}})
 const act=(action:string,f:unknown=fence)=>bridge.perform({action,fence:f,expectedRevision:view.record?.revision??0,...(action==='request'?{actionId:'original_request'}:{})})
 return {view,calls,act,diagnoses,change:()=>{changed=true;resolves=0},lose:()=>lost=true}
}
afterEach(()=>vi.unstubAllGlobals())
describe('explicit account recheck bridge',()=>{
 it('blocks new account requests behind an unsynchronized detached local stop',async()=>{
  const e=fixture(),enabled=await e.act('enable');await e.diagnoses.stop(unit,enabled.diagnosis!.revision,'pause')
  await expect(e.act('request')).rejects.toThrow('stop');expect(e.calls).not.toContain('request')
 })

 it('requires enable before request and reports the true audit as owner review without granting quota',async()=>{
  const e=fixture();await e.act('inspect',null);expect(e.calls).toEqual(['discover'])
  await expect(e.act('request')).rejects.toThrow('admission')
  expect((await e.act('enable')).diagnosis?.decision.operation).toBe('account_recheck')
  expect((await e.act('request')).budget?.pending).toBe(true)
  Object.assign(e.view.record!.actions[0],{phase:'verified',auditId:'audit_original',checkedAt:now,result:'quota_blocked',evidenceRef:'audit/audit_original'});e.view.budget!.pending=false
  const done=await e.act('inspect');expect(done.record!.actions[0].checkedAt).toBe(now);expect(done.quotaState).toBe('blocked');expect(done.diagnosis?.decision.state).toBe('owner_action')
  expect(e.calls.filter(c=>c==='request')).toHaveLength(1)
 })
 it('preserves a lost request and rejects changed units and foreign targets',async()=>{
  const e=fixture();await e.act('enable');e.lose();await expect(e.act('request')).rejects.toThrow('Lost')
  expect((await e.act('inspect')).record?.actions).toHaveLength(1);await expect(e.act('request')).rejects.toThrow('retained')
  const b=fixture();await b.act('enable');b.change();await expect(b.act('request')).rejects.toThrow('changed');expect(b.calls).not.toContain('request')
  await expect(b.act('enable',{...fence,accountId:'foreign'})).rejects.toThrow('approved')
 })
 it('allows off-switch cancellation while preventing new requests',async()=>{
  const e=fixture();await e.act('enable');e.view.globalEnabled=false
  expect((await e.act('cancel')).diagnosis?.cancelled).toBe(true);await expect(e.act('request')).rejects.toThrow('disabled')
 })
})
describe('single-attempt account transport',()=>{
 it('persists Retry-After and blocks later calls without retrying',async()=>{
  let saved:string|null=null;const pause=new RelayDeliveryPause({load:async()=>saved,save:async v=>{saved=v}},()=>now)
  const fetcher=vi.fn(async()=>new Response('',{status:429,headers:{'Retry-After':'3600'}}));vi.stubGlobal('fetch',fetcher)
  const transport=accountRecheckTransport('https://relay.example','fixture','s'.repeat(40),undefined,pause)
  await expect(transport.call('discover',unit,{})).rejects.toThrow('unavailable');expect(saved).toBe(String(now+3600000))
  await expect(transport.call('discover',unit,{})).rejects.toThrow('paused');expect(fetcher).toHaveBeenCalledTimes(1)
 })
 it('rejects foreign scope and oversized responses and accepts an empty inventory',async()=>{
  const pause=new RelayDeliveryPause({load:async()=>null,save:async()=>{}},()=>now),transport=accountRecheckTransport('https://relay.example','fixture','s'.repeat(40),undefined,pause)
  for(const body of [JSON.stringify({schema:ACCOUNT_RECHECK_SCHEMA,globalEnabled:true,record:null,targets:[{...fence,unit:{...unit,generation:2}}]}),'x'.repeat(128001)]){
   vi.stubGlobal('fetch',vi.fn(async()=>new Response(body)));await expect(transport.call('discover',unit,{})).rejects.toThrow()
  }
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({schema:ACCOUNT_RECHECK_SCHEMA,globalEnabled:true,record:null,targets:[]}))))
  expect((await transport.call('discover',unit,{})).targets).toEqual([])
 })
})
