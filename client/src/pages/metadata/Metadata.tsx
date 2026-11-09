import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, CheckCircle2, ChevronDown, ChevronRight, Clock, FileJson, Loader2, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useMetadataLibrary } from '@/hooks/useMetadataLibrary'
import { useSeriesOrder } from '@/hooks/useSeriesOrder'
import { clipperChapterParts } from '@/lib/clipperParts'
import { clipper3Api, type MetadataChapterStatus } from '@/lib/api'

function counts(chapters: MetadataChapterStatus[]) {
  return { complete: chapters.filter(c => c.state === 'complete').length,
    done: chapters.reduce((n, c) => n + c.done, 0), total: chapters.reduce((n, c) => n + c.total, 0) }
}

function Status({ chapter }: { chapter: MetadataChapterStatus }) {
  if (chapter.state === 'complete') return <Badge variant="success" className="gap-1"><CheckCircle2 className="h-3 w-3" />Complete</Badge>
  if (chapter.state === 'blocked' || chapter.pages.some(p => p.state === 'invalid'))
    return <Badge variant="outline" className="gap-1 text-amber-600"><AlertTriangle className="h-3 w-3" />Check</Badge>
  if (chapter.state === 'partial') return <Badge variant="secondary">Partially generated</Badge>
  return <Badge variant="outline" className="gap-1 text-muted-foreground"><Clock className="h-3 w-3" />Pending</Badge>
}

function Header({ data, title = 'Metadata', back }: {
  data: ReturnType<typeof useMetadataLibrary>; title?: string; back?: string
}) {
  return <>
    {back && <Button asChild variant="ghost" size="sm" className="mb-3"><Link to={back}><ArrowLeft className="h-4 w-4 mr-2" />Back</Link></Button>}
    <div className="flex flex-wrap items-start justify-between gap-4 mb-5">
      <div>
        <h1 className="flex items-center gap-2 text-3xl font-bold"><FileJson className="h-7 w-7 text-primary" />{title}</h1>
        <p className="text-muted-foreground mt-1">Metadata generated in Sleeper Cell, fetched and checked against the current chapter files.</p>
        {data.snapshot?.configured && <p className="text-xs text-muted-foreground mt-2" role="status">
          {data.fetching ? 'Fetching metadata…' : 'Automatically fetches when phones report new metadata and checks every minute.'}
          {data.snapshot.sync.checkedAt && ` Last checked ${new Date(data.snapshot.sync.checkedAt).toLocaleTimeString()}.`}
        </p>}
      </div>
      <Button variant="outline" onClick={() => { void data.sync() }} disabled={data.fetching || data.snapshot?.configured === false}>
        <RefreshCw className={`h-4 w-4 mr-2 ${data.fetching ? 'animate-spin' : ''}`} />Fetch metadata
      </Button>
    </div>
    {data.error && <div role="alert" className="border border-destructive/30 bg-destructive/10 text-destructive rounded-md p-3 mb-4">{data.error}</div>}
    {data.snapshot && !data.snapshot.configured && <p className="rounded-md border p-3 mb-4 text-sm text-muted-foreground">
      Configure Cloudflare R2 in <Link to="/settings" className="underline">Settings</Link> to fetch metadata from Sleeper Cell. Saved metadata is shown below.
    </p>}
    {!!data.snapshot?.sync.errors.length && <div role="alert" className="rounded-md border border-amber-500/40 p-3 mb-4 text-sm">
      <p className="font-medium">Some metadata could not be fetched</p>
      {data.snapshot.sync.errors.slice(0, 3).map((error, i) => <p key={i} className="text-muted-foreground">{error.reason}</p>)}
    </div>}
  </>
}

function Loading() { return <div className="p-12 flex justify-center" role="status" aria-label="Loading Metadata"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div> }

export function MetadataLibrary() {
  const data = useMetadataLibrary()
  const ordered = useSeriesOrder(data.snapshot?.series ?? [])
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const sections = useMemo(() => {
    const groups = new Map<number, { series: typeof ordered[number]; chapters: MetadataChapterStatus[] }[]>()
    for (const series of ordered) for (const part of clipperChapterParts(series.chapters)) {
      const rows = groups.get(part.number) ?? []
      rows.push({ series, chapters: part.chapters }); groups.set(part.number, rows)
    }
    return [...groups].sort(([a], [b]) => a - b)
  }, [ordered])
  return <div className="p-4 md:p-6">
    <Header data={data} />
    {!data.snapshot && !data.error && <Loading />}
    {data.snapshot && sections.length === 0 && <Card className="p-12 text-center">
      <FileJson className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
      <h2 className="text-xl font-semibold">No downloaded chapters yet</h2>
      <p className="text-muted-foreground mt-2">Download chapters in the Library to track their metadata here.</p>
    </Card>}
    <div className="space-y-5">
      {sections.map(([part, rows]) => <section key={part}>
        <button type="button" className="flex w-full flex-wrap items-center gap-2 py-3 text-left font-semibold" aria-expanded={!collapsed.has(part)} aria-controls={`metadata-part-${part}`}
          onClick={() => setCollapsed(previous => { const next = new Set(previous); if (next.has(part)) next.delete(part); else next.add(part); return next })}>
          <ChevronDown className={`h-4 w-4 ${collapsed.has(part) ? '-rotate-90' : ''}`} />Part {part}
          <span className="font-normal text-xs text-muted-foreground">Chapters {(part - 1) * 20 + 1}–{part * 20} · {rows.length} series</span>
        </button>
        <Card id={`metadata-part-${part}`} hidden={collapsed.has(part)} className="divide-y overflow-hidden">
          {rows.map(({ series, chapters }) => {
            const summary = counts(chapters)
            return <Link key={series.id} to={`/metadata/series/${series.id}?part=${part}`} className="flex flex-wrap items-center gap-3 px-4 py-4 hover:bg-accent/50">
              <div className="h-10 w-10 rounded-md bg-primary/10 flex items-center justify-center"><FileJson className="h-5 w-5 text-primary" /></div>
              <div className="flex-1 min-w-32"><h3 className="font-semibold">{series.title}</h3><p className="text-xs text-muted-foreground">{summary.complete}/{chapters.length} chapters complete · {summary.done}/{summary.total} pages</p></div>
              <Progress aria-label={`${series.title} metadata progress`} value={summary.total ? summary.done / summary.total * 100 : 0} className="hidden sm:block h-1 w-28" />
              <Badge variant={summary.complete === chapters.length ? 'success' : 'secondary'}>{summary.complete === chapters.length ? <><CheckCircle2 className="h-3 w-3 mr-1" />Complete</> : `${summary.complete}/${chapters.length} chapters`}</Badge>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </Link>
          })}
        </Card>
      </section>)}
    </div>
  </div>
}

export function MetadataSeries() {
  const { id } = useParams()
  const [search] = useSearchParams()
  const data = useMetadataLibrary()
  const series = data.snapshot?.series.find(s => s.id === id)
  const parts = clipperChapterParts(series?.chapters ?? [])
  const selection = search.get('part')
  const selected = selection === null || selection === 'all' ? null : Number(selection)
  const shown = selected === null ? parts : parts.filter(p => p.number === selected)
  return <div className="p-4 md:p-6">
    <Header data={data} title={series ? `${series.title} · Metadata` : 'Metadata'} back="/metadata" />
    {!data.snapshot && !data.error && <Loading />}
    {data.snapshot && !series && <p>This series has no downloaded chapters available for Metadata.</p>}
    {series && <>
      <nav aria-label="Metadata parts" className="flex flex-wrap gap-2 mb-6">
        <Button asChild variant={selected === null ? 'default' : 'outline'} size="sm"><Link to={`/metadata/series/${id}`}>All parts</Link></Button>
        {parts.map(p => <Button asChild key={p.number} variant={selected === p.number ? 'default' : 'outline'} size="sm"><Link to={`/metadata/series/${id}?part=${p.number}`}>Part {p.number} · {counts(p.chapters).complete}/{p.chapters.length}</Link></Button>)}
      </nav>
      {shown.length === 0 && <p className="text-muted-foreground">No downloaded chapters in this part.</p>}
      {shown.map(part => <section key={part.number} className="mb-6">
        <h2 className="font-semibold mb-3">Part {part.number} <span className="text-sm font-normal text-muted-foreground">· Chapters {(part.number - 1) * 20 + 1}–{part.number * 20}</span></h2>
        <Card className="divide-y overflow-hidden">
          {part.chapters.map(chapter => <Link key={chapter.id} to={`/metadata/chapter/${chapter.id}`} className="flex items-center gap-3 px-4 py-4 hover:bg-accent/50">
            {chapter.state === 'complete' ? <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" /> : <Clock className="h-5 w-5 shrink-0 text-muted-foreground" />}
            <div className="flex-1 min-w-0"><h3 className="font-medium">Chapter {chapter.number}{chapter.title ? ` · ${chapter.title}` : ''}</h3>
              <p className="text-xs text-muted-foreground">{chapter.done}/{chapter.total} pages with metadata</p>
              {chapter.reason && <p className="text-xs text-muted-foreground mt-1 break-words">{chapter.reason}</p>}
            </div>
            <Status chapter={chapter} /><ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          </Link>)}
        </Card>
      </section>)}
    </>}
  </div>
}

export function MetadataChapter() {
  const { id } = useParams()
  const data = useMetadataLibrary()
  const series = data.snapshot?.series.find(s => s.chapters.some(c => c.id === id))
  const chapter = series?.chapters.find(c => c.id === id)
  const [document, setDocument] = useState<{ page: string; text?: string; error?: string } | null>(null)
  const sequence = useRef(0)
  useEffect(() => { sequence.current++; setDocument(null); return () => { sequence.current++ } }, [id])
  async function view(filename: string) {
    const current = ++sequence.current
    setDocument({ page: filename })
    try {
      const value = await clipper3Api.getImageMetadata(id!, filename)
      if (current !== sequence.current) return
      const text = value.content ?? ''
      let formatted = text
      try { formatted = JSON.stringify(JSON.parse(text), null, 2) } catch { /* Legacy metadata can be plain text. */ }
      setDocument({ page: filename, text: formatted })
    } catch (error) {
      if (current === sequence.current) setDocument({ page: filename, error: error instanceof Error ? error.message : 'Could not read metadata' })
    }
  }
  const part = chapter ? Math.max(1, Math.ceil(chapter.number / 20)) : 1
  return <div className="p-4 md:p-6">
    <Header data={data} title={chapter ? `Chapter ${chapter.number} · Metadata` : 'Metadata'} back={series ? `/metadata/series/${series.id}?part=${part}` : '/metadata'} />
    {!data.snapshot && !data.error && <Loading />}
    {data.snapshot && !chapter && <p>This chapter is unavailable.</p>}
    {chapter && <>
      <div className="flex items-center gap-3 mb-4"><Status chapter={chapter} /><span className="text-sm text-muted-foreground">{chapter.done}/{chapter.total} pages with metadata</span></div>
      {chapter.reason && <p className="text-sm text-muted-foreground mb-4">{chapter.reason}</p>}
      <Card className="divide-y overflow-hidden">
        {chapter.pages.map(page => <div key={page.filename} className="flex flex-wrap items-center gap-3 px-4 py-4">
          {page.state === 'complete' ? <CheckCircle2 className="h-5 w-5 text-emerald-500" /> : page.state === 'invalid' ? <AlertTriangle className="h-5 w-5 text-amber-500" /> : <Clock className="h-5 w-5 text-muted-foreground" />}
          <div className="flex-1 min-w-32"><p className="font-medium">{page.filename}</p><p className="text-xs text-muted-foreground break-words">{page.state === 'complete' ? 'Metadata prepared and validated' : page.reason || 'Metadata not prepared yet'}</p></div>
          {page.hasMetadata && <Button variant="outline" size="sm" onClick={() => { void view(page.filename) }}><FileJson className="h-4 w-4 mr-2" />View metadata</Button>}
        </div>)}
      </Card>
    </>}
    <Dialog open={document !== null} onOpenChange={open => { if (!open) { sequence.current++; setDocument(null) } }}>
      <DialogContent className="max-w-4xl"><DialogHeader><DialogTitle>{document?.page} · Metadata</DialogTitle><DialogDescription>Saved chapter metadata from Sleeper Cell</DialogDescription></DialogHeader>
        {document?.error ? <p role="alert" className="text-destructive">{document.error}</p> : document?.text !== undefined ? <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-4 text-xs">{document.text || 'No metadata saved.'}</pre> : <Loading />}
      </DialogContent>
    </Dialog>
  </div>
}
