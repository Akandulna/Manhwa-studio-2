/**
 * Narration — a series' chapters in one language.
 *
 * The Sleeper-Cell phones write each chapter's script and voice it, and upload
 * both to R2. This page's one job is getting them onto this Mac: "Fetch from
 * phone" previews what the phones uploaded (the only R2 read, on the click),
 * the user ticks chapters, and the server downloads the scripts and voiceovers.
 * Every attached voiceover is aligned by itself, and once a chapter's sections
 * all have their timeline the alignment document (script-timeline.md, or
 * script-timeline.hi.md) is written to the chapter folder for Editor 2.0.
 *
 * Each row shows where a chapter stands: script, sections with audio, sections
 * aligned and the document. "Align again" picks up an alignment that failed or
 * was interrupted. Progress arrives over the socket.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle,
  DownloadCloud,
  FileCheck,
  FileText,
  FolderOpen,
  Loader2,
  RefreshCw,
  Replace,
  Volume2,
  Waves
} from 'lucide-react'
import {
  narrationApi,
  openFolder,
  phoneScriptsIn,
  NarrationChapter,
  NarrationPhoneFetch,
  NarrationPhonePreview,
  NarrationSeriesDetail
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { useToast } from '@/components/ui/use-toast'
import { useSocket } from '@/lib/socket'
import { LanguageTabs } from '@/components/LanguageTabs'
import { LANGUAGE_LABEL, NarrationLanguage, useNarrationLanguage, withLang } from '@/lib/narrationLanguage'
import { usePublishedChapters } from '@/hooks/usePublishedChapters'
import { usePhoneScripts } from '@/hooks/usePhoneScripts'
import { CompletedBadge, PublishedBadge, completedRowClass, publishedRowClass } from '@/components/PublishedBadge'
import { PhoneScriptBadge } from '@/components/PhoneSyncBadge'
import { PhoneRefreshButton } from '@/components/PhoneRefreshButton'
import { PhoneFetchDialog, type PhoneFetchSelection } from '@/components/narration/PhoneFetchDialog'
import { ReplaceScriptDialog } from '@/components/narration/ReplaceScriptDialog'
import { cn } from '@/lib/utils'

const chapters = (n: number) => `${n} chapter${n === 1 ? '' : 's'}`

/** Alignment events from the server (see alignmentService.ts). */
interface AlignmentEvent {
  chapterId: string
  language?: NarrationLanguage
  stage?: 'aligning' | 'done' | 'failed'
  error?: string
}

/** What a finished fetch did, in a few lines. */
function FetchSummary({ run }: { run: NarrationPhoneFetch }) {
  if (run.stage === 'failed') {
    return (
      <p className="flex items-center gap-2 text-sm text-destructive">
        <AlertTriangle className="h-4 w-4" />
        {run.error ?? 'Fetch from phone failed'}
      </p>
    )
  }
  const voiceovers = run.voiceovers
  const fetched = voiceovers?.fetched ?? []
  const otherScript = fetched.filter(c => c.scriptMatches === false)
  const resplit = fetched.filter(c => c.resplit)
  return (
    <div className="space-y-1 text-sm">
      <p className="flex items-center gap-2">
        <CheckCircle className="h-4 w-4 text-emerald-600" />
        {[
          run.scripts ? `${run.scripts.imported} script${run.scripts.imported === 1 ? '' : 's'} saved` : null,
          run.scripts?.aboutUpdated ? 'about text updated' : null,
          voiceovers
            ? fetched.length > 0
              ? `voiceover attached to ${chapters(fetched.length)} (chapter ${fetched.map(c => c.chapterNumber).join(', ')}) — aligning now`
              : 'no new voiceover'
            : null
        ].filter(Boolean).join(', ')}
      </p>
      {resplit.length > 0 && (
        <p className="text-muted-foreground">
          Sections replaced with the phone's splits: chapter {resplit.map(c => c.chapterNumber).join(', ')}
        </p>
      )}
      {otherScript.length > 0 && (
        <p className="flex items-center gap-1 text-amber-600">
          <AlertTriangle className="h-4 w-4" />
          The phone voiced a different script than the one here for chapter{' '}
          {otherScript.map(c => c.chapterNumber).join(', ')} — fetch its script too
        </p>
      )}
      {voiceovers?.failed.map(f => (
        <p key={f.folder} className="flex items-center gap-1 text-destructive">
          <AlertTriangle className="h-4 w-4" />
          {f.folder}: {f.reason}
        </p>
      ))}
    </div>
  )
}

/** One "n/m" status cell: done when n reaches m, muted when there is nothing yet. */
function Count({ icon: Icon, done, total, label, title }: {
  icon: typeof Volume2
  done: number
  total: number
  label: string
  title: string
}) {
  const complete = total > 0 && done === total
  return (
    <span
      title={title}
      className={cn(
        'flex w-28 items-center gap-1 text-xs tabular-nums',
        complete ? 'text-emerald-600' : total === 0 ? 'text-muted-foreground' : 'text-amber-600'
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      {total === 0 ? `${label} –` : `${label} ${done}/${total}`}
    </span>
  )
}

export default function NarrationChapters() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { toast } = useToast()
  const { socket } = useSocket()
  const [language, setLanguage] = useNarrationLanguage('narration')

  const [series, setSeries] = useState<NarrationSeriesDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [aligner, setAligner] = useState<{ available: boolean; error?: string } | null>(null)

  // Fetch from phone: the preview being chosen from, the run in flight, and the last outcome.
  const [previewing, setPreviewing] = useState(false)
  const [preview, setPreview] = useState<NarrationPhonePreview | null>(null)
  const [starting, setStarting] = useState(false)
  const [fetchRun, setFetchRun] = useState<NarrationPhoneFetch | null>(null)
  const [lastFetch, setLastFetch] = useState<NarrationPhoneFetch | null>(null)
  // Chapters whose "Align again" was just asked for, until the reload shows them aligning.
  const [aligningNow, setAligningNow] = useState<Set<string>>(new Set())
  const [replacing, setReplacing] = useState<NarrationChapter | null>(null)

  // Rendered or completed chapters in this language.
  const { isPublished, completedPart } = usePublishedChapters(id, language)
  // Scripts on the Sleeper-Cell phone: the server's copy of its receipt, no R2 read.
  const phoneScriptsReceipt = usePhoneScripts(id)
  const phoneScripts = phoneScriptsIn(phoneScriptsReceipt.status, language)

  const loadSeries = useCallback(async () => {
    if (!id) return
    try {
      const data = await narrationApi.getSeriesDetail(id, language)
      setSeries(data)
      setFetchRun(data.phoneFetch)
      setAligningNow(new Set())
    } catch {
      toast({ title: 'Error', description: 'Failed to load series', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [id, language])

  useEffect(() => {
    setLastFetch(null)
    setReplacing(null)
    loadSeries()
  }, [loadSeries])

  useEffect(() => {
    narrationApi.getAlignmentStatus().then(setAligner).catch(() => setAligner(null))
  }, [])

  // Many alignment events arrive in a burst; one reload settles them.
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleReload = useCallback(() => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current)
    reloadTimer.current = setTimeout(loadSeries, 600)
  }, [loadSeries])
  useEffect(() => () => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current)
  }, [])

  const chapterIds = useRef(new Set<string>())
  chapterIds.current = new Set(series?.chapters.map(c => c.id) ?? [])

  useEffect(() => {
    if (!socket || !id) return
    const mine = (event: { language?: NarrationLanguage }) => (event.language ?? 'en') === language

    const onFetchEvent = (run: NarrationPhoneFetch) => {
      if (run.seriesId !== id || !mine(run)) return
      if (run.stage === 'done' || run.stage === 'failed') {
        setFetchRun(null)
        setLastFetch(run)
        loadSeries()
        if (run.stage === 'failed') {
          toast({ title: 'Fetch from phone failed', description: run.error, variant: 'destructive' })
        }
      } else {
        setFetchRun(run)
        // Each chapter attached in the step before is aligning now.
        if (run.stage === 'voiceover') scheduleReload()
      }
    }
    const onAlignmentEvent = (event: AlignmentEvent) => {
      if (!mine(event) || !chapterIds.current.has(event.chapterId)) return
      scheduleReload()
    }

    socket.on('narration:fetch', onFetchEvent)
    socket.on('alignment:progress', onAlignmentEvent)
    socket.on('alignment:chapter-complete', onAlignmentEvent)
    const onReplacement = (event: AlignmentEvent) => { if (chapterIds.current.has(event.chapterId) && mine(event)) scheduleReload() }
    socket.on('narration:script-replaced', onReplacement)
    return () => {
      socket.off('narration:fetch', onFetchEvent)
      socket.off('alignment:progress', onAlignmentEvent)
      socket.off('alignment:chapter-complete', onAlignmentEvent)
      socket.off('narration:script-replaced', onReplacement)
    }
  }, [socket, id, language, loadSeries, scheduleReload])

  const handlePreview = async () => {
    if (!id) return
    setPreviewing(true)
    try {
      const result = await narrationApi.previewPhone(id, language)
      if (!result.configured) {
        toast({ title: 'R2 is not set up', description: 'Fill in Settings → Cloudflare first.', variant: 'destructive' })
        return
      }
      setPreview(result)
    } catch (error) {
      toast({
        title: 'Could not look at the phone uploads',
        description: error instanceof Error ? error.message : 'Failed to reach R2',
        variant: 'destructive'
      })
    } finally {
      setPreviewing(false)
    }
  }

  const handleFetch = async (selection: PhoneFetchSelection) => {
    if (!id) return
    setStarting(true)
    try {
      await narrationApi.fetchFromPhone(id, language, selection)
      setPreview(null)
      setLastFetch(null)
      setFetchRun(prev => prev ?? {
        seriesId: id,
        language,
        stage: selection.scriptChapterIds.length > 0 ? 'scripts' : 'voiceover'
      })
    } catch (error) {
      toast({
        title: 'Could not start the fetch',
        description: error instanceof Error ? error.message : 'Fetch failed',
        variant: 'destructive'
      })
    } finally {
      setStarting(false)
    }
  }

  const handleAlign = async (chapter: NarrationChapter) => {
    setAligningNow(prev => new Set(prev).add(chapter.id))
    try {
      const result = await narrationApi.alignChapter(chapter.id, language)
      if (result.started) {
        toast({ title: `Aligning chapter ${chapter.number}`, description: `${result.sections} section(s) left to align` })
      } else {
        toast({
          title: result.documentWritten ? 'Alignment document written' : 'Nothing to align',
          description: result.documentWritten ? 'Every section was already aligned.' : undefined
        })
      }
    } catch (error) {
      toast({
        title: 'Could not align',
        description: error instanceof Error ? error.message : 'Alignment failed',
        variant: 'destructive'
      })
    } finally {
      loadSeries()
    }
  }

  const handleOpenFolder = async (folder: string) => {
    try {
      await openFolder(folder)
    } catch {
      toast({ title: 'Error', description: 'Failed to open folder', variant: 'destructive' })
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  if (!series) {
    return (
      <div className="p-6 text-center">
        <h2 className="text-xl font-semibold">Series not found</h2>
        <Button variant="link" onClick={() => navigate(withLang('/narration', language))}>
          Return to Library
        </Button>
      </div>
    )
  }

  const list = series.chapters
  const scripted = list.filter(c => c.hasScript).length
  const voiced = list.filter(c => c.sections > 0 && c.withAudio === c.sections).length
  const aligned = list.filter(c => c.sections > 0 && c.aligned === c.sections).length
  const documents = list.filter(c => c.documentWritten).length
  const phoneSeries = phoneScripts?.series[series.id]
  const fetching = !!fetchRun

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-start gap-6 mb-6">
        <Button variant="ghost" size="icon" onClick={() => navigate(withLang('/narration', language))}>
          <ArrowLeft className="h-5 w-5" />
        </Button>

        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-4 mb-2">
            <h1 className="text-3xl font-bold">{series.title}</h1>
            {/* Locked while a fetch runs: its progress belongs to this tab */}
            <LanguageTabs value={language} onChange={setLanguage} disabled={fetching} />
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span>{chapters(list.length)}</span>
            <span>•</span>
            <span>{scripted} {LANGUAGE_LABEL[language]} scripts</span>
            <span>•</span>
            <span>{voiced} with audio</span>
            <span>•</span>
            <span>{aligned} aligned ({documents} documents written)</span>
            {phoneSeries && (
              <>
                <span>•</span>
                <span title={phoneScripts?.device ? `Sleeper-Cell on ${phoneScripts.device}` : 'Sleeper-Cell'}>
                  {phoneSeries.done}/{phoneSeries.total} {language === 'hi' ? 'converted' : 'scripted'} on phone
                </span>
              </>
            )}
            <PhoneRefreshButton receipt={phoneScriptsReceipt} />
          </div>
        </div>

        <div className="flex shrink-0 gap-2">
          <Button variant="outline" onClick={() => handleOpenFolder(series.rootFolder)}>
            <FolderOpen className="h-4 w-4 mr-2" />
            Open folder
          </Button>
          <Button
            onClick={handlePreview}
            disabled={previewing || fetching}
            title="See what the phones uploaded to R2 for this language, and choose what to download"
          >
            {previewing || fetching ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <DownloadCloud className="h-4 w-4 mr-2" />
            )}
            Fetch from phone
          </Button>
        </div>
      </div>

      {aligner && !aligner.available && (
        <Card className="mb-6 border-amber-500">
          <CardContent className="py-4">
            <div className="flex items-start gap-3 text-amber-600">
              <AlertTriangle className="h-5 w-5 shrink-0" />
              <div>
                <p className="font-medium">The aligner can't run on this Mac</p>
                <p className="text-sm text-muted-foreground">
                  {aligner.error ?? 'WhisperX is not installed.'} Fetched voiceovers are kept; align them once it works.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {(fetchRun || lastFetch) && (
        <Card className="mb-6">
          <CardContent className="py-4">
            {fetchRun ? (
              <p className="flex items-center gap-2 text-sm">
                <Loader2 className="h-4 w-4 animate-spin" />
                {fetchRun.stage === 'scripts'
                  ? 'Saving the phone\'s scripts...'
                  : fetchRun.chapterNumber !== undefined
                    ? `Downloading voiceover for chapter ${fetchRun.chapterNumber} (${fetchRun.current}/${fetchRun.total})...`
                    : 'Looking for the phone\'s voiceovers...'}
              </p>
            ) : (
              lastFetch && <FetchSummary run={lastFetch} />
            )}
          </CardContent>
        </Card>
      )}

      {/* Chapters */}
      <Card className="overflow-hidden divide-y">
        {list.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">No downloaded chapters in this series.</p>
        )}
        {list.map(chapter => {
          // A completed Part's chapter: files deleted, only continuity kept — nothing left to fetch.
          const completed = completedPart(chapter.id)
          const aligning = chapter.aligning || aligningNow.has(chapter.id)
          const allAligned = chapter.sections > 0 && chapter.aligned === chapter.sections
          // Sections with audio but no timeline (a failed or interrupted run), or a missing document.
          const canAlign = !aligning && chapter.withAudio > 0 &&
            (chapter.aligned < chapter.withAudio || (allAligned && !chapter.documentWritten))
          const phoneScript = phoneScripts?.chapters[chapter.id]
          return (
            <div
              key={chapter.id}
              className={cn(
                'flex items-center gap-4 px-4 py-3',
                completed !== null ? completedRowClass : isPublished(chapter.id) ? publishedRowClass : ''
              )}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-medium shrink-0">Chapter {chapter.number}</span>
                  {chapter.title && <span className="text-sm text-muted-foreground truncate">- {chapter.title}</span>}
                  {completed === null && isPublished(chapter.id) && <PublishedBadge />}
                </div>
              </div>

              {completed !== null ? (
                <CompletedBadge part={completed} />
              ) : (
                <>
                  {phoneScript && (
                    <PhoneScriptBadge script={phoneScript} device={phoneScripts?.device ?? null} hinglish={language === 'hi'} />
                  )}

                  <span
                    className={cn(
                      'flex w-20 items-center gap-1 text-xs',
                      chapter.hasScript ? 'text-emerald-600' : 'text-muted-foreground'
                    )}
                    title={chapter.hasScript ? 'Script saved in the chapter folder' : 'No script fetched yet'}
                  >
                    <FileText className="h-3.5 w-3.5" />
                    Script {chapter.hasScript ? '✓' : '–'}
                  </span>

                  <Count
                    icon={Volume2}
                    label="Audio"
                    done={chapter.withAudio}
                    total={chapter.sections}
                    title={chapter.fetchedAt
                      ? `Sections with audio — fetched from the phone ${new Date(chapter.fetchedAt).toLocaleString()}`
                      : 'Sections with audio'}
                  />

                  {aligning ? (
                    <span className="flex w-28 items-center gap-1 text-xs text-primary">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Aligning {chapter.aligned}/{chapter.sections}
                    </span>
                  ) : (
                    <Count
                      icon={Waves}
                      label="Aligned"
                      done={chapter.aligned}
                      total={chapter.sections}
                      title="Sections with their Script with Timeline"
                    />
                  )}

                  <span
                    className={cn(
                      'flex w-24 items-center gap-1 text-xs',
                      chapter.documentWritten ? 'text-emerald-600' : 'text-muted-foreground'
                    )}
                    title={chapter.documentWritten
                      ? `${language === 'hi' ? 'script-timeline.hi.md' : 'script-timeline.md'} is in the chapter folder`
                      : 'Written once every section is aligned'}
                  >
                    <FileCheck className="h-3.5 w-3.5" />
                    Document {chapter.documentWritten ? '✓' : '–'}
                  </span>

                  <div className="flex shrink-0 justify-end gap-1">
                    <Button variant="outline" size="sm" onClick={() => setReplacing(chapter)} disabled={aligning || !!fetchRun}
                      title="Replace this language’s script and prepare a new voiceover and timeline">
                      <Replace className="h-4 w-4 mr-1" />Replace
                    </Button>
                    {canAlign && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleAlign(chapter)}
                        disabled={aligner?.available === false}
                        title={allAligned ? 'Write the missing alignment document' : 'Align the sections that have no timeline yet'}
                      >
                        <RefreshCw className="h-4 w-4 mr-1" />
                        Align again
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handleOpenFolder(chapter.folderPath)}
                      title="Open the chapter folder"
                    >
                      <FolderOpen className="h-4 w-4" />
                    </Button>
                  </div>
                </>
              )}
            </div>
          )
        })}
      </Card>

      <PhoneFetchDialog
        language={language}
        preview={preview}
        starting={starting}
        onCancel={() => setPreview(null)}
        onConfirm={handleFetch}
      />
      {replacing && <ReplaceScriptDialog key={`${replacing.id}:${language}`} chapter={replacing} language={language}
        onClose={() => setReplacing(null)} onSaved={() => { void loadSeries() }} />}
    </div>
  )
}
