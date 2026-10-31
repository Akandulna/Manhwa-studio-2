/** Delivery timestamps do not change snapshot content. Nested source evidence keeps its timestamps. */
export function receiptContent(value:unknown):string {
  const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'
    ?Object.fromEntries(Object.keys(v).sort().map(key=>[key,canonical(v[key])])):v
  if(!value||typeof value!=='object'||Array.isArray(value))return JSON.stringify(value)
  const {updatedAt:_,...content}=value as Record<string,unknown>
  return JSON.stringify(canonical(content))
}
export const PRESENCE_CHECKPOINT_MS=300_000

/** Optional source revision. Legacy clients keep their prior behavior. */
export function staleReceipt(prior:unknown,incoming:unknown):boolean {
 const p=(prior as any)?.wifiRevision,n=(incoming as any)?.wifiRevision
 return Number.isSafeInteger(p)&&p>0&&Number.isSafeInteger(n)&&n>0&&n<p
}
