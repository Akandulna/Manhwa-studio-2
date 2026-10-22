/** Redacted Phase 2 evidence shared by Studio and the relay. Never contains DOM text or screenshots. */
export const UI_PROVIDERS = ['chatgpt','gemini','aistudio'] as const
export const UI_WORKFLOWS = ['composer_empty','composer_ready','model_menu','upload_menu','response_actions'] as const
export const UI_CONTROLS = ['composer','send','upload','model','navigation','response_actions'] as const
export interface UiControl {
  id: typeof UI_CONTROLS[number]; count:number; label:string; signature:string; icon:string
  location:number[]; style:string
}
export interface WebsiteUiEvidence {
  schema:'website-ui/1'; provider:typeof UI_PROVIDERS[number]; workflow:typeof UI_WORKFLOWS[number]
  variant:{ viewport:string; locale:string; theme:'light'|'dark'; profileVariant:string }
  baselineVersion:string|null; changeId:string|null
  classification:'baseline_missing'|'unchanged'|'suspected'|'informational'|'compatibility_warning'|'blocking'|'unchecked'
  expected:UiControl[]; observed:UiControl[]
  lastMatchingAt:string|null; firstChangedAt:string|null; baselineAcceptedAt:string|null; compatibilityVerifiedAt:string|null
  reason:'stable'|'loading'|'streaming'|'session_overlay'|'quota_overlay'|'dialog'|'keyboard'|'unsupported'|'not_observed'
  impact:'none'|'unknown'|'active_workflow'|'blocked'
  audit:{ state:'checked'|'due'|'deferred'; dueAt:string }
  route:{ monitorObservedAt:string; clipperReceivedAt:string|null; issuesReceivedAt:string|null }
}
const obj = (v:any) => !!v && typeof v === 'object' && !Array.isArray(v)
const exact = (v:any,fields:string[]) => obj(v) && Object.keys(v).length===fields.length && fields.every(k => Object.prototype.hasOwnProperty.call(v,k))
const time = (v:any) => typeof v==='string' && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v))
const nullableTime = (v:any) => v===null || time(v)
const hash = (v:any) => typeof v==='string' && /^[a-f0-9]{8,64}$/.test(v)
export function validWebsiteUi(v:any): v is WebsiteUiEvidence {
  if (!exact(v,['schema','provider','workflow','variant','baselineVersion','changeId','classification','expected','observed','lastMatchingAt','firstChangedAt','baselineAcceptedAt','compatibilityVerifiedAt','reason','impact','audit','route']) || v.schema!=='website-ui/1' || !UI_PROVIDERS.includes(v.provider) || !UI_WORKFLOWS.includes(v.workflow)) return false
  if (!exact(v.variant,['viewport','locale','theme','profileVariant']) || !/^\d{2,4}x\d{2,4}$/.test(v.variant.viewport) || !/^[a-zA-Z-]{2,24}$/.test(v.variant.locale) || !['light','dark'].includes(v.variant.theme) || !/^[a-zA-Z0-9_-]{1,64}$/.test(v.variant.profileVariant)) return false
  if (![v.baselineVersion,v.changeId].every(x => x===null || hash(x)) || !['baseline_missing','unchanged','suspected','informational','compatibility_warning','blocking','unchecked'].includes(v.classification)) return false
  for (const list of [v.expected,v.observed]) {
    if (!Array.isArray(list) || list.length>6 || new Set(list.map(c => c?.id)).size!==list.length || !list.every(c => exact(c,['id','count','label','signature','icon','location','style']) && UI_CONTROLS.includes(c.id) && Number.isInteger(c.count) && c.count>=0 && c.count<=2 && ['prompt','send','submit','run','attach','upload','model','navigation','copy','unrecognized','absent'].includes(c.label) && hash(c.signature) && hash(c.icon) && hash(c.style) && Array.isArray(c.location) && c.location.length===4 && c.location.every((n:any) => Number.isInteger(n) && n>=0 && n<=8))) return false
  }
  if (![v.lastMatchingAt,v.firstChangedAt,v.baselineAcceptedAt,v.compatibilityVerifiedAt].every(nullableTime) || !['stable','loading','streaming','session_overlay','quota_overlay','dialog','keyboard','unsupported','not_observed'].includes(v.reason) || !['none','unknown','active_workflow','blocked'].includes(v.impact)) return false
  return exact(v.audit,['state','dueAt']) && ['checked','due','deferred'].includes(v.audit.state) && time(v.audit.dueAt) && exact(v.route,['monitorObservedAt','clipperReceivedAt','issuesReceivedAt']) && time(v.route.monitorObservedAt) && nullableTime(v.route.clipperReceivedAt) && nullableTime(v.route.issuesReceivedAt)
}
