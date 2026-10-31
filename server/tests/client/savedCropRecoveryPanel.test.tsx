import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {describe,it,expect,vi} from 'vitest'
import SavedCropRecoveryPanel from '../../../client/src/components/recovery/SavedCropRecoveryPanel'
import {SavedCropRecoverySession,targetKey,type RecoveryInspection,type RecoveryTarget,type RecoveryPanelGateway} from '../../../client/src/components/recovery/savedCropRecoverySession'
const NOW=Date.parse('2026-10-23T10:00:00Z')
const target:RecoveryTarget={workspaceId:'workspace',taskId:'task:sha256:'+'a'.repeat(64),attemptId:'attempt',generation:1,fingerprint:'b'.repeat(64),artifactId:'saved_crop',sha256:'c'.repeat(64),destinationId:'d'.repeat(64),chapterLabel:'Synthetic Chapter 1',pageLabel:'page_001.png',destinationLabel:'Private local crop store'}
const other:RecoveryTarget={...target,artifactId:'other_crop',pageLabel:'page_002.png'}
function inspection():RecoveryInspection{return {target:structuredClone(target),observedAt:NOW,globalEnabled:true,canonical:true,sourceMatches:true,localState:'missing',episode:{revision:1,enabled:true,paused:false,cancelled:false,nextEligibleAt:0,actions:[]}}}
function setup(){
 let now=NOW,view=inspection(),counter=0
 const perform=vi.fn<Parameters<RecoveryPanelGateway['perform']>,ReturnType<RecoveryPanelGateway['perform']>>(async(action,t,revision,id)=>{
  if(action!=='inspect'&&action!=='reconcile'&&revision!==(view.episode?.revision??0))throw new Error('Private server rejection')
  view={...view,target:structuredClone(t),observedAt:now,episode:view.episode?structuredClone(view.episode):null}
  if(action==='run'){view.localState='verified';view.episode!.revision++;view.episode!.actions.push({id:id!,phase:'verified',at:now,finishedAt:now})}
  if(action==='enable'){view.episode=view.episode??{revision:0,enabled:false,paused:false,cancelled:false,nextEligibleAt:0,actions:[]};view.episode={...view.episode,revision:view.episode.revision+1,enabled:true,paused:false}}
  if(action==='pause'||action==='cancel'){view.episode!.revision++;view.episode![action==='pause'?'paused':'cancelled']=true}
  return structuredClone(view)
 })
 const gateway:RecoveryPanelGateway={connected:true,perform}
 const session=new SavedCropRecoverySession(gateway,()=>now,()=> 'ui_action_'+(++counter))
 return {session,perform,gateway,get view(){return view},set view(v:RecoveryInspection){view=v},advance:(ms:number)=>{now+=ms},ready:async()=>{session.select(target);await session.perform('inspect');session.confirm(true)}}
}
const render=(session:SavedCropRecoverySession,targets=[target])=>renderToStaticMarkup(createElement(SavedCropRecoveryPanel,{session,targets}))
describe('saved crop recovery operator session',()=>{
 it('defaults disconnected without any request or mounting side effect',async()=>{
  const fetch=vi.spyOn(globalThis,'fetch');try{const s=new SavedCropRecoverySession();s.select(target);await s.perform('inspect');expect(s.gate('run').allowed).toBe(false);expect(render(s)).toContain('Live recovery remains disabled');expect(fetch).not.toHaveBeenCalled()}finally{fetch.mockRestore()}
 })
 it('requires explicit selection, inspection and scope confirmation',async()=>{
  const s=setup();expect(s.session.gate('inspect').allowed).toBe(false);s.session.select(target);expect(s.perform).not.toHaveBeenCalled();expect(s.session.gate('run').allowed).toBe(false)
  await s.session.perform('inspect');expect(s.session.gate('run').reason).toContain('Confirm');s.session.confirm(true);expect(s.session.gate('run').allowed).toBe(true)
  s.session.select(other);expect(s.session.getSnapshot().confirmed).toBe(false);expect(s.session.getSnapshot().inspection).toBeNull()
 })
 it('pins one action identity and inspected revision for a restore',async()=>{
  const s=setup();await s.ready();await s.session.perform('run');expect(s.perform.mock.calls.map(c=>c[0])).toEqual(['inspect','run']);expect(s.perform.mock.calls[1]).toEqual(['run',target,1,'ui_action_1'])
  expect(s.session.gate('run').reason).toContain('already verified');expect(s.session.getSnapshot().confirmed).toBe(false)
 })
 it('separates enabling the episode from permission to restore',async()=>{
  const s=setup();s.view={...inspection(),episode:null};await s.ready();expect(s.session.gate('run').reason).toContain('Enable');expect(s.session.gate('enable').allowed).toBe(true)
  await s.session.perform('enable');expect(s.perform.mock.calls.map(c=>c[0])).toEqual(['inspect','enable']);expect(s.session.gate('run').reason).toContain('Confirm');s.session.confirm(true);expect(s.session.gate('run').allowed).toBe(true)
 })
 it('retains a lost action identity through selection changes and a successful refresh',async()=>{
  const s=setup();await s.ready();s.perform.mockRejectedValueOnce(new Error('token=secret'));await s.session.perform('run')
  s.session.select(null);s.session.select(target);await s.session.perform('inspect');s.session.confirm(true)
  expect(s.session.gate('run').reason).toContain('original restore action is unconfirmed');expect(s.session.gate('reconcile').allowed).toBe(true)
  await s.session.perform('run');expect(s.perform.mock.calls.filter(c=>c[0]==='run')).toHaveLength(1);expect(render(s.session)).not.toContain('token=secret')
 })
 it('clears a lost reply only after the original action has a definitive receipt',async()=>{
  const s=setup();await s.ready();s.perform.mockRejectedValueOnce(new Error('lost reply'));await s.session.perform('run')
  s.view={...inspection(),episode:{...inspection().episode!,revision:3,actions:[{id:'ui_action_1',phase:'safe_failure',at:NOW,finishedAt:NOW}]}}
  await s.session.perform('reconcile');expect(s.perform.mock.calls[s.perform.mock.calls.length-1][3]).toBe('ui_action_1');s.session.confirm(true);expect(s.session.gate('run').allowed).toBe(true)
 })
 it('rejects successful-looking responses that omit the original receipt',async()=>{
  const s=setup();await s.ready();s.perform.mockResolvedValueOnce(inspection());await s.session.perform('run');expect(s.session.getSnapshot().current).toBe(false);expect(s.session.gate('run').reason).toContain('unconfirmed');expect(s.session.gate('reconcile').allowed).toBe(true)
 })
 it('ignores a late inspection reply after scope selection changes',async()=>{
  const s=setup();let resolve!:(v:RecoveryInspection)=>void;s.perform.mockImplementationOnce(()=>new Promise(r=>{resolve=r}));s.session.select(target);const pending=s.session.perform('inspect');s.session.select(other);resolve(inspection());await pending
  expect(s.session.getSnapshot().target).toEqual(other);expect(s.session.getSnapshot().inspection).toBeNull()
 })
 it('ignores an older inspection even after reselecting the same scope',async()=>{
  const s=setup();let resolve!:(v:RecoveryInspection)=>void;s.perform.mockImplementationOnce(()=>new Promise(r=>{resolve=r}));s.session.select(target);const first=s.session.perform('inspect');s.session.select(target);await s.session.perform('inspect');const current=s.session.getSnapshot().inspection
  resolve({...inspection(),globalEnabled:false});await first;expect(s.session.getSnapshot().inspection).toEqual(current)
 })
 it('pins selection and blocks duplicate requests while mutation is pending',async()=>{
  const s=setup();await s.ready();let resolve!:(v:RecoveryInspection)=>void;s.perform.mockImplementationOnce(()=>new Promise(r=>{resolve=r}));const pending=s.session.perform('run');s.session.select(other);expect(s.session.getSnapshot().target).toEqual(target);await s.session.perform('run');expect(s.perform.mock.calls).toHaveLength(2)
  const v=inspection();v.localState='verified';v.episode!.actions=[{id:'ui_action_1',phase:'verified',at:NOW,finishedAt:NOW}];resolve(v);await pending;expect(s.session.getSnapshot().inspection?.localState).toBe('verified')
 })
 it('expires evidence locally without background polling',async()=>{
  const s=setup();await s.ready();s.advance(120_000);expect(s.session.gate('run').allowed).toBe(false);s.session.expireInspection();expect(s.session.getSnapshot().confirmed).toBe(false);expect(s.session.getSnapshot().error).toContain('stale');expect(s.perform).toHaveBeenCalledTimes(1)
 })
 it('keeps failed refresh evidence last-known and blocks new mutations',async()=>{
  const s=setup();await s.ready();s.perform.mockRejectedValueOnce(new Error('private raw response'));await s.session.perform('inspect');expect(s.session.getSnapshot().inspection).not.toBeNull();expect(s.session.getSnapshot().current).toBe(false);expect(render(s.session)).toContain('Last known');s.session.confirm(true);expect(s.session.gate('run').allowed).toBe(false)
 })
 it('rejects foreign, stale, future and malformed evidence',async()=>{
  const changes=[(v:RecoveryInspection)=>{v.target=other},(v:RecoveryInspection)=>{v.observedAt=NOW+1},(v:RecoveryInspection)=>{v.observedAt=NOW-120_000},(v:RecoveryInspection)=>{v.sourceMatches='true' as any},(v:RecoveryInspection)=>{v.episode!.revision=1.5},(v:RecoveryInspection)=>{v.episode!.actions=[{id:'x',phase:'executing',at:NOW,finishedAt:NOW}]},(v:RecoveryInspection)=>{v.episode!.actions=Array(4).fill({id:'x',phase:'safe_failure',at:NOW,finishedAt:NOW})}]
  for(const change of changes){const s=setup(),v=inspection();change(v);s.perform.mockResolvedValueOnce(v);s.session.select(target);await s.session.perform('inspect');expect(s.session.getSnapshot().inspection).toBeNull();expect(s.session.gate('run').allowed).toBe(false)}
 })
 it('rejects revision rollback and preserves the last known history',async()=>{
  const s=setup();s.view.episode!.revision=4;await s.ready();s.perform.mockResolvedValueOnce(inspection());await s.session.perform('inspect');expect(s.session.getSnapshot().inspection?.episode?.revision).toBe(4);expect(s.session.getSnapshot().current).toBe(false)
 })
 it('holds reserved, executing and unknown actions for inspection',async()=>{
  for(const phase of ['reserved','executing','unknown'] as const){const s=setup();s.view.episode!.actions=[{id:'original',phase,at:NOW,finishedAt:phase==='unknown'?NOW:null}];await s.ready();expect(s.session.gate('run').allowed).toBe(false);expect(s.session.gate('enable').allowed).toBe(false);expect(s.session.gate('reconcile').allowed).toBe(true)}
 })
 it('keeps outcome inspection available while live recovery is off',async()=>{
  const s=setup();s.view.globalEnabled=false;s.view.episode!.actions=[{id:'original',phase:'unknown',at:NOW,finishedAt:NOW}];await s.ready();expect(s.session.gate('run').allowed).toBe(false);expect(s.session.gate('enable').allowed).toBe(false);expect(s.session.gate('pause').allowed).toBe(false);expect(s.session.gate('reconcile').allowed).toBe(true)
 })
 it('blocks source mismatch, conflicting/unknown files, cancellation, exhaustion and cooldown',async()=>{
  const changes=[(v:RecoveryInspection)=>{v.canonical=false},(v:RecoveryInspection)=>{v.sourceMatches=false},(v:RecoveryInspection)=>{v.localState='conflict'},(v:RecoveryInspection)=>{v.localState='unknown'},(v:RecoveryInspection)=>{v.episode!.cancelled=true},(v:RecoveryInspection)=>{v.episode!.nextEligibleAt=NOW+10_000},(v:RecoveryInspection)=>{v.episode!.actions=[1,2,3].map(i=>({id:'action_'+i,phase:'safe_failure',at:NOW,finishedAt:NOW}))}]
  for(const change of changes){const s=setup();change(s.view);await s.ready();expect(s.session.gate('run').allowed).toBe(false);expect(s.session.gate('enable').allowed).toBe(false)}
 })
 it('allows stop controls without restore confirmation and pins the revision',async()=>{
  const s=setup();s.session.select(target);await s.session.perform('inspect');await s.session.perform('pause');expect(s.perform.mock.calls[1].slice(0,3)).toEqual(['pause',target,1]);expect(s.session.getSnapshot().inspection!.episode!.paused).toBe(true);await s.session.perform('cancel');expect(s.perform.mock.calls[2].slice(0,3)).toEqual(['cancel',target,2]);expect(s.session.gate('enable').allowed).toBe(false)
 })
 it('disables stop controls once the local restore is complete',async()=>{
  const s=setup();await s.ready();await s.session.perform('run');expect(s.session.gate('pause').allowed).toBe(false);expect(s.session.gate('cancel').allowed).toBe(false)
 })
 it('does not mistake a historical successful restore for a currently present local copy',async()=>{
  const s=setup();s.view.episode!.actions=[{id:'original',phase:'verified',at:NOW,finishedAt:NOW}];await s.ready();expect(s.session.gate('run').reason).toContain('prior restore');expect(render(s.session)).toContain('Local copy: missing')
 })
 it('requires exact target identities before any inspection',()=>{
  const s=setup();expect(()=>s.session.select({...target,taskId:'chapter-title'})).toThrow('exact');expect(targetKey(target)).not.toEqual(targetKey({...target,destinationId:'e'.repeat(64)}))
 })
})
describe('saved crop recovery panel rendering',()=>{
 it('renders accessible controls, selected scope and evidence freshness',async()=>{
  const s=setup();await s.ready();const html=render(s.session);for(const label of ['Restore a saved crop result','Saved result and destination','Inspect saved result','Check saved outcome','Restore local copy','Pause recovery','Cancel recovery','I confirm this saved result','role="status"','aria-live="polite"','Saved result identity','Private local crop store','Observed'])expect(html).toContain(label)
 })
 it('shows uncertain history without a generation or reservation-reset action',async()=>{
  const s=setup();s.view.episode!.actions=[{id:'original',phase:'unknown',at:NOW,finishedAt:NOW}];await s.ready();const html=render(s.session);expect(html).toContain('Outcome uncertain');expect(html).toContain('Recovery history');expect(html).toContain('Attempts used: 1/3');expect(html).not.toContain('Regenerate');expect(html).not.toContain('Clear reservations')
 })
 it('escapes labels and omits raw server secrets',async()=>{
  const s=setup(),t={...target,chapterLabel:'<script>private()</script>'};s.session.select(t);s.perform.mockRejectedValueOnce(new Error('secret token private@example.test'));await s.session.perform('inspect');const html=render(s.session,[t]);expect(html).toContain('&lt;script&gt;');expect(html).not.toContain('<script>');expect(html).not.toContain('secret token')
 })
 it('does not inspect, enable or poll on render',()=>{
  const s=setup();s.session.select(target);render(s.session);render(s.session);expect(s.perform).not.toHaveBeenCalled();expect(s.session.getSnapshot().inspection).toBeNull()
 })
})
describe('shared saved-upload and local-import budget projection',()=>{
 it('blocks restoration when an earlier upload exhausted the shared budget or remains pending',async()=>{
  for(const budget of [{used:3,uiUsed:0,nextEligibleAt:0,pending:false,exhausted:true},{used:1,uiUsed:0,nextEligibleAt:0,pending:true,exhausted:false}]){
   const s=setup();s.view={...inspection(),budget};await s.ready();expect(s.session.gate('run').allowed).toBe(false);expect(s.session.gate('enable').allowed).toBe(false)
  }
 })
 it('rejects malformed aggregate budgets rather than silently showing only local attempts',async()=>{
  const s=setup();s.perform.mockResolvedValueOnce({...inspection(),budget:{used:4,uiUsed:0,nextEligibleAt:0,pending:false,exhausted:true}});s.session.select(target);await s.session.perform('inspect');expect(s.session.getSnapshot().current).toBe(false)
 })
})
