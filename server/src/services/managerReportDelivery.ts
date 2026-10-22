import { parseManagerReport, type ManagerReport } from './managerProtocol.js'
import { RelayDeliveryPause, RelayDeliveryPaused } from './relayDeliveryPause.js'

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
  return accepted
}
