import {useState} from 'react'
import {Button} from '@/components/ui/button'
interface Target {deviceId:string;profileId:string;accountId:string;quotaObservedAt:number;recheckAt:number;scope:{product:string;model:string;feature:string};[key:string]:unknown}
interface View {
 targets:Target[];selected:Target|null;globalEnabled:boolean;observedAt:number;pageLabel:string
 record:{revision:number;enabled:boolean;paused:boolean;cancelled:boolean;actions:{id:string;phase:string;auditId:string|null;at:number;checkedAt:number|null;result:string|null}[]}|null
 budget?:{used:number;pending:boolean;exhausted:boolean;nextEligibleAt:number}
 profileAudit?:{state:string;reason:string|null;retryNotBefore:number|null;lastSuccessfulAt:number|null}|null;quotaState?:string
 diagnosis?:{decision:{state:string;reason:string}}|null
}
const outcomes:Record<string,string>={quota_blocked:'Identity checked; scoped quota is still blocked.',identity_checked:'Identity checked. Quota evidence and task eligibility remain separate.',signed_out:'The target is signed out. Sign in through its normal controls.',identity_changed:'The observed identity changed. Review the relationship in Accounts.',unknown:'The audit could not verify readiness. Original cooldowns and history are retained.',withdrawn:'The queued request was withdrawn; newer owner edits and normal audit cadence are preserved.'}
export default function ManagedAccountRecheckRecovery({pageId}:{pageId:string}){
 const [view,setView]=useState<View|null>(null),[selected,setSelected]=useState<Target|null>(null),[busy,setBusy]=useState(false),[confirmed,setConfirmed]=useState(false),[error,setError]=useState('')
 async function act(action:string){
  setBusy(true);setConfirmed(false);setError('')
  try{const response=await fetch('/api/managed-pilot/pages/'+encodeURIComponent(pageId)+'/account-recovery',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,fence:selected,expectedRevision:view?.record?.revision??0,...(action==='request'?{actionId:crypto.randomUUID()}:{})})});if(!response.ok)throw new Error();setView(await response.json())}
  catch{setView(null);setError('Recheck outcome is unconfirmed. Inspect the original account/audit receipt before another request.')}
  finally{setBusy(false)}
 }
 const r=view?.record,last=r?.actions.at(-1),current=!!view?.selected&&JSON.stringify(view.selected)===JSON.stringify(selected)&&Date.now()-view.observedAt<120000
 const blocked=busy||!current||!view?.globalEnabled||!confirmed||r?.cancelled||view?.budget?.pending||view?.budget?.exhausted||(view?.budget?.nextEligibleAt??0)>Date.now()||(selected?.recheckAt??Infinity)>Date.now()||last?.phase==='verified'
 return <section aria-label="Account recheck recovery" className="space-y-3 rounded border p-3 text-sm">
  <Button variant="outline" disabled={busy} onClick={()=>void act('inspect')}>Inspect account recheck recovery</Button>
  {error&&<p role="alert">{error}</p>}
  {view&&<>
   <p>{view.pageLabel} — inspected {new Date(view.observedAt).toISOString()}</p>
   {!view.globalEnabled&&<p>Account recovery admission is off. Normal account observations remain under the existing audit scheduler.</p>}
   {!view.targets.length&&<p>No confirmed pinned account and scoped reset target is available. Use Accounts for pre-claim waiting or identity review.</p>}
   {!!view.targets.length&&<>
    <label className="block">Same-account audit target<select aria-label="Same-account audit target" className="mt-1 block w-full rounded border p-2" value={selected?view.targets.findIndex(t=>JSON.stringify(t)===JSON.stringify(selected))+1:0} disabled={busy||!!r} onChange={event=>{const t=view.targets[Number(event.target.value)-1]??null;setSelected(t);setConfirmed(false);setView({...view,selected:null,record:null,budget:undefined,diagnosis:null})}}><option value="0">Choose the original or a confirmed linked profile</option>{view.targets.map((t,i)=><option key={i} value={i+1}>{t.deviceId} / {t.profileId} — {t.scope.product==='chatgpt'?'ChatGPT':t.scope.product}, {t.scope.feature==='uploads'?'uploads':'generation'}</option>)}</select></label>
    {selected&&<><p>Confirmed account: {selected.accountId}. Quota observed {new Date(selected.quotaObservedAt).toISOString()}; recheck eligible after {new Date(selected.recheckAt).toISOString()}.</p>
     {view.budget&&<p>Shared attempts: {view.budget.used}/3. Quota evidence: {view.quotaState??'unknown'}.</p>}
     {view.profileAudit&&<p>Idle scheduler: {view.profileAudit.state}{view.profileAudit.reason?' ('+view.profileAudit.reason+')':''}.</p>}
     {last?.phase==='executing'&&<p>{last.auditId?'The original audit is running; its claim remains held until the worker acknowledges cleanup.':'Request queued with the existing idle audit scheduler.'}</p>}
     {last?.checkedAt&&<p>Audit source time: {new Date(last.checkedAt).toISOString()}</p>}
     {last?.result&&<p>{outcomes[last.result]??'Inspect the retained original receipt.'}</p>}
     <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={busy||!current||!view.globalEnabled} onChange={event=>setConfirmed(event.target.checked)}/>I confirm this same-account target. One idle check grants no quota and does not switch accounts.</label>
     <div className="flex flex-wrap gap-2">
      <Button disabled={!!blocked} onClick={()=>void act('enable')}>Enable this recheck</Button>
      <Button disabled={!!blocked||!r?.enabled||r.paused} onClick={()=>void act('request')}>Request one idle recheck</Button>
      <Button variant="outline" disabled={busy||!r||r.cancelled||r.paused||last?.phase==='verified'} onClick={()=>void act('pause')}>Pause rechecks</Button>
      <Button variant="outline" disabled={busy||!r||r.cancelled||last?.phase==='verified'} onClick={()=>void act('cancel')}>Cancel rechecks</Button>
     </div>
     <p>Queued requests can be withdrawn. An audit already running retains its original claim until normal cleanup.</p>
     <ol aria-label="Account recheck timeline">{r?.actions.map(a=><li key={a.id}>{new Date(a.at).toISOString()} — {a.result?outcomes[a.result]??a.result:a.phase}</li>)}</ol>
    </>}
   </>}
  </>}
 </section>
}
