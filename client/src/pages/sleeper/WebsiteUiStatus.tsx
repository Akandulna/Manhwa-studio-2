import type { ManagerObservation } from '../../../../server/src/services/managerProtocol'
import { UI_PROVIDERS, type UiControl } from '../../../../server/src/services/websiteUiProtocol'
import { Badge } from '@/components/ui/badge'
const names = { chatgpt:'ChatGPT',gemini:'Gemini',aistudio:'Google AI Studio' }
const when = (at:string|null) => at ? new Date(at).toLocaleString() : 'Not received'
const auditState = (o:ManagerObservation) => Date.now()>Date.parse(o.websiteUi!.audit.dueAt) && o.websiteUi!.audit.state==='checked' ? 'due (last reported checked)' : o.websiteUi!.audit.state
const readable = (v:string) => v.replace(/_/g,' ')
const describe = (c:UiControl|undefined) => c ? `${c.count===0?'Missing':c.count===2?'Ambiguous':c.label} · position ${c.location.slice(0,2).join(', ')}` : 'No baseline'
export default function WebsiteUiStatus({ observations,devices }: { observations:ManagerObservation[]; devices:string[] }) {
  const facts = observations.filter(o => o.websiteUi)
  return (
    <section id="website-ui-status" aria-label="Website UI monitoring" className="space-y-3">
      <h2 className="text-lg font-semibold">Website UI monitoring</h2>
      <p className="text-sm text-muted-foreground">Only observed pages are checked. Review baselines and verify required controls on the affected phone. Acknowledging an alert does not accept a baseline or establish compatibility.</p>
      <div className="grid gap-2 md:grid-cols-3">
        {UI_PROVIDERS.map(provider => {
          const coverage = facts.filter(o => o.source.manager==='website_ui' && o.websiteUi!.provider===provider)
          const missing = devices.filter(id => !coverage.some(o => o.source.deviceId===id))
          return <div className="rounded border p-3 text-sm" key={provider}>
            <strong>{names[provider]}</strong>
            {!coverage.length && <p>Not checked · no observed page baseline.</p>}
            {coverage.map(o => <p key={`${o.source.id}/${o.key}`}>{o.source.deviceId} · {readable(o.websiteUi!.workflow)} · {Date.now()-Date.parse(o.observedAt)>300_000?'Last known · ':''}{readable(o.websiteUi!.classification)} · audit {auditState(o)}</p>)}
            {coverage.length>0 && missing.map(id => <p key={id}>{id} · Not checked</p>)}
          </div>
        })}
      </div>
      {facts.map(o => {
        const ui=o.websiteUi!
        return <details className="rounded border p-3 text-sm" key={`${o.source.id}/${o.key}`}>
          <summary className="cursor-pointer">{names[ui.provider]} · {o.source.deviceId} · {readable(ui.workflow)} <Badge variant="outline">{readable(ui.classification)}</Badge></summary>
          <div className="mt-3 space-y-2">
            <p>Profile {o.scope.profileId ?? 'Unknown'} · {ui.variant.viewport} · {ui.variant.locale} · {ui.variant.theme} · profile variant {ui.variant.profileVariant}</p>
            <p>Baseline {ui.baselineVersion?.slice(0,12) ?? 'missing'} · Accepted {when(ui.baselineAcceptedAt)} · Controls verified {when(ui.compatibilityVerifiedAt)}</p>
            <p>Last matching page {when(ui.lastMatchingAt)} · First changed page {when(ui.firstChangedAt)}</p>
            <p>Observation {readable(ui.reason)} · Clipping impact {readable(ui.impact)} · Audit {auditState(o)}, due {when(ui.audit.dueAt)}</p>
            <ol className="list-decimal space-y-1 pl-5" aria-label="Website UI reporting path">
              <li>Website UI Monitor observed {when(ui.route.monitorObservedAt)}</li>
              <li>Device Image Clipper Manager received {when(ui.route.clipperReceivedAt)}</li>
              <li>Issues Manager received {when(ui.route.issuesReceivedAt)}</li>
            </ol>
            {ui.changeId && <p>Change reference {ui.changeId.slice(0,12)}. Work impact is limited to the observed device, profile and page variant.</p>}
            <div className="overflow-auto">
              <table className="w-full text-left text-xs">
                <thead><tr><th className="p-2">Control</th><th className="p-2">Expected</th><th className="p-2">Observed</th><th className="p-2">Other changes</th></tr></thead>
                <tbody>{ui.observed.map(c => {
                  const prior=ui.expected.find(p => p.id===c.id)
                  const changes=prior ? [prior.signature!==c.signature?'label':null,prior.icon!==c.icon?'icon':null,prior.style!==c.style?'appearance':null].filter(Boolean).join(', ') : 'No baseline'
                  return <tr className="border-t" key={c.id}><td className="p-2">{readable(c.id)}</td><td className="p-2">{describe(prior)}</td><td className="p-2">{describe(c)}</td><td className="p-2">{changes||'None'}</td></tr>
                })}</tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">Evidence contains control categories, appearance fingerprints and coarse positions. Conversation text, images, account names and screenshots are excluded. Unobserved dialogs and variants remain unchecked.</p>
          </div>
        </details>
      })}
    </section>
  )
}
