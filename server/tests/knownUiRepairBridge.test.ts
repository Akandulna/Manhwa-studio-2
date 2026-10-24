import {afterEach,it,expect,vi} from 'vitest'
import {KnownUiRepairBridge,knownUiRepairTransport,type UiRepairView} from '../src/services/knownUiRepairBridge.js'
import {AutomationRecovery} from '../src/services/automationRecovery.js'
import {RelayDeliveryPause} from '../src/services/relayDeliveryPause.js'
import {UI_REPAIR_SCHEMA} from '../src/services/knownUiRepairProtocol.js'
import type {ProductionStoreDatabase} from '../src/services/productionJobStore.js'
const now=1792714000000,unit={workspaceId:'fixture',taskId:'task:sha256:'+'a'.repeat(64),attemptId:'attempt',generation:1,fingerprint:'b'.repeat(64)}
const fence={unit,deviceId:'phone',profileId:'profile',accountId:'confirmed',commandId:'original_command',bindingId:'original_view',sourceSha256:'a'.repeat(64),policyRevision:1,repairId:'email-connector-not-now/1' as const,uiChangeId:null,uiObservedAt:null}
function memory():ProductionStoreDatabase{const rows=new Map<string,string>();return {transaction:async work=>work({get:async k=>rows.get(k)??null,list:async p=>[...rows].filter(([k])=>k.startsWith(p)).map(([key,value])=>({key,value})),insert:async(k,v)=>{rows.set(k,v)},replace:async(k,old,v)=>{if(rows.get(k)!==old)return false;rows.set(k,v);return true}})}}
function fixture(){
 const diagnoses=new AutomationRecovery(memory(),()=>now,new Set(['ui_repair'])),calls:string[]=[]
 const session:any={schema:'managed-session-evidence/1',bindingId:fence.bindingId,commandId:fence.commandId,profileId:'profile',fingerprint:unit.fingerprint,cachedSourceSha256:fence.sourceSha256,observedAt:now,documentKind:'chatgpt_home',ready:true,composer:'empty',attachments:'none',response:'none',login:'unknown',exactView:true,currentProfile:true,cachedSourceVerified:true,untouched:true,context:'empty_unsent'}
 const offer:any={schema:'known-ui-repair-proof/1',observedAt:now,session,repairId:fence.repairId,overlay:'present',control:'unique_enabled',composerAccessible:false}
 const view:UiRepairView={globalEnabled:true,admissionReady:true,budget:{used:0,uiUsed:0,nextEligibleAt:0,pending:false,exhausted:false},record:{schema:UI_REPAIR_SCHEMA,fence,revision:1,enabled:false,paused:false,cancelled:false,nextEligibleAt:0,offer,actions:[]}}
 let changed=false,resolves=0,lost=false
 const bridge=new KnownUiRepairBridge({diagnoses,enabled:()=>true,now:()=>now,resolve:async()=>{resolves++;return {unit:changed&&resolves>1?{...unit,generation:2}:unit,pageLabel:'page.png'}},call:async(action,_f,d)=>{calls.push(action);if(action==='control'){Object.assign(view.record!,{revision:view.record!.revision+1,enabled:d.enabled,paused:d.paused,cancelled:d.cancelled})}if(action==='reserve'){if(view.budget.pending)throw Error('Original pending');view.record!.revision++;view.record!.actions.push({id:String(d.actionId),at:now,phase:'reserved',finishedAt:null,evidenceRef:null,before:null,after:null,effect:null});view.budget.used++;view.budget.uiUsed++;view.budget.pending=true;if(lost)throw Error('Lost acknowledgment')}return structuredClone(view)}})
 const act=(action:string)=>bridge.perform({action,fence,expectedRevision:view.record!.revision,...(action==='reserve'?{actionId:'one_grant'}:{})})
 return {act,view,calls,diagnoses,change:()=>{changed=true;resolves=0},lose:()=>lost=true}
}
afterEach(()=>vi.unstubAllGlobals())
it('requires explicit admission, holds a lost grant and reports actual readiness only as owner review',async()=>{
 const e=fixture();await e.act('inspect');await expect(e.act('reserve')).rejects.toThrow('admission');expect(e.calls).not.toContain('reserve')
 expect((await e.act('enable')).diagnosis?.decision.operation).toBe('ui_repair');e.lose();await expect(e.act('reserve')).rejects.toThrow('Lost')
 expect((await e.act('inspect')).budget.pending).toBe(true);await expect(e.act('reserve')).rejects.toThrow('Original action needs reconciliation');expect(e.view.budget.used).toBe(1)
 Object.assign(e.view.record!.actions[0],{phase:'verified',effect:'dismissed',before:e.view.record!.offer,after:{...e.view.record!.offer,overlay:'absent',control:'absent',composerAccessible:true},finishedAt:now,evidenceRef:'ui-repair/one_grant'});e.view.budget.pending=false
 expect((await e.act('inspect')).diagnosis?.decision.state).toBe('owner_action')
})
it('fences source changes and a durable detached stop before any grant',async()=>{
 const e=fixture();await e.act('enable');e.change();await expect(e.act('reserve')).rejects.toThrow('changed');expect(e.calls).not.toContain('reserve')
 const b=fixture(),enabled=await b.act('enable');await b.diagnoses.stop(unit,enabled.diagnosis!.revision,'pause');await expect(b.act('reserve')).rejects.toThrow('stop');expect(b.calls).not.toContain('reserve')
})
it('permits off-switch cancellation but refuses admission',async()=>{
 const e=fixture();await e.act('enable');e.view.globalEnabled=false;await expect(e.act('reserve')).rejects.toThrow('off');expect((await e.act('cancel')).record?.cancelled).toBe(true)
})
it('persists Retry-After once and never internally retries a navigation request',async()=>{
 let saved:string|null=null;const pause=new RelayDeliveryPause({load:async()=>saved,save:async v=>{saved=v}},()=>now),fetcher=vi.fn(async()=>new Response('',{status:429,headers:{'Retry-After':'3600'}}));vi.stubGlobal('fetch',fetcher)
 const call=knownUiRepairTransport('https://relay.example','fixture','s'.repeat(40),undefined,pause)
 await expect(call('discover',unit,{})).rejects.toThrow('unavailable');expect(saved).toBe(String(now+3600000));await expect(call('discover',unit,{})).rejects.toThrow('paused');expect(fetcher).toHaveBeenCalledTimes(1)
})
it('rejects foreign original-view receipts, extra proof fields and oversized bodies',async()=>{
 const e=fixture(),pause=new RelayDeliveryPause({load:async()=>null,save:async()=>{}},()=>now),call=knownUiRepairTransport('https://relay.example','fixture','s'.repeat(40),undefined,pause)
 for(const body of [JSON.stringify({schema:UI_REPAIR_SCHEMA,...e.view,record:{...e.view.record,fence:{...fence,bindingId:'new_view'}}}),JSON.stringify({schema:UI_REPAIR_SCHEMA,...e.view,record:{...e.view.record,offer:{...e.view.record!.offer,text:'private'}}}),'x'.repeat(64001)]){vi.stubGlobal('fetch',vi.fn(async()=>new Response(body)));await expect(call('inspect',fence,{})).rejects.toThrow()}
})

it('correlates the exact recent original incident without claiming verified recovery',async()=>{
 const e=fixture();e.view.record!.fence={...fence,uiChangeId:'c'.repeat(64),uiObservedAt:now-1000};
 // Inspect derives correlation from the server-owned original record, never a browser-chosen incident.
 const result=await e.act('inspect');expect(result.diagnosis?.evidence.uiChangeId).toBe('c'.repeat(64));expect(result.diagnosis?.decision.state).not.toBe('verified')
})
