import {TaskConflict,canonicalJson,type CropSpec} from './managedTaskProtocol.js'
export const ACCOUNTS_SCHEMA='managed-accounts/1'
export type AccountProduct='chatgpt'|'gemini_apps'|'aistudio'
export type AccountEvidence='observed'|'locally_counted'|'estimated'|'owner_supplied'|'unknown'
export interface AccountScope {provider:'openai'|'google';product:AccountProduct;model:string;project:string|null;feature:string}
export interface AccountSiteObservation {login:'signed_in'|'signed_out'|'unknown';email:string|null;candidate:string|null;plan:string|null}
export interface AccountObservation {checkedAt:number;sites:{chatgpt:AccountSiteObservation;gemini_apps:AccountSiteObservation}}
export interface ManagedAccountProfile {id:string;deviceId:string;profileId:string;observation:AccountObservation|null;links:Partial<Record<AccountProduct,{accountId:string;candidate:string}>>;audit:{cadenceHours:24|48;dueAt:number;lastSuccessfulAt:number|null;state:'due'|'deferred'|'running'|'success'|'failed';reason:string|null;nextCheckAt:number;retryNotBefore:number|null;claimId:string|null}}
export interface ManagedAccount {id:string;provider:'openai'|'google';candidate:string;maxConcurrent:number}
export interface AccountQuota {accountId:string;scope:AccountScope;state:'available'|'blocked'|'unknown';evidence:AccountEvidence;observedAt:number;recheckAt:number|null}
export interface AccountQuotaRecord extends AccountQuota {sourceId:string;receivedAt:number}
export interface AccountPolicy {revision:number;stage:'crop_json';enabled:boolean;auditsEnabled:boolean;allowed:{provider:CropSpec['provider'];product:string;model:string;mode:string|null;effort:string|null}[];preferredProfiles:string[];allowUnknownQuota:boolean;allowEstimatedQuota:boolean;criticalMaxAgeHours:number;contextPortable:boolean}
export interface AccountSelection {routingRequired:boolean;state:'eligible'|'waiting';selected:{deviceId:string;profileId:string;accountId:string}|null;candidates:{deviceId:string;profileId:string;accountId:string|null;reasons:string[];rank:number}[];nextCheckAt:number|null;policyRevision:number|null}
export interface AccountSelectionPin {policy:AccountPolicy;selectedAt:number;accountId:string;observationAt:number;quotaEvidence:AccountQuota[];configuration:CropSpec;reason:string}
export const profileKey=(device:string,profile:string)=>device+'/'+profile
export const scopeKey=(scope:AccountScope)=>canonicalJson(scope)
export const accountIdValid=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v)
const record=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v)
export function exact(v:unknown,keys:string[]):asserts v is Record<string,any> {if(!record(v)||Object.keys(v).sort().join(',')!==keys.sort().join(','))throw new TaskConflict('Exact account operation fields required')}
export function parseAccountScope(v:unknown):AccountScope {
 exact(v,['provider','product','model','project','feature'])
 if(!['openai','google'].includes(v.provider)||!['chatgpt','gemini_apps','aistudio'].includes(v.product)||v.provider!==(v.product==='chatgpt'?'openai':'google')||![v.model,v.feature].every(x=>typeof x==='string'&&!!x.trim()&&x.length<=100)||!(v.project===null||accountIdValid(v.project)))throw new TaskConflict('Exact provider/product/model/project/feature scope required')
 return {...v} as AccountScope
}
export function parseAccountPolicy(v:unknown):AccountPolicy {
 exact(v,['revision','stage','enabled','auditsEnabled','allowed','preferredProfiles','allowUnknownQuota','allowEstimatedQuota','criticalMaxAgeHours','contextPortable'])
 if(!Number.isSafeInteger(v.revision)||v.revision<1||v.stage!=='crop_json'||![v.enabled,v.auditsEnabled,v.allowUnknownQuota,v.allowEstimatedQuota,v.contextPortable].every(x=>typeof x==='boolean')||!Number.isInteger(v.criticalMaxAgeHours)||v.criticalMaxAgeHours<1||v.criticalMaxAgeHours>48||!Array.isArray(v.preferredProfiles)||v.preferredProfiles.length>32||v.preferredProfiles.some((x:any)=>typeof x!=='string'||!/^([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{1,128})$/.test(x))||new Set(v.preferredProfiles).size!==v.preferredProfiles.length||!Array.isArray(v.allowed)||v.allowed.length<1||v.allowed.length>16)throw new TaskConflict('Invalid versioned stage policy')
 for(const c of v.allowed){exact(c,['provider','product','model','mode','effort']);if(!['chatgpt','gemini','aistudio'].includes(c.provider)||![c.product,c.model].every(x=>typeof x==='string'&&!!x.trim()&&x.length<=100)||![c.mode,c.effort].every(x=>x===null||typeof x==='string'&&!!x.trim()&&x.length<=100))throw new TaskConflict('Fully resolved allowed configuration required')}
 return structuredClone(v) as AccountPolicy
}
export const taskScope=(s:CropSpec):AccountScope=>({provider:s.provider==='chatgpt'?'openai':'google',product:s.provider==='chatgpt'?'chatgpt':s.provider==='gemini'?'gemini_apps':'aistudio',model:s.model,project:null,feature:'crop_json'})
export function scopeMatches(limit:AccountScope,request:AccountScope):boolean {return limit.provider===request.provider&&limit.product===request.product&&(limit.model==='*'||limit.model===request.model)&&(limit.project===null||limit.project===request.project)&&(limit.feature==='*'||limit.feature===request.feature)}
/** Derive only whitelisted observations from the phone's legacy check; failed checks remain unknown. */
export async function accountObservation(raw:unknown,now:number):Promise<AccountObservation> {
 if(!record(raw)||typeof raw.checkedAt!=='string')throw new TaskConflict('Phone check required')
 const checkedAt=Date.parse(raw.checkedAt)
 if(!Number.isSafeInteger(checkedAt)||checkedAt<=0||checkedAt>now+300_000)throw new TaskConflict('Invalid account check time')
 async function site(v:unknown,provider:string):Promise<AccountSiteObservation>{
  if(!record(v)||typeof v.signedIn!=='boolean'||v.error!=null&&v.error!=='')return {login:'unknown',email:null,candidate:null,plan:null}
  const email=v.signedIn&&typeof v.email==='string'&&v.email.length<=320&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email.trim())?v.email.trim():null
  const hash=email?[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(provider+'\n'+email.toLowerCase())))].map(b=>b.toString(16).padStart(2,'0')).join(''):null
  return {login:v.signedIn?'signed_in':'signed_out',email,candidate:hash?provider+':'+hash:null,plan:v.signedIn&&typeof v.plan==='string'&&v.plan.trim()&&v.plan.length<=100&&v.plan!=='null'?v.plan.trim():null}
 }
 return {checkedAt,sites:{chatgpt:await site(raw.chatGpt,'openai'),gemini_apps:await site(raw.gemini,'google')}}
}
export function parseAccountQuota(v:unknown,now:number):AccountQuota {
 exact(v,['accountId','scope','state','evidence','observedAt','recheckAt'])
 const scope=parseAccountScope(v.scope)
 if(!accountIdValid(v.accountId)||!['available','blocked','unknown'].includes(v.state)||!['observed','locally_counted','estimated','owner_supplied','unknown'].includes(v.evidence)||!Number.isSafeInteger(v.observedAt)||v.observedAt<=0||v.observedAt>now+300_000||!(v.recheckAt===null||Number.isSafeInteger(v.recheckAt)&&v.recheckAt>0)||v.evidence==='unknown'&&v.state!=='unknown')throw new TaskConflict('Bounded labelled quota evidence required')
 return {...v,scope} as AccountQuota
}
