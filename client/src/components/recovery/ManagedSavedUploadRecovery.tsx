import {useState} from 'react'
import {Button} from '@/components/ui/button'
interface UploadView {
 pageLabel:string;observedAt:number;globalEnabled:boolean
 budget:{used:number;nextEligibleAt:number;pending:boolean;exhausted:boolean}|null
 episode:{fence:Record<string,unknown>;revision:number;enabled:boolean;paused:boolean;cancelled:boolean;actions:{id:string;phase:string;at:number}[]}|null
 diagnosis:{decision:{state:string;reason:string}}|null
}
/** One explicit grant, executed only by the original phone's separate saved-upload action. */
export default function ManagedSavedUploadRecovery({pageId,canonical=false}:{pageId:string;canonical?:boolean}){
 const [view,setView]=useState<UploadView|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[confirmed,setConfirmed]=useState(false)
 async function act(action:string){
  setBusy(true);setError('');setConfirmed(false)
  const actionId=action==='reserve'?crypto.randomUUID():action==='reconcile'?view?.episode?.actions.at(-1)?.id:undefined
  try{
   const r=await fetch('/api/managed-pilot/pages/'+encodeURIComponent(pageId)+'/upload-recovery',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,fence:view?.episode?.fence??null,expectedRevision:view?.episode?.revision??0,...(actionId?{actionId}:{})})})
   if(!r.ok)throw new Error();setView(await r.json())
  }catch{setView(null);setError('Saved-upload outcome is unconfirmed. Inspect the original action before continuing.')}
  finally{setBusy(false)}
 }
 const e=view?.episode,last=e?.actions.at(-1),current=!!view&&Date.now()-view.observedAt<120000
 const held=!view?.globalEnabled||!e||e.cancelled||view.budget?.pending||view.budget?.exhausted||(view.budget?.nextEligibleAt??0)>Date.now()||last?.phase==='verified'
 return <section aria-label="Saved upload recovery" className="space-y-3 rounded border p-3 text-sm">
  <Button variant="outline" disabled={busy} onClick={()=>void act('inspect')}>Inspect saved upload recovery</Button>
  {error&&<p role="alert">{error}</p>}
  {view&&<>
   <p>{view.pageLabel} — evidence {new Date(view.observedAt).toISOString()}</p>
   {!e&&<p>{canonical?'No saved-upload recovery episode exists for this completed task.':'No original-phone saved-byte offer is recorded. On the original phone, use Inspect / execute saved-upload recovery grant.'}</p>}
   {!view.globalEnabled&&<p>Saved-upload recovery is off. Retained outcomes can still be inspected.</p>}
   {e&&<>
    <p>Last inspected shared attempts: {view.budget?.used??0}/3. Upload: {last?.phase??'not started'}.</p>
    <p className="break-all">Saved artifact checksum: {String(e.fence.sha256)}</p>
    {view.diagnosis&&<p>{view.diagnosis.decision.state}: {view.diagnosis.decision.reason}</p>}
    <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={busy||held&&!(e.paused&&last?.phase==='verified'&&view.globalEnabled)} onChange={event=>setConfirmed(event.target.checked)}/>I confirm this original saved packet. A grant permits one cloud transfer on its original phone.</label>
    <div className="flex flex-wrap gap-2">
     <Button disabled={busy||!current||!confirmed||(!e.paused||last?.phase!=='verified')&&held} onClick={()=>void act('enable')}>Enable saved upload</Button>
     <Button disabled={busy||held||!current||!confirmed||!e.enabled||e.paused} onClick={()=>void act('reserve')}>Grant one saved upload</Button>
     <Button variant="outline" disabled={busy||e.cancelled||e.paused||last?.phase==='verified'} onClick={()=>void act('pause')}>Pause saved upload</Button>
     <Button variant="outline" disabled={busy||e.cancelled||last?.phase==='verified'} onClick={()=>void act('cancel')}>Cancel saved upload</Button>
     <Button variant="outline" disabled={busy||!last||!['executing','unknown','verified'].includes(last.phase)} onClick={()=>void act('reconcile')}>Check original cloud upload</Button>
    </div>
    {last?.phase==='reserved'&&<p>Grant retained. On the original phone, use Inspect / execute saved-upload recovery grant once.</p>}
    {last?.phase==='verified'&&<p>Cloud upload verified. Canonical validation and local import remain separate.</p>}
    <ol aria-label="Saved upload timeline">{e.actions.map(a=><li key={a.id}>{new Date(a.at).toISOString()} — {a.phase}</li>)}</ol>
   </>}
  </>}
 </section>
}
