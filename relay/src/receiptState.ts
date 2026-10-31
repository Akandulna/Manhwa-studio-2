/** Delivery timestamps do not change snapshot content. Nested source evidence keeps its timestamps. */
export function receiptContent(value:unknown):string {
  const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'
    ?Object.fromEntries(Object.keys(v).sort().map(key=>[key,canonical(v[key])])):v
  if(!value||typeof value!=='object'||Array.isArray(value))return JSON.stringify(value)
  const {updatedAt:_,...content}=value as Record<string,unknown>
  return JSON.stringify(canonical(content))
}
export const PRESENCE_CHECKPOINT_MS=300_000
