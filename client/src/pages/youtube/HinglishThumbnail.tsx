import { useRef, useState } from 'react'
import { Copy, Download, Loader2, Move, Pencil, RotateCcw, Save } from 'lucide-react'
import { thumbnailApi, youtubeApi, type YouTubeWorkspace, type YouTubeHindiOverlay } from '@/lib/youtube'
import type { YouTubeThumbnailVersion } from '../../../../server/src/services/youtubeTypes'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export const DEFAULT_HINDI_STYLE: YouTubeHindiOverlay = { template: 'outline', color: '#FFE44D', size: 34, x: 96, y: 96 }
export const HINDI_TEMPLATES: { id: YouTubeHindiOverlay['template']; name: string }[] = [{ id: 'outline', name: 'Classic outline' }, { id: 'shadow', name: 'Shadow' }, { id: 'italic', name: 'Italic' }, { id: 'badge', name: 'Badge' }]
const clamp = (value: number) => Math.round(Math.max(0, Math.min(100, value)) * 100) / 100
export function overlayWidthPercent(image: Pick<YouTubeThumbnailVersion, 'width' | 'height'>, style: YouTubeHindiOverlay) { return Math.min(style.size, 100 * image.height * (432 / 148) / image.width) }

export function HindiOverlayPreview({ seriesId, image, settings, onChange, disabled = false }: { seriesId: string; image: YouTubeThumbnailVersion; settings: YouTubeHindiOverlay; onChange?: (value: YouTubeHindiOverlay) => void; disabled?: boolean }) {
  const frame = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: number; x: number; y: number; initialX: number; initialY: number } | null>(null)
  const style = { position: 'absolute' as const, width: `${overlayWidthPercent(image, settings)}%`, left: `${settings.x}%`, top: `${settings.y}%`, transform: `translate(-${settings.x}%, -${settings.y}%)` }
  const word = <img alt="HINDI — Extra Bold Latin lettering" src={thumbnailApi.overlayStamp(settings)} draggable={false} className="block h-auto w-full select-none" />
  return <div ref={frame} aria-label="Hinglish thumbnail preview" className="relative w-full overflow-hidden rounded-lg bg-muted/30" style={{ aspectRatio: `${image.width}/${image.height}` }}>
    <img alt="Selected thumbnail for the Hinglish version" src={thumbnailApi.media(seriesId, image.id)} draggable={false} className="absolute inset-0 h-full w-full select-none object-fill" />
    {onChange ? <button type="button" aria-label="Move HINDI overlay" title="Drag to move; arrow keys adjust position" disabled={disabled} style={{ ...style, touchAction: 'none' }} className="cursor-grab rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary active:cursor-grabbing"
      onPointerDown={event => { if (disabled) return;event.preventDefault();event.currentTarget.focus();event.currentTarget.setPointerCapture(event.pointerId);drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, initialX: settings.x, initialY: settings.y } }}
      onPointerMove={event => { const start = drag.current;if (!start || start.id !== event.pointerId || !frame.current) return;const parent = frame.current.getBoundingClientRect();const word = event.currentTarget.getBoundingClientRect();onChange({ ...settings, x: clamp(start.initialX + (event.clientX - start.x) / Math.max(1, parent.width - word.width) * 100), y: clamp(start.initialY + (event.clientY - start.y) / Math.max(1, parent.height - word.height) * 100) }) }}
      onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }} onLostPointerCapture={() => { drag.current = null }}
      onKeyDown={event => { const move: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };const delta = move[event.key];if (!delta) return;event.preventDefault();const step = event.shiftKey ? 5 : 1;onChange({ ...settings, x: clamp(settings.x + delta[0] * step), y: clamp(settings.y + delta[1] * step) }) }}>
      <span className="pointer-events-none block">{word}</span>
    </button> : <div style={style}>{word}</div>}
  </div>
}

export default function HinglishThumbnail({ workspace: w, image, onSaved, disabled = false }: { workspace: YouTubeWorkspace; image: YouTubeThumbnailVersion; onSaved: (w: YouTubeWorkspace) => void; disabled?: boolean }) {
  const saved = w.hindiOverlay ?? DEFAULT_HINDI_STYLE
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<YouTubeHindiOverlay>({ ...saved })
  const [baseId, setBaseId] = useState(image.id)
  const [busy, setBusy] = useState<'save' | 'copy' | 'reload' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const changedBase = baseId !== image.id
  async function copy() {
    setError(''); setNotice(''); setBusy('copy')
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('Image copying is unavailable. Use Download PNG instead.')
      const png = fetch(thumbnailApi.hinglishMedia(w.seriesId, image.id, saved)).then(async response => { if (!response.ok) { const result = await response.json().catch(() => null);throw new Error(result?.error ?? 'Could not render this thumbnail.') } return response.blob() })
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);setNotice('Hinglish thumbnail copied with the HINDI overlay.')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Image copying was blocked. Use Download PNG instead.') }
    finally { setBusy(null) }
  }
  async function save() {
    setBusy('save'); setError(''); setNotice('')
    try { onSaved(await thumbnailApi.saveHindiOverlay(w.seriesId, baseId, draft, w.titles.revision));setEditing(false);setNotice('Hindi overlay saved. Copy or download the finished thumbnail.') }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save the overlay.') }
    finally { setBusy(null) }
  }
  async function reload() {
    setBusy('reload'); setError('')
    try { const next = await youtubeApi.openWorkspace(w.seriesId);onSaved(next);setEditing(false) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not reload the workspace.') }
    finally { setBusy(null) }
  }
  const messages = <>{error && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">{error}<Button variant="link" size="sm" disabled={Boolean(busy)} onClick={() => void reload()}>Reload workspace</Button></div>}{notice && <p role="status" className="rounded-lg bg-emerald-500/10 p-3 text-sm">{notice}</p>}</>
  return <section aria-label="Hinglish thumbnail" className="flex min-w-0 flex-col rounded-xl border bg-background/40 p-4">
    <div className="mb-3 flex items-center justify-between gap-3"><h3 className="text-sm font-semibold">Hinglish thumbnail</h3><Badge variant="secondary">HINDI overlay</Badge></div>
    <HindiOverlayPreview seriesId={w.seriesId} image={image} settings={saved} />
    <p className="mt-3 text-xs text-muted-foreground">Same selected image · Extra Bold HINDI lettering</p>
    <div className="mt-4 flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={disabled || Boolean(busy)} onClick={() => void copy()}>{busy === 'copy' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Copy className="mr-2 h-4 w-4" />}Copy image</Button><Button size="sm" asChild><a href={thumbnailApi.hinglishMedia(w.seriesId, image.id, saved, true)} download="youtube-thumbnail-hindi.png"><Download className="mr-2 h-4 w-4" />Download PNG</a></Button><Button size="sm" variant="outline" aria-label="Edit Hinglish thumbnail overlay" disabled={disabled || Boolean(busy)} onClick={() => { setDraft({ ...saved });setBaseId(image.id);setError('');setNotice('');setEditing(true) }}><Pencil className="mr-2 h-4 w-4" />Edit</Button></div>
    {!editing && <div className="mt-3">{messages}</div>}
    <Dialog open={editing} onOpenChange={value => { if (!busy) setEditing(value) }}><DialogContent className="max-h-[90dvh] w-[calc(100vw_-_2rem)] max-w-5xl grid-cols-[minmax(0,1fr)] overflow-y-auto"><DialogHeader><DialogTitle>Edit Hinglish thumbnail</DialogTitle><DialogDescription>Choose an Extra Bold HINDI style, pick its color, and drag it to position. Changes apply when you save.</DialogDescription></DialogHeader>
      {changedBase && <p role="alert" className="rounded-lg border border-amber-500/30 p-3 text-sm">The selected image changed. Close and reopen this editor before saving.</p>}
      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(240px,1fr)]"><div className="min-w-0 space-y-3"><HindiOverlayPreview seriesId={w.seriesId} image={image} settings={draft} onChange={setDraft} disabled={Boolean(busy) || changedBase} /><p className="flex items-center gap-2 text-xs text-muted-foreground"><Move className="h-3.5 w-3.5" />Drag the word, or focus it and use arrow keys. Shift moves faster.</p><div className="flex flex-wrap gap-2">{([{ label: 'Bottom right', x: 96, y: 96 }, { label: 'Bottom left', x: 4, y: 96 }, { label: 'Top right', x: 96, y: 4 }, { label: 'Top left', x: 4, y: 4 }, { label: 'Center', x: 50, y: 50 }]).map(position => <Button key={position.label} variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => setDraft(s => ({ ...s, x: position.x, y: position.y }))}>{position.label}</Button>)}</div></div>
        <div className="min-w-0 space-y-5"><fieldset disabled={Boolean(busy)}><legend className="mb-2 text-sm font-medium">Text templates</legend><div className="grid grid-cols-2 gap-2">{HINDI_TEMPLATES.map(template => <button key={template.id} type="button" aria-pressed={draft.template === template.id} onClick={() => setDraft(s => ({ ...s, template: template.id }))} className={`rounded-lg border bg-muted/30 p-2 text-left ${draft.template === template.id ? 'border-primary ring-1 ring-primary' : 'hover:border-primary/50'}`}><img alt="" className="h-12 w-full object-contain" src={thumbnailApi.overlayStamp({ template: template.id, color: draft.color })} /><span className="mt-1 block text-xs">{template.name}</span></button>)}</div></fieldset>
          <fieldset disabled={Boolean(busy)}><legend className="mb-2 text-sm font-medium">Text color</legend><div className="flex flex-wrap items-center gap-2">{['#FFE44D', '#FFFFFF', '#FF4848', '#42D9FF', '#87FF72', '#FF8BD8'].map(color => <button key={color} type="button" aria-label={`Text color ${color}`} aria-pressed={draft.color === color} style={{ backgroundColor: color }} className={`h-8 w-8 rounded-md border-2 ${draft.color === color ? 'border-primary ring-2 ring-primary/40' : 'border-black/20'}`} onClick={() => setDraft(s => ({ ...s, color }))} />)}<label className="flex items-center gap-2 text-xs text-muted-foreground">Custom<input type="color" aria-label="Custom text color" value={draft.color} onChange={event => setDraft(s => ({ ...s, color: event.target.value.toUpperCase() }))} className="h-8 w-9 cursor-pointer rounded border bg-transparent" /></label></div></fieldset>
          {([{ key: 'size', label: 'Text size', min: 10, max: 60 }, { key: 'x', label: 'Horizontal position', min: 0, max: 100 }, { key: 'y', label: 'Vertical position', min: 0, max: 100 }] as const).map(control => <label key={control.key} className="block space-y-2"><span className="flex justify-between text-sm"><span>{control.label}</span><span className="text-xs tabular-nums text-muted-foreground">{Math.round(draft[control.key])}%</span></span><input aria-label={control.label} type="range" min={control.min} max={control.max} step="1" value={draft[control.key]} disabled={Boolean(busy)} onChange={event => setDraft(s => ({ ...s, [control.key]: Number(event.target.value) }))} className="block w-full accent-primary" /></label>)}
        </div></div>
      {messages}<div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4"><Button variant="ghost" disabled={Boolean(busy)} onClick={() => setDraft({ ...DEFAULT_HINDI_STYLE })}><RotateCcw className="mr-2 h-4 w-4" />Reset overlay</Button><div className="flex gap-2"><Button variant="outline" disabled={Boolean(busy)} onClick={() => setEditing(false)}>Cancel</Button><Button disabled={Boolean(busy) || changedBase} onClick={() => void save()}>{busy === 'save' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}Save overlay</Button></div></div>
    </DialogContent></Dialog>
  </section>
}
