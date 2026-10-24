import { parseManagerReport, type ManagerReport } from './managerProtocol.js'
import { RelayDeliveryPause, RelayDeliveryPaused } from './relayDeliveryPause.js'
import { learnRelayFeatures } from './relayTraffic.js'
import { managerAcknowledgment } from './managerBatch.js'

/** One immutable delivery attempt; callers own the durable outbox and retry schedule. */
export async function sendManagerReport(url: string, token: string, report: ManagerReport, pause: RelayDeliveryPause): Promise<ManagerReport> {
  await pause.beforeSend()
  const response = await fetch(`${url}/manager/report?device=${encodeURIComponent(report.source.deviceId)}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(report), signal: AbortSignal.timeout(15000), redirect: 'error'
  })
  if (response.status === 429) {
    await response.body?.cancel()
    await pause.record(response.headers.get('Retry-After'))
    throw new RelayDeliveryPaused()
  }
  if (!response.ok) { await response.body?.cancel(); throw new Error('Manager relay delivery failed') }
  const result = await response.json() as { report?: unknown }
  const accepted = parseManagerReport(result.report)
  if (!accepted?.receivedAt) throw new Error('Manager relay returned an invalid acknowledgment')
  return managerAcknowledgment(accepted,report)
}

/** Capability negotiated by the relay hello. Each event retains its own receipt and sequence. */
export async function sendManagerBatch(url:string,token:string,reports:ManagerReport[],pause:RelayDeliveryPause):Promise<PromiseSettledResult<ManagerReport>[]> {
  try {
    await pause.beforeSend()
    const device=reports[0]?.source.deviceId
    if(!device||reports.some(r=>r.source.deviceId!==device))throw new Error('Mixed manager batch authority')
    const response=await fetch(`${url}/manager/batch?device=${encodeURIComponent(device)}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({schema:'manager-batch/1',reports}),signal:AbortSignal.timeout(15000),redirect:'error'})
    if(response.status===429){await response.body?.cancel();await pause.record(response.headers.get('Retry-After'));throw new RelayDeliveryPaused()}
    if(!response.ok){if(response.status===404||response.status===405)learnRelayFeatures([]);await response.body?.cancel();throw new Error('Manager batch delivery failed')}
    const raw=await response.json() as {schema?:unknown;results?:any[]}
    if(raw.schema!=='manager-batch/1'||!Array.isArray(raw.results)||raw.results.length!==reports.length)throw new Error('Invalid manager batch acknowledgment')
    return reports.map((report,i)=>{
      try {
        if(raw.results![i]?.eventId!==report.eventId||raw.results![i]?.error)throw new Error('Manager event was not acknowledged')
        return {status:'fulfilled',value:managerAcknowledgment(raw.results![i].report,report)}
      } catch(reason){return {status:'rejected',reason}}
    })
  }catch(reason){return reports.map(()=>({status:'rejected',reason}))}
}
