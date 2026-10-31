import {useState} from 'react'
import {Button} from '@/components/ui/button'
interface View {evidence:{observation:{id:string;failure:string;observedAt:number;outcome:string;uiChangeId:string|null;correctionContext?:{capturedAt:number;state:string;lockedCandidates:number;failedCandidates:number;executable:false;portable:false;liveConversationVerified:false};session?:{observedAt:number;context:string;documentKind:string;composer:string;attachments:string;response:string;cachedSourceVerified:boolean;login:string}};receivedAt:number}[];outcome:string;stale:boolean;budget:{used:number};diagnosis:{decision:{state:string;reason:string}}|null}
const labels:Record<string,string>={generation_quota:'Generation quota block',upload_allowance:'Attachment upload allowance block',unsupported_attachment:'Unsupported attachment chooser',signed_out:'Signed out',missing_control:'Required control missing',network_timeout:'Network timeout',executor_stopped:'Executor stopped',malformed_output:'Output validation failed',cloud_transfer:'Saved cloud transfer unavailable',unknown:'Unclassified failure'}
export default function ManagedExecutorEvidence({pageId}:{pageId:string}){
 const [view,setView]=useState<View|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('')
 async function inspect(){setBusy(true);setError('');try{const r=await fetch('/api/managed-pilot/pages/'+encodeURIComponent(pageId)+'/executor-evidence',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',cache:'no-store'});if(!r.ok)throw new Error();setView(await r.json())}catch{setView(null);setError('Observation inspection unavailable. Original work and receipts remain retained.')}finally{setBusy(false)}}
 return <section aria-label="Executor failure observations" className="space-y-3 rounded border p-3 text-sm">
  <Button variant="outline" disabled={busy} onClick={()=>void inspect()}>Inspect phone failure observations</Button>
  <p>Read-only diagnosis. Observations grant no repair, resend, account switch or quota capacity.</p>
  {error&&<p role="alert">{error}</p>}
  {view&&<>
   <p>Authority outcome: {view.outcome}. Shared recovery attempts: {view.budget.used}/3.</p>
   {!view.evidence.length&&<p>No original phone observation is available. A compatible phone can explicitly deliver a retained observation.</p>}
   {view.stale&&<p>Source evidence is stale or superseded. Its source time is retained; a newer observation is required.</p>}
   {view.diagnosis&&<p>Diagnosis: {view.diagnosis.decision.state}. {view.diagnosis.decision.reason}</p>}
   <ol aria-label="Original phone failure timeline" className="space-y-3">{view.evidence.map(({observation:e,receivedAt})=><li key={e.id}>
    <p>{labels[e.failure]??'Unclassified failure'} — journal outcome: {e.outcome}.</p>
    <p>Observed {new Date(e.observedAt).toISOString()}. Received {new Date(receivedAt).toISOString()}.</p>
    {e.session&&<div className="space-y-1 rounded border p-2">
     <p>Original session checkpoint: {e.session.context==='empty_unsent'?'empty unsent page observed':'held for inspection'} at {new Date(e.session.observedAt).toISOString()}.</p>
     <p>Composer: {e.session.composer}. Attachments: {e.session.attachments}. Response: {e.session.response}. Original cached input: {e.session.cachedSourceVerified?'verified':'unverified'}.</p>
     <p>This observation grants no navigation or resend. Login and quota readiness require separate verification.</p>
    </div>}
    {e.correctionContext&&<div className="space-y-1 rounded border p-2">
     <p>Original private correction context: {e.correctionContext.state==='scoped'?'failed fields scoped':'held for owner review'}; captured {new Date(e.correctionContext.capturedAt).toISOString()}.</p>
     <p>Validator-valid candidates locked: {e.correctionContext.lockedCandidates}. Candidates with failed fields: {e.correctionContext.failedCandidates}.</p>
     <p>{e.correctionContext.state==='scoped'?'The original phone can validate a private draft.':'The original phone retains the ambiguous correction scope for review.'} Raw reply and draft stay private; this evidence grants no correction execution, publication, live-conversation restoration or account fallback.</p>
    </div>}
    {e.uiChangeId&&<p>Linked recent profile UI incident. The device manager keeps its original incident and review controls.</p>}
   </li>)}</ol>
  </>}
 </section>
}
