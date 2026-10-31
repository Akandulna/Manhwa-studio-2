import {useEffect,useRef,useState} from 'react'
import {Button} from '@/components/ui/button'
const confirmation='I reviewed every required earlier message and external rule for this original task. This exact ordered text inventory is complete; hidden state, non-text attachments and provider settings remain unsupported.'
interface Props {pageId:string;unit:unknown;target:{deviceId:string;profileId:string};packageId:string;onChanged:()=>void}
export default function ManagedInheritedContext({pageId,unit,target,packageId,onChanged}:Props){
 const [packet,setPacket]=useState<any>(null),[reference,setReference]=useState<any>(null),[status,setStatus]=useState<any>(null),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[receipt,setReceipt]=useState<any>(null)
 const wire=useRef(''),pending=useRef<any>(null),epoch=useRef(0),fileRead=useRef(0),active=useRef(true)
 useEffect(()=>{active.current=true;return ()=>{active.current=false;epoch.current++}},[])
 async function load(file:File|undefined,kind:'packet'|'reference'){
  const generation=++fileRead.current;epoch.current++;pending.current=null;setStatus(null);setReceipt(null);setConfirmed(false);setError('')
  if(kind==='packet'){setPacket(null);wire.current=''}else setReference(null)
  try{if(!file||file.size>(kind==='packet'?512000:16000))throw new Error();const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await file.arrayBuffer()),value=JSON.parse(text)
   if(!active.current||generation!==fileRead.current)return
   if(kind==='packet'){if(!Array.isArray(value.entries)||value.entries.length<1||value.entries.length>64||typeof value.packetId!=='string'||value.entries.some((e:any)=>!e||['content','id','kind','sourceId','revision','sha256'].some(k=>typeof e[k]!=='string')||!Number.isSafeInteger(e.bytes)))throw new Error();wire.current=text;setPacket(value)}else setReference(value)
  }catch{if(active.current&&generation===fileRead.current)setError('Choose a bounded UTF-8 context packet and its independently retained reference.')}
 }
 const matching=packet&&reference&&['workspaceId','taskId','attemptId','generation','fingerprint'].every(k=>packet.binding?.unit?.[k]===(unit as any)?.[k])&&packet.binding?.packageId===packageId&&packet.binding?.target?.deviceId===target.deviceId&&packet.binding?.target?.profileId===target.profileId&&packet.packetId===reference.packetId&&['accountId','policyRevision','packageId','sourceSha256','manifestSha256','promptSha256'].every(k=>packet.binding?.[k]===reference.binding?.[k])&&['deviceId','profileId'].every(k=>packet.binding?.target?.[k]===reference.binding?.target?.[k])&&['workspaceId','taskId','attemptId','generation','fingerprint'].every(k=>packet.binding?.unit?.[k]===reference.binding?.unit?.[k])
 async function perform(action:'status'|'review'|'withdraw'){
  if(!matching||busy||action==='review'&&(!confirmed||!status))return
  const turn=epoch.current;setBusy(true);setError('');setConfirmed(false)
  const body=action==='review'?(pending.current??{action,id:crypto.randomUUID(),packetWire:wire.current,reference,requiredEntries:packet.entries.map(({content,...entry}:any)=>entry),supersedesId:status.review?.request.id??null,confirmation}):action==='withdraw'?{action,id:status.review.request.id,binding:status.review.request.binding}:{action,binding:packet.binding}
  if(action==='review')pending.current=body
  try{const response=await fetch('/api/managed-pilot/pages/'+encodeURIComponent(pageId)+'/inherited-context',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
   if(!response.ok)throw new Error();const value=await response.json();if(!active.current||turn!==epoch.current)return
   if(action==='status'){setStatus(value);setReceipt(null)}else{setReceipt(value);setStatus(null);pending.current=null;onChanged()}
  }catch{if(active.current&&turn===epoch.current)setError('Review outcome is unconfirmed. Inspect requirements or retry the same review identity. Provider delivery remains disabled.')}
  finally{if(active.current&&turn===epoch.current)setBusy(false)}
 }
 return <section aria-label="Inherited text requirements" className="space-y-2 rounded border p-3 min-w-0">
  <p>Earlier conversation or external rules required</p>
  <p>Choose the exact local text packet and its independently retained reference. Review every entry below. Text stays on this Studio computer; the relay retains entry IDs, revisions, hashes and byte counts. Native import and provider delivery remain pending.</p>
  <label className="block">Context packet<input className="block max-w-full" type="file" accept=".json" disabled={busy} onChange={e=>void load(e.target.files?.[0],'packet')}/></label>
  <label className="block">Retained packet reference<input className="block max-w-full" type="file" accept=".json" disabled={busy} onChange={e=>void load(e.target.files?.[0],'reference')}/></label>
  {packet&&<><p className="break-all">Packet: {packet.packetId}</p>{packet.entries.map((e:any,i:number)=><details key={i} className="min-w-0"><summary className="break-all">{i+1}. {e.kind} / {e.id} / {e.sourceId} / {e.revision} ({e.bytes} bytes)</summary><pre className="whitespace-pre-wrap break-words text-xs">{e.content}</pre></details>)}</>}
  <Button variant="outline" disabled={busy||!matching} onClick={()=>void perform('status')}>Inspect inherited text requirements</Button>
  {status&&<p>Requirements: {String(status.state).replace(/_/g,' ')}. {status.review?`Original review: ${status.review.request.id}.`:''}</p>}
  {status?.review?.withdrawnAt===null&&<Button variant="outline" disabled={busy} onClick={()=>void perform('withdraw')}>Withdraw inherited text review</Button>}
  {status&&<><label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)}/><span>{confirmation}</span></label><Button variant="outline" disabled={busy||!matching||!confirmed} onClick={()=>void perform('review')}>{pending.current?'Retry original inherited text review':'Review inherited text requirements'}</Button></>}
  {receipt&&<p className="break-all">Retained original review {receipt.request.id}{receipt.withdrawnAt!==null?' — withdrawn':''}. Inspect again to see current requirements. No context delivery was authorized.</p>}
  {error&&<p role="alert">{error}</p>}
 </section>
}
