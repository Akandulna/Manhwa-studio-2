/**
 * AI Crop Lab — Module 3 AI: Auto-Crop
 *
 * "How well has the AI learned?" Provides:
 *  - Training (with the min-sample guardrail surfaced)
 *  - Version history table + an inline SVG chart of metrics over versions
 *  - Hold-out evaluation with objective metrics + a side-by-side user-vs-AI view
 *  - Blind test mode with per-suggestion 👍/👎 and a live approval rate
 */

import { useState, useEffect, useMemo, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Checkbox } from '@/components/ui/checkbox'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import PointerTrainingLab from './PointerTrainingLab'
import {
  Sparkles, Loader2, Play, BrainCircuit, CheckCircle2, ThumbsUp, ThumbsDown,
  Eye, EyeOff, FlaskConical, AlertTriangle
} from 'lucide-react'
import { useSocket } from '@/lib/socket'
import { useToast } from '@/components/ui/use-toast'
import {
  aiCropApi, clipperApi,
  type AiCropStatus, type AiModelInfo, type EvalChapters, type EvaluationRunInfo,
  type EvalPerChapter, type EvalRect, type ImageManifest, type AiSuggestion
} from '@/lib/api'

function pct(v: number | null | undefined): string {
  return v == null ? '—' : `${(v * 100).toFixed(1)}%`
}

export default function AiCropLab() {
  const { toast } = useToast()
  const {
    aiCropTrainingProgress, aiCropTrainingComplete,
    aiCropEvaluateProgress, aiCropEvaluateComplete
  } = useSocket()

  const [status, setStatus] = useState<AiCropStatus | null>(null)
  const [models, setModels] = useState<AiModelInfo[]>([])
  const [evalChapters, setEvalChapters] = useState<EvalChapters | null>(null)
  const [evaluations, setEvaluations] = useState<EvaluationRunInfo[]>([])

  const [isTraining, setIsTraining] = useState(false)
  const [isEvaluating, setIsEvaluating] = useState(false)
  const [selectedHoldout, setSelectedHoldout] = useState<Set<string>>(new Set())
  const [currentEval, setCurrentEval] = useState<EvaluationRunInfo['metrics'] | null>(null)
  const [sideBySideChapter, setSideBySideChapter] = useState<EvalPerChapter | null>(null)

  const refresh = useCallback(async () => {
    const [s, m, c, e] = await Promise.all([
      aiCropApi.getStatus().catch(() => null),
      aiCropApi.getModels().catch(() => []),
      aiCropApi.getEvalChapters().catch(() => null),
      aiCropApi.getEvaluations().catch(() => [])
    ])
    setStatus(s)
    setModels(m)
    setEvalChapters(c)
    setEvaluations(e)
    if (c) setSelectedHoldout(new Set(c.holdout.map(ch => ch.id)))
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // ----- Training -----
  async function startTraining() {
    setIsTraining(true)
    try {
      await aiCropApi.train()
    } catch (err) {
      setIsTraining(false)
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to train', variant: 'destructive' })
    }
  }

  useEffect(() => {
    if (!aiCropTrainingComplete) return
    setIsTraining(false)
    if (aiCropTrainingComplete.error) {
      toast({ title: 'Training failed', description: aiCropTrainingComplete.error, variant: 'destructive' })
    } else {
      const c = aiCropTrainingComplete
      const bits: string[] = []
      if (c.usesEmbeddings) bits.push('visual embeddings')
      if (c.hasCutModel) {
        const r = c.cutMetrics?.boundaryRecall
        bits.push(typeof r === 'number' ? `cut detector (recall ${Math.round(r * 100)}%)` : 'cut detector')
      }
      const extra = bits.length ? ` — ${bits.join(', ')}` : ''
      toast({ title: 'Training complete', description: `Model v${c.version} is now active${extra}.` })
    }
    refresh()
  }, [aiCropTrainingComplete])

  // ----- Hold-out evaluation -----
  async function startEvaluation() {
    const ids = Array.from(selectedHoldout)
    if (ids.length === 0) {
      toast({ title: 'Select chapters', description: 'Pick at least one finalized chapter to evaluate.' })
      return
    }
    setIsEvaluating(true)
    setCurrentEval(null)
    try {
      await aiCropApi.evaluate(ids)
    } catch (err) {
      setIsEvaluating(false)
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to evaluate', variant: 'destructive' })
    }
  }

  useEffect(() => {
    if (!aiCropEvaluateComplete) return
    setIsEvaluating(false)
    if (aiCropEvaluateComplete.error) {
      toast({ title: 'Evaluation failed', description: aiCropEvaluateComplete.error, variant: 'destructive' })
      return
    }
    if (aiCropEvaluateComplete.aggregate && aiCropEvaluateComplete.perChapter) {
      setCurrentEval({
        aggregate: aiCropEvaluateComplete.aggregate as EvaluationRunInfo['metrics']['aggregate'],
        perChapter: aiCropEvaluateComplete.perChapter as EvalPerChapter[]
      })
    }
    refresh()
  }, [aiCropEvaluateComplete])

  async function activateModel(version: number) {
    try {
      await aiCropApi.setActiveModel(version)
      toast({ title: 'Active model updated', description: `Model v${version} will be used for inference.` })
      refresh()
    } catch (err) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed', variant: 'destructive' })
    }
  }

  const readyModels = useMemo(() => models.filter(m => m.status === 'ready'), [models])

  // The active engine decides what "Run AI" needs: Gemini for the default
  // guideline cropper, the Python sidecar for a trained model.
  const canSuggest = status?.engine === 'guidelines'
    ? !!status?.geminiAvailable
    : !!status?.sidecarAvailable

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 pt-6 pb-2 flex-shrink-0">
        <FlaskConical className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold">AI Crop Lab</h1>
          <p className="text-sm text-muted-foreground">
            Train, evaluate, and track how well the AI has learned your cropping style.
          </p>
        </div>
      </div>

      <Tabs defaultValue="rectangle" className="flex-1 min-h-0 flex flex-col">
        <TabsList className="mx-6 w-fit flex-shrink-0">
          <TabsTrigger value="rectangle">Rectangle Crops</TabsTrigger>
          <TabsTrigger value="training">Image Clipper 2.0 Training</TabsTrigger>
        </TabsList>

        <TabsContent value="rectangle" className="flex-1 min-h-0 overflow-auto mt-0">
          <div className="max-w-5xl mx-auto p-6 space-y-6">
            {/* Training panel */}
            <TrainingPanel
              status={status}
              isTraining={isTraining}
              progress={aiCropTrainingProgress}
              onTrain={startTraining}
              onCancel={() => aiCropApi.cancelTraining()}
            />

            {/* Version history */}
            <VersionHistory models={models} onActivate={activateModel} />

            {/* Hold-out evaluation */}
            <Card>
              <CardContent className="p-4 space-y-4">
                <div className="flex items-center gap-2">
                  <BrainCircuit className="h-5 w-5 text-primary" />
                  <h2 className="text-lg font-semibold">Hold-out evaluation</h2>
                  <div className="flex-1" />
                  <Button size="sm" onClick={startEvaluation} disabled={isEvaluating || !status?.sidecarAvailable}>
                    {isEvaluating
                      ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" />Evaluating…</>
                      : <><Play className="h-4 w-4 mr-1" />Run evaluation</>}
                  </Button>
                  {isEvaluating && (
                    <Button size="sm" variant="ghost" onClick={() => aiCropApi.cancelEvaluation()}>Cancel</Button>
                  )}
                </div>

                <p className="text-xs text-muted-foreground">
                  The AI crops these chapters from scratch and is scored against your own finalized crops.
                </p>

                {/* Chapter selector */}
                {evalChapters && evalChapters.holdout.length > 0 ? (
                  <ScrollArea className="max-h-40 border rounded-md">
                    <div className="p-2 space-y-1">
                      {evalChapters.holdout.map(ch => (
                        <label key={ch.id} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-accent cursor-pointer text-sm">
                          <Checkbox
                            checked={selectedHoldout.has(ch.id)}
                            onCheckedChange={(v) => {
                              setSelectedHoldout(prev => {
                                const next = new Set(prev)
                                if (v) next.add(ch.id); else next.delete(ch.id)
                                return next
                              })
                            }}
                          />
                          <span className="flex-1">{ch.seriesTitle} · Ch {ch.number}</span>
                          <Badge variant="outline" className="text-[10px]">{ch.cropCount} crops</Badge>
                        </label>
                      ))}
                    </div>
                  </ScrollArea>
                ) : (
                  <p className="text-sm text-muted-foreground italic">
                    No finalized chapters yet — finalize some crops in the Image Clipper first.
                  </p>
                )}

                {isEvaluating && aiCropEvaluateProgress && (
                  <Progress value={aiCropEvaluateProgress.percent} className="h-2" />
                )}

                {currentEval && (
                  <EvalResults
                    metrics={currentEval}
                    chaptersMeta={evalChapters?.holdout || []}
                    onViewSideBySide={setSideBySideChapter}
                  />
                )}
              </CardContent>
            </Card>

            {/* Side-by-side viewer */}
            {sideBySideChapter && (
              <SideBySideViewer
                data={sideBySideChapter}
                onClose={() => setSideBySideChapter(null)}
              />
            )}

            {/* Blind test */}
            <BlindTest
              chapters={evalChapters?.blind || []}
              hasModel={readyModels.length > 0}
              canSuggest={canSuggest}
              engine={status?.engine}
            />

            {/* Past evaluations */}
            {evaluations.length > 0 && (
              <Card>
                <CardContent className="p-4">
                  <h2 className="text-sm font-semibold mb-2">Recent evaluation runs</h2>
                  <div className="space-y-1 text-xs">
                    {evaluations.slice(0, 8).map(run => (
                      <div key={run.id} className="flex items-center gap-3 py-1 border-b last:border-0">
                        <Badge variant="outline" className="text-[10px] capitalize">{run.mode}</Badge>
                        <span className="text-muted-foreground">{new Date(run.createdAt).toLocaleString()}</span>
                        <div className="flex-1" />
                        <span>IoU {pct(run.metrics.aggregate?.meanIoU)}</span>
                        <span>F1 {pct(run.metrics.aggregate?.f1)}</span>
                        <span>{run.chapterIds.length} ch</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>

        <TabsContent value="training" className="flex-1 min-h-0 mt-0">
          <PointerTrainingLab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ============ Training panel ============

function TrainingPanel({ status, isTraining, progress, onTrain, onCancel }: {
  status: AiCropStatus | null
  isTraining: boolean
  progress: { phase: string; percent: number } | null
  onTrain: () => void
  onCancel: () => void
}) {
  const canTrain = status?.canTrain && status.sidecarAvailable && !isTraining
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">Model training</h2>
          <div className="flex-1" />
          {status && (
            <Badge variant="secondary">
              Active: {status.engine === 'guidelines'
                ? 'Guidelines (Gemini)'
                : status.activeModelVersion != null ? `v${status.activeModelVersion}` : '—'}
            </Badge>
          )}
          <Button size="sm" onClick={onTrain} disabled={!canTrain}>
            {isTraining
              ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" />Training…</>
              : <><BrainCircuit className="h-4 w-4 mr-1" />Train model</>}
          </Button>
          {isTraining && <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>}
        </div>

        <p className="text-xs text-muted-foreground">
          The default <strong>Guidelines (Gemini)</strong> model crops by following your written
          guidelines — no training needed. Edit them in{' '}
          <Link to="/settings" className="underline">Settings</Link>. Training a model below learns
          your style from finalized crops as an alternative engine.
        </p>

        {status && status.engine === 'guidelines' && !status.geminiAvailable && (
          <div className="flex items-start gap-2 text-xs text-amber-600 bg-amber-500/10 rounded p-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <span>Gemini is not configured — set <code>GEMINI_API_KEY</code> in your .env to use the default guideline model.</span>
          </div>
        )}

        {status && !status.sidecarAvailable && (
          <div className="flex items-start gap-2 text-xs text-amber-600 bg-amber-500/10 rounded p-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <span>{status.sidecarError || 'Python sidecar unavailable (needed only for training/evaluation). Run `npm run ml:setup`.'}</span>
          </div>
        )}

        {status && (
          <div className="text-sm text-muted-foreground">
            Dataset: <span className="font-medium text-foreground">{status.sampleCount}</span> finalized crops
            {!status.canTrain && (
              <span className="text-amber-600">
                {' '}· need {Math.max(0, status.minSamples - status.sampleCount)} more to train (min {status.minSamples})
              </span>
            )}
          </div>
        )}

        {status && (
          <div className="text-xs text-muted-foreground">
            Vision model:{' '}
            {status.backboneAvailable ? (
              <span className="text-foreground">ready — new models learn from image content</span>
            ) : (
              <span className="text-amber-600">not installed — run `npm run ml:setup` to enable visual embeddings</span>
            )}
          </div>
        )}

        {isTraining && progress && (
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground capitalize w-24">{progress.phase}…</span>
            <Progress value={progress.percent} className="flex-1 h-2" />
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ============ Version history + chart ============

function VersionHistory({ models, onActivate }: { models: AiModelInfo[]; onActivate: (v: number) => void }) {
  const ready = models.filter(m => m.status === 'ready').slice().reverse() // ascending by version
  if (models.length === 0) {
    return (
      <Card><CardContent className="p-4 text-sm text-muted-foreground">
        No models trained yet. Train your first model above once you have enough crops.
      </CardContent></Card>
    )
  }
  return (
    <Card>
      <CardContent className="p-4 space-y-4">
        <h2 className="text-lg font-semibold">Version history</h2>

        {ready.length >= 1 && <MetricChart models={ready} />}

        <div className="text-xs">
          <div className="grid grid-cols-[auto_1fr_auto_auto_auto_auto] gap-x-4 gap-y-1 items-center">
            <div className="font-medium text-muted-foreground">Ver</div>
            <div className="font-medium text-muted-foreground">Trained</div>
            <div className="font-medium text-muted-foreground text-right">Samples</div>
            <div className="font-medium text-muted-foreground text-right">IoU</div>
            <div className="font-medium text-muted-foreground text-right">Preset</div>
            <div className="font-medium text-muted-foreground text-right">Active</div>
            {models.map(m => (
              <FragmentRow key={m.id} m={m} onActivate={onActivate} />
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function FragmentRow({ m, onActivate }: { m: AiModelInfo; onActivate: (v: number) => void }) {
  return (
    <>
      <div className="py-1">{m.label || `v${m.version}`}</div>
      <div className="py-1 text-muted-foreground">
        {m.kind === 'guidelines'
          ? <span className="italic">built-in</span>
          : new Date(m.createdAt).toLocaleDateString()}
        {m.status !== 'ready' && <Badge variant="outline" className="ml-1 text-[10px] capitalize">{m.status}</Badge>}
      </div>
      <div className="py-1 text-right">{m.trainingSampleCount}</div>
      <div className="py-1 text-right">{pct(m.metrics?.meanIoU)}</div>
      <div className="py-1 text-right">{pct(m.metrics?.presetAccuracy)}</div>
      <div className="py-1 text-right">
        {m.active
          ? <Badge variant="secondary" className="text-[10px]"><CheckCircle2 className="h-3 w-3 mr-0.5" />Active</Badge>
          : m.status === 'ready'
            ? <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2" onClick={() => onActivate(m.version)}>Set active</Button>
            : <span className="text-muted-foreground">—</span>}
      </div>
    </>
  )
}

/** Lightweight inline SVG line chart of metrics over model versions (no chart dep). */
function MetricChart({ models }: { models: AiModelInfo[] }) {
  const W = 480, H = 160, padL = 32, padB = 22, padT = 10, padR = 10
  const innerW = W - padL - padR, innerH = H - padT - padB
  const n = models.length
  const x = (i: number) => padL + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW)
  const y = (v: number) => padT + (1 - v) * innerH // metrics in [0,1]

  const series: { key: keyof NonNullable<AiModelInfo['metrics']>; color: string; label: string }[] = [
    { key: 'meanIoU', color: '#3b82f6', label: 'Mean IoU' },
    { key: 'f1', color: '#22c55e', label: 'F1' },
    { key: 'presetAccuracy', color: '#f59e0b', label: 'Preset acc' }
  ]

  const line = (key: keyof NonNullable<AiModelInfo['metrics']>) =>
    models.map((m, i) => {
      const v = m.metrics?.[key]
      return v == null ? null : `${x(i)},${y(v as number)}`
    }).filter(Boolean).join(' ')

  return (
    <div className="border rounded-md p-2 bg-muted/30">
      <svg width={W} height={H} className="overflow-visible">
        {/* gridlines at 0/0.5/1 */}
        {[0, 0.5, 1].map(g => (
          <g key={g}>
            <line x1={padL} y1={y(g)} x2={W - padR} y2={y(g)} stroke="currentColor" strokeOpacity={0.12} />
            <text x={4} y={y(g) + 3} fontSize={9} fill="currentColor" fillOpacity={0.5}>{g.toFixed(1)}</text>
          </g>
        ))}
        {/* x labels */}
        {models.map((m, i) => (
          <text key={m.id} x={x(i)} y={H - padB + 14} fontSize={9} textAnchor="middle" fill="currentColor" fillOpacity={0.5}>
            v{m.version}
          </text>
        ))}
        {/* series */}
        {series.map(s => (
          <g key={s.key}>
            <polyline points={line(s.key)} fill="none" stroke={s.color} strokeWidth={2} />
            {models.map((m, i) => {
              const v = m.metrics?.[s.key]
              return v == null ? null : <circle key={m.id} cx={x(i)} cy={y(v as number)} r={3} fill={s.color} />
            })}
          </g>
        ))}
      </svg>
      <div className="flex gap-4 mt-1 text-[10px]">
        {series.map(s => (
          <span key={s.key} className="flex items-center gap-1">
            <span className="inline-block w-3 h-1 rounded" style={{ background: s.color }} />{s.label}
          </span>
        ))}
      </div>
    </div>
  )
}

// ============ Eval results ============

function EvalResults({ metrics, chaptersMeta, onViewSideBySide }: {
  metrics: EvaluationRunInfo['metrics']
  chaptersMeta: { id: string; number: number; seriesTitle: string }[]
  onViewSideBySide: (c: EvalPerChapter) => void
}) {
  const agg = metrics.aggregate
  const cards = [
    { label: 'Mean IoU', value: pct(agg.meanIoU) },
    { label: 'Precision', value: pct(agg.precision) },
    { label: 'Recall', value: pct(agg.recall) },
    { label: 'F1 @ 0.5', value: pct(agg.f1) },
    { label: 'Count acc', value: pct(agg.countAccuracy) },
    { label: 'Preset acc', value: pct(agg.presetAccuracy) }
  ]
  const metaFor = (id: string) => chaptersMeta.find(c => c.id === id)

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
        {cards.map(c => (
          <div key={c.label} className="border rounded-md p-2 text-center">
            <div className="text-lg font-semibold">{c.value}</div>
            <div className="text-[10px] text-muted-foreground">{c.label}</div>
          </div>
        ))}
      </div>

      <div className="text-xs border rounded-md overflow-hidden">
        <div className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-x-3 px-3 py-1.5 bg-muted font-medium">
          <span>Chapter</span><span className="text-right">IoU</span><span className="text-right">P/R</span>
          <span className="text-right">Count</span><span className="text-right">AI/User</span><span className="text-right" />
        </div>
        {metrics.perChapter.map(pc => {
          const meta = metaFor(pc.chapterId)
          return (
            <div key={pc.chapterId} className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-x-3 px-3 py-1.5 border-t items-center">
              <span>{meta ? `${meta.seriesTitle} · Ch ${meta.number}` : pc.chapterId.slice(0, 8)}</span>
              <span className="text-right">{pct(pc.metrics.meanIoU)}</span>
              <span className="text-right">{pct(pc.metrics.precision)}/{pct(pc.metrics.recall)}</span>
              <span className="text-right">{pct(pc.metrics.countAccuracy)}</span>
              <span className="text-right">{pc.metrics.aiCount}/{pc.metrics.userCount}</span>
              <span className="text-right">
                <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2" onClick={() => onViewSideBySide(pc)}>
                  <Eye className="h-3 w-3 mr-1" />Compare
                </Button>
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ============ Side-by-side viewer ============

function SideBySideViewer({ data, onClose }: { data: EvalPerChapter; onClose: () => void }) {
  const [manifest, setManifest] = useState<ImageManifest | null>(null)
  const [userCrops, setUserCrops] = useState<EvalRect[]>([])
  const [showUser, setShowUser] = useState(true)
  const [showAi, setShowAi] = useState(true)
  const chapterId = data.chapterId

  useEffect(() => {
    let cancelled = false
    Promise.all([
      clipperApi.getManifest(chapterId),
      clipperApi.createSession(chapterId)
    ]).then(([m, session]) => {
      if (cancelled) return
      setManifest(m)
      setUserCrops((session.crops || []).map(c => ({
        canvasX: c.canvasX, canvasY: c.canvasY, canvasW: c.canvasW, canvasH: c.canvasH, aspectPreset: c.aspectRatio
      })))
    }).catch(() => {})
    return () => { cancelled = true }
  }, [chapterId])

  const zoom = manifest ? Math.min(0.25, 460 / manifest.canvasWidth) : 0.2

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <h2 className="text-sm font-semibold">Side-by-side: user vs AI</h2>
          <div className="flex-1" />
          <Button size="sm" variant={showUser ? 'default' : 'outline'} className="h-7 text-xs" onClick={() => setShowUser(v => !v)}>
            {showUser ? <Eye className="h-3 w-3 mr-1" /> : <EyeOff className="h-3 w-3 mr-1" />}
            <span style={{ color: showUser ? undefined : '#3b82f6' }}>User</span>
          </Button>
          <Button size="sm" variant={showAi ? 'default' : 'outline'} className="h-7 text-xs" onClick={() => setShowAi(v => !v)}>
            {showAi ? <Eye className="h-3 w-3 mr-1" /> : <EyeOff className="h-3 w-3 mr-1" />}
            <span style={{ color: showAi ? undefined : '#f59e0b' }}>AI</span>
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onClose}>Close</Button>
        </div>

        <div className="flex gap-4 text-xs mb-2">
          <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 border-2" style={{ borderColor: '#3b82f6' }} />User ({userCrops.length})</span>
          <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 border-2 border-dashed" style={{ borderColor: '#f59e0b' }} />AI ({data.aiCrops.length})</span>
        </div>

        {!manifest ? (
          <div className="flex items-center justify-center h-40"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <ScrollArea className="h-[480px] border rounded-md bg-neutral-950">
            <div className="relative mx-auto" style={{ width: manifest.canvasWidth * zoom, height: manifest.canvasHeight * zoom }}>
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
              {showUser && userCrops.map((c, i) => (
                <div key={`u${i}`} style={overlayStyle(c, zoom, '#3b82f6', false)} />
              ))}
              {showAi && data.aiCrops.map((c, i) => (
                <div key={`a${i}`} style={overlayStyle(c, zoom, '#f59e0b', true)} />
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  )
}

function overlayStyle(c: EvalRect, zoom: number, color: string, dashed: boolean): React.CSSProperties {
  return {
    position: 'absolute',
    left: c.canvasX * zoom, top: c.canvasY * zoom,
    width: c.canvasW * zoom, height: c.canvasH * zoom,
    border: `2px ${dashed ? 'dashed' : 'solid'} ${color}`,
    background: `${color}1a`,
    pointerEvents: 'none'
  }
}

// ============ Blind test ============

function BlindTest({ chapters, hasModel, canSuggest, engine }: {
  chapters: { id: string; number: number; seriesTitle: string; cropCount: number }[]
  hasModel: boolean
  canSuggest: boolean
  engine?: 'guidelines' | 'trained'
}) {
  const { toast } = useToast()
  const { aiCropSuggestComplete, aiCropSuggestProgress } = useSocket()
  const [chapterId, setChapterId] = useState<string>('')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [suggestions, setSuggestions] = useState<AiSuggestion[]>([])

  async function run() {
    if (!chapterId) return
    setRunning(true)
    setSuggestions([])
    try {
      const session = await clipperApi.createSession(chapterId)
      setSessionId(session.id)
      await aiCropApi.suggest(session.id)
    } catch (err) {
      setRunning(false)
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed', variant: 'destructive' })
    }
  }

  useEffect(() => {
    if (!aiCropSuggestComplete || !sessionId) return
    if (aiCropSuggestComplete.cropSessionId !== sessionId) return
    setRunning(false)
    if (aiCropSuggestComplete.error) {
      toast({ title: 'Blind test failed', description: aiCropSuggestComplete.error, variant: 'destructive' })
      return
    }
    // Reload persisted suggestions (includes ids) for rating.
    aiCropApi.getSuggestions(sessionId, 'pending').then(setSuggestions).catch(() => {})
  }, [aiCropSuggestComplete])

  async function rate(id: string, rating: 'up' | 'down') {
    setSuggestions(prev => prev.map(s => s.id === id ? { ...s, rating } : s))
    try {
      await aiCropApi.updateSuggestion(id, { rating })
    } catch { /* best-effort */ }
  }

  const rated = suggestions.filter(s => s.rating)
  const ups = suggestions.filter(s => s.rating === 'up').length
  const approval = rated.length > 0 ? ups / rated.length : null

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <ThumbsUp className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">Blind test</h2>
          <div className="flex-1" />
          {approval != null && (
            <Badge variant="secondary">Approval: {pct(approval)} ({ups}/{rated.length})</Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          The AI crops a chapter with no user crops; rate each suggestion to gauge real-world quality.
          {engine === 'guidelines'
            ? ' (Default model: following your written guidelines via Gemini.)'
            : hasModel ? '' : ' (No trained model yet — using rule-based detection.)'}
        </p>

        <div className="flex items-center gap-2">
          <select
            className="flex-1 h-9 rounded-md border bg-background px-2 text-sm"
            value={chapterId}
            onChange={(e) => setChapterId(e.target.value)}
          >
            <option value="">Select a chapter…</option>
            {chapters.map(ch => (
              <option key={ch.id} value={ch.id}>{ch.seriesTitle} · Ch {ch.number}</option>
            ))}
          </select>
          <Button size="sm" onClick={run} disabled={!chapterId || running || !canSuggest}>
            {running ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" />Cropping…</> : <><Play className="h-4 w-4 mr-1" />Run AI</>}
          </Button>
        </div>

        {running && aiCropSuggestProgress?.cropSessionId === sessionId && (
          <Progress value={aiCropSuggestProgress.percent} className="h-2" />
        )}

        {suggestions.length > 0 && (
          <div className="space-y-1">
            {suggestions.map((s, i) => (
              <div key={s.id} className="flex items-center gap-3 text-xs border rounded-md px-3 py-1.5">
                <Badge variant="outline" className="text-[10px]">#{i + 1}</Badge>
                <span className="text-muted-foreground">{s.aspectPreset}</span>
                <span className="text-muted-foreground">conf {pct(s.confidence)}</span>
                <span className="text-muted-foreground">{Math.round(s.canvasW)}×{Math.round(s.canvasH)}px</span>
                <div className="flex-1" />
                <Button size="sm" variant={s.rating === 'up' ? 'default' : 'outline'} className="h-6 w-6 p-0" onClick={() => rate(s.id, 'up')}>
                  <ThumbsUp className="h-3 w-3" />
                </Button>
                <Button size="sm" variant={s.rating === 'down' ? 'default' : 'outline'} className="h-6 w-6 p-0" onClick={() => rate(s.id, 'down')}>
                  <ThumbsDown className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
