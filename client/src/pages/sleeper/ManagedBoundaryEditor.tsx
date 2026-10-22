import {useEffect,useState} from 'react'
import {Button} from '@/components/ui/button'
import {CropPointerEditor} from '@/components/clipper3/CropPointerEditor'
import type {Clipper3ImageCropFile} from '@/lib/api'
interface Boundary {id:string;left:number;top:number;right:number;bottom:number}
interface Feedback {id:string;revision:string;note:string;bounds:Boundary[];changes:{cropId:string;before:Boundary;after:Boundary|null}[]}
interface Props {pageId:string;taskId:string;revision:string;chapterId:string;filename:string;pointers:Clipper3ImageCropFile;onPending:(pending:boolean)=>void;onApplied:()=>void}
const bounds=(file:Clipper3ImageCropFile):Boundary[]=>file.crops.map(c=>({id:c.id,left:Math.min(...c.crop.points.map(p=>p.x)),top:Math.min(...c.crop.points.map(p=>p.y)),right:Math.max(...c.crop.points.map(p=>p.x)),bottom:Math.max(...c.crop.points.map(p=>p.y))}))
function apply(file:Clipper3ImageCropFile,values:Boundary[]):Clipper3ImageCropFile {return {...file,crops:file.crops.filter(c=>values.some(b=>b.id===c.id)).map(c=>{const b=values.find(b=>b.id===c.id)!;return {...c,crop:{mode:'rectangle',points:[{id:'P1',x:b.left,y:b.top},{id:'P2',x:b.right,y:b.top},{id:'P3',x:b.right,y:b.bottom},{id:'P4',x:b.left,y:b.bottom}]}}})}}
export default function ManagedBoundaryEditor(p:Props){
 const [draft,setDraft]=useState(p.pointers),[feedback,setFeedback]=useState<Feedback|null>(null),[note,setNote]=useState(''),[busy,setBusy]=useState(true),[error,setError]=useState(''),[dirty,setDirty]=useState(false),[dragging,setDragging]=useState(false),[zoom,setZoom]=useState(0.8)
 const url='/api/managed-pilot/pages/'+encodeURIComponent(p.pageId)+'/boundary-feedback'
 useEffect(()=>{let live=true;setBusy(true);fetch(url).then(async r=>{const v=await r.json();if(!r.ok)throw Error(v.error);if(v.revision!==p.revision||v.taskId!==p.taskId)throw Error('Published page changed; refresh the crop preview');if(!live)return;setFeedback(v.feedback);p.onPending(!!v.feedback?.changes.length);if(v.feedback){if(v.feedback.revision!==p.revision)throw Error('Saved feedback belongs to an older revision; keep it for comparison and refresh');setDraft(apply(p.pointers,v.feedback.bounds));setNote(v.feedback.note);p.onPending(!!v.feedback.changes.length)}}).catch(e=>{if(live){setError(e.message);p.onPending(true)}}).finally(()=>{if(live)setBusy(false)});return()=>{live=false}},[url,p.revision,p.taskId])
 useEffect(()=>{if(!dirty)return;const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue=''};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn)},[dirty])
 async function save(){setBusy(true);setError('');try{const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({taskId:p.taskId,expectedRevision:p.revision,expectedFeedbackId:feedback?.id??null,bounds:bounds(draft),note})});const v=await r.json();if(!r.ok)throw Error(v.error);setFeedback(v.feedback);setDirty(false);p.onPending(!!v.feedback.changes.length)}catch(e){setError(e instanceof Error?e.message:'Feedback not saved')}finally{setBusy(false)}}
 async function applySaved(){if(!feedback||dirty)return;setBusy(true);setError('');try{const r=await fetch('/api/managed-pilot/pages/'+encodeURIComponent(p.pageId)+'/apply-boundaries',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({taskId:p.taskId,expectedRevision:p.revision,feedbackId:feedback.id})});const v=await r.json();if(!r.ok)throw Error(v.error);p.onApplied()}catch(e){setError(e instanceof Error?e.message:'Corrections not applied')}finally{setBusy(false)}}
 return <div className="space-y-3 rounded border p-3">
  <h4 className="font-medium">Manual boundary feedback</h4>
  <p className="text-sm">Select a crop, then drag its box or corner handles. Save your feedback when finished. Your original and adjusted coordinates are recorded for comparison; this does not approve or cut the page. Apply saved boundaries when ready to review the corrected revision.</p>
  {error&&<p role="alert">{error}</p>}
  <div className="sticky top-0 z-30 flex flex-wrap items-center gap-3 rounded border bg-background p-3">
   <Button disabled={busy||dragging||!dirty} onClick={()=>void save()}>Save boundary feedback</Button>
   <Button variant="outline" disabled={busy||dragging} onClick={()=>{setDraft(p.pointers);setDirty(true);p.onPending(true)}}>Reset draft to original</Button>
   <label>Zoom <input aria-label="Boundary editor zoom" type="range" min="0.4" max="1.4" step="0.1" value={zoom} onChange={e=>setZoom(Number(e.target.value))}/></label>
   <span role="status">{busy?'Loading or saving…':dirty?'Unsaved boundary feedback':feedback?`Saved · ${feedback.changes.length} changed crops`:'No saved changes'}</span>
  </div>
  <label className="block text-sm">What should I learn from these changes? (optional)<textarea className="mt-1 block w-full rounded border bg-background p-2" maxLength={4000} value={note} onChange={e=>{setNote(e.target.value);setDirty(true);p.onPending(true)}} placeholder="For example: include the entire speech bubble; keep this continuous scene together."/></label>
  {!busy&&!error&&<div className="overflow-x-auto"><CropPointerEditor reviewMode chapterId={p.chapterId} filename={p.filename} width={p.pointers.image.width!} height={p.pointers.image.height!} zoom={zoom} initialFile={draft} onInteractionChange={setDragging} onCommit={file=>{setDraft(file);setDirty(true);p.onPending(true)}}/></div>}
  {feedback&&!!feedback.changes.length&&<Button disabled={busy||dirty||dragging} onClick={()=>void applySaved()}>Apply saved boundaries for review</Button>}
  {feedback&&<p className="text-sm">Saved changes: {feedback.changes.map(c=>c.cropId+(c.after?' adjusted':' removed')).join(', ')||'none'}. Your notes and each saved version are retained.</p>}
 </div>
}
