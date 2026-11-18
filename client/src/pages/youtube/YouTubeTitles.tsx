import SleeperCellGeneration from './SleeperCellGeneration'
import PromptActions from './PromptActions'
import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Check, CheckCircle2, ChevronDown, Copy, ExternalLink, FileText, History, Lightbulb, Loader2, Pencil, Plus, RefreshCw, Search, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { youtubeApi, type YouTubeWorkspace } from '@/lib/youtube'

type Modal = 'generate' | 'custom' | 'history' | 'research' | null
type Action = 'prepare' | 'import' | 'select' | 'custom' | 'reload'
const date = (value: string) => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const message = (cause: unknown) => cause instanceof Error ? cause.message : 'Could not update titles. Please try again.'
function readDrafts(seriesId: string): Record<string, string> {
  try {
    const value = JSON.parse(sessionStorage.getItem(`youtube-title-drafts:${seriesId}`) ?? '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length <= 100000))
  } catch { return {} }
}

export default function YouTubeTitles({ workspace, onSaved, onDescription }: { workspace: YouTubeWorkspace; onSaved: (value: YouTubeWorkspace) => void; onDescription?: () => void }) {
  const requests = workspace.titles.requests
  const suggestions = workspace.titles.suggestions
  const waiting = [...requests].reverse().filter(item => !item.importedAt)
  const [requestId, setRequestId] = useState(() => waiting[0]?.id ?? requests.slice(-1)[0]?.id ?? '')
  const [drafts, setDrafts] = useState(() => readDrafts(workspace.seriesId))
  const [customTitle, setCustomTitle] = useState('')
  const [modal, setModal] = useState<Modal>(null)
  const [copiedPrompts, setCopiedPrompts] = useState<Record<string, boolean>>({})
  const [showPrompt, setShowPrompt] = useState(false)
  const [showMore, setShowMore] = useState(false)
  const [query, setQuery] = useState('')
  const [batch, setBatch] = useState('all')
  const [pending, setPending] = useState<Action | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const responseRef = useRef<HTMLTextAreaElement>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const titleRef = useRef<HTMLParagraphElement>(null)
  const hindiTitleRef = useRef<HTMLParagraphElement>(null)
  const mounted = useRef(true)
  const busy = pending !== null
  const request = requests.find(item => item.id === requestId)
  const response = drafts[requestId] ?? ''
  const chosen = workspace.selectedTitle
  const ideasOpen = !chosen || showMore
  const count = Array.from(customTitle.trim()).length
  const research = [...requests].reverse().find(item => item.response)?.response?.research
  const previousChoices = [...workspace.titles.selections].reverse().filter((item, index, all) => item.title !== chosen && all.findIndex(other => other.title === item.title) === index)
  const batches = requests.filter(item => item.importedAt)
  const ordered = [...batches].reverse().flatMap(item => suggestions.filter(suggestion => suggestion.requestId === item.id))
  const visible = (ordered.length === suggestions.length ? ordered : suggestions).filter(item => (batch === 'all' || item.requestId === batch) && item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))

  useEffect(() => { setShowMore(false) }, [chosen])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    try { sessionStorage.setItem(`youtube-title-drafts:${workspace.seriesId}`, JSON.stringify(drafts)) } catch { /* Storage may be unavailable; keep the in-memory draft. */ }
  }, [drafts, workspace.seriesId])

  function open(value: Modal) { setError(''); setNotice(''); setModal(value) }
  async function act(action: Action, task: () => Promise<YouTubeWorkspace>, success: string, after?: (value: YouTubeWorkspace) => void) {
    setPending(action); setError(''); setNotice('')
    try {
      const next = await task()
      if (mounted.current) {
        onSaved(next)
        if (action === 'select' || action === 'custom') {
          setShowMore(false)
          requestAnimationFrame(() => titleRef.current?.focus())
        }
        after?.(next); setNotice(success)
      }
    } catch (cause) { if (mounted.current) setError(message(cause)) }
    finally { if (mounted.current) setPending(null) }
  }
  function prepare() {
    open('generate'); setRequestId(''); setShowPrompt(false)
    void act('prepare', () => youtubeApi.prepareTitles(workspace.seriesId, workspace.titles.revision), '', next => setRequestId(next.titles.requests.slice(-1)[0]!.id))
  }
  function resume(id: string) {
    setRequestId(id); setShowPrompt(false); open('generate')
  }
  function edit(title?: string) { if (title !== undefined) setCustomTitle(title); open('custom') }
  async function copy(value: string, target: 'prompt' | 'title' | 'hindiTitle') {
    setError(''); setNotice('')
    try {
      await navigator.clipboard.writeText(value)
      if (mounted.current) {
        if (target === 'prompt') setCopiedPrompts(previous => ({ ...previous, [requestId]: true }))
        setNotice(target === 'prompt' ? request?.importedAt ? 'Original prompt copied to clipboard.' : 'Prompt copied. Continue in AI Studio, then paste its response here.' : 'Title copied to clipboard.')
        
      }
    } catch {
      if (target === 'prompt') {
        setShowPrompt(true)
        requestAnimationFrame(() => { promptRef.current?.focus(); promptRef.current?.select() })
      } else if ((target === 'hindiTitle' ? hindiTitleRef : titleRef).current) {
        (target === 'hindiTitle' ? hindiTitleRef : titleRef).current?.focus(); const element = (target === 'hindiTitle' ? hindiTitleRef : titleRef).current; if (element) window.getSelection()?.selectAllChildren(element)
      }
      setError('Clipboard access is unavailable. The text is selected; use your keyboard’s Copy command.')
    }
  }
  function refresh() {
    void act('reload', () => youtubeApi.openWorkspace(workspace.seriesId), 'Saved titles refreshed. Your response drafts are kept.', next => {
      if (!next.titles.requests.some(item => item.id === requestId)) setRequestId(next.titles.requests.slice(-1)[0]?.id ?? '')
    })
  }
  const feedback = error || notice ? <div aria-live="polite">
    {error && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"><p>{error}</p>{error.includes('another window') && <Button variant="outline" size="sm" className="mt-3" disabled={busy} onClick={refresh}><RefreshCw className="mr-2 h-3.5 w-3.5" />Refresh saved titles</Button>}</div>}
    {notice && <div role="status" className="flex items-start gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 text-sm"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" /><p className="flex-1">{notice}</p><button aria-label="Dismiss message" onClick={() => setNotice('')} className="rounded p-0.5 text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button></div>}
  </div> : null

  return <div className="space-y-5">
    {!modal && feedback}
    {chosen && <div className="grid gap-4 md:grid-cols-2"><section aria-label="Selected title" className="rounded-xl border border-primary/25 bg-primary/5 p-5 sm:p-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-primary"><CheckCircle2 className="h-4 w-4" />English title</span>
        <div className="flex gap-1"><Button variant="ghost" size="sm" onClick={() => edit(chosen)} disabled={busy}><Pencil className="mr-2 h-3.5 w-3.5" />Edit</Button><Button variant="outline" size="sm" onClick={() => copy(chosen, 'title')}><Copy className="mr-2 h-3.5 w-3.5" />Copy title</Button></div>
      </div>
      <p ref={titleRef} tabIndex={-1} className="max-w-4xl select-text break-words text-lg font-semibold leading-relaxed outline-none sm:text-xl">{chosen}</p>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground">Saved for this series · Used across all parts</p>{onDescription && <Button size="sm" onClick={onDescription}>{workspace.description && !workspace.descriptionNeedsUpdate ? 'View description' : 'Create description'}<ArrowRight className="ml-2 h-4 w-4" /></Button>}</div>
    </section><section aria-label="Hinglish title" className="flex flex-col rounded-xl border bg-card p-5 sm:p-6"><div className="mb-3 flex flex-wrap items-center justify-between gap-3"><span className="text-xs font-semibold uppercase tracking-wider text-primary">Hinglish title</span><Button variant="outline" size="sm" onClick={() => copy(`${chosen} - Hindi`, 'hindiTitle')}><Copy className="mr-2 h-3.5 w-3.5" />Copy Hinglish title</Button></div><p ref={hindiTitleRef} tabIndex={-1} className="select-text break-words text-lg font-semibold leading-relaxed outline-none sm:text-xl">{chosen} - Hindi</p><p className="mt-auto pt-4 text-xs text-muted-foreground">Uses the same selected title with “ - Hindi” added.</p>{Array.from(`${chosen} - Hindi`).length > 100 && <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">This title exceeds 100 characters. Shorten the English title to 92 characters or fewer to fit both versions.</p>}</section></div>}

    {waiting.length > 0 && <div className="flex flex-col gap-3 rounded-xl border border-blue-500/20 bg-blue-500/5 px-4 py-3 sm:flex-row sm:items-center">
      <div className="flex flex-1 items-start gap-3"><FileText className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" /><div><p className="text-sm font-medium">{waiting.length === 1 ? 'A prompt is waiting for a response' : `${waiting.length} prompts are waiting for responses`}</p><p className="mt-0.5 text-xs text-muted-foreground">Continue where you left off. Your saved titles stay in place.</p></div></div>
      <Button size="sm" variant="outline" onClick={() => resume(waiting[0].id)} disabled={busy}>Continue<ArrowRight className="ml-2 h-3.5 w-3.5" /></Button>
    </div>}

    <section aria-labelledby="youtube-title-suggestions-heading" className="space-y-4">
      <div className="flex flex-col justify-between gap-4 xl:flex-row xl:items-center">
        <div><h2 id="youtube-title-suggestions-heading" className="text-xl font-semibold">Title ideas</h2><p className="mt-1 text-sm text-muted-foreground">{suggestions.length ? chosen && !showMore ? `${suggestions.length} saved ideas. Open More to browse other titles.` : `${suggestions.length} saved ideas. Pick a title or make it your own.` : 'Find a story hook that makes people want to watch.'}</p></div>
        <div className="flex flex-wrap items-center gap-2">
          {chosen && <Button variant="outline" size="sm" aria-expanded={showMore} aria-controls="youtube-other-titles" onClick={() => setShowMore(value => !value)}>More<ChevronDown className={`ml-2 h-4 w-4 transition-transform ${showMore ? 'rotate-180' : ''}`} /></Button>}
          <Button variant="ghost" size="sm" onClick={() => open('history')} disabled={busy || !requests.length && !previousChoices.length}><History className="mr-2 h-4 w-4" />History</Button>
          <Button variant="outline" size="sm" onClick={() => edit()} disabled={busy}><Pencil className="mr-2 h-3.5 w-3.5" />Use my own title</Button>
          {suggestions.length > 0 && <Button size="sm" onClick={prepare} disabled={busy}><Plus className="mr-2 h-4 w-4" />Request five more</Button>}
        </div>
      </div>

      <div id="youtube-other-titles" hidden={!ideasOpen} className="space-y-4">
      {suggestions.length > 5 && <div className="flex flex-col gap-3 rounded-xl border bg-card p-3 sm:flex-row">
        <div className="relative flex-1"><Search aria-hidden="true" className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><Input aria-label="Search saved titles" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a title idea…" className="border-transparent bg-muted/40 pl-9" /></div>
        <select aria-label="Filter title batch" value={batch} onChange={event => setBatch(event.target.value)} className="h-10 rounded-md border bg-background px-3 text-sm sm:max-w-[210px]"><option value="all">All batches · {suggestions.length} ideas</option>{[...batches].reverse().map(item => <option key={item.id} value={item.id}>Batch {batches.indexOf(item) + 1} · {date(item.createdAt)}</option>)}</select>
      </div>}

      {!suggestions.length ? <div className="rounded-xl border border-dashed bg-card px-6 py-12 text-center sm:py-16">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10"><Lightbulb className="h-7 w-7 text-primary" /></div>
        <h3 className="text-xl font-semibold">Start with five title ideas</h3><p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">We’ll prepare the research prompt. Use it in AI Studio or with Sleeper Cell, bring back the response, and choose your favourite.</p>
        <Button className="mt-6" onClick={waiting.length ? () => resume(waiting[0].id) : prepare} disabled={busy}><Sparkles className="mr-2 h-4 w-4" />{waiting.length ? 'Continue title generation' : 'Generate title ideas'}</Button>
        <div className="mx-auto mt-8 flex max-w-lg flex-wrap justify-center gap-x-6 gap-y-2 text-xs text-muted-foreground"><span>1. Copy prompt</span><span>2. Paste response</span><span>3. Choose a title</span></div>
      </div> : visible.length === 0 ? <div className="rounded-xl border p-10 text-center"><Search className="mx-auto mb-3 h-6 w-6 text-muted-foreground" /><p className="font-medium">No matching title ideas</p><Button variant="link" onClick={() => { setQuery(''); setBatch('all') }}>Clear filters</Button></div>
      : <div className="grid gap-3 lg:grid-cols-2">{visible.map(item => {
        const selected = item.title === chosen
        return <article key={item.id} className={`flex flex-col rounded-xl border p-5 transition-colors ${selected ? 'border-primary/50 bg-primary/5' : 'bg-card hover:border-primary/30'}`}>
          <div className="mb-3 flex items-center justify-between gap-3"><span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Batch {Math.max(0, batches.findIndex(source => source.id === item.requestId)) + 1}</span>{selected && <Badge variant="outline" className="gap-1 border-primary/30 text-primary"><Check className="h-3 w-3" />Selected</Badge>}</div>
          <p className="flex-1 break-words text-base font-medium leading-relaxed">{item.title}</p>
          <div className="mt-5 flex items-center justify-between gap-3"><span className="text-xs text-muted-foreground">{Array.from(item.title).length}/100 characters</span><div className="flex items-center gap-1"><Button variant="ghost" size="sm" aria-label={`Edit title: ${item.title}`} onClick={() => edit(item.title)} disabled={busy}><Pencil className="h-3.5 w-3.5" /><span className="sr-only">Edit</span></Button><Button variant={selected ? 'secondary' : 'outline'} size="sm" disabled={busy || selected} aria-label={`${selected ? 'Selected' : 'Use title'}: ${item.title}`} onClick={() => act('select', () => youtubeApi.selectTitle(workspace.seriesId, { suggestionId: item.id }, workspace.titles.revision), 'Title selected and saved.')}>
            {selected ? <Check className="mr-1.5 h-3.5 w-3.5" /> : null}{selected ? 'Selected' : 'Use title'}
          </Button></div></div>
        </article>
      })}</div>}
      </div>
      {research && <Button variant="ghost" size="sm" onClick={() => open('research')}><FileText className="mr-2 h-4 w-4" />Story research & sources</Button>}
    </section>

    <Dialog open={modal === 'generate'} onOpenChange={value => { if (!value) setModal(null) }}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-2xl flex-col gap-0 overflow-y-auto p-0">
        <DialogHeader className="border-b px-6 py-5 pr-12"><DialogTitle>Generate title ideas</DialogTitle><DialogDescription>Use AI Studio (Gemini 4 Hydrogen · High) to research the series and return five new titles.</DialogDescription></DialogHeader>
        <div className="space-y-5 p-6">
          {pending === 'prepare' ? <div role="status" className="flex items-center justify-center gap-3 py-16"><Loader2 className="h-5 w-5 animate-spin text-primary" />Preparing your prompt…</div> : request ? <>
            {requests.length > 1 && <div className="flex flex-col gap-2 sm:flex-row sm:items-center"><Label htmlFor="youtube-title-request" className="shrink-0 text-xs text-muted-foreground">Saved prompt</Label><select id="youtube-title-request" value={requestId} disabled={busy} className="min-w-0 flex-1 rounded-md border bg-background p-2 text-xs" onChange={event => { setRequestId(event.target.value); setError(''); setNotice(''); setShowPrompt(false) }}>{[...requests].reverse().map(item => <option key={item.id} value={item.id}>Prompt {requests.indexOf(item) + 1} · {date(item.createdAt)} · {item.importedAt ? 'Imported' : 'Awaiting response'}</option>)}</select></div>}
            {request.importedAt ? <div className="rounded-xl border bg-muted/20 p-6 text-center"><CheckCircle2 className="mx-auto mb-3 h-8 w-8 text-emerald-500" /><h3 className="font-semibold">These five titles are already saved</h3><p className="mt-2 text-sm text-muted-foreground">You can view the original prompt or return to your ideas.</p><div className="mt-4 flex flex-wrap justify-center gap-2"><Button onClick={() => setModal(null)}>View saved ideas</Button><Button variant="outline" onClick={() => copy(request.prompt, 'prompt')}><Copy className="mr-2 h-4 w-4" />Copy original prompt</Button></div></div> : <>
              <p className="text-sm leading-relaxed text-muted-foreground">Copy the prompt to AI Studio, choose Gemini 4 Hydrogen with High thinking, and turn on Grounding with Google Search. Bring back its complete JSON response; your earlier titles stay saved.</p>
            <SleeperCellGeneration key={`automation:${requestId}`} workspace={workspace} requestId={requestId} kind="titles" onSaved={onSaved} />
              <PromptActions key={requestId} copied={Boolean(copiedPrompts[requestId])} pasted={Boolean(response.trim())} disabled={busy} onCopy={() => copy(request.prompt, 'prompt')} onPaste={text => setDrafts(previous => ({ ...previous, [requestId]: text }))} onFallback={() => { responseRef.current?.focus(); setNotice('Paste the response into the box below using Cmd+V or Ctrl+V.') }} />
              <div className="space-y-3"><Label htmlFor="youtube-title-response">AI Studio title JSON response</Label><Textarea ref={responseRef} id="youtube-title-response" value={response} disabled={busy} rows={9} maxLength={100000} placeholder="Paste AI Studio’s response here…" className="resize-y font-mono text-xs leading-relaxed" onChange={event => setDrafts(previous => ({ ...previous, [requestId]: event.target.value }))} /><p className="text-xs text-muted-foreground">Drafts stay in this browser tab, even if you close this dialog or refresh.</p></div>
            </>}
            {<div><button onClick={() => setShowPrompt(value => !value)} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground" aria-expanded={showPrompt}><ChevronDown className={`h-3.5 w-3.5 transition-transform ${showPrompt ? 'rotate-180' : ''}`} />{showPrompt ? 'Hide full prompt' : 'Preview full prompt'}</button>{showPrompt && <><Label htmlFor="youtube-title-prompt" className="sr-only">Title generation prompt</Label><Textarea ref={promptRef} id="youtube-title-prompt" value={request.prompt} readOnly rows={6} className="mt-3 font-mono text-xs" /></>}</div>}
          </> : !error ? <p className="text-sm text-muted-foreground">No prepared prompt found. Close this dialog and start a new batch.</p> : null}
          {feedback}
        </div>
        {request && !request.importedAt && pending !== 'prepare' && <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-muted/20 px-6 py-4">
          <Button variant="ghost" size="sm" onClick={() => setModal(null)} disabled={busy}>Continue later</Button>
          <Button disabled={busy || !response.trim()} onClick={() => act('import', () => youtubeApi.importTitles(workspace.seriesId, request.id, response, workspace.titles.revision), 'Five new title ideas added. Your earlier suggestions are still saved.', () => { setDrafts(previous => { const next = { ...previous }; delete next[requestId]; return next }); setBatch('all'); setQuery(''); setModal(null) })}>{pending === 'import' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}Add five title ideas</Button>
        </div>}
      </DialogContent>
    </Dialog>

    <Dialog open={modal === 'custom'} onOpenChange={value => { if (!value) setModal(null) }}><DialogContent className="w-[calc(100vw-2rem)] max-w-xl">
      <DialogHeader><DialogTitle>Make the title yours</DialogTitle><DialogDescription>Write your own title or refine an idea. It will become the selected title for this series.</DialogDescription></DialogHeader>
      <div className="space-y-3"><Label htmlFor="youtube-custom-title">Your title</Label><Textarea id="youtube-custom-title" value={customTitle} disabled={busy} onChange={event => setCustomTitle(event.target.value)} rows={4} placeholder="Enter an English YouTube title…" aria-describedby="youtube-custom-title-count" /><p id="youtube-custom-title-count" className={`text-right text-xs ${count > 100 ? 'text-destructive' : 'text-muted-foreground'}`}>{count}/100 characters{count > 100 ? ' · Please shorten your title' : ''}</p></div>
      {feedback}<div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setModal(null)}>Cancel</Button><Button disabled={busy || !customTitle.trim() || count > 100} onClick={() => act('custom', () => youtubeApi.selectTitle(workspace.seriesId, { title: customTitle }, workspace.titles.revision), 'Your title is selected and saved.', () => { setCustomTitle(''); setModal(null) })}>{pending === 'custom' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Use this title</Button></div>
    </DialogContent></Dialog>

    <Dialog open={modal === 'history'} onOpenChange={value => { if (!value) setModal(null) }}><DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-2xl overflow-y-auto">
      <DialogHeader><DialogTitle>Title history</DialogTitle><DialogDescription>Reopen a prompt or return to an earlier title selection.</DialogDescription></DialogHeader>
      <div className="space-y-6">
        <section className="space-y-3"><h3 className="text-sm font-semibold">Prepared prompts</h3>{!requests.length && <p className="text-sm text-muted-foreground">No prompts prepared yet.</p>}{[...requests].reverse().map(item => <button key={item.id} disabled={busy} onClick={() => resume(item.id)} className="flex w-full items-center gap-3 rounded-lg border p-3 text-left hover:bg-accent/50"><FileText className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1"><span className="block text-sm font-medium">Prompt {requests.indexOf(item) + 1}</span><span className="text-xs text-muted-foreground">{date(item.createdAt)}</span></span><Badge variant={item.importedAt ? 'secondary' : 'outline'}>{item.importedAt ? '5 ideas saved' : 'Awaiting response'}</Badge><ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" /></button>)}</section>
        {previousChoices.length > 0 && <section className="space-y-3"><h3 className="text-sm font-semibold">Previous selections</h3>{previousChoices.map(item => <div key={item.id} className="space-y-3 rounded-lg border p-4"><p className="text-sm leading-relaxed">{item.title}</p><div className="flex items-center justify-between gap-3"><span className="text-xs text-muted-foreground">{date(item.selectedAt)}</span><Button size="sm" variant="outline" disabled={busy} aria-label={`Restore title: ${item.title}`} onClick={() => act('select', () => youtubeApi.selectTitle(workspace.seriesId, item.suggestionId ? { suggestionId: item.suggestionId } : { title: item.title }, workspace.titles.revision), 'Previous title restored.', () => setModal(null))}>Use again</Button></div></div>)}</section>}
      </div>{feedback}
    </DialogContent></Dialog>

    <Dialog open={modal === 'research'} onOpenChange={value => { if (!value) setModal(null) }}><DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-2xl overflow-y-auto">
      <DialogHeader><DialogTitle>Story research & sources</DialogTitle><DialogDescription>Context returned by the AI for the latest imported batch.</DialogDescription></DialogHeader>
      {research && <div className="space-y-5"><h3 className="font-semibold">{research.resolvedTitle}</h3><p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{research.summary}</p><div className="space-y-2">{research.sources.map((source, index) => <a key={`${source.url}-${index}`} href={source.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 rounded-lg border p-3 text-sm hover:bg-accent/50"><span className="min-w-0 flex-1 break-words">{source.title}<span className="mt-1 block text-xs text-muted-foreground">{new URL(source.url).hostname}</span></span><ExternalLink className="h-4 w-4 shrink-0 text-muted-foreground" /></a>)}</div><p className="text-xs text-muted-foreground">Source links are supplied by the AI. Review them if story details look incorrect.</p></div>}
    </DialogContent></Dialog>
  </div>
}
