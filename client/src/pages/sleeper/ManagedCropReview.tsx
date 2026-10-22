import ManagedBoundaryEditor from './ManagedBoundaryEditor'
import type {Clipper3ImageCropFile} from '@/lib/api'
import {useEffect,useState} from 'react'
import {Button} from '@/components/ui/button'
interface Review {
 revision:string;appliedFeedbackId?:string;baseRevision?:string;taskId:string;reviewed:boolean;reviewedAt:string|null;chapterId:string;filename:string
 pointers:{image:{width:number;height:number};crops:{id:string;reason:string;crop:{points:{x:number;y:number}[]}}[]}
 metadata:{crops:{id:string;description:string}[]}
 cut:{complete:boolean;files:{filename:string;width:number;height:number;bytes:number;sha256:string}[]}
}
async function request(pageId:string,action='review',body?:unknown):Promise<Review> {
 const response=await fetch('/api/managed-pilot/pages/'+encodeURIComponent(pageId)+'/'+action,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})
 const result=await response.json();if(!response.ok)throw new Error(result.error??'Managed review unavailable')
 return result
}
/** Immutable published input: viewing does not approve it or generate a new provider request. */
export default function ManagedCropReview({pageId,taskId,onChanged}:{pageId:string;taskId:string;onChanged?:()=>void}) {
 const [editingBoundaries,setEditingBoundaries]=useState(false),[pendingBoundaries,setPendingBoundaries]=useState(false)
 const [review,setReview]=useState<Review|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('')
 useEffect(()=>{setReview(null);setError('');setEditingBoundaries(false);setPendingBoundaries(false)},[pageId,taskId])
 async function run(action='review',body?:unknown) {
  setBusy(true);setError('')
  try {const next=await request(pageId,action,body);if(next.taskId!==taskId)throw new Error('This page belongs to a different task. Reopen the current task.');setReview(next);if(body)onChanged?.()}
  catch(e){setError(e instanceof Error?e.message:'Managed review unavailable');setReview(null)}finally{setBusy(false)}
 }
 const decision=(reviewed:boolean)=>{if(review)void run('review',{taskId,expectedRevision:review.revision,reviewed})}
 return <section className="space-y-3 rounded border p-4">
  <h3 className="font-medium">Review published page</h3>
  <Button variant="outline" disabled={busy||editingBoundaries} onClick={()=>void run()}>Open or refresh crop preview</Button>
  {error&&<p role="alert">{error}</p>}
  {review&&<>
   {review.appliedFeedbackId&&<p className="text-sm">Your saved boundary corrections are applied to this revision.</p>}
   <p>{review.filename} · {review.pointers.crops.length} crops · {review.reviewed?'Reviewed':'Needs review'}</p>
   <Button variant="outline" disabled={busy||editingBoundaries||!!review.appliedFeedbackId||review.reviewed||review.cut.complete} onClick={()=>{setEditingBoundaries(true);setPendingBoundaries(true)}}>Adjust boundaries / flag feedback</Button>
   {editingBoundaries&&<ManagedBoundaryEditor key={review.revision} pageId={pageId} taskId={taskId} revision={review.revision} chapterId={review.chapterId} filename={review.filename} pointers={review.pointers as Clipper3ImageCropFile} onPending={setPendingBoundaries} onApplied={()=>{setEditingBoundaries(false);setPendingBoundaries(false);void run()}}/>}
   {!editingBoundaries&&<div className="relative mx-auto max-w-2xl">
    <img className="block w-full" src={`/api/clipper3/chapters/${encodeURIComponent(review.chapterId)}/image/${encodeURIComponent(review.filename)}?revision=${review.revision}`} alt={review.filename}/>
    <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1 1" preserveAspectRatio="none" aria-label="Published crop boundaries">
     {review.pointers.crops.map(c=><polygon key={c.id} points={c.crop.points.map(p=>`${p.x},${p.y}`).join(' ')} fill="rgba(37,99,235,0.08)" stroke="#2563eb" strokeWidth="2" vectorEffect="non-scaling-stroke"/>)}
    </svg>
   </div>}
   {pendingBoundaries&&<p className="text-sm">Boundary feedback is being edited or awaits application. Save it for comparison before approving any cuts.</p>}
   <ol className="space-y-2 text-sm">{review.pointers.crops.map(c=><li key={c.id}><strong>{c.id}</strong>: {c.reason}<p>{review.metadata.crops.find(m=>m.id===c.id)?.description}</p></li>)}</ol>
   <div className="flex flex-wrap gap-2">
    <Button disabled={busy||pendingBoundaries||review.reviewed} onClick={()=>decision(true)}>Mark this page reviewed</Button>
    <Button variant="outline" disabled={busy||!review.reviewed} onClick={()=>decision(false)}>Unmark page review</Button>
    <Button disabled={busy||pendingBoundaries||!review.reviewed||review.cut.complete} onClick={()=>void run('cut',{taskId,expectedRevision:review.revision})}>Cut reviewed page</Button>
   </div>
   <p className="text-sm">{review.cut.complete?`${review.cut.files.length} verified cut files`:'Page cut is incomplete'}. Chapter completion and Editor handoff require their own checks.</p>
   {review.cut.complete&&<ul>{review.cut.files.map(f=><li key={f.filename}><a target="_blank" rel="noreferrer" href={`/api/managed-pilot/pages/${encodeURIComponent(pageId)}/cut/${encodeURIComponent(f.filename)}?revision=${review.revision}`}>{f.filename}</a> · {f.width} × {f.height}</li>)}</ul>}
  </>}
 </section>
}
