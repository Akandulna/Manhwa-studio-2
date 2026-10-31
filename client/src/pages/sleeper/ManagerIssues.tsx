import RetainedRecoveryControls from '@/components/recovery/RetainedRecoveryControls'
import { useState } from 'react'
import WebsiteUiStatus from './WebsiteUiStatus'
import { Link } from 'react-router-dom'
import { useManagers } from '@/hooks/useManagers'
import { managersApi } from '@/lib/api'
import type { ManagerIncident, ManagerObservation } from '../../../../server/src/services/managerProtocol'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

const readable = (value: string) => value.replace(/_/g, ' ')
const when = (at: string | null) => at ? new Date(at).toLocaleString() : 'Not reported'

function IncidentCard({ incident: i, queued, pending, acknowledge }: {
  incident: ManagerIncident
  queued: boolean
  pending: boolean
  acknowledge: (id: string, notificationId: string) => Promise<void>
}) {
  const impacts = [...new Map(Object.values(i.impacts).map(p => [JSON.stringify(p.scope), p])).values()]
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">{i.summary}</CardTitle>
          <div className="flex gap-2">
            <Badge variant={i.severity === 'blocking' ? 'destructive' : 'outline'}>{i.severity}</Badge>
            <Badge variant="secondary">{readable(i.state)}</Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p>{i.nextAction}</p>
        {i.cause === 'website_ui' && <a className="underline" href="#website-ui-status">View website UI evidence and reporting path</a>}
        <p className="text-xs text-muted-foreground">
          First seen {when(i.firstOccurredAt)} · Last evidence {when(i.lastOccurredAt)} · {i.occurrences} occurrence{i.occurrences === 1 ? '' : 's'}
        </p>
        <div className="flex flex-wrap gap-3">
          {impacts.map(p => (
            <span key={JSON.stringify(p.scope)} className="flex gap-2">
              {p.scope.seriesId && <Link className="underline" to={`/series/${encodeURIComponent(p.scope.seriesId)}`}>Series</Link>}
              {p.scope.chapterId && <Link className="underline" to={`/chapter/${encodeURIComponent(p.scope.chapterId)}/preview`}>Chapter</Link>}
              <Link className="underline" to={p.scope.profileId ? '/sleeper-cells/accounts' : '/sleeper-cells'}>
                {p.scope.profileId ? 'Account profile' : 'Device'}
              </Link>
            </span>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {i.acknowledgedAt
            ? `Acknowledged ${when(i.acknowledgedAt)}. The condition retains its own status.`
            : queued ? 'Acknowledgment saved; waiting for relay delivery.' : 'Notification not yet acknowledged.'}
        </p>
        {!i.acknowledgedAt && (
          <Button size="sm" variant="outline" disabled={pending || queued} onClick={() => void acknowledge(i.id, i.notificationId)}>
            {queued ? 'Acknowledgment queued' : pending ? 'Saving…' : 'Acknowledge notification'}
          </Button>
        )}
        <details>
          <summary className="cursor-pointer">Evidence and recovery history</summary>
          <ol className="mt-2 space-y-1">
            {i.history.map((h, n) => (
              <li key={`${h.eventId}/${n}`}>
                {when(h.at)} · {readable(h.action)} · <span className="text-xs text-muted-foreground">{h.evidenceRef}</span>
              </li>
            ))}
          </ol>
        </details>
      </CardContent>
    </Card>
  )
}

function ObservationRow({ fact: o, chapter, sourceLabel }: {
  fact: ManagerObservation
  chapter?: { title: string; name: string }
  sourceLabel: string
}) {
  return (
    <tr className="border-t align-top">
      <td className="p-3">
        {chapter ? `${chapter.title} · ${chapter.name}` : o.scope.profileId ? `Profile ${o.scope.profileId}` : 'Shared resource'}
        <div className="text-muted-foreground">{readable(o.stage)}</div>
      </td>
      <td className="p-3">{sourceLabel}<div className="text-xs text-muted-foreground">{o.source.deviceId}</div></td>
      <td className="p-3">{o.override ? 'Manual/archive override' : readable(o.workState)}</td>
      <td className="p-3">{o.availability.map((a, n) => <div key={n}>{a.destination}: {readable(a.state)}</div>)}</td>
      <td className="p-3">
        {o.compatibility}
        {o.identity === 'unresolved' && <div className="text-xs text-muted-foreground">Legacy identity unconfirmed</div>}
      </td>
      <td className="p-3">
        {when(o.observedAt)}
        <div className="text-xs text-muted-foreground">
          {Date.now() - Date.parse(o.observedAt) > 300_000 ? 'Last known' : 'Source observation'} · {o.receivedAt ? 'Relay accepted' : 'Delivery pending'}
        </div>
      </td>
    </tr>
  )
}

export default function ManagerIssues() {
  const { data, error, reload } = useManagers()
  const [chapter, setChapter] = useState('')
  const [history, setHistory] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const facts = data?.observations.filter(o => !o.websiteUi && (!chapter || o.scope.chapterId === chapter)) ?? []
  const incidents = data?.incidents.filter(i =>
    (history || i.state !== 'resolved') && (!chapter || Object.values(i.impacts).some(p => p.scope.chapterId === chapter))
  ) ?? []

  async function acknowledge(id: string, notificationId: string) {
    setPending(id)
    setActionError(null)
    try {
      await managersApi.acknowledge(id, notificationId)
      await reload()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not save acknowledgment.')
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Production issues</h1>
          <p className="mt-1 text-sm text-muted-foreground">Evidence, handoffs and source freshness across Studio and phones.</p>
        </div>
        <Button variant="outline" onClick={() => void reload()}>Refresh view</Button>
      </div>
      <RetainedRecoveryControls />
      {(error || data?.error || actionError) && (
        <p role="alert" className="rounded border border-destructive p-3 text-sm">{error || data?.error || actionError}</p>
      )}
      {!data && !error && <p>Loading manager reports…</p>}
      {data && !data.enabled && (
        <Card>
          <CardHeader><CardTitle>Observation reporting is disabled</CardTitle></CardHeader>
          <CardContent>
            Enable manager observations in the Studio server configuration and on compatible phones to collect reports.
            Existing progress remains available in <Link className="underline" to="/sleeper-cells/live">Live Progress</Link>.
          </CardContent>
        </Card>
      )}
      {data?.enabled && (
        <>
          {(data.deliveryError || data.pendingReports > 0) && (
            <p role="status" className="rounded border p-3 text-sm">
              {data.deliveryError || 'Reports are awaiting relay acceptance.'} {data.pendingReports} saved reports pending.
              Evidence retains its original source time.
            </p>
          )}
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {data.managers.map(m => (
              <div key={`${m.id}/${m.deviceId ?? ''}`} className="rounded-lg border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{m.name}</span>
                  <Badge variant={m.state === 'reporting' ? 'secondary' : 'outline'}>{readable(m.state)}</Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{m.deviceId ?? 'Shared role'} · {when(m.observedAt)}</p>
                {m.observedAt && !m.authorityAccepted && <p className="text-xs text-muted-foreground">Relay acceptance pending</p>}
              </div>
            ))}
          </div>
          <WebsiteUiStatus observations={data.observations} devices={[...new Set(data.managers.filter(m => m.id === 'device' && m.deviceId).map(m => m.deviceId!))]} />
          <div className="flex flex-wrap items-center gap-4">
            <label className="text-sm">
              Chapter
              <select aria-label="Filter by chapter" className="ml-2 rounded border bg-background p-2" value={chapter} onChange={e => setChapter(e.target.value)}>
                <option value="">All chapters</option>
                {data.chapters.map(c => <option key={c.chapterId} value={c.chapterId}>{c.title} · {c.name}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={history} onChange={e => setHistory(e.target.checked)} />Include resolved incidents
            </label>
          </div>
          <section className="space-y-3" aria-label="Issues inbox">
            <h2 className="text-lg font-semibold">Issues inbox</h2>
            {!incidents.length && (
              <p className="text-sm text-muted-foreground">No matching incidents in the received reports. Managers marked “not reporting” have not supplied evidence.</p>
            )}
            {incidents.map(i => (
              <IncidentCard key={i.id} incident={i} queued={data.pendingAcknowledgments?.includes(i.id) ?? false} pending={pending === i.id} acknowledge={acknowledge} />
            ))}
          </section>
          <section className="space-y-3">
            <h2 className="text-lg font-semibold">Chapter evidence and handoffs</h2>
            <p className="text-sm text-muted-foreground">
              A saved phone output, a cloud object, a Mac import and module validation are separate facts.
              Unknown compatibility does not establish current completion.
            </p>
            <div className="overflow-auto rounded-lg border">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted"><tr>{['Chapter / stage', 'Source', 'Work', 'Availability', 'Revision', 'Last source evidence'].map(t => <th className="p-3" key={t}>{t}</th>)}</tr></thead>
                <tbody>
                  {facts.map(o => (
                    <ObservationRow key={`${o.source.id}/${o.key}`} fact={o} chapter={data.chapters.find(c => c.chapterId === o.scope.chapterId)} sourceLabel={data.managers.find(m => m.id === o.source.manager)?.name ?? readable(o.source.manager)} />
                  ))}
                </tbody>
              </table>
              {!facts.length && <p className="p-4 text-sm text-muted-foreground">No matching evidence has been reported.</p>}
            </div>
          </section>
          {!!data.disagreements?.length && (
            <section className="space-y-2">
              <h2 className="text-lg font-semibold">Progress differences</h2>
              {data.disagreements.filter(d => !chapter || d.chapterId === chapter).map((d, n) => <p className="rounded border p-3 text-sm" key={n}>{readable(d.stage)} · {d.reason}</p>)}
            </section>
          )}
        </>
      )}
    </div>
  )
}
