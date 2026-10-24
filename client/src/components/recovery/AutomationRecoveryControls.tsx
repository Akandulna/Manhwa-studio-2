import {useState} from 'react'
import {Button} from '@/components/ui/button'
import type {RecoveryTarget} from './savedCropRecoverySession'
interface Diagnosis {
 revision:number;enabled:boolean;paused:boolean;cancelled:boolean
 evidence:{observedAt:number;failure:string};budget:{used:number;uiUsed:number;pending:boolean}
 decision:{state:string;reason:string;requiredPostcondition:string;recheckAt:number|null}
 history:{at:number;state:string;reason:string}[]
}
/** Same exact target and authority ledger as manual recovery. Controls never start a production job. */
export default function AutomationRecoveryControls({pageId,target}:{pageId:string;target:RecoveryTarget}){
 const [view,setView]=useState<{diagnosis:Diagnosis;globalEnabled:boolean|null}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[confirmed,setConfirmed]=useState(false)
 async function act(action:string){
  setBusy(true);setError('');setConfirmed(false)
  try{const r=await fetch('/api/managed-pilot/pages/'+encodeURIComponent(pageId)+'/automation-recovery',{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',body:JSON.stringify({action,target,expectedRevision:view?.diagnosis.revision??0})});if(!r.ok)throw new Error();setView(await r.json())}
  catch{setView(null);setError('Recovery control is unconfirmed. Inspect again before continuing.')}
  finally{setBusy(false)}
 }
 const d=view?.diagnosis
 return <section aria-label="Automation recovery" className="space-y-2 rounded border p-3 text-sm">
  <Button variant="outline" disabled={busy} onClick={()=>void act('inspect')}>Inspect automation recovery</Button>
  {error&&<p role="alert">{error}</p>}
  {d&&<>
   <p>{d.decision.state}: {d.decision.reason}</p>
   <p>Attempts: {d.budget.used}/3; UI repairs: {d.budget.uiUsed}/2. Evidence: {new Date(d.evidence.observedAt).toISOString()}.</p>
   <p>Verification required: {d.decision.requiredPostcondition}</p>
   {d.decision.recheckAt!==null&&<p>Recheck after {new Date(d.decision.recheckAt).toISOString()}</p>}
   {view?.globalEnabled===false&&<p>Automatic recovery is globally disabled.</p>}
   {view?.globalEnabled===null&&<p>Inspect again to check global recovery admission.</p>}
   <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={busy||!view?.globalEnabled||d.cancelled} onChange={e=>setConfirmed(e.target.checked)}/>Allow a resumed production run to restore this exact saved crop using the shared attempt budget.</label>
   <div className="flex flex-wrap gap-2">
    <Button disabled={busy||!confirmed||!view?.globalEnabled||d.cancelled||d.budget.pending} onClick={()=>void act('enable')}>Allow automatic restore</Button>
    <Button variant="outline" disabled={busy||d.cancelled} onClick={()=>void act('pause')}>Pause automation recovery</Button>
    <Button variant="outline" disabled={busy||d.cancelled} onClick={()=>void act('disable')}>Disable automation recovery</Button>
    <Button variant="outline" disabled={busy||d.cancelled} onClick={()=>void act('cancel')}>Cancel automation recovery</Button>
   </div>
   <ol aria-label="Recovery timeline">{d.history.slice(-10).map((h,i)=><li key={i}>{new Date(h.at).toISOString()} — {h.state}: {h.reason}</li>)}</ol>
  </>}
 </section>
}
