import {useEffect,useRef,useState} from 'react'
import {Button} from '@/components/ui/button'
const hold='Keep this recovery family held; preserve all charges, claims and uncertain outcomes. Do not resume or resend work.'
const close='Close only this unused recovery approval; preserve its charge and evidence. Do not resume or resend work.'
export default function ManagedFamilyDispositionControls({unit}:{unit:object}){
 const [snapshot,setSnapshot]=useState<any>(null),[selection,setSelection]=useState('hold'),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[pending,setPending]=useState<any>(null),[message,setMessage]=useState(''),mounted=useRef(true)
 const key='managed-family-dispositions/'+JSON.stringify(unit)
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
 function journal(){const v=JSON.parse(localStorage.getItem(key)??'[]');if(!Array.isArray(v)||v.length>16)throw new Error();return v}
 function save(records:any[]){if(records.length>16)throw new Error();localStorage.setItem(key,JSON.stringify(records))}
 async function call(body:object){const r=await fetch('/api/managed-pilot/recovery-disposition',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw new Error();return r.json()}
 async function inspect(){setBusy(true);setConfirmed(false);try{
  const old=journal().find((r:any)=>r.receipt===null);if(old){setPending(old.intent);setSnapshot(null);setMessage('An original saved decision needs reconciliation before another inspection.');return}
  const value=await call({action:'inspect',unit});if(mounted.current){setSnapshot(value);setSelection('hold');setMessage('')}
 }catch{if(mounted.current)setMessage('Family inspection is unavailable. Preserve the original holds and evidence.')}finally{if(mounted.current)setBusy(false)}}
 async function decide(reconcile=false){
  if(busy)return
  let intent=pending
  setBusy(true);setConfirmed(false)
  try{
   let records=journal()
   if(!reconcile){
    if(!snapshot||!confirmed||Date.now()-snapshot.checkedAt>=15000||records.some((r:any)=>r.receipt===null))throw new Error()
    const reference=selection==='hold'?null:snapshot.actions[Number(selection)].reference
    intent={schema:'recovery-family-disposition/1',eventId:crypto.randomUUID(),unit,mode:reference?'close_unused':'retain_hold',reference,production:null,inspectedAt:snapshot.checkedAt,inspectionToken:snapshot.inspectionToken,confirmation:reference?close:hold}
    records.push({intent,receipt:null});save(records);setPending(intent)
   }
   if(!intent)throw new Error()
   let receipt=reconcile?await call({action:'resolve',intent}):null
   if(receipt===null)receipt=await call({action:'apply',intent})
   if(JSON.stringify(receipt.intent)!==JSON.stringify(intent))throw new Error()
   records=journal();const record=records.find((r:any)=>r.intent.eventId===intent.eventId);if(!record)throw new Error();record.receipt=receipt;save(records)
   if(mounted.current){setPending(null);setSnapshot(null);setMessage(receipt.state==='applied'?'Original disposition acknowledged. Charges, claims and evidence are retained; no work resumed.':'Original decision expired without applying. Its audit is retained. Inspect afresh before another decision.')}
  }catch{if(mounted.current){setSnapshot(null);setMessage('Disposition is held or unconfirmed. Reconcile the original saved decision; do not replace its identity or assume an unknown action was unused.')}}finally{if(mounted.current)setBusy(false)}
 }
 return <section aria-label="Recovery family disposition" className="space-y-2 rounded border p-3 text-sm">
  <h3 className="font-semibold">Recovery family disposition</h3>
  <p>Inspect every linked recovery ledger. Unknown and started effects keep their original outcomes and receipts.</p>
  <Button variant="outline" disabled={busy||!!pending} onClick={()=>void inspect()}>Inspect original recovery family</Button>
  {pending&&<Button variant="outline" disabled={busy} onClick={()=>void decide(true)}>Reconcile saved family decision</Button>}
  {snapshot&&<>
   <p>{snapshot.budget.used}/3 original actions charged; {snapshot.budget.pending?'an original outcome remains pending':'no pending recovery effect'}. {snapshot.units.length} linked attempt(s).</p>
   <ul>{snapshot.actions.map((a:any)=><li className="break-all" key={a.reference.actionId}>{a.reference.actionId}: {a.phase}. {a.productionRequired?'Use the original production run to dispose its unused pending intent.':!a.unusedClosable?'Original outcome stays retained.':''}</li>)}</ul>
   <label className="block">Disposition<select className="w-full rounded border p-2" value={selection} disabled={busy} onChange={e=>{setSelection(e.target.value);setConfirmed(false)}}><option value="hold">Keep family held</option>{snapshot.actions.map((a:any,index:number)=>a.unusedClosable&&!a.productionRequired?<option key={a.reference.actionId} value={index}>Close unused approval {a.reference.actionId}</option>:null)}</select></label>
   <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)}/><span>{selection==='hold'?hold:close}</span></label>
   <Button variant="outline" disabled={busy||!confirmed} onClick={()=>void decide()}>Record exact family disposition</Button>
   <p>{snapshot.history.length} original disposition receipt(s) retained. Inspection never resumes work or resets an allowance.</p>
  </>}
  {message&&<p role="status">{message}</p>}
 </section>
}
