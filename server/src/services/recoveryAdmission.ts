const reconciliationActions=new Set(['inspect','discover','discover-binding','discover-retained','status','pause','disable','cancel','stop','reinspect','withdraw','finish','unknown','report','resolve','apply','receipt','complete','next'])

/** The kill switch blocks new repair work, while retaining inspection, stop and receipt delivery. */
export function recoveryAllowedWhileDisabled(raw:unknown):boolean {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return false
 const body=raw as Record<string,any>,action=body.action
 if(body.schema==='recovery-stop/1'&&['pause','disable','cancel','reinspect'].includes(body.mode))return true
 if(typeof action!=='string')return false
 if(reconciliationActions.has(action))return true
 if(action==='control'||action==='control-binding'){
  const d=body.details??body
  return d.enabled===false||d.paused===true||d.cancelled===true
 }
 // The correction handler independently requires an already verified immutable receipt when disabled.
 return action==='commit'
}
