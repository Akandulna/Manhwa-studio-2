import AutomationRecoveryControls from './AutomationRecoveryControls'
import {useMemo,useState} from 'react'
import {Button} from '@/components/ui/button'
import SavedCropRecoveryPanel from './SavedCropRecoveryPanel'
import {SavedCropRecoverySession,type RecoveryInspection,type RecoveryTarget} from './savedCropRecoverySession'

/** Target discovery and all inspections require an explicit operator action. No polling or auto-enable. */
export default function ManagedSavedCropRecovery({pageId}:{pageId:string}){
 const [targets,setTargets]=useState<RecoveryTarget[]>([]),[loading,setLoading]=useState(false),[error,setError]=useState('')
 const url='/api/managed-pilot/pages/'+encodeURIComponent(pageId)+'/recovery'
 const session=useMemo(()=>new SavedCropRecoverySession({connected:true,async perform(action,target,expectedRevision,actionId){
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',body:JSON.stringify({action,target,expectedRevision,...(actionId?{actionId}:{})})})
  if(!response.ok)throw new Error('Inspect the retained recovery outcome')
  return await response.json() as RecoveryInspection
 }}),[url])
 async function load(){
  setLoading(true);setError('')
  try{const response=await fetch(url,{cache:'no-store'});if(!response.ok)throw new Error();const value=await response.json();if(!Array.isArray(value.targets)||value.targets.length!==1)throw new Error();setTargets(value.targets)}catch{setError('Saved result unavailable. Check the published page and refresh its task.')}
  finally{setLoading(false)}
 }
 return <section className="space-y-3" aria-label="Saved crop recovery">
  {!targets.length&&<Button variant="outline" disabled={loading} onClick={()=>void load()}>{loading?'Loading saved result…':'Open saved crop recovery'}</Button>}
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  {!!targets.length&&<><SavedCropRecoveryPanel session={session} targets={targets}/><AutomationRecoveryControls key={pageId} pageId={pageId} target={targets[0]}/></>}
 </section>
}
