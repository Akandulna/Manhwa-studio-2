import SleeperCellGeneration from './SleeperCellGeneration'
import PromptActions from './PromptActions'
import { useEffect, useRef, useState } from 'react'
import { ArrowRight, CheckCircle2, Copy, FileText, History, Loader2, Pencil, RefreshCw, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { youtubeApi, type YouTubeWorkspace } from '@/lib/youtube'

type Modal = 'generate' | 'edit' | 'history' | 'regenerate' | null
const date = (value: string) => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
function draft(key: string) { try { return sessionStorage.getItem(key) ?? '' } catch { return '' } }

export default function YouTubeDescription({ workspace, onSaved, onTitles }: { workspace: YouTubeWorkspace; onSaved: (value: YouTubeWorkspace) => void; onTitles: () => void }) {
  const state = workspace.descriptions
  const currentTitle = workspace.selectedTitle
  const latest = [...state.requests].reverse().find(item => item.title === currentTitle && !item.importedAt && item.outputVersion === 2 && item.identityPolicy === 'no-series-name/1')
  const [requestId, setRequestId] = useState(latest?.id ?? '')
  const [modal, setModal] = useState<Modal>(null)
  const [copiedPrompts, setCopiedPrompts] = useState<Record<string, boolean>>({})
  const [showPrompt, setShowPrompt] = useState(false)
  const [response, setResponse] = useState('')
  const [editText, setEditText] = useState('')
  const [editTitle, setEditTitle] = useState('')
  const [editVariant, setEditVariant] = useState<'en' | 'hinglish'>('en')
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const mounted = useRef(true)
  const responseRef = useRef<HTMLTextAreaElement>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const descriptionRef = useRef<HTMLDivElement>(null)
  const hinglishRef = useRef<HTMLDivElement>(null)
  const request = state.requests.find(item => item.id === requestId)
  const responseKey = `youtube-description-response:${workspace.seriesId}:${requestId}`
  const editorKey = `youtube-description-edit:${workspace.seriesId}:${editTitle}${editVariant === 'hinglish' ? ':hinglish' : ''}`
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { setResponse(draft(responseKey)) }, [responseKey])
  const changeResponse = (text: string) => { setResponse(text); try { sessionStorage.setItem(responseKey, text) } catch { /* retain in memory */ } }
  const changeEdit = (text: string) => { setEditText(text); try { sessionStorage.setItem(editorKey, text) } catch { /* retain in memory */ } }
  function open(value: Modal) { setError(''); setNotice(''); setModal(value) }
  async function act(task: () => Promise<YouTubeWorkspace>, success = '', after?: (value: YouTubeWorkspace) => void) {
    setBusy(true); setError(''); setNotice('')
    try { const next = await task(); if (mounted.current) { onSaved(next); after?.(next); setNotice(success) } }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not save description.') }
    finally { if (mounted.current) setBusy(false) }
  }
  function resume(id: string) { setRequestId(id); setShowPrompt(false); open('generate') }
  function generate(revisionFeedback = '', reuse = true) {
    if (reuse && latest) { resume(latest.id); return }
    open('generate'); setRequestId(''); setShowPrompt(false)
    void act(() => youtubeApi.prepareDescription(workspace.seriesId, workspace.titles.revision, revisionFeedback, reuse), '', next => {
      setRequestId([...next.descriptions.requests].reverse().find(item => item.title === next.selectedTitle && !item.importedAt)!.id)
    })
  }
  async function copy(text: string, kind: 'prompt' | 'description', variant: 'en' | 'hinglish' = 'en') {
    setError(''); setNotice('')
    try { await navigator.clipboard.writeText(text); if (mounted.current) { if (kind === 'prompt') setCopiedPrompts(previous => ({ ...previous, [requestId]: true })); setNotice(kind === 'prompt' ? 'Prompt copied. Use it in AI Studio, then bring back the response.' : 'Description copied to clipboard.') } }
    catch {
      if (kind === 'prompt') { setShowPrompt(true); requestAnimationFrame(() => { promptRef.current?.focus(); promptRef.current?.select() }) }
      else { const element = (variant === 'hinglish' ? hinglishRef : descriptionRef).current; if (element) { element.focus(); window.getSelection()?.selectAllChildren(element) } }
      setError('Clipboard access is unavailable. Select the text and use your keyboard’s Copy command.')
    }
  }
  function edit(variant: 'en' | 'hinglish') {
    if (!currentTitle) return
    setEditVariant(variant); setEditTitle(currentTitle)
    const saved = variant === 'hinglish' ? workspace.hinglishDescription : workspace.description
    setEditText(draft(`youtube-description-edit:${workspace.seriesId}:${currentTitle}${variant === 'hinglish' ? ':hinglish' : ''}`) || saved || ''); open('edit')
  }
  function refresh() { void act(() => youtubeApi.openWorkspace(workspace.seriesId), 'Workspace refreshed. Your pasted response and edits are retained.') }
  const messages = error || notice ? <div aria-live="polite">{error && <div role="alert" className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"><p>{error}</p>{/changed|another window/.test(error) && <Button size="sm" variant="outline" disabled={busy} onClick={refresh}><RefreshCw className="mr-2 h-4 w-4" />Refresh workspace</Button>}</div>}{notice && <p role="status" className="flex items-start gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 text-sm"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />{notice}</p>}</div> : null

  return <div className="space-y-5">
    {!modal && messages}
    {!currentTitle ? <div className="rounded-xl border border-dashed bg-card px-6 py-16 text-center"><FileText className="mx-auto mb-4 h-8 w-8 text-muted-foreground" /><h2 className="text-xl font-semibold">Start with your title</h2><p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">Choose a suggested title or enter your own. We’ll use it to prepare the description prompt.</p><Button className="mt-6" onClick={onTitles}>Choose a title<ArrowRight className="ml-2 h-4 w-4" /></Button></div>
      : <>
        <section className="rounded-xl border bg-card p-5"><p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Writing for this title</p><p className="break-words font-medium leading-relaxed">{currentTitle}</p></section>
        {(workspace.descriptionNeedsUpdate || workspace.hinglishDescriptionNeedsUpdate) && <div role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm"><p className="font-medium">Your title changed</p><p className="mt-1 text-muted-foreground">Your saved descriptions are kept below. Generate updated versions, or review, edit and save each one against the new title.</p></div>}
        <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-xl font-semibold">Descriptions</h2><p className="mt-1 text-sm text-muted-foreground">Two English-worded versions · Shared across all parts · No real series names</p></div><div className="flex flex-wrap gap-2"><Button size="sm" variant="ghost" disabled={busy || !state.requests.length && !state.versions.length} onClick={() => open('history')}><History className="mr-2 h-4 w-4" />History</Button><Button size="sm" disabled={busy} onClick={() => workspace.description && workspace.hinglishDescription ? (setFeedback(''), open('regenerate')) : generate()}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}{workspace.description && workspace.hinglishDescription ? 'Regenerate both' : 'Generate both descriptions'}</Button></div></div>
        {latest && <div className="flex flex-col gap-3 rounded-xl border border-blue-500/20 bg-blue-500/5 p-4 sm:flex-row sm:items-center"><div className="flex-1"><p className="text-sm font-medium">Your two-description prompt is ready</p><p className="mt-1 text-xs text-muted-foreground">Copy it to AI Studio (Gemini 4 Hydrogen · High) and import both versions together.</p></div><Button size="sm" variant="outline" disabled={busy} onClick={() => resume(latest.id)}>Continue<ArrowRight className="ml-2 h-4 w-4" /></Button></div>}
        <div className="grid items-stretch gap-4 md:grid-cols-2">{(['en', 'hinglish'] as const).map(variant => {
          const text = variant === 'en' ? workspace.description : workspace.hinglishDescription
          const needsUpdate = variant === 'en' ? workspace.descriptionNeedsUpdate : workspace.hinglishDescriptionNeedsUpdate
          const name = variant === 'en' ? 'English' : 'Hinglish'
          return <section key={variant} aria-label={`${name} description`} className="flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card"><div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3"><div><h3 className="text-sm font-semibold">{name} description</h3><p className="mt-1 text-xs text-muted-foreground">{variant === 'en' ? 'For the English recap' : 'English wording for the Hindi recap'}</p></div><Badge variant={needsUpdate || !text ? 'outline' : 'secondary'}>{needsUpdate ? 'Review needed' : text ? 'Saved' : 'Not created'}</Badge></div>{text ? <div ref={variant === 'en' ? descriptionRef : hinglishRef} tabIndex={-1} className="flex-1 whitespace-pre-wrap break-words p-5 text-sm leading-relaxed outline-none">{text}</div> : <div className="flex flex-1 flex-col items-center justify-center px-5 py-10 text-center"><FileText className="mb-3 h-7 w-7 text-muted-foreground" /><p className="text-sm text-muted-foreground">{variant === 'en' ? 'Generate both versions or write your own English description.' : 'Generate an alternative English description that naturally includes “in Hindi”.'}</p></div>}<div className="space-y-3 border-t p-4"><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={!text} onClick={() => void copy(text!, 'description', variant)}><Copy className="mr-2 h-4 w-4" />Copy {name} description</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => edit(variant)}><Pencil className="mr-2 h-4 w-4" />{text ? 'Edit' : 'Write my own'}</Button></div><p className="text-xs text-muted-foreground">{Array.from(text ?? '').length}/5,000 characters</p></div></section>
        })}</div>
      </>}

    <Dialog open={modal === 'generate'} onOpenChange={value => { if (!value) setModal(null) }}><DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-2xl flex-col gap-0 overflow-y-auto p-0">
      <DialogHeader className="border-b p-6 pr-12"><DialogTitle>Generate English & Hinglish descriptions</DialogTitle><DialogDescription>Copy one prompt to AI Studio (Gemini 4 Hydrogen · High), then import its JSON response containing both descriptions.</DialogDescription></DialogHeader>
      <div className="space-y-4 p-6">
        {busy && !request ? <p role="status" className="flex items-center gap-2 py-12"><Loader2 className="h-5 w-5 animate-spin" />Preparing description prompt…</p> : request && <>
          {request.outputVersion !== 2 && <p className="rounded-lg border border-amber-500/30 p-3 text-sm">This earlier prompt creates an English description only. <Button variant="link" size="sm" disabled={busy} onClick={() => generate('', false)}>Create a prompt for both versions</Button></p>}<p className="rounded-lg bg-muted/30 p-3 text-sm"><span className="mb-1 block text-xs text-muted-foreground">Title used for this prompt</span>{request.title}</p>
          {request.title !== currentTitle && <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">This prompt uses a previous title. Start a new request for the current title.</p>}
          {request.importedAt ? <div className="space-y-3 rounded-lg border p-4"><p className="text-sm">This response is already saved. Find it in description history.</p><Button size="sm" variant="outline" onClick={() => copy(request.prompt, 'prompt')}>Copy original prompt</Button></div> : <>
            <p className="text-sm leading-relaxed text-muted-foreground">Copy the prompt to AI Studio (Gemini 4 Hydrogen · High), then paste its complete JSON response containing both descriptions.</p>
            <SleeperCellGeneration key={`automation:${requestId}`} workspace={workspace} requestId={requestId} kind="descriptions" onSaved={onSaved} />
            <PromptActions key={requestId} copied={Boolean(copiedPrompts[requestId])} pasted={Boolean(response.trim())} disabled={busy} onCopy={() => copy(request.prompt, 'prompt')} onPaste={changeResponse} onFallback={() => { responseRef.current?.focus(); setNotice('Paste the response into the box below using Cmd+V or Ctrl+V.') }} />
            <div className="space-y-3"><Label htmlFor="youtube-description-response">AI Studio description JSON response</Label><Textarea ref={responseRef} id="youtube-description-response" value={response} onChange={event => changeResponse(event.target.value)} disabled={busy} rows={9} maxLength={100000} placeholder="Paste the complete JSON response…" className="font-mono text-xs" /><p className="text-xs text-muted-foreground">Formatting escapes are supported. This draft stays in this browser tab.</p></div>
          </>}
          {<details open={showPrompt} onToggle={event => setShowPrompt(event.currentTarget.open)}><summary className="cursor-pointer text-xs text-muted-foreground">Preview full prompt</summary><Textarea ref={promptRef} aria-label="Description generation prompt" readOnly value={request.prompt} rows={7} className="mt-3 font-mono text-xs" /></details>}
        </>}
        {messages}
      </div>
      {request && !request.importedAt && <div className="flex flex-wrap justify-between gap-3 border-t bg-muted/20 p-4 sm:px-6"><Button size="sm" variant="ghost" disabled={busy} onClick={() => setModal(null)}>Continue later</Button><Button disabled={busy || !response.trim() || request.title !== currentTitle} onClick={() => act(() => youtubeApi.importDescription(workspace.seriesId, request.id, response, workspace.titles.revision), 'Response saved. You can edit or copy the descriptions below.', () => { changeResponse(''); setModal(null) })}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{request.outputVersion === 2 ? 'Save descriptions' : 'Save English description'}</Button></div>}
    </DialogContent></Dialog>

    <Dialog open={modal === 'edit'} onOpenChange={value => { if (!value) setModal(null) }}><DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-2xl overflow-y-auto"><DialogHeader><DialogTitle>Edit {editVariant === 'en' ? 'English' : 'Hinglish'} description</DialogTitle><DialogDescription>Saving creates a new version and keeps the other description. Earlier versions remain in history.</DialogDescription></DialogHeader><p className="text-xs text-muted-foreground">For: {editTitle}{editVariant === 'hinglish' ? ' - Hindi' : ''}</p>{editVariant === 'hinglish' && <p className="text-xs text-muted-foreground">A Hinglish opening hook is fine; keep the rest in English with different wording, and include “in Hindi” naturally. Omit the real series name, aliases and identifying hashtags.</p>}<Label htmlFor="youtube-description-editor" className="sr-only">Description text</Label><Textarea id="youtube-description-editor" value={editText} onChange={event => changeEdit(event.target.value)} disabled={busy} rows={14} /><p className={`text-right text-xs ${Array.from(editText.trim()).length > 5000 ? 'text-destructive' : 'text-muted-foreground'}`}>{Array.from(editText.trim()).length}/5,000 characters</p>{messages}<div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setModal(null)}>Continue later</Button><Button disabled={busy || !editText.trim() || Array.from(editText.trim()).length > 5000 || editTitle !== currentTitle} onClick={() => act(() => youtubeApi.saveDescriptionText(workspace.seriesId, editTitle, editText, workspace.titles.revision, editVariant), 'Description changes saved as a new version.', () => { try { sessionStorage.removeItem(editorKey) } catch { /* optional */ } setModal(null) })}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}Save changes</Button></div></DialogContent></Dialog>

    <Dialog open={modal === 'regenerate'} onOpenChange={value => { if (!value) setModal(null) }}><DialogContent className="w-[calc(100vw-2rem)] max-w-xl"><DialogHeader><DialogTitle>Regenerate both descriptions</DialogTitle><DialogDescription>Your saved English and Hinglish descriptions stay available until you import both new versions.</DialogDescription></DialogHeader><Label htmlFor="youtube-description-feedback">What would you like to change? (optional)</Label><Textarea id="youtube-description-feedback" rows={4} maxLength={4000} value={feedback} onChange={event => setFeedback(event.target.value)} placeholder="For example: make the opening shorter and more suspenseful…" /><Button onClick={() => generate(feedback, false)}>Create updated prompt<ArrowRight className="ml-2 h-4 w-4" /></Button></DialogContent></Dialog>

    <Dialog open={modal === 'history'} onOpenChange={value => { if (!value) setModal(null) }}><DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-2xl overflow-y-auto"><DialogHeader><DialogTitle>Description history</DialogTitle><DialogDescription>Review saved versions of both descriptions or reopen a prepared prompt.</DialogDescription></DialogHeader><div className="space-y-6"><section className="space-y-3"><h3 className="font-semibold">Saved versions</h3>{!state.versions.length && <p className="text-sm text-muted-foreground">No descriptions saved yet.</p>}{[...state.versions].reverse().map(version => <details key={version.id} className="rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium">{date(version.createdAt)} · {version.source === 'generated' ? 'Generated' : version.source === 'edited' ? 'Edited' : 'Imported from earlier workspace'}{version.id === state.selectedVersionId ? ' · Current' : ''}</summary><p className="my-3 text-xs text-muted-foreground">Title: {version.title || 'No title recorded'}</p><div className="grid gap-4 md:grid-cols-2"><div><p className="mb-2 text-xs font-semibold text-muted-foreground">English</p><p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{version.text || 'Not created'}</p></div><div><p className="mb-2 text-xs font-semibold text-muted-foreground">Hinglish</p><p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{version.hinglishText || 'Not part of this earlier version'}</p></div></div>{version.id !== state.selectedVersionId && <Button size="sm" variant="outline" className="mt-4" disabled={busy} onClick={() => act(() => youtubeApi.restoreDescription(workspace.seriesId, version.id, workspace.titles.revision), 'Description version restored.', () => setModal(null))}>Restore this version</Button>}</details>)}</section><section className="space-y-3"><h3 className="font-semibold">Prepared prompts</h3>{[...state.requests].reverse().map(item => <button key={item.id} onClick={() => resume(item.id)} className="flex w-full items-start justify-between gap-3 rounded-lg border p-3 text-left hover:bg-accent/40"><span className="min-w-0"><span className="block text-sm font-medium">{item.title}</span><span className="mt-1 block text-xs text-muted-foreground">{date(item.createdAt)} · {item.importedAt ? 'Imported' : 'Awaiting response'}</span></span><ArrowRight className="mt-1 h-4 w-4 shrink-0" /></button>)}</section></div>{messages}</DialogContent></Dialog>
  </div>
}
