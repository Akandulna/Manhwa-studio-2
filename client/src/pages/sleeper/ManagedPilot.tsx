import {productionApi,type ProductionJob,type ProductionReconciliation} from '@/lib/api'
import {useSocket} from '@/lib/socket'
import ManagedCropReview from './ManagedCropReview'
import {useEffect,useState} from 'react'
import {Link} from 'react-router-dom'
import {Button} from '@/components/ui/button'
import {Card,CardContent} from '@/components/ui/card'
interface Options {enabled:boolean;workspaceId:string|null;series:{id:string;title:string}[];profiles:{device:string;deviceName:string;id:string;name:string}[];policy:string}
interface Timeline {task:{id:string;state:string;generation:number;fingerprint:string;canonical:string|null};attempt:{id:string;activeCommandId:string;checkpointRef:string|null;phase:string;submission:string;leaseExpiresAt:string;deviceId:string;profileId:string}|null;commands:{id:string;action:string;phase:string}[];cancelledUnknownReport?:{id:string;startCommandId:string;stopCommandId:string;evidenceDigest:string;checkpointCount:0;completedReplyRetained:false;resolvedAt:string|null}|null;cancelledSubmissionReport?:{id:string;startCommandId:string;completedReplyHash:string;evidenceDigest:string;checkpointCount:number;resolvedAt:string|null}|null;uploadOnlyReport?:{id:string;startCommandId:string;stopCommandId:string;uploadRecorded:true;submitRecorded:false;checkpointCount:0;resolvedAt:string|null}|null}
async function api<T>(route:string,body?:unknown):Promise<T> {
 const response=await fetch('/api'+route,{...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})})
 const result=await response.json();if(!response.ok)throw new Error(result.error??'Managed pilot unavailable');return result
}
export default function ManagedPilot() {
 const [productionSeries,setProductionSeries]=useState(''),[productionJob,setProductionJob]=useState<ProductionJob|null>(null)
 const [reconciliation,setReconciliation]=useState<ProductionReconciliation|null>(null)
 useEffect(()=>setReconciliation(null),[productionSeries,productionJob?.id,productionJob?.revision])
 const [portableRun,setPortableRun]=useState(''),[fleetProfiles,setFleetProfiles]=useState<string[]>([])
 const {socket}=useSocket()
 useEffect(()=>{setProductionJob(null);if(!productionSeries)return;let current=true;void productionApi.get(productionSeries).then(result=>{if(current)setProductionJob(result.job)}).catch(()=>{if(current)setProductionJob(null)});return()=>{current=false}},[productionSeries])
 useEffect(()=>{if(!socket)return;const receive=(job:ProductionJob)=>{if(job.seriesId===productionSeries)setProductionJob(job)};socket.on('production:updated',receive);return()=>{socket.off('production:updated',receive)}},[socket,productionSeries])
 const [options,setOptions]=useState<Options|null>(null),[series,setSeries]=useState(''),[chapter,setChapter]=useState(''),[page,setPage]=useState(''),[profile,setProfile]=useState('')
 const [chapters,setChapters]=useState<{id:string;number:number}[]>([]),[pages,setPages]=useState<{id:string;index:number;status:string}[]>([])
 const [taskLookup,setTaskLookup]=useState(''),[transferTarget,setTransferTarget]=useState('')
 const [task,setTask]=useState<Timeline|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('')
 useEffect(()=>{void api<Options>('/managed-pilot/options').then(setOptions).catch(e=>setMessage(e.message))},[])
 useEffect(()=>{setChapter('');setPage('');setChapters([]);if(series){let current=true;void api<{chapters:{id:string;number:number}[]}>(`/series/${encodeURIComponent(series)}`).then(r=>{if(current)setChapters(r.chapters)}).catch(e=>setMessage(e.message));return()=>{current=false}}},[series])
 useEffect(()=>{setPage('');setPages([]);if(chapter){let current=true;void api<{pages:{id:string;index:number;status:string}[]}>(`/chapters/${encodeURIComponent(chapter)}`).then(r=>{if(current)setPages(r.pages)}).catch(e=>setMessage(e.message));return()=>{current=false}}},[chapter])
 async function work(operation:()=>Promise<void>){setBusy(true);setMessage('');try{await operation()}catch(e){setMessage(e instanceof Error?e.message:'Operation unavailable')}finally{setBusy(false)}}
 const selected=options?.profiles.find(p=>`${p.device}:${p.id}`===profile)??options?.profiles.find(p=>p.device===task?.attempt?.deviceId&&p.id===task?.attempt?.profileId)
 const locked=!!task
 const selectClass='rounded border bg-background p-2 text-sm w-full'
 async function refresh(){if(task)setTask(await api<Timeline>('/managed-pilot/tasks/'+encodeURIComponent(task.task.id)))}
 return <div className="mx-auto max-w-3xl space-y-5 p-6">
  <Link to="/sleeper-cells" className="text-sm underline">Back to Phone Status</Link>
  <h1 className="text-2xl font-semibold">Managed page pilot</h1>
  <p className="text-sm text-muted-foreground">One page on one paired phone. Uses ChatGPT’s available default model without model selection. Saved results are recovered without resending the prompt; uncertain outcomes wait for reconciliation.</p>
  {options&&!options.enabled&&<p role="status" className="rounded border p-3 text-sm">Managed dispatch is disabled. The relay, separate managed credentials and artifact storage must be configured before pairing.</p>}
  {options?.enabled&&<p className="text-sm">On the phone: Tools → Settings → Cloudflare R2 → Managed page pilot. Pair the selected profile using workspace <strong>{options.workspaceId}</strong> and its separate device token. Pairing blocks legacy automation until reconciled unpairing.</p>}
  <Card><CardContent className="space-y-4 p-5">
   <label className="block text-sm">Series<select className={selectClass} value={series} disabled={busy||locked} onChange={e=>setSeries(e.target.value)}><option value="">Choose series</option>{options?.series.map(s=><option key={s.id} value={s.id}>{s.title}</option>)}</select></label>
   <label className="block text-sm">Chapter<select className={selectClass} value={chapter} disabled={busy||locked} onChange={e=>setChapter(e.target.value)}><option value="">Choose chapter</option>{chapters.map(c=><option key={c.id} value={c.id}>Chapter {c.number}</option>)}</select></label>
   <label className="block text-sm">Page<select className={selectClass} value={page} disabled={busy||locked} onChange={e=>setPage(e.target.value)}><option value="">Choose page</option>{pages.filter(p=>p.status==='done').map(p=><option key={p.id} value={p.id}>Page {p.index+1}</option>)}</select></label>
   <label className="block text-sm">Phone and profile<select className={selectClass} value={profile} disabled={busy||locked} onChange={e=>setProfile(e.target.value)}><option value="">Choose paired profile</option>{options?.profiles.map(p=><option key={`${p.device}:${p.id}`} value={`${p.device}:${p.id}`}>{p.deviceName} · {p.name}</option>)}</select></label>
   <Button disabled={busy||locked||!options?.enabled||!page||!selected} onClick={()=>void work(async()=>{const result=await api<Timeline>('/managed-pilot/start',{pageId:page,deviceId:selected!.device,profileId:selected!.id});setTask(result);localStorage.setItem('managed-pilot-view',JSON.stringify({taskId:result.task.id,pageId:page}));setMessage('Page assigned. On the phone, open Managed page pilot and tap Check task / run. After the output is uploaded, import it here.');})}>Enroll phone and assign page</Button>
  </CardContent></Card>
  <Card><CardContent className="space-y-3 p-5">
   <h2 className="font-medium">Managed crop production</h2>
   <p className="text-sm text-muted-foreground">All prepared pages in one series, assigned one at a time per explicitly selected phone. Healthy phones continue distinct pages while retained work waits. Studio validates saved outputs automatically. On the phone, use Check task / run for each assignment and reconcile each publication. Stops before page review; scripts and voiceovers are separate workflows.</p>
   <label className="block text-sm">Production series<select className={selectClass} value={productionSeries} disabled={busy||productionJob?.status==='running'} onChange={e=>setProductionSeries(e.target.value)}><option value="">Choose prepared series</option>{options?.series.map(value=><option key={value.id} value={value.id}>{value.title}</option>)}</select></label>
   <label className="block text-sm">Additional managed phones<select multiple className={selectClass} value={fleetProfiles} disabled={busy||productionJob?.status==='running'} onChange={e=>setFleetProfiles([...e.target.selectedOptions].map(o=>o.value))}>{options?.profiles.filter(p=>p.device!==selected?.device).map(p=><option key={`${p.device}:${p.id}`} value={`${p.device}:${p.id}`}>{p.deviceName} · {p.name}</option>)}</select></label>
   <Button disabled={busy||!options?.enabled||!productionSeries||!selected||productionJob?.status==='running'||!!(productionJob?.config.managedCrop&&['failed','interrupted','cancelled'].includes(productionJob.status))} onClick={()=>void work(async()=>{
    setProductionJob(await productionApi.start(productionSeries,{device:selected!.device,profileId:selected!.id,managedCrop:true,...(fleetProfiles.length?{managedDevices:fleetProfiles.map(key=>{const p=options!.profiles.find(p=>`${p.device}:${p.id}`===key)!;return {device:p.device,profileId:p.id}})}:{}),clipper:{ai:'chatgpt',flow:'classic',tabs:1,chatGpt:{mode:null,model:null,effort:null}}}))
   })}>Run managed crop pages</Button>
   <label className="block text-sm">Portable saved run<textarea className={selectClass} rows={4} value={portableRun} onChange={e=>setPortableRun(e.target.value)} placeholder="Export a reconciled run here, or paste its bundle in another Studio database with the same prepared sources."/></label>
   <Button variant="outline" disabled={busy||!productionSeries||!portableRun||!!productionJob} onClick={()=>void work(async()=>{setProductionJob(await productionApi.adoptRun(productionSeries,JSON.parse(portableRun)));setReconciliation(null);setMessage('Original run adopted without dispatch. Inspect it in this Studio before resuming.');})}>Adopt original run without dispatch</Button>
   {productionJob&&<div role="status" className="space-y-2 text-sm"><p>{productionJob.status} · {productionJob.message}</p>
    <Button variant="outline" disabled={busy} onClick={()=>void work(async()=>setProductionJob((await productionApi.get(productionSeries)).job))}>Refresh production</Button>
    <Button variant="outline" disabled={busy||!productionJob.config.managedCrop||!['interrupted','failed'].includes(productionJob.status)} onClick={()=>void work(async()=>{const bundle=await productionApi.exportRun(productionSeries,{jobId:productionJob.id,revision:productionJob.revision??0});setPortableRun(JSON.stringify(bundle,null,2));setMessage('Portable run exported. The destination must verify original receipts and exact prepared sources before adoption.');})}>Export original run</Button>
    <Button variant="outline" disabled={busy||!productionJob.config.managedCrop} onClick={()=>void work(async()=>{
     const selectedJob=productionJob;setReconciliation(null)
     setReconciliation(await productionApi.reconcile(productionSeries,{jobId:selectedJob.id,revision:selectedJob.revision??0}))
    })}>Inspect saved run (no provider work)</Button>
    {reconciliation&&reconciliation.jobId===productionJob.id&&reconciliation.revision===(productionJob.revision??0)&&<div className="space-y-2 rounded border p-3" aria-label="Saved run reconciliation">
     <p>Read-only observation · {new Date(reconciliation.checkedAt).toLocaleString()}. Refresh after any task or job change. Resume and handoff recheck current ownership and the exact saved run.</p>
     <p>{reconciliation.requiresAttention?'Retained work needs reconciliation.':'Original claim evidence observed.'} Unassigned prepared pages: {reconciliation.unassignedPages}.</p>
     {!reconciliation.observations.length&&<p>No saved task receipts in this run. No page was assigned.</p>}
     <ul className="space-y-2">{reconciliation.observations.map(row=><li key={row.taskId}><strong>Task {row.taskId.slice(-8)} · {row.state.replace(/_/g,' ')}</strong><p>{row.message}</p>{row.owner&&<p>Original/current observation: attempt {row.owner.generation} · {row.owner.deviceId} · {row.owner.profileId} · {row.owner.submission}.</p>}</li>)}</ul>
     <Button disabled={busy||reconciliation.requiresAttention||!['failed','interrupted'].includes(productionJob.status)} onClick={()=>void work(async()=>{
      const expected={jobId:reconciliation.jobId,revision:reconciliation.revision,scopeDigest:reconciliation.scopeDigest}
      setReconciliation(null)
      setProductionJob(await productionApi.resume(productionSeries,expected))
      setMessage('Original managed run resumed after fresh ownership checks. Use the phone’s managed controls only for its current assignment.')
     })}>Resume inspected run</Button>
    </div>}
    {productionJob.resumedFrom&&<p>Resumed from saved revision {productionJob.resumedFrom.revision}; original claim receipts retained.</p>}
    {productionJob.pendingHandoff&&<Button variant="outline" disabled={busy} onClick={()=>void work(async()=>{setProductionJob(await productionApi.handoff(productionSeries,{jobId:productionJob.id,revision:productionJob.revision??0,intentId:productionJob.pendingHandoff!.eventId}));setReconciliation(null);setMessage('Pending authority handoff reconciled. Inspect the updated run before resuming.');})}>Finish pending production handoff</Button>}
    {task&&productionJob.command?.managedClaims?.some(c=>c.taskId===task.task.id)&&<div className="space-y-2 rounded border p-3">
     <p>Production handoff for the open task. Pause scheduling first; the phone must acknowledge confirmed unsent before transfer.</p>
     <Button variant="outline" disabled={busy||!!productionJob.pendingHandoff||!['running','failed','interrupted'].includes(productionJob.status)} onClick={()=>void work(async()=>{setProductionJob(await productionApi.pauseHandoff(productionSeries,{jobId:productionJob.id,revision:productionJob.revision??0,taskId:task.task.id}));await refresh();setMessage('Scheduling paused. On the current phone, check managed work to acknowledge Stop. Refresh this task before handoff.');})}>Pause run and request task stop</Button>
     <label className="block text-sm">Production handoff target<select className={selectClass} value={transferTarget} disabled={busy} onChange={e=>setTransferTarget(e.target.value)}><option value="">Choose another paired phone</option>{options?.profiles.filter(p=>p.device!==task.attempt?.deviceId).map(p=><option key={`${p.device}:${p.id}`} value={`${p.device}:${p.id}`}>{p.deviceName} · {p.name}</option>)}</select></label>
     <Button variant="outline" disabled={busy||!!productionJob.pendingHandoff||!['failed','interrupted'].includes(productionJob.status)||!transferTarget||task.task.state!=='paused'||task.attempt?.phase!=='stop_confirmed'||task.attempt?.submission!=='unsent'||task.attempt?.checkpointRef!==null} onClick={()=>void work(async()=>{const target=options!.profiles.find(p=>`${p.device}:${p.id}`===transferTarget)!;setProductionJob(await productionApi.handoff(productionSeries,{jobId:productionJob.id,revision:productionJob.revision??0,taskId:task.task.id,attemptId:task.attempt!.id,generation:task.task.generation,fingerprint:task.task.fingerprint,stopCommandId:task.attempt!.activeCommandId,deviceId:target.device,profileId:target.id}));await refresh();setReconciliation(null);setMessage('Confirmed-unsent production handoff applied. Inspect the updated run, then resume. No provider request was sent by handoff.');})}>Hand off confirmed-unsent production task</Button>
    </div>}
    {(productionJob.status==='running'||productionJob.config.managedCrop&&['failed','interrupted'].includes(productionJob.status))&&<Button variant="outline" disabled={busy} onClick={()=>void work(async()=>setProductionJob(await productionApi.stop(productionSeries)))}>Stop managed production</Button>}
    {productionJob.command?.managedTaskIds?.map(id=><Button variant="ghost" size="sm" key={id} disabled={busy} onClick={()=>void work(async()=>{setTask(await api<Timeline>('/managed-pilot/tasks/'+encodeURIComponent(id)));setPage('');setMessage('Read-only production task timeline. Select its source page after closing this retained task view to review the publication.');})}>Open task {id.slice(-8)}</Button>)}
   </div>}
  </CardContent></Card>
  {!task&&<div className="space-y-2"><label className="block text-sm">Task ID from phone inspection<input className={selectClass} value={taskLookup} onChange={e=>setTaskLookup(e.target.value)} placeholder="task:sha256:…" /></label><Button variant="outline" disabled={busy||!/^task:sha256:[a-f0-9]{64}$/.test(taskLookup.trim())} onClick={()=>void work(async()=>{const id=taskLookup.trim();setTask(await api<Timeline>('/managed-pilot/tasks/'+encodeURIComponent(id)));localStorage.setItem('managed-pilot-view',JSON.stringify({taskId:id,pageId:page}));})}>Open retained task</Button></div>}
  {!task&&<Button variant="outline" disabled={busy||!options?.enabled} onClick={()=>void work(async()=>{const saved=JSON.parse(localStorage.getItem('managed-pilot-view')??'null');if(!saved?.taskId)throw new Error('No saved task view on this browser.');setTask(await api<Timeline>('/managed-pilot/tasks/'+encodeURIComponent(saved.taskId)));setPage(saved.pageId);})}>Reopen last task view</Button>}
  {task&&<Card><CardContent className="space-y-3 p-5">
   <h2 className="font-medium">Page: {task.task.state.replace(/_/g,' ')}</h2>
   <Button variant="ghost" size="sm" disabled={busy} onClick={()=>{setTask(null);localStorage.removeItem('managed-pilot-view')}}>Close task view</Button>
   <p className="text-sm">Attempt {task.task.generation} · {task.attempt?.phase.replace(/_/g,' ')??'not claimed'} · provider outcome {task.attempt?.submission??'unsent'}</p>
   {task.attempt&&<p className="text-sm">Owner: {options?.profiles.find(p=>p.device===task.attempt!.deviceId&&p.id===task.attempt!.profileId)?.deviceName??task.attempt.deviceId} · {task.attempt.profileId}. Lease: {new Date(task.attempt.leaseExpiresAt).toLocaleString()}. Expiry alone does not release ownership.</p>}
   {task.uploadOnlyReport&&<p className="text-sm">Worker evidence: upload recorded, Send not recorded, no checkpoints. Original command {task.uploadOnlyReport.startCommandId}. {task.uploadOnlyReport.resolvedAt?'Reviewed upload-only cancellation; task history and source binding retained.':'Review this evidence and the provider tab before releasing the phone hold.'}</p>}
   {task.cancelledSubmissionReport&&<p className="text-sm">Cancelled reply retained privately. Checkpoints: {task.cancelledSubmissionReport.checkpointCount}. Completed reply hash: {task.cancelledSubmissionReport.completedReplyHash}. {task.cancelledSubmissionReport.resolvedAt?'Discard reviewed; task remains cancelled.':'Review the original conversation and worker evidence before discarding this output.'}</p>}
   {task.cancelledUnknownReport&&<p className="text-sm">Cancelled attempt has an unknown provider outcome and no retained reply. {task.cancelledUnknownReport.resolvedAt?'Abandonment reviewed. The original page remains quarantined; no retry or publication is permitted.':'Reviewing abandonment releases only this phone for other pages. It does not prove that ChatGPT received nothing. The original page remains quarantined.'}</p>}
   <div className="flex flex-wrap gap-2">
    <Button variant="outline" disabled={busy} onClick={()=>void work(refresh)}>Refresh task</Button>
    <Button disabled={busy||!page||!['running','verified_complete'].includes(task.task.state)} onClick={()=>void work(async()=>{await api('/managed-pilot/import',{pageId:page,taskId:task.task.id});await refresh();setMessage('Verified crop output imported. On the phone, Check task / run again to reconcile the completed attempt. Review the page in Image Clipper.');})}>Import saved result</Button>
    <Button variant="outline" disabled={busy||!page||task.task.state!=='uncertain'||task.attempt?.phase!=='result_saved'} onClick={()=>void work(async()=>{await api('/managed-pilot/import-recovered',{pageId:page,taskId:task.task.id});await refresh();setMessage('Retained saved output validated and published. On the phone, Check task / run to reconcile. No provider prompt was regenerated.');})}>Validate and publish recovered result</Button>
    {task.uploadOnlyReport&&!task.uploadOnlyReport.resolvedAt&&<Button variant="outline" disabled={busy||task.task.state!=='cancelled'||task.attempt?.phase!=='stop_confirmed'||task.attempt?.submission!=='unknown'} onClick={()=>{
     if(!window.confirm('Release cancelled upload-only task '+task.task.id+' after reviewing its worker evidence and provider tab? The task remains cancelled and unknown in history. This does not retry or publish the page.'))return
     void work(async()=>{await api('/managed-pilot/resolve-upload-only',{taskId:task.task.id,reportId:task.uploadOnlyReport!.id,confirmUploadOnly:true});await refresh();setMessage('Upload-only cancellation reviewed. On the phone, tap Request / check upload-only reconciliation again to validate the receipt and release its local hold. Pairing and source binding remain.');})
    }}>Review and release upload-only hold</Button>}
    {task.cancelledSubmissionReport&&!task.cancelledSubmissionReport.resolvedAt&&<Button variant="outline" disabled={busy||task.task.state!=='cancelled'||task.attempt?.phase!=='stop_confirmed'||task.attempt?.submission!=='submitted'} onClick={()=>{
     if(!window.confirm('Discard the completed reply for cancelled task '+task.task.id+' and release only its phone hold? Review the original conversation and retained evidence first. History and evidence remain; this cannot retry or publish the page.'))return
     void work(async()=>{await api('/managed-pilot/resolve-cancelled-submission',{taskId:task.task.id,reportId:task.cancelledSubmissionReport!.id,confirmDiscard:true});await refresh();setMessage('Discard reviewed. On the phone, check cancelled-reply discard review to validate the receipt and release the local hold.');})
    }}>Review discard of cancelled reply</Button>}
    {task.cancelledUnknownReport&&!task.cancelledUnknownReport.resolvedAt&&<Button variant="outline" disabled={busy||task.task.state!=='cancelled'||task.attempt?.phase!=='stop_confirmed'||task.attempt?.submission!=='unknown'} onClick={()=>{
     if(!window.confirm('Permanently abandon cancelled attempt '+task.attempt!.id+' for task '+task.task.id+' with its provider outcome still UNKNOWN? ChatGPT may have received it. Release only this phone for other pages; keep this page quarantined and preserve all history. No resend, publication or unsent claim is permitted.'))return
     void work(async()=>{await api('/managed-pilot/resolve-cancelled-unknown',{taskId:task.task.id,reportId:task.cancelledUnknownReport!.id,confirmAbandon:true});await refresh();setMessage('Abandonment reviewed. On the original phone, check cancelled-unknown abandonment to validate the receipt. The original page remains quarantined.');})
    }}>Review abandonment of unknown outcome</Button>}
    {page&&<Button variant="outline" disabled={busy} onClick={()=>{
     if(!window.confirm('Bind this page to its actual changed source revision? The prior task must be reconciled. Its cancelled or completed history remains immutable; unchanged sources cannot be retried.'))return
     void work(async()=>{const result=await api<Timeline>('/managed-pilot/pages/'+encodeURIComponent(page)+'/rebind',{expectedPreviousTaskId:task.task.id});setTask(result);localStorage.setItem('managed-pilot-view',JSON.stringify({taskId:result.task.id,pageId:page}));setMessage('Changed source revision bound without dispatch. Prior task and outputs remain historical. Close this task view and assign the page when the phone has synced the new source.');})
    }}>Bind changed source revision</Button>}
    <Button variant="outline" disabled={busy||!['assigned','running'].includes(task.task.state)} onClick={()=>void work(async()=>{await api('/managed-pilot/stop',{taskId:task.task.id,cancel:false});await refresh();setMessage('Pause requested. On the original phone, Check task / run to stop and acknowledge. Transfer is allowed only after confirmed-unsent acknowledgment.');})}>Pause task for handoff</Button>
    <Button variant="outline" disabled={busy||task.task.state==='verified_complete'} onClick={()=>void work(async()=>{await api('/managed-pilot/stop',{taskId:task.task.id,cancel:true});await refresh();setMessage('Cancel recorded. On the phone, Check task / run to acknowledge the stop. Unknown provider outcomes keep their reservation.');})}>Cancel task</Button>
   </div>
   {page&&task.attempt&&<div className="space-y-2 rounded border p-3">
    <p className="text-sm">Single-page pilot transfer requires an acknowledged pause, confirmed unsent work and reconnect support on both phones. For a retained production run, use its production handoff controls above. The target must have the exact prepared source synced and a fresh paired handshake. Uncertain, cancelled and saved work stays with its current evidence.</p>
    <label className="block text-sm">Transfer target<select className={selectClass} value={transferTarget} disabled={busy} onChange={e=>setTransferTarget(e.target.value)}><option value="">Choose a different paired phone</option>{options?.profiles.filter(p=>p.device!==task.attempt!.deviceId).map(p=><option key={`${p.device}:${p.id}`} value={`${p.device}:${p.id}`}>{p.deviceName} · {p.name}</option>)}</select></label>
    <Button variant="outline" disabled={busy||!transferTarget||task.task.state!=='paused'||task.attempt.phase!=='stop_confirmed'||task.attempt.submission!=='unsent'||task.attempt.checkpointRef!==null} onClick={()=>void work(async()=>{
     const target=options?.profiles.find(p=>`${p.device}:${p.id}`===transferTarget);if(!target)throw new Error('Choose a current target profile')
     const result=await api<Timeline>('/managed-pilot/pages/'+encodeURIComponent(page)+'/transfer-unsent',{taskId:task.task.id,attemptId:task.attempt!.id,generation:task.task.generation,fingerprint:task.task.fingerprint,stopCommandId:task.attempt!.activeCommandId,deviceId:target.device,profileId:target.id})
     setTask(result);setTransferTarget('');setMessage('Unsent task transferred with a new generation. On the target phone, Check task / run. The previous attempt and stop history remain retained.')
    })}>Transfer confirmed-unsent task</Button>
   </div>}
   {page&&task.task.state==='verified_complete'&&<ManagedCropReview key={page+task.task.id} pageId={page} taskId={task.task.id}/>}
   <ul className="text-sm text-muted-foreground">{task.commands.map(c=><li key={c.id}>{c.action} · {c.phase.replace(/_/g,' ')}</li>)}</ul>
  </CardContent></Card>}
  <Button variant="outline" disabled={busy||!selected||!options?.enabled} onClick={()=>void work(async()=>{await api('/managed-pilot/unpair',{deviceId:selected!.device});setMessage('Authority unpaired. On the phone, tap Finish unpairing. Unresolved attempts must be reconciled before legacy automation becomes available.');})}>Unpair reconciled phone</Button>
  {message&&<p role="status" className="rounded border p-3 text-sm whitespace-pre-wrap">{message}</p>}
 </div>
}
