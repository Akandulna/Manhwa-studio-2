import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, BookOpen, Check, CheckCircle2, ChevronDown, Loader2, RotateCcw, Search, Settings, X, Youtube } from 'lucide-react'
import { seriesApi, type Series } from '@/lib/api'
import { youtubeApi, type YouTubeLibraryStatus } from '@/lib/youtube'
import { useSeriesOrder } from '@/hooks/useSeriesOrder'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'

const englishLabels: Record<YouTubeLibraryStatus['english'], string> = { not_started: 'Not started', in_progress: 'In progress', needs_update: 'Needs update', done: 'Done' }
export default function YouTubeLibrary() {
  const [series, setSeries] = useState<Series[]>([])
  const [statuses, setStatuses] = useState<Record<string, YouTubeLibraryStatus>>({})
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [notice, setNotice] = useState('')
  const [savingId, setSavingId] = useState<string | null>(null)
  const ordered = useSeriesOrder(series)
  async function load() {
    setLoading(true); setError('')
    try {
      const rows = await seriesApi.getAll()
      // Keep batches bounded for large libraries; do not create empty workspaces on list views.
      const batches = []
      for (let i = 0; i < rows.length; i += 500) batches.push(rows.slice(i, i + 500).map(row => row.id))
      const result = await Promise.all(batches.map(ids => youtubeApi.libraryStatuses(ids)))
      setSeries(rows); setStatuses(Object.assign({}, ...result))
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load series.') }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])
  async function markDone(row: Series, done: boolean) {
    if (savingId || !statuses[row.id]) return
    setSavingId(row.id); setSaveError(''); setNotice('')
    try {
      const result = await youtubeApi.setSeriesDone(row.id, done, statuses[row.id].revision)
      setStatuses(current => ({ ...current, [row.id]: result }))
      setNotice(done ? `${row.title} moved to Completed series below.` : `${row.title} reopened.`)
    } catch (cause) { setSaveError(cause instanceof Error ? cause.message : 'Could not update this series.') }
    finally { setSavingId(null) }
  }
  const visible = ordered.filter(row => row.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const active = visible.filter(row => !statuses[row.id]?.closedAt)
  const closed = visible.filter(row => statuses[row.id]?.closedAt)
  const totalClosed = series.filter(row => statuses[row.id]?.closedAt).length
  function card(row: Series) {
    const status = statuses[row.id]
    const done = status?.english === 'done'
    const archived = Boolean(status?.closedAt)
    return <article key={row.id} aria-label={row.title} className="rounded-xl border bg-card transition-colors hover:border-primary/40">
      <Link to={`/youtube/series/${encodeURIComponent(row.id)}`} className="group flex items-center gap-4 rounded-t-xl p-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${done ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-muted text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary'}`}>{done ? <CheckCircle2 className="h-5 w-5" /> : <BookOpen className="h-5 w-5" />}</div>
        <div className="min-w-0 flex-1"><h3 className="truncate font-semibold" title={row.title}>{row.title}</h3><p className="mt-1 truncate text-xs text-muted-foreground">{row.chapterCount !== undefined ? `${row.chapterCount} chapters · ` : ''}{row.sourceSite}</p><p className="mt-3 text-xs font-medium text-primary">Open workspace</p></div><ArrowRight aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-1" />
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3"><div className="flex flex-wrap gap-2"><Badge variant="outline" className={`gap-1.5 font-normal ${done ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400' : status?.english === 'needs_update' ? 'border-amber-500/30 text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`}>{done && <Check className="h-3 w-3" />}English · {englishLabels[status?.english ?? 'not_started']}</Badge><Badge variant="outline" title="Hinglish uses the selected thumbnail with a customizable HINDI overlay" className="font-normal text-muted-foreground">Hinglish · {({ not_started: 'Not started', title_ready: 'Title ready', needs_update: 'Needs update', thumbnail_pending: 'Thumbnail needed', done: 'Done' } as const)[status?.hinglish ?? 'not_started']}</Badge></div><Button variant={archived ? 'outline' : 'secondary'} size="sm" disabled={Boolean(savingId)} aria-label={`${archived ? 'Reopen' : 'Mark done'}: ${row.title}`} onClick={() => void markDone(row, !archived)}>{savingId === row.id ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : archived ? <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> : <Check className="mr-1.5 h-3.5 w-3.5" />}{archived ? 'Reopen' : 'Mark done'}</Button></div>
    </article>
  }
  return <div className="mx-auto min-w-0 max-w-7xl space-y-7 p-5 sm:p-8">
    <header className="flex flex-col justify-between gap-5 sm:flex-row sm:items-start"><div><div className="mb-3 flex items-center gap-2 text-xs font-medium text-muted-foreground"><Youtube className="h-4 w-4 text-red-500" />PUBLISHING WORKSPACE</div><h1 className="text-3xl font-semibold tracking-tight">YouTube</h1><p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">Choose a series to prepare its YouTube title, description, and thumbnail. Mark it done when you’re finished to move it out of your active list.</p></div><Button variant="outline" size="sm" asChild><Link to="/settings?tab=youtube"><Settings className="mr-2 h-4 w-4" />Manage guidelines</Link></Button></header>
    <section className="space-y-4" aria-labelledby="youtube-series-heading">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center"><div className="flex items-center gap-3"><h2 id="youtube-series-heading" className="text-lg font-semibold">Your series</h2>{!loading && <span className="rounded-md bg-muted px-2 py-0.5 text-xs tabular-nums text-muted-foreground">{series.length - totalClosed} active</span>}</div><div className="relative sm:w-80"><Search aria-hidden="true" className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><Input aria-label="Search manhwa series" placeholder="Find a series…" className="bg-card pl-9 pr-9" value={query} onChange={event => setQuery(event.target.value)} />{query && <button aria-label="Clear series search" className="absolute right-2 top-2 rounded p-1 text-muted-foreground hover:text-foreground" onClick={() => setQuery('')}><X className="h-4 w-4" /></button>}</div></div>
      {notice && <p role="status" className="rounded-lg bg-emerald-500/10 p-3 text-sm">{notice}</p>}
      {saveError && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"><p>{saveError}</p><Button variant="outline" size="sm" onClick={() => { setSaveError(''); void load() }}>Reload statuses</Button></div>}
      {loading ? <div role="status" className="flex items-center justify-center gap-3 rounded-xl border bg-card py-20 text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" />Loading your series…</div>
        : error ? <div role="alert" className="rounded-xl border border-destructive/20 bg-destructive/5 p-6"><p className="font-medium">Could not load your series</p><p className="mt-2 text-sm text-muted-foreground">{error}</p><Button className="mt-4" variant="outline" onClick={load}>Try again</Button></div>
        : !series.length ? <div className="rounded-xl border border-dashed bg-card p-12 text-center"><BookOpen className="mx-auto mb-4 h-8 w-8 text-muted-foreground" /><h3 className="text-lg font-semibold">Your first series starts here</h3><p className="mt-2 text-sm text-muted-foreground">Add a series to the library, then prepare its YouTube materials here.</p><Button className="mt-5" asChild><Link to="/add">Add a series</Link></Button></div>
        : !visible.length ? <div className="rounded-xl border bg-card p-12 text-center"><Search className="mx-auto mb-3 h-6 w-6 text-muted-foreground" /><h3 className="font-medium">No series found</h3><p className="mt-2 text-sm text-muted-foreground">Try a different name or clear your search.</p><Button variant="link" onClick={() => setQuery('')}>Clear search</Button></div>
        : active.length ? <div className="grid gap-3 lg:grid-cols-2">{active.map(card)}</div> : <div className="rounded-xl border border-dashed bg-card p-8 text-center"><CheckCircle2 className="mx-auto mb-3 h-7 w-7 text-emerald-500" /><h3 className="font-medium">{query ? 'Matching series are completed' : 'Your active list is clear'}</h3><p className="mt-2 text-sm text-muted-foreground">Open Completed series below to view or reopen them.</p></div>}
      <p className="text-xs text-muted-foreground">English shows Done when a title, description, and thumbnail are saved and current. Mark done moves a series to the completed list; it can be reopened anytime.</p>
    </section>
    {!loading && !error && totalClosed > 0 && <details className="group rounded-xl border bg-card"><summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-xl p-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary [&::-webkit-details-marker]:hidden"><div><span className="font-semibold">Completed series</span><Badge variant="secondary" className="ml-3">{query ? `${closed.length} / ${totalClosed}` : totalClosed}</Badge><p className="mt-1 text-xs text-muted-foreground">Manually marked done · Expand to view or reopen</p></div><ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" /></summary><div className="border-t p-4">{closed.length ? <div className="grid gap-3 lg:grid-cols-2">{closed.map(card)}</div> : <p className="p-3 text-sm text-muted-foreground">No completed series match your search.</p>}</div></details>}
  </div>
}
