import {createHash} from 'node:crypto'
import {canonicalJson,TaskConflict,type CropAttempt} from './managedTaskProtocol.js'
import {recoveryUnitKey,type RecoveryUnit} from './automationRecoveryPolicy.js'
import {parseAccountRecheckFence,type AccountRecheckFence} from './accountRecheckRecoveryProtocol.js'
import {recoveryExact,recoveryId} from './managedSavedImportRecoveryProtocol.js'
import type {AccountRecheckTransport} from './accountRecheckRecoveryTransport.js'
import type {AutomationRecovery} from './automationRecovery.js'
export class AccountRecheckRecoveryBridge {
 constructor(private deps:{resolve:()=>Promise<{unit:RecoveryUnit;outcome:CropAttempt['submission'];canonical:boolean;pageLabel:string}>;transport:AccountRecheckTransport;diagnoses:AutomationRecovery;enabled:()=>boolean;now?:()=>number}){}
 async perform(raw:unknown){
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||JSON.stringify(raw).length>12000)throw new TaskConflict('Bounded account recheck controls required')
  const body=raw as Record<string,any>;recoveryExact(body,'actionId' in body?['action','fence','expectedRevision','actionId']:['action','fence','expectedRevision'])
  if(!['inspect','enable','request','pause','cancel','disable'].includes(body.action)||!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0||body.action==='request'&&(!recoveryId(body.actionId)||body.actionId.length>96)||'actionId' in body&&body.action!=='request')throw new TaskConflict('Exact account recheck action required')
  const source=await this.deps.resolve(),discovery=await this.deps.transport.call('discover',source.unit,{})
  const targets=discovery.targets??[]
  if(body.fence===null){if(body.action!=='inspect')throw new TaskConflict('Select an approved account recheck target');return {...discovery,pageLabel:source.pageLabel,observedAt:(this.deps.now??Date.now)(),globalEnabled:this.deps.enabled()&&discovery.globalEnabled,selected:null,diagnosis:null}}
  const selected=parseAccountRecheckFence(body.fence)
  if(!targets.some(t=>canonicalJson(t)===canonicalJson(selected)))throw new TaskConflict('Refresh the approved original account/reset target')
  let view=await this.deps.transport.call('inspect',selected,{})
  if(body.action!=='inspect'){
   if(body.expectedRevision!==(view.record?.revision??0))throw new TaskConflict('Inspect the current account recheck revision')
   if(!['pause','cancel','disable'].includes(body.action)&&!(this.deps.enabled()&&view.globalEnabled))throw new TaskConflict('Account recheck recovery remains disabled')
   if(['enable','request'].includes(body.action))await this.deps.diagnoses.assertAdmission(source.unit,body.action==='request'?'account_recheck':undefined)
   if(body.action==='request'){
    const admission=await this.deps.diagnoses.inspect(source.unit)
    if(!admission?.enabled||admission.paused||admission.cancelled)throw new TaskConflict('Explicit current Automation admission required')
    const current=await this.deps.resolve();if(recoveryUnitKey(current.unit)!==recoveryUnitKey(source.unit))throw new TaskConflict('Current page changed before account recheck')
    await this.deps.diagnoses.assertAdmission(source.unit,body.action==='request'?'account_recheck':undefined)
    view=await this.deps.transport.call('request',selected,{revision:body.expectedRevision,actionId:body.actionId})
   }else view=await this.deps.transport.call('control',selected,{revision:body.expectedRevision,enabled:body.action==='enable'?true:body.action==='disable'?false:view.record?.enabled??false,paused:body.action==='pause'?true:body.action==='enable'?false:view.record?.paused??false,cancelled:body.action==='cancel'})
  }
  if(!view.budget)throw new TaskConflict('Authoritative shared recheck budget required')
  const last=view.record?.actions.at(-1),completed=last?.phase==='verified',now=(this.deps.now??Date.now)()
  const scope='account/'+selected.accountId+'/'+createHash('sha256').update(canonicalJson(selected.scope)).digest('hex')
  let diagnosis=await this.deps.diagnoses.observeInspection(source.unit,{reference:'account-recheck/inspection',observedAt:now,failure:selected.scope.feature==='uploads'?'upload_allowance':'generation_quota',outcome:source.outcome,inputCurrent:true,reviewRequired:completed,canonical:source.canonical,localState:'unknown',savedCheckpoint:source.outcome==='saved',login:'unknown',quota:view.quotaState??'unknown',quotaScope:scope,recheckAt:selected.recheckAt,pageExpected:false,profileExpected:false,loading:false,precedingActionReconciled:source.outcome==='unsent'||source.outcome==='saved',knownRepair:false,uiChangeId:null,adapterScope:'account-idle-recheck',contextVerified:false,contextPortable:false,policyAllowsAlternative:false,correctionAllowed:false,acceptedUnitsPreserved:true,safeReleaseVerified:false,deviceReachable:false},view.budget)
  if(['enable','pause','cancel','disable'].includes(body.action))diagnosis=await this.deps.diagnoses.control(source.unit,diagnosis.revision,{enabled:body.action==='enable'?true:body.action==='disable'?false:diagnosis.enabled,paused:body.action==='pause'?true:body.action==='enable'?false:diagnosis.paused,cancelled:body.action==='cancel'})
  return {...view,targets,selected,pageLabel:source.pageLabel,observedAt:now,globalEnabled:this.deps.enabled()&&view.globalEnabled,diagnosis}
 }
}
