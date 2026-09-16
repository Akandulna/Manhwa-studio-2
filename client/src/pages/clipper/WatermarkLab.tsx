/**
 * Watermark Lab — Module 3: Image Clipper
 *
 * Identify a series' site watermark so the export pipeline can auto-white-fill it:
 *  - Pick a series + a chapter, then drag a box over the watermark to save it as a
 *    template (OpenCV matches it across every page on export).
 *  - Manage templates (enable/disable, match threshold, delete).
 *  - Run a detection preview to see what would be white-filled.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Loader2, Droplet, Trash2, ScanSearch, AlertTriangle, Crop as CropIcon } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import {
  clipperApi, watermarkApi,
  type ClipperSeries, type ClipperChapterSummary, type ImageManifest,
  type WatermarkTemplate
} from '@/lib/api'

interface DispRect { x: number; y: number; w: number; h: number }

export default function WatermarkLab() {
  const { toast } = useToast()

  const [status, setStatus] = useState<{ available: boolean; error?: string } | null>(null)
  const [series, setSeries] = useState<ClipperSeries[]>([])
  const [seriesId, setSeriesId] = useState('')
  const [chapters, setChapters] = useState<ClipperChapterSummary[]>([])
  const [chapterId, setChapterId] = useState('')
  const [manifest, setManifest] = useState<ImageManifest | null>(null)
  const [templates, setTemplates] = useState<WatermarkTemplate[]>([])

  const [detected, setDetected] = useState<{ canvasX: number; canvasY: number; canvasW: number; canvasH: number }[] | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [label, setLabel] = useState('')

  // Drawing state (display-space).
  const layerRef = useRef<HTMLDivElement | null>(null)
  const [draft, setDraft] = useState<DispRect | null>(null)
  const dragStart = useRef<{ x: number; y: number } | null>(null)

  const zoom = useMemo(
    () => (manifest ? Math.min(0.5, 460 / manifest.canvasWidth) : 0.3),
    [manifest]
  )

  // ----- Initial load -----
  useEffect(() => {
    watermarkApi.getStatus().then(setStatus).catch(() => setStatus({ available: false }))
    clipperApi.getSeries().then(setSeries).catch(() => setSeries([]))
  }, [])

  // ----- Series → chapters + templates -----
  useEffect(() => {
    if (!seriesId) { setChapters([]); setTemplates([]); return }
    clipperApi.getSeriesDetail(seriesId).then(d => setChapters(d.chapters)).catch(() => setChapters([]))
    watermarkApi.listTemplates(seriesId).then(setTemplates).catch(() => setTemplates([]))
  }, [seriesId])

  const reloadTemplates = useCallback(() => {
    if (seriesId) watermarkApi.listTemplates(seriesId).then(setTemplates).catch(() => {})
  }, [seriesId])

  // ----- Chapter → manifest -----
  useEffect(() => {
    setManifest(null); setDetected(null); setDraft(null)
    if (!chapterId) return
    clipperApi.getManifest(chapterId).then(setManifest).catch(() => setManifest(null))
  }, [chapterId])

  // ----- Drawing handlers -----
  function pointerPos(e: React.MouseEvent): { x: number; y: number } {
    const el = layerRef.current
    if (!el) return { x: 0, y: 0 }
    const rect = el.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function onMouseDown(e: React.MouseEvent) {
    if (!manifest) return
    const p = pointerPos(e)
    dragStart.current = p
    setDraft({ x: p.x, y: p.y, w: 0, h: 0 })
    setDetected(null)
  }

  function onMouseMove(e: React.MouseEvent) {
    if (!dragStart.current) return
    const p = pointerPos(e)
    const s = dragStart.current
    setDraft({
      x: Math.min(s.x, p.x),
      y: Math.min(s.y, p.y),
      w: Math.abs(p.x - s.x),
      h: Math.abs(p.y - s.y)
    })
  }

  function onMouseUp() {
    dragStart.current = null
    // Discard accidental tiny drags.
    setDraft(d => (d && d.w > 6 && d.h > 6 ? d : null))
  }

  // ----- Save template from the drafted box -----
  async function saveTemplate() {
    if (!draft || !chapterId || !seriesId) return
    setSaving(true)
    try {
      await watermarkApi.createTemplate(seriesId, {
        chapterId,
        canvasX: draft.x / zoom,
        canvasY: draft.y / zoom,
        canvasW: draft.w / zoom,
        canvasH: draft.h / zoom,
        label: label.trim() || undefined
      })
      toast({ title: 'Watermark template saved', description: 'It will be auto-white-filled on export for this series.' })
      setDraft(null); setLabel('')
      reloadTemplates()
    } catch (err) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to save', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  async function runDetect() {
    if (!chapterId) return
    setDetecting(true)
    setDetected(null)
    try {
      const res = await watermarkApi.detect(chapterId)
      setManifest(res.manifest)
      setDetected(res.rects)
      toast({ title: 'Detection complete', description: `${res.rects.length} watermark match(es) found on this chapter.` })
    } catch (err) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Detection failed', variant: 'destructive' })
    } finally {
      setDetecting(false)
    }
  }

  async function toggleTemplate(t: WatermarkTemplate) {
    setTemplates(prev => prev.map(x => x.id === t.id ? { ...x, enabled: !x.enabled } : x))
    try { await watermarkApi.updateTemplate(t.id, { enabled: !t.enabled }) } catch { reloadTemplates() }
  }

  async function setThreshold(t: WatermarkTemplate, threshold: number) {
    setTemplates(prev => prev.map(x => x.id === t.id ? { ...x, threshold } : x))
    try { await watermarkApi.updateTemplate(t.id, { threshold }) } catch { reloadTemplates() }
  }

  async function removeTemplate(id: string) {
    try {
      await watermarkApi.deleteTemplate(id)
      setTemplates(prev => prev.filter(x => x.id !== id))
    } catch (err) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to delete', variant: 'destructive' })
    }
  }

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Droplet className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Watermark Lab</h1>
            <p className="text-sm text-muted-foreground">
              Identify a series' site watermark; it's auto-detected and white-filled when crops are exported.
            </p>
          </div>
        </div>

        {status && !status.available && (
          <div className="flex items-start gap-2 text-xs text-amber-600 bg-amber-500/10 rounded p-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <span>{status.error || 'OpenCV sidecar unavailable. Run `npm run ml:setup` to enable detection.'}</span>
          </div>
        )}

        {/* Selectors */}
        <Card>
          <CardContent className="p-4 flex flex-wrap items-center gap-3">
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm min-w-56"
              value={seriesId}
              onChange={(e) => { setSeriesId(e.target.value); setChapterId('') }}
            >
              <option value="">Select a series…</option>
              {series.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
            </select>

            <select
              className="h-9 rounded-md border bg-background px-2 text-sm min-w-48 disabled:opacity-50"
              value={chapterId}
              onChange={(e) => setChapterId(e.target.value)}
              disabled={!seriesId}
            >
              <option value="">Select a chapter…</option>
              {chapters.map(c => <option key={c.id} value={c.id}>Ch {c.number}</option>)}
            </select>

            <div className="flex-1" />

            <Button size="sm" variant="outline" onClick={runDetect} disabled={!chapterId || detecting || !status?.available}>
              {detecting
                ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" />Detecting…</>
                : <><ScanSearch className="h-4 w-4 mr-1" />Detection preview</>}
            </Button>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
          {/* Canvas */}
          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center gap-2 text-sm">
                <CropIcon className="h-4 w-4 text-primary" />
                <span className="font-medium">Drag a box over the watermark to save it as a template.</span>
              </div>

              {!manifest ? (
                <div className="flex items-center justify-center h-64 text-sm text-muted-foreground">
                  {chapterId ? <Loader2 className="h-5 w-5 animate-spin" /> : 'Pick a series and chapter to begin.'}
                </div>
              ) : (
                <>
                  <ScrollArea className="h-[560px] border rounded-md bg-neutral-950">
                    <div
                      className="relative mx-auto"
                      style={{ width: manifest.canvasWidth * zoom, height: manifest.canvasHeight * zoom }}
                    >
                      {manifest.images.map(img => (
                        <img
                          key={img.filename}
                          src={clipperApi.getImageUrl(chapterId, img.filename)}
                          alt=""
                          loading="lazy"
                          draggable={false}
                          style={{
                            position: 'absolute', top: img.canvasY * zoom, left: 0,
                            width: manifest.canvasWidth * zoom, height: img.canvasHeight * zoom,
                            pointerEvents: 'none', userSelect: 'none'
                          }}
                        />
                      ))}

                      {/* Capture layer for drawing */}
                      <div
                        ref={layerRef}
                        className="absolute inset-0 cursor-crosshair"
                        onMouseDown={onMouseDown}
                        onMouseMove={onMouseMove}
                        onMouseUp={onMouseUp}
                        onMouseLeave={onMouseUp}
                      />

                      {/* Draft selection */}
                      {draft && (
                        <div
                          className="absolute border-2 border-sky-400 bg-sky-400/20 pointer-events-none"
                          style={{ left: draft.x, top: draft.y, width: draft.w, height: draft.h }}
                        />
                      )}

                      {/* Detected matches */}
                      {detected?.map((r, i) => (
                        <div
                          key={i}
                          className="absolute border-2 border-dashed border-red-500 bg-red-500/15 pointer-events-none"
                          style={{ left: r.canvasX * zoom, top: r.canvasY * zoom, width: r.canvasW * zoom, height: r.canvasH * zoom }}
                        />
                      ))}
                    </div>
                  </ScrollArea>

                  <div className="flex items-center gap-2">
                    <Input
                      placeholder="Label (optional, e.g. luacomic badge)"
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                      className="h-9 max-w-xs"
                    />
                    <Button size="sm" onClick={saveTemplate} disabled={!draft || saving}>
                      {saving ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" />Saving…</> : 'Save as watermark template'}
                    </Button>
                    {draft && (
                      <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>Clear</Button>
                    )}
                    {detected && (
                      <span className="text-xs text-muted-foreground ml-auto">
                        <span className="inline-block w-3 h-2 border-2 border-dashed border-red-500 align-middle mr-1" />
                        {detected.length} detected (would be white-filled)
                      </span>
                    )}
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* Template list */}
          <Card>
            <CardContent className="p-4 space-y-3">
              <h2 className="text-sm font-semibold">Templates for this series</h2>
              {!seriesId ? (
                <p className="text-xs text-muted-foreground italic">Select a series to see its watermark templates.</p>
              ) : templates.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">No templates yet. Draw a box over the watermark and save it.</p>
              ) : (
                <div className="space-y-3">
                  {templates.map(t => (
                    <div key={t.id} className="border rounded-md p-2 space-y-2">
                      <div className="flex items-center gap-2">
                        <img
                          src={watermarkApi.templateFileUrl(t.id)}
                          alt={t.label}
                          className="h-8 max-w-24 object-contain bg-neutral-200 dark:bg-neutral-700 rounded border"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-medium truncate">{t.label}</div>
                          <div className="text-[10px] text-muted-foreground">{t.width}×{t.height}px</div>
                        </div>
                        <Switch checked={t.enabled} onCheckedChange={() => toggleTemplate(t)} />
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => removeTemplate(t.id)}>
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
                        </Button>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-muted-foreground w-16">Match {Math.round(t.threshold * 100)}%</span>
                        <Slider
                          min={0.5} max={0.98} step={0.01}
                          value={[t.threshold]}
                          onValueChange={(v) => setThreshold(t, v[0])}
                          className="flex-1"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <p className="text-[11px] text-muted-foreground pt-1">
                Lower the match threshold to catch more (risk false hits); raise it to be stricter.
                Disabled templates are skipped on export.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
