import { managerPayload, parseManagerReport, type ManagerReport, type ManagerFact } from './managerProtocol.js'
export const MANAGER_BATCH_BYTES = 256_000
export function managerBatch(reports: ManagerReport[]): ManagerReport[] {
  const batch: ManagerReport[]=[]
  for(const report of reports) {
    if(batch.length===16)break
    if(Buffer.byteLength(JSON.stringify({schema:'manager-batch/1',reports:[...batch,report]}))>MANAGER_BATCH_BYTES)break
    batch.push(report)
  }
  return batch
}
export function managerAcknowledgment(raw:unknown,original:ManagerReport):ManagerReport {
  const report=parseManagerReport(raw)
  if(!report?.receivedAt||report.eventId!==original.eventId||managerPayload(report)!==managerPayload(original))throw new Error('Relay acknowledgment does not match manager event')
  return report
}

export function managerFactChunks(facts:ManagerFact[]):ManagerFact[][] {
  const chunks:ManagerFact[][]=[];let chunk:ManagerFact[]=[]
  for(const fact of facts) {
    if(Buffer.byteLength(JSON.stringify(fact))>240_000)throw new Error('Manager fact exceeds delivery byte bound')
    if(chunk.length===100||Buffer.byteLength(JSON.stringify([...chunk,fact]))>240_000){chunks.push(chunk);chunk=[]}
    chunk.push(fact)
  }
  if(chunk.length)chunks.push(chunk)
  return chunks
}
