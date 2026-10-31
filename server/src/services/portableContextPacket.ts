/** Private Studio verification. Transcript bytes are never sent to the relay. */
import {createHash} from 'node:crypto'
import {TaskConflict,canonicalJson} from './managedTaskProtocol.js'
import {recoveryExact} from './managedSavedImportRecoveryProtocol.js'
import {contextBinding,contextInventory,inheritedPermissions} from './inheritedContextProtocol.js'
export function verifyContextPacket(wire:unknown,reference:unknown,now=Date.now()){
 const need=(v:unknown)=>{if(!v)throw new TaskConflict('Exact independently pinned context packet required')}
 need(typeof wire==='string'&&Buffer.byteLength(wire as string)<=512000&&Number.isSafeInteger(now)&&now>0)
 const text=wire as string;let depth=0,quoted=false,escaped=false
 for(const c of text){if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false}else if(c==='"')quoted=true;else if(c==='{'||c==='['){depth++;need(depth<=16)}else if(c==='}'||c===']'){depth--;need(depth>=0)}}need(depth===0&&!quoted)
 recoveryExact(reference,['binding','packetId']);contextBinding(reference.binding)
 const p=JSON.parse(text);recoveryExact(p,['schema','binding','preparedAt','origin','contextScope','notRepresented','entries','packetId',...Object.keys(inheritedPermissions)])
 need(text===canonicalJson(p)+'\n');contextBinding(p.binding)
 need(canonicalJson(p.binding)===canonicalJson(reference.binding)&&p.packetId===reference.packetId&&p.schema==='managed-portable-context/1'&&p.origin==='operator-supplied-text'&&p.contextScope==='unreviewed-inherited-text/1'&&Number.isSafeInteger(p.preparedAt)&&p.preparedAt>0&&p.preparedAt<=now)
 need(canonicalJson(p.notRepresented)==='["provider_hidden_state","non_text_attachments","provider_settings","live_conversation_binding"]'&&Object.keys(inheritedPermissions).every(k=>p[k]===false)&&Array.isArray(p.entries)&&p.entries.length>0&&p.entries.length<=64)
 const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex')
 const inventory=p.entries.map((e:any)=>{recoveryExact(e,['id','kind','sourceId','revision','content','sha256','bytes']);need(typeof e.content==='string'&&!/[\uD800-\uDFFF]/u.test(e.content)&&!e.content.startsWith('\uFEFF')&&!e.content.includes('\0'));need(Buffer.byteLength(e.content)===e.bytes&&hash(e.content)===e.sha256);const {content,...entry}=e;return entry})
 contextInventory(inventory);const {packetId,...body}=p;need(packetId==='context_'+hash(canonicalJson(body)))
 return {binding:contextBinding(p.binding),packetId,requiredEntries:inventory}
}
