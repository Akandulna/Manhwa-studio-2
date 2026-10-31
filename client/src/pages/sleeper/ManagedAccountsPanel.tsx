import {useCallback,useEffect,useState} from 'react'
import {Card,CardContent,CardHeader,CardTitle} from '@/components/ui/card'
import {Button} from '@/components/ui/button'

type Product='chatgpt'|'gemini_apps'
type Policy={revision:number;stage:'crop_json';enabled:boolean;auditsEnabled:boolean;allowed:{provider:string;product:string;model:string;mode:null;effort:null}[];preferredProfiles:string[];allowUnknownQuota:boolean;allowEstimatedQuota:boolean;criticalMaxAgeHours:number;contextPortable:boolean}
type Profile={id:string;deviceId:string;profileId:string;observation:{checkedAt:number;sites:Record<Product,{login:string;email:string|null;candidate:string|null;plan:string|null}>}|null;links:Partial<Record<Product,{accountId:string;candidate:string}>>;audit:{state:string;reason:string|null;dueAt:number;lastSuccessfulAt:number|null;cadenceHours:24|48;claimId:string|null}}
type Snapshot={policy:Policy|null;profiles:Profile[];accounts:{id:string;candidate:string;maxConcurrent:number}[];quotas:{accountId:string;scope:{provider:string;product:string;model:string;project:string|null;feature:string};state:string;evidence:string;observedAt:number;recheckAt:number|null}[];reservations:{resource:string;attempt_id:string}[];waiting:{taskId:string;observedAt:number;candidates:{deviceId:string;profileId:string;reasons:string[]}[]}[];issues:{id:string;profileId:string;reason:string;resolvedAt:number|null}[]}
const defaults:Policy={revision:0,stage:'crop_json',enabled:false,auditsEnabled:false,allowed:[{provider:'chatgpt',product:'chatgpt-web',model:'provider-default',mode:null,effort:null}],preferredProfiles:[],allowUnknownQuota:false,allowEstimatedQuota:false,criticalMaxAgeHours:24,contextPortable:false}
const label=(v:string)=>({chatgpt:'ChatGPT',gemini_apps:'Gemini Apps',signed_in:'signed in',signed_out:'signed out',critical_evidence_stale_audit_required:'Readiness evidence is stale; waiting for an idle audit',shared_account_capacity_reserved:'Another task holds this account’s capacity',quota_unknown:'Quota is unknown',quota_exhausted:'Quota is exhausted',quota_reset_requires_recheck:'Estimated reset passed; quota needs rechecking',quota_evidence_requires_recheck:'Quota evidence needs rechecking',account_identity_confirmation_required:'Confirm the account relationship',device_browser_or_profile_reserved:'Phone or profile is busy',device_offline_or_stale:'Phone is offline or its status is stale',required_capability_unverified:'Required capability is unverified',configuration_not_allowed_by_policy:'Configuration is outside the allowed policy',login_unknown_audit_required:'Login status is unknown; waiting for an idle audit',sign_in_required:'Sign in on this phone',account_routing_disabled:'Account selection is paused',update_phone_for_audits:'Update the phone to support audits',check_failed:'Account check failed',retry_delay:'Waiting before the next audit'} as Record<string,string>)[v]??v.replace(/_/g,' ')
const date=(v:number|null)=>v===null?'never':new Date(v).toLocaleString()
async function request(body?:Record<string,unknown>):Promise<Snapshot>{const r=await fetch('/api/managed-pilot/accounts',{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const value=await r.json();if(!r.ok)throw new Error(value.error??'Account controls unavailable');return value}

export default function ManagedAccountsPanel(){
 const [snapshot,setSnapshot]=useState<Snapshot|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false)
 const reload=useCallback(async()=>{try{setSnapshot(await request());setError('')}catch(e){setError(e instanceof Error?e.message:'Account controls unavailable')}},[])
 useEffect(()=>{void reload();const timer=setInterval(()=>void reload(),60_000);return()=>clearInterval(timer)},[reload])
 async function update(body:Record<string,unknown>){setBusy(true);try{await request({...body,eventId:crypto.randomUUID()});await reload()}catch(e){setError(e instanceof Error?e.message:'Account update failed')}finally{setBusy(false)}}
 const policy=snapshot?.policy??defaults
 function setPolicy(change:Partial<Policy>){void update({action:'policy',policy:{...policy,...change,revision:policy.revision+1}})}
 return <Card className="mb-6"><CardHeader className="flex-row items-center justify-between"><CardTitle>Managed accounts and scheduling</CardTitle><Button variant="outline" disabled={busy} onClick={()=>void reload()}>Refresh</Button></CardHeader><CardContent className="space-y-4 break-words [overflow-wrap:anywhere]">
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  {snapshot&&<>
   <div className="flex flex-wrap gap-5 text-sm">
    <label><input type="checkbox" disabled={busy} checked={policy.auditsEnabled} onChange={e=>setPolicy({auditsEnabled:e.target.checked})}/> Idle account audits</label>
    <label><input type="checkbox" disabled={busy} checked={policy.enabled} onChange={e=>setPolicy({enabled:e.target.checked})}/> Account-aware initial selection</label>
    <label><input type="checkbox" disabled={busy} checked={policy.allowUnknownQuota} onChange={e=>setPolicy({allowUnknownQuota:e.target.checked})}/> Permit requests with unknown quota</label>
   </div>
   <p className="text-sm text-muted-foreground">Policy {policy.revision}: ChatGPT default model for managed crop pages. Quotas remain unknown unless evidenced or supplied by you. Shared accounts allow one concurrent task by default. Audits run while a compatible paired phone is open and idle; offline and busy checks stay overdue.</p>
   <label className="block text-sm">Preferred profiles, in order (device/profile, separated by commas)
    <input className="mt-1 w-full rounded border bg-background p-2" key={policy.revision} defaultValue={policy.preferredProfiles.join(', ')} disabled={busy} onBlur={e=>{const value=e.target.value.split(',').map(s=>s.trim()).filter(Boolean);if(JSON.stringify(value)!==JSON.stringify(policy.preferredProfiles))setPolicy({preferredProfiles:value})}}/>
   </label>
   <div className="overflow-x-auto"><table className="min-w-[600px] w-full text-left text-sm"><thead><tr><th>Device / profile</th><th>Evidence and account identity</th><th>Audit</th></tr></thead><tbody>
    {snapshot.profiles.map(p=><tr key={p.id} className="border-t align-top"><td className="p-2">{p.deviceId}<br/>{p.profileId}</td><td className="space-y-2 p-2">
     {(['chatgpt','gemini_apps'] as const).map(product=>{const observation=p.observation?.sites[product],link=p.links[product],candidate=observation?.candidate;return <div key={product}>
      <span>{label(product)}: {label(observation?.login??'unknown')} · plan {observation?.plan??'unknown'}<br/>{observation?.email??'Identity unknown'}</span>
      <div className="text-xs text-muted-foreground">Observed {date(p.observation?.checkedAt??null)}{p.observation&&` · ${Math.max(0,Math.floor((Date.now()-p.observation.checkedAt)/3_600_000))}h ago`}{p.observation&&Date.now()-p.observation.checkedAt>policy.criticalMaxAgeHours*3_600_000?' · stale':''} · {link?.candidate===candidate&&candidate?`Confirmed account: ${link?.accountId}`:'Unconfirmed relationship'}</div>
      {candidate&&link?.candidate!==candidate&&<Button size="sm" variant="outline" disabled={busy} onClick={()=>void update({action:'confirm',deviceId:p.deviceId,profileId:p.profileId,product,candidate,accountId:snapshot.accounts.find(a=>a.candidate===candidate)?.id??'account_'+candidate.split(':')[1],maxConcurrent:1})}>Confirm this account</Button>}
     </div>})}
    </td><td className="p-2">{label(p.audit.state)}{p.audit.reason&&` · ${label(p.audit.reason)}`}<br/>Due {date(p.audit.dueAt)}<br/>Last successful {date(p.audit.lastSuccessfulAt)}<br/>
     <select aria-label={`Audit cadence for ${p.id}`} className="rounded border bg-background p-1" disabled={busy} value={p.audit.cadenceHours} onChange={e=>void update({action:'cadence',deviceId:p.deviceId,profileId:p.profileId,hours:Number(e.target.value)})}><option value={24}>Every 24 hours</option><option value={48}>Every 48 hours</option></select><br/>
     <Button size="sm" variant="outline" disabled={busy||!policy.auditsEnabled||p.audit.claimId!==null} onClick={()=>void update({action:'audit_recheck',deviceId:p.deviceId,profileId:p.profileId})}>Request idle recheck</Button>
     <p className="text-xs text-muted-foreground">Waits for an idle phone. Repeat requests and failed checks have a 15-minute cooldown.</p>
    </td></tr>)}
   </tbody></table></div>
   <div className="space-y-2"><h3 className="font-medium">Scoped quota evidence</h3>
    {snapshot.quotas.map((q,i)=><p key={i} className="text-sm">{q.accountId} · {q.scope.product}/{q.scope.model}/{q.scope.project??'all projects'}/{q.scope.feature}: {q.state} ({q.evidence}, {date(q.observedAt)}){q.recheckAt!==null&&` · recheck ${date(q.recheckAt)}`}</p>)}
    {snapshot.accounts.filter(a=>a.candidate.startsWith('openai:')).map(a=><div key={a.id} className="flex flex-wrap items-center gap-2 text-sm"><span>{a.id.slice(0,24)}… · crop quota (owner supplied):</span>{(['available','blocked','unknown'] as const).map(state=><Button key={state} variant="outline" size="sm" disabled={busy} onClick={()=>void update({action:'quota',profileId:null,quota:{accountId:a.id,scope:{provider:'openai',product:'chatgpt',model:'provider-default',project:null,feature:'crop_json'},state,evidence:state==='unknown'?'unknown':'owner_supplied',observedAt:Date.now(),recheckAt:null}})}>{state}</Button>)}</div>)}
   </div>
   <div className="text-sm"><h3 className="font-medium">Reservations</h3>{snapshot.reservations.length?snapshot.reservations.map(r=><p key={r.resource}>{r.resource} · {r.attempt_id}</p>):<p>No active reservations.</p>}</div>
   {snapshot.waiting.length>0&&<div className="text-sm"><h3 className="font-medium">Waiting for eligibility</h3>{snapshot.waiting.map(w=><div key={w.taskId} className="mt-2"><p>{w.taskId}</p>{w.candidates.map(c=><p key={c.deviceId+'/'+c.profileId}>{c.deviceId}/{c.profileId}: {c.reasons.map(label).join('; ')}</p>)}</div>)}</div>}
   {snapshot.issues.some(i=>!i.resolvedAt)&&<div className="text-sm"><h3 className="font-medium">Owner actions</h3>{snapshot.issues.filter(i=>!i.resolvedAt).map(i=><p key={i.id}>{i.profileId}: {i.reason}</p>)}</div>}
  </>}
 </CardContent></Card>
}
