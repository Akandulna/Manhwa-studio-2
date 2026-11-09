/**
 * AntiGravity → Running processes: one tab for everything that runs. The
 * left column shows the Google (Antigravity) and ChatGPT (Codex) usage
 * limits, the Sleeper-Cell phones (their Image Clipper, Metadata, Narration,
 * Voiceover and Editor runs, as Live Progress shows them) and the one
 * AntiGravity process; the right side shows the one selected. There is no
 * list of runs: one process exists at a time, and the pages it is processing
 * now are its rows (as many as the parallel-pages setting).
 *
 *   /antigravity/runs          → the current AntiGravity process (else the last one)
 *   /antigravity/runs/phones   → the phones
 *   /antigravity/runs/:runId   → that run (old run links keep working)
 *
 * AntiGravity runs refresh on local progress events. Phone status is the
 * server's last receipt, live through the relay; R2 is read only when
 * "Refresh from phone" is pressed (free-tier rule: nothing polls R2).
 */

import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowRight, Loader2, Orbit, Smartphone } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { PhoneRefreshButton } from '@/components/PhoneRefreshButton'
import { usePhoneOverview } from '@/hooks/usePhoneOverview'
import { usePhoneRelay } from '@/hooks/usePhoneRelay'
import { clipper3Api, type PhoneOverview, type PhoneOverviewPhone } from '@/lib/api'
import type { PhoneReceipt } from '@/hooks/usePhoneReceipt'
import { cn } from '@/lib/utils'
import { AVERAGE_OVER, PhoneProgress } from '../sleeper/LiveProgress'
import { ago, Light, phoneActivity, phoneList, useNow } from '../sleeper/sleeperShared'
import { RunDetail } from './AntiGravityRun'
import { UsageLimitsPanel } from '@/components/antigravity/UsageLimitsPanel'
import { AntiGravityTopBar, runOriginPath, useCurrentProcess } from './shared'

const WORKING = new Set(['preparing', 'running', 'pause_requested', 'stop_requested'])

const runBadge = (control: string) =>
  WORKING.has(control) ? 'secondary' : control === 'completed' ? 'success' : ['paused', 'interrupted', 'completed_with_errors'].includes(control) ? 'warning' : 'outline'

function usePhones(receipt: PhoneReceipt<PhoneOverview>) {
  const relay = usePhoneRelay()
  const overview = receipt.status
  const phones = useMemo(() => phoneList(overview, relay), [overview, relay])
  const several = phones.length > 1
  const activity = phones.map(phone => ({ phone, ...phoneActivity(overview, phone, several) }))
  return { overview, phones, several, activity, busy: activity.filter(a => a.busy) }
}

function PhonesPanel({ receipt }: { receipt: PhoneReceipt<PhoneOverview> }) {
  const { overview, several, activity, busy } = usePhones(receipt)
  const now = useNow(busy.length > 0)
  const averageTook = useMemo(() => {
    const auto = (overview?.recent ?? []).filter(f => f.run !== 'manual' && f.took !== null).slice(0, AVERAGE_OVER)
    return auto.length ? auto.reduce((sum, f) => sum + f.took!, 0) / auto.length : null
  }, [overview])

  return (
    <div className="min-w-0 space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-semibold"><Smartphone className="h-5 w-5" /> Phones</h2>
          <p className="text-sm text-muted-foreground">Image Clipper, Metadata, Narration, Voiceover and Editor runs on the Sleeper-Cell phones.</p>
        </div>
        <div className="flex items-center gap-2">
          <PhoneRefreshButton receipt={receipt} />
        </div>
      </header>
      {!overview && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Reading the last phone report…</div>}
      {overview && !overview.configured && (
        <Card><CardContent className="p-5 text-sm text-muted-foreground">Phone status needs Cloudflare R2 or the phone relay (Settings → Cloudflare).</CardContent></Card>
      )}
      {overview?.configured && (
        <>
          {busy.map(({ phone }) => (
            <PhoneProgress key={phone.id || phone.name} phone={phone} overview={overview} several={several} averageTook={averageTook} now={now} />
          ))}
          {busy.length === 0 && (
            <Card><CardContent className="flex items-center gap-3 p-5"><Light tone="idle" size="h-3 w-3" /><span className="font-medium">Nothing running on the phones</span></CardContent></Card>
          )}
          {activity.filter(a => !a.busy).length > 0 && busy.length > 0 && (
            <p className="text-xs text-muted-foreground">Idle: {activity.filter(a => !a.busy).map(a => a.phone.name).join(', ')}</p>
          )}
        </>
      )}
      <div className="flex flex-wrap gap-4 text-sm">
        <Link to="/sleeper-cells/live" className="inline-flex items-center gap-1 hover:underline">Full Live Progress <ArrowRight className="h-3.5 w-3.5" /></Link>
        <Link to="/sleeper-cells" className="inline-flex items-center gap-1 hover:underline">Start a phone run on Phone Status <ArrowRight className="h-3.5 w-3.5" /></Link>
      </div>
    </div>
  )
}

function phoneSummary(phone: PhoneOverviewPhone, title: string | null, several: boolean) {
  const what = title ?? 'Idle'
  return several ? `${phone.name}: ${what}` : what
}

export default function AntiGravityRuns({ phonesView = false }: { phonesView?: boolean }) {
  const { runId } = useParams()
  const receipt = usePhoneOverview()
  const phones = usePhones(receipt)
  const { current } = useCurrentProcess()
  const [titles, setTitles] = useState<Map<string, string>>(new Map())
  const now = useNow(false)

  useEffect(() => {
    clipper3Api.getSeries().then(list => setTitles(new Map(list.map(s => [s.id, s.title])))).catch(() => { /* ids stay */ })
  }, [])

  const selected = phonesView ? 'phones' : runId ?? 'process'
  const proc = current?.run ?? null
  // Library goes back to where the shown process was started (its part's Image Clipper).
  const libraryTo = selected === 'process' && proc ? runOriginPath(proc) : undefined

  const item = (on: boolean) => cn(
    'block w-full rounded-md border px-3 py-2 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    on ? 'border-primary bg-primary/10' : 'border-transparent hover:bg-muted'
  )

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6">
      <AntiGravityTopBar tab="runs" libraryTo={libraryTo} crumbs={[{ label: 'AntiGravity', to: '/antigravity' }, { label: 'Running processes' }]} />
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <aside className="w-full shrink-0 space-y-5 lg:sticky lg:top-4 lg:w-72" aria-label="Processes">
          <UsageLimitsPanel />
          <section className="space-y-1">
            <h2 className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Phones</h2>
            <Link to="/antigravity/runs/phones" className={item(selected === 'phones')} aria-current={selected === 'phones' ? 'page' : undefined}>
              <div className="flex items-center gap-2">
                <Light tone={phones.busy.length ? 'good' : 'idle'} live={phones.busy.length > 0} size="h-2.5 w-2.5" />
                <span className="text-sm font-medium">Sleeper-Cell phones</span>
              </div>
              <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                {!receipt.status ? 'Reading…' : !receipt.status.configured ? 'Not set up' : phones.busy.length === 0 ? 'Nothing running' : phones.busy.map(a => <div key={a.phone.id || a.phone.name} className="truncate">{phoneSummary(a.phone, a.title, phones.several)}</div>)}
              </div>
            </Link>
          </section>
          <section className="space-y-1">
            <h2 className="flex items-center gap-1.5 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"><Orbit className="h-3.5 w-3.5" /> AntiGravity</h2>
            <Link to="/antigravity/runs" className={item(selected !== 'phones')} aria-current={selected !== 'phones' ? 'page' : undefined}>
              <div className="flex items-center gap-2">
                {current?.live && proc && WORKING.has(proc.control) ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" /> : <Light tone={current?.live ? 'good' : 'idle'} size="h-2.5 w-2.5" />}
                <span className="truncate text-sm font-medium">{current?.live && proc ? `${proc.kind === 'metadata' ? 'Metadata · ' : proc.kind === 'editor' ? 'Timeline · ' : ''}${titles.get(proc.seriesId) ?? 'Series'} · Part ${proc.partNumber}` : 'Current process'}</span>
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                {!current ? 'Reading…' : current.live && proc ? (
                  <>
                    <Badge variant={runBadge(proc.control)} className="px-1.5 py-0 text-[10px]">{proc.control.replace(/_/g, ' ')}</Badge>
                    {proc.engine === 'codex' && <Badge variant="outline" className="px-1.5 py-0 text-[10px]">ChatGPT</Badge>}
                    <span className="truncate" title={new Date(proc.createdAt).toLocaleString()}>started {ago(proc.createdAt, now)}</span>
                  </>
                ) : 'Nothing running'}
              </div>
            </Link>
          </section>
        </aside>
        <main className="min-w-0 flex-1">
          {selected === 'phones' && <PhonesPanel receipt={receipt} />}
          {selected === 'process' && (
            !current ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Reading the current process…</div>
            : current.live && proc ? <RunDetail key={proc.id} runId={proc.id} seriesTitleOf={id => titles.get(id)} />
            : (
              <div className="space-y-6">
                <Card><CardContent className="flex flex-wrap items-center gap-3 p-5">
                  <Light tone="idle" size="h-3 w-3" />
                  <span className="font-medium">Nothing running</span>
                  <span className="text-sm text-muted-foreground">Press Start process in a part's Image Clipper (Library). One process runs at a time.</span>
                </CardContent></Card>
                {proc && (
                  <section className="space-y-2">
                    <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Last process</h2>
                    <RunDetail key={proc.id} runId={proc.id} seriesTitleOf={id => titles.get(id)} />
                  </section>
                )}
              </div>
            )
          )}
          {selected !== 'phones' && selected !== 'process' && <RunDetail key={selected} runId={selected} seriesTitleOf={id => titles.get(id)} />}
        </main>
      </div>
    </div>
  )
}
