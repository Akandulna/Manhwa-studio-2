import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, ChevronRight, Download, Eye, FileText, History, Image, Loader2, RefreshCw, Save, Type, Upload, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { youtubeApi, type YouTubeGuideline, type YouTubeGuidelines as Documents, type YouTubeGuidelineVersion } from '@/lib/youtube'

const message = (error: unknown) => error instanceof Error ? error.message : 'Could not save guidelines.'
const date = (value: string) => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
const titles = { title: 'Title guidelines', thumbnail: 'Thumbnail guidelines', description: 'Description instructions' }

function DocumentEditor({ document, onSaved }: { document: YouTubeGuideline; onSaved: (value: YouTubeGuideline) => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [text, setText] = useState(document.text)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const [history, setHistory] = useState<YouTubeGuidelineVersion[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [preview, setPreview] = useState<YouTubeGuideline | null>(null)
  const [modal, setModal] = useState<'read' | 'history' | null>(null)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const description = document.kind === 'description'
  useEffect(() => { setText(document.text); setFile(null); setHistory([]); setPreview(null); if (inputRef.current) inputRef.current.value = '' }, [document.id, document.text])

  function chooseFile(selected: File | null) {
    setError(''); setSaved(''); setDragging(false)
    if (selected && (selected.size > 10 * 1024 * 1024 || selected.size === 0)) {
      setFile(null); setError('Choose a non-empty document up to 10 MB.'); if (inputRef.current) inputRef.current.value = ''; return
    }
    setFile(selected)
  }
  async function save() {
    setBusy(true); setError(''); setSaved('')
    try {
      const next = description ? await youtubeApi.saveDescription(text, document.id) : await youtubeApi.upload(document.kind as 'title' | 'thumbnail', file!, document.id)
      onSaved(next); setFile(null); setSaved('Saved. New requests will use these guidelines.')
    } catch (cause) { setError(message(cause)) }
    finally { setBusy(false) }
  }
  async function loadHistory() {
    setModal('history'); setHistoryLoading(true); setError(''); setSaved('')
    try { setHistory(await youtubeApi.history(document.kind)) }
    catch (cause) { setError(message(cause)) }
    finally { setHistoryLoading(false) }
  }
  async function viewVersion(id: string) {
    setError(''); setHistoryLoading(true)
    try { setPreview(await youtubeApi.version(document.kind, id)); setModal('read') }
    catch (cause) { setError(message(cause)) }
    finally { setHistoryLoading(false) }
  }
  const feedback = error || saved ? <div aria-live="polite">{error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}{saved && <p role="status" className="flex items-start gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 text-sm"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />{saved}</p>}</div> : null

  return <section aria-label={titles[document.kind]} className="overflow-hidden rounded-xl border bg-card">
    <div className="border-b px-5 py-5 sm:px-6"><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-lg font-semibold">{titles[document.kind]}</h3><Badge variant="outline" className="gap-1.5 font-normal"><CheckCircle2 className="h-3 w-3 text-emerald-500" />Active</Badge></div><p className="mt-1.5 text-sm text-muted-foreground">{description ? 'Set the tone and structure for English descriptions.' : document.kind === 'title' ? 'The reference document used to shape your title suggestions.' : 'The visual rules used to create your thumbnail variations.'}</p></div>
    <div className="space-y-5 p-5 sm:p-6">
      {!modal && feedback}
      <div className="flex flex-col justify-between gap-4 rounded-lg bg-muted/35 p-4 sm:flex-row sm:items-start">
        <div className="flex min-w-0 gap-3"><FileText className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" /><div className="min-w-0"><p className="break-words text-sm font-medium">{document.sourceName}</p><p className="mt-1 text-xs text-muted-foreground">Updated {date(document.createdAt)}</p></div></div>
        <div className="flex shrink-0 gap-1"><Button variant="ghost" size="sm" onClick={() => { setPreview(document); setModal('read'); setError(''); setSaved('') }}><Eye className="mr-1.5 h-3.5 w-3.5" />Read</Button><Button variant="ghost" size="sm" asChild><a href={youtubeApi.download(document.kind, document.id)} download aria-label={`Download ${titles[document.kind].toLowerCase()}`}><Download className="h-4 w-4" /></a></Button><Button variant="ghost" size="sm" onClick={loadHistory} disabled={historyLoading}><History className="mr-1.5 h-3.5 w-3.5" />History</Button></div>
      </div>
      {description ? <div className="space-y-3"><Label htmlFor="youtube-description-instructions">Description instructions</Label><Textarea id="youtube-description-instructions" value={text} disabled={busy} onChange={event => setText(event.target.value)} rows={12} maxLength={500000} className="text-sm leading-relaxed" /><div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground">{text.trim() === document.text.trim() ? 'All changes saved' : 'You have unsaved changes'}</p><Button onClick={save} disabled={busy || text.trim() === document.text.trim() || text.trim().length < 20}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}Save instructions</Button></div></div>
        : <div className="space-y-3">
          <p className="text-sm font-medium">Update the guideline document</p>
          <input ref={inputRef} id={`youtube-${document.kind}-file`} type="file" disabled={busy} className="hidden" aria-label={`Choose ${document.kind} guideline document`} onChange={event => chooseFile(event.target.files?.[0] ?? null)} />
          {file ? <div className="flex items-start gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4"><FileText className="mt-0.5 h-5 w-5 shrink-0 text-primary" /><div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{file.name}</p><p className="mt-1 text-xs text-muted-foreground">{(file.size / 1024).toFixed(0)} KB · Ready to save</p></div><Button aria-label="Remove selected document" size="icon" variant="ghost" className="h-7 w-7" disabled={busy} onClick={() => { chooseFile(null); if (inputRef.current) inputRef.current.value = '' }}><X className="h-4 w-4" /></Button></div>
            : <button type="button" disabled={busy} onClick={() => inputRef.current?.click()} className={`flex w-full cursor-pointer flex-col items-center rounded-xl border-2 border-dashed px-5 py-8 text-center transition-colors focus-within:ring-2 focus-within:ring-primary ${dragging ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40 hover:bg-accent/20'} ${busy ? 'pointer-events-none opacity-50' : ''}`} onDragOver={event => { event.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); if (!busy) { if (event.dataTransfer.files.length !== 1) { setDragging(false); setError('Choose one document at a time.'); return } chooseFile(event.dataTransfer.files[0]) } }}><Upload className="mb-3 h-6 w-6 text-muted-foreground" /><span className="text-sm font-medium">Choose a file or drop it here</span><span className="mt-1.5 max-w-sm text-xs leading-relaxed text-muted-foreground">PDF with selectable text, TXT, Markdown, or title-report JSON · Up to 10 MB</span></button>}
          {file && <div className="flex flex-wrap items-center justify-between gap-3"><Button variant="ghost" size="sm" onClick={() => inputRef.current?.click()} disabled={busy}>Choose another file</Button><Button onClick={save} disabled={busy}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}Save new guidelines</Button></div>}
        </div>}
    </div>
    <div className="border-t bg-muted/15 px-5 py-3 text-xs leading-relaxed text-muted-foreground sm:px-6">Changes apply to new requests. Earlier documents and saved series results are kept.</div>
    <Dialog open={modal !== null} onOpenChange={value => { if (!value) setModal(null) }}><DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-3xl overflow-y-auto">
      <DialogHeader><DialogTitle>{modal === 'history' ? `${titles[document.kind]} history` : titles[document.kind]}</DialogTitle><DialogDescription>{modal === 'history' ? 'Previous versions are kept automatically. Viewing one does not change the active document.' : preview?.sourceName}</DialogDescription></DialogHeader>
      {historyLoading ? <p role="status" className="flex items-center gap-2 py-8"><Loader2 className="h-4 w-4 animate-spin" />Loading document…</p> : modal === 'history' ? <div className="space-y-2">{history.map(version => <button key={version.id} onClick={() => viewVersion(version.id)} className="flex w-full items-center gap-3 rounded-lg border p-4 text-left hover:bg-accent/40"><FileText className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1"><span className="block break-words text-sm font-medium">{version.sourceName}</span><span className="mt-1 block text-xs text-muted-foreground">{date(version.createdAt)}</span></span>{version.id === document.id && <Badge variant="secondary">Current</Badge>}<ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" /></button>)}</div>
        : preview && <><div className="flex flex-wrap items-center justify-between gap-3"><Badge variant="outline">{preview.id === document.id ? 'Current document' : 'Previous version'}</Badge><Button size="sm" variant="outline" asChild><a href={youtubeApi.download(document.kind, preview.id)} download><Download className="mr-2 h-3.5 w-3.5" />Download</a></Button></div><pre className="max-h-[55dvh] overflow-y-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/20 p-5 font-sans text-sm leading-relaxed">{preview.text}</pre>{history.length > 0 && <Button size="sm" variant="ghost" onClick={() => setModal('history')}>Back to version history</Button>}</>}
      {feedback}
    </DialogContent></Dialog>
  </section>
}

export default function YouTubeGuidelines() {
  const [documents, setDocuments] = useState<Documents | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  async function load() {
    setLoading(true); setError('')
    try { setDocuments(await youtubeApi.guidelines()) }
    catch (cause) { setError(message(cause)) }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])
  return <div className="space-y-6">
    <div><h2 className="text-2xl font-semibold tracking-tight">YouTube guidelines</h2><p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">Keep your channel’s writing and visual style in one place. Choose what you want to update below.</p></div>
    {loading && <div role="status" className="flex items-center justify-center gap-3 rounded-xl border py-20 text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" />Loading guidelines…</div>}
    {error && <div role="alert" className="space-y-3 rounded-xl border border-destructive/20 p-5"><p className="text-sm text-destructive">{error}</p><Button variant="outline" onClick={load}><RefreshCw className="mr-2 h-4 w-4" />Reload guidelines</Button></div>}
    {!loading && documents && <Tabs defaultValue="title" className="space-y-5"><TabsList aria-label="Guideline categories" className="grid h-auto w-full grid-cols-3 gap-1 rounded-xl border bg-muted/30 p-1">
      {[{ value: 'title', label: 'Titles', icon: Type }, { value: 'thumbnail', label: 'Thumbnails', icon: Image }, { value: 'description', label: 'Descriptions', icon: FileText }].map(({ value, label, icon: Icon }) => <TabsTrigger key={value} value={value} className="gap-2 rounded-lg px-2 py-3 text-xs sm:text-sm"><Icon className="hidden h-4 w-4 sm:block" />{label}</TabsTrigger>)}
    </TabsList>{(['title', 'thumbnail', 'description'] as const).map(kind => <TabsContent key={kind} value={kind} forceMount className="mt-0 data-[state=inactive]:hidden"><DocumentEditor document={documents[kind]} onSaved={value => setDocuments(current => current && ({ ...current, [kind]: value }))} /></TabsContent>)}</Tabs>}
  </div>
}
