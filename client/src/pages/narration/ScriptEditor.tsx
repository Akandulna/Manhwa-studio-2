/**
 * Script Editor Page
 * 
 * The main workspace for generating and editing narration scripts.
 * Supports both API mode and Manual mode.
 *
 * Scripts are generated on the English tab only. The Hindi tab edits the
 * chapter's Hinglish script, which is converted from the English one: in API
 * mode by itself once the English script is saved (or with "Convert to
 * Hinglish"), in Manual mode with the step 1 and step 2 prompts and a pasted reply
 * that is checked before it is saved.
 */

import { useEffect, useRef, useState } from 'react'
import { usePublishedChapters } from '@/hooks/usePublishedChapters'
import { PublishedBadge } from '@/components/PublishedBadge'
import { useParams, useNavigate } from 'react-router-dom'
import { narrationApi, ChapterScriptDetail, ManualPromptResponse, AIStatus, HinglishEvent } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { 
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { MurgaaDialog } from '@/components/narration/MurgaaDialog'
import { useToast } from '@/components/ui/use-toast'
import { useSocket } from '@/lib/socket'
import { LanguageTabs } from '@/components/LanguageTabs'
import { useNarrationLanguage, withLang } from '@/lib/narrationLanguage'
import {
  ArrowLeft,
  ArrowRight,
  Save,
  Wand2,
  Copy,
  Check,
  FolderOpen,
  Loader2,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  AlertTriangle,
  Flag,
  FileText,
  Sparkles,
  Bird,
  Languages
} from 'lucide-react'

export default function ScriptEditor() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { toast } = useToast()
  const { socket, narrationProgress: anyNarrationProgress } = useSocket()
  const [language, setLanguage] = useNarrationLanguage('narration')
  // Only this tab's language — the other one may be generating the same chapter.
  const narrationProgress =
    anyNarrationProgress && (anyNarrationProgress.language ?? 'en') === language ? anyNarrationProgress : null

  // Already rendered to video in this language — surfaced in the header so a
  // published chapter is not rewritten by mistake.
  const { isPublished } = usePublishedChapters(undefined, language)

  const [chapter, setChapter] = useState<ChapterScriptDetail | null>(null)
  const [aiStatus, setAIStatus] = useState<AIStatus | null>(null)
  const [murgaaOpen, setMurgaaOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [generating, setGenerating] = useState(false)
  
  // Editor state
  const [mode, setMode] = useState<'api' | 'manual'>('api')
  const [scriptContent, setScriptContent] = useState('')
  const [hasChanges, setHasChanges] = useState(false)
  
  // Manual mode
  const [manualPrompt, setManualPrompt] = useState<ManualPromptResponse | null>(null)
  const [manualResponse, setManualResponse] = useState('')
  const [copied, setCopied] = useState(false)

  // Continuity panel
  const [showContinuity, setShowContinuity] = useState(true)

  // Hinglish, from the English tab: API conversion, or copy the prompt and paste the reply
  const [converting, setConverting] = useState(false)
  const [hinglishReply, setHinglishReply] = useState('')
  const [hinglishIssues, setHinglishIssues] = useState<{ issues: string[]; followUp: string } | null>(null)
  const [submittingHinglish, setSubmittingHinglish] = useState(false)
  const [copiedHinglish, setCopiedHinglish] = useState<'prompt' | 'write' | 'fix' | null>(null)

  const manualStepsRef = useRef<HTMLDivElement>(null)

  // Radix keeps the inactive tab's panel mounted but `hidden`, so it has no
  // layout while API mode is showing. Effects — layout effects included — all run
  // before the browser unhides it and re-applies the scrollTop it remembered, so
  // zeroing synchronously does nothing. Wait a frame, once per chapter, and clear
  // it after that restore has landed.
  const scrollResetForChapter = useRef<string>()
  useEffect(() => {
    if (mode !== 'manual' || !id || scrollResetForChapter.current === id) return
    const frame = requestAnimationFrame(() => {
      const el = manualStepsRef.current
      if (!el || el.clientHeight === 0) return
      scrollResetForChapter.current = id
      el.scrollTop = 0
    })
    return () => cancelAnimationFrame(frame)
  }, [id, mode, loading])

  useEffect(() => {
    if (id) {
      // The manual prompt carries this language's continuity, so it is rebuilt.
      setManualPrompt(null)
      setManualResponse('')
      setHinglishReply('')
      setHinglishIssues(null)
      loadData()
    }
  }, [id, language])

  // This chapter's Hinglish conversion: refresh its status (and, on the Hindi
  // tab, the script unless it has unsaved edits) when it finishes.
  useEffect(() => {
    if (!socket || !id) return
    const handleHinglish = (event: HinglishEvent) => {
      if (event.chapterId !== id) return
      if (event.stage === 'done' || event.stage === 'review' || event.stage === 'failed') {
        if (language === 'hi' && !hasChanges) {
          loadChapter()
        } else {
          narrationApi.getChapterDetail(id, language)
            .then(data => setChapter(prev => (prev ? { ...prev, hinglish: data.hinglish } : data)))
            .catch(() => {})
        }
      } else {
        setChapter(prev => (prev ? { ...prev, hinglish: { ...prev.hinglish, queued: true } } : prev))
      }
    }
    socket.on('narration:hinglish', handleHinglish)
    return () => {
      socket.off('narration:hinglish', handleHinglish)
    }
  }, [socket, id, language, hasChanges])


  // Handle generation progress
  useEffect(() => {
    if (narrationProgress && narrationProgress.chapterId === id) {
      if (narrationProgress.stage === 'done') {
        setGenerating(false)
        loadChapter()
        toast({
          title: 'Script Generated',
          description: 'Your script is ready for review'
        })
      } else if (narrationProgress.stage === 'failed') {
        setGenerating(false)
        toast({
          title: 'Generation Failed',
          description: narrationProgress.error || 'Unknown error',
          variant: 'destructive'
        })
      }
    }
  }, [narrationProgress])

  const loadData = async () => {
    try {
      const [chapterData, aiData] = await Promise.all([
        narrationApi.getChapterDetail(id!, language),
        narrationApi.getAIStatus()
      ])
      setChapter(chapterData)
      setAIStatus(aiData)
      setScriptContent(chapterData.script?.content || '')
      setHasChanges(false)
      // Hindi has only the editor: its scripts are converted, never generated here.
      setMode(aiData.configured || language === 'hi' ? 'api' : 'manual')
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to load chapter',
        variant: 'destructive'
      })
    } finally {
      setLoading(false)
    }
  }

  const loadChapter = async () => {
    try {
      const data = await narrationApi.getChapterDetail(id!, language)
      setChapter(data)
      setScriptContent(data.script?.content || '')
      setHasChanges(false)
    } catch (error) {
      console.error('Failed to reload chapter:', error)
    }
  }

  const handleScriptChange = (value: string) => {
    setScriptContent(value)
    setHasChanges(true)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await narrationApi.saveScript(id!, language, scriptContent)
      setHasChanges(false)
      toast({
        title: 'Script Saved',
        description: 'Your changes have been saved'
      })
      loadChapter()
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to save script',
        variant: 'destructive'
      })
    } finally {
      setSaving(false)
    }
  }

  const handleGenerate = async () => {
    setGenerating(true)
    try {
      await narrationApi.generateScript(id!, language)
      toast({
        title: 'Generation Started',
        description: 'This may take a minute...'
      })
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to start generation',
        variant: 'destructive'
      })
      setGenerating(false)
    }
  }

  const handleLoadManualPrompt = async () => {
    try {
      const data = await narrationApi.getManualPrompt(id!, language)
      setManualPrompt(data)
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to load manual prompt',
        variant: 'destructive'
      })
    }
  }

  const handleCopyPrompt = async () => {
    if (!manualPrompt) return
    
    await navigator.clipboard.writeText(manualPrompt.prompt)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
    toast({
      title: 'Copied!',
      description: 'Prompt copied to clipboard'
    })
  }

  const handleSubmitManual = async () => {
    if (!manualResponse.trim()) {
      toast({
        title: 'Error',
        description: 'Please paste the AI response',
        variant: 'destructive'
      })
      return
    }

    setSaving(true)
    try {
      const result = await narrationApi.submitManualResult(id!, language, manualResponse)
      
      if (result.needsSummaryRegeneration) {
        toast({
          title: 'Script Saved',
          description: 'Summary/closing fields missing. Consider regenerating them.',
          variant: 'default'
        })
      } else {
        toast({
          title: 'Script Saved',
          description: 'Manual submission processed successfully'
        })
      }
      
      setManualResponse('')
      setMode('api')  // Switch to API tab to show the script
      loadChapter()
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to submit',
        variant: 'destructive'
      })
    } finally {
      setSaving(false)
    }
  }

  const handleRegenerateSummary = async () => {
    setSaving(true)
    try {
      await narrationApi.regenerateSummary(id!, language)
      toast({
        title: 'Summary Regenerated',
        description: 'Continuity metadata updated from current script'
      })
      loadChapter()
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to regenerate summary',
        variant: 'destructive'
      })
    } finally {
      setSaving(false)
    }
  }

  const handleTogglePartEnd = async () => {
    try {
      const result = await narrationApi.togglePartEnd(id!, language)
      toast({
        title: result.isPartEnd ? 'Marked as Part End' : 'Unmarked as Part End'
      })
      loadChapter()
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to toggle part end',
        variant: 'destructive'
      })
    }
  }

  const handleGenerateOutro = async () => {
    setGenerating(true)
    try {
      const result = await narrationApi.generateOutro(id!, language)
      if (result.success) {
        toast({
          title: 'Outro Generated',
          description: 'Part outro has been created'
        })
        loadChapter()
      }
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to generate outro',
        variant: 'destructive'
      })
    } finally {
      setGenerating(false)
    }
  }

  /** Queue this chapter's Hinglish conversion (API mode), whatever its status. */
  const handleConvertHinglish = async () => {
    setConverting(true)
    try {
      await narrationApi.convertHinglishChapter(id!)
      setChapter(prev => (prev ? { ...prev, hinglish: { ...prev.hinglish, queued: true } } : prev))
      toast({ title: 'Converting to Hinglish', description: 'The Hindi tab gets the script when it is done' })
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to queue the conversion',
        variant: 'destructive'
      })
    } finally {
      setConverting(false)
    }
  }

  const copyText = async (text: string, which: 'prompt' | 'write' | 'fix') => {
    await navigator.clipboard.writeText(text)
    setCopiedHinglish(which)
    setTimeout(() => setCopiedHinglish(null), 2000)
    const description = {
      prompt: 'Step 1 copied - paste it into a new chat',
      write: 'Step 2 copied - paste it into the same chat',
      fix: 'Fix prompt copied'
    }[which]
    toast({ title: 'Copied!', description })
  }

  /** Step 1 (scene notes) opens the chat; step 2 (write) follows in the same chat. */
  const handleCopyHinglishPrompt = async (step: 'prompt' | 'write') => {
    try {
      const prompts = await narrationApi.getHinglishPrompt(id!)
      await copyText(step === 'prompt' ? prompts.prompt : prompts.writePrompt, step)
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to build the Hinglish prompt',
        variant: 'destructive'
      })
    }
  }

  /** Check the pasted reply; it is saved if it passes, or with `force` marked for review. */
  const handleSubmitHinglish = async (force: boolean) => {
    setSubmittingHinglish(true)
    try {
      const result = await narrationApi.submitHinglish(id!, hinglishReply, force)
      if (!result.saved) {
        setHinglishIssues({ issues: result.issues, followUp: result.followUp ?? '' })
        return
      }
      setHinglishIssues(null)
      setHinglishReply('')
      toast({
        title: 'Hinglish Saved',
        description: result.issues.length > 0
          ? 'Saved as needing review - it shows on the Hindi tab'
          : 'Passed the check - it is on the Hindi tab'
      })
      const data = await narrationApi.getChapterDetail(id!, language)
      setChapter(prev => (prev ? { ...prev, hinglish: data.hinglish } : data))
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to save the Hinglish script',
        variant: 'destructive'
      })
    } finally {
      setSubmittingHinglish(false)
    }
  }

  const handleOpenFolder = async () => {
    if (!chapter) return
    try {
      await narrationApi.openFolder(chapter.folderPath)
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to open folder',
        variant: 'destructive'
      })
    }
  }

  const getProgressLabel = () => {
    if (!narrationProgress || narrationProgress.chapterId !== id) return null
    
    const stage = narrationProgress.stage
    if (stage === 'preprocessing') {
      return `Preprocessing images... ${narrationProgress.preprocessPercent || 0}%`
    } else if (stage === 'extracting-beats') {
      return `Extracting beats (batch ${narrationProgress.batchCurrent}/${narrationProgress.batchTotal})`
    } else if (stage === 'generating-script') {
      return 'Generating script...'
    } else if (stage === 'generating-summary') {
      return 'Creating summary...'
    } else if (stage === 'saving') {
      return 'Saving...'
    }
    return 'Processing...'
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  if (!chapter) {
    return (
      <div className="p-6 text-center">
        <h2 className="text-xl font-semibold">Chapter not found</h2>
        <Button variant="link" onClick={() => navigate(withLang('/narration', language))}>
          Return to Library
        </Button>
      </div>
    )
  }

  const isHindi = language === 'hi'
  const hinglish = chapter.hinglish
  const hinglishLabel: Record<typeof hinglish.state, string> = {
    waiting: 'Waiting for the English script',
    pending: 'Not converted yet',
    stale: 'Stale - the English changed since it was converted',
    review: 'Needs review',
    done: 'Done',
    failed: 'Conversion failed'
  }
  const canGenerate = chapter.imagesValid && aiStatus?.configured && !generating && !hasChanges
  const isGenerating = generating || (narrationProgress?.chapterId === id && narrationProgress?.stage !== 'done' && narrationProgress?.stage !== 'failed')

  return (
    <div className="p-6 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-start gap-4 mb-4">
        <Button variant="ghost" size="icon" onClick={() => navigate(withLang(`/narration/series/${chapter.seriesId}`, language))}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold">
              {chapter.seriesTitle} - Chapter {chapter.number}
            </h1>
            {/* Locked with unsaved edits, like Prev/Next, so they aren't lost */}
            <LanguageTabs value={language} onChange={setLanguage} disabled={hasChanges} />
          </div>
          {chapter.title && (
            <p className="text-muted-foreground">{chapter.title}</p>
          )}
        </div>

        <div className="flex items-center gap-2">
          {id && isPublished(id) && <PublishedBadge />}
          {hasChanges && (
            <Badge variant="outline" className="text-yellow-500 border-yellow-500">
              Unsaved
            </Badge>
          )}
          
          <Button variant="outline" onClick={handleOpenFolder}>
            <FolderOpen className="h-4 w-4 mr-2" />
            Images
          </Button>
          
          <Button 
            onClick={handleSave} 
            disabled={!hasChanges || saving}
          >
            {saving ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            Save
          </Button>
          
          <Button variant="outline" onClick={() => setMurgaaOpen(true)}>
            <Bird className="h-4 w-4 mr-2" />
            Murgaa
          </Button>

          <Button variant="outline" onClick={() => window.open('https://aistudio.google.com', '_blank', 'noopener,noreferrer')}>
            <Sparkles className="h-4 w-4 mr-2" />
            Gemini AI Studio
          </Button>

          {/* Chapter Navigation */}
          <div className="flex items-center gap-1 ml-2 border-l pl-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => chapter.prevChapterId && navigate(withLang(`/narration/chapter/${chapter.prevChapterId}`, language))}
              disabled={!chapter.prevChapterId || hasChanges}
              title={chapter.prevChapterId ? `Go to Chapter ${chapter.prevChapterNumber}` : 'No previous chapter'}
            >
              <ArrowLeft className="h-4 w-4 mr-1" />
              Prev
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => chapter.nextChapterId && navigate(withLang(`/narration/chapter/${chapter.nextChapterId}`, language))}
              disabled={!chapter.nextChapterId || hasChanges}
              title={chapter.nextChapterId ? `Go to Chapter ${chapter.nextChapterNumber}` : 'No next chapter'}
            >
              Next
              <ArrowRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        </div>
      </div>

      <MurgaaDialog scope="script" open={murgaaOpen} onOpenChange={setMurgaaOpen} />

      {/* Image validation warning */}
      {!chapter.imagesValid && (
        <Card className="mb-4 border-destructive">
          <CardContent className="py-3">
            <div className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              <span>{chapter.imageError || 'Chapter images not available'}</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Hindi: where this Hinglish script stands against its English one */}
      {isHindi && hinglish.queued && (
        <Card className="mb-4">
          <CardContent className="py-3">
            <div className="flex items-center gap-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Converting the English script to Hinglish...
            </div>
          </CardContent>
        </Card>
      )}
      {isHindi && !hinglish.queued && hinglish.state !== 'done' && (
        <Card className={`mb-4 ${hinglish.state === 'failed' ? 'border-destructive' : 'border-yellow-500'}`}>
          <CardContent className="py-3">
            <div className="flex items-start gap-2 text-yellow-600">
              <AlertTriangle className="h-5 w-5 mt-0.5 shrink-0" />
              <div className="flex-1 space-y-1 text-sm">
                {hinglish.state === 'review' && (
                  <>
                    <p className="font-medium">Saved even though it failed the check - review it. Saving your edits clears this.</p>
                    {hinglish.review?.map(line => <p key={line} className="text-xs">{line}</p>)}
                  </>
                )}
                {hinglish.state === 'stale' && (
                  <p>The English script changed after this was converted. Convert it again from the English tab.</p>
                )}
                {(hinglish.state === 'pending' || hinglish.state === 'failed') && (
                  <p>No Hinglish script yet. Hindi scripts are converted from the English one, on the English tab.</p>
                )}
                {hinglish.state === 'waiting' && (
                  <p>No English script yet. Generate it on the English tab; it is converted to Hinglish after.</p>
                )}
                {hinglish.error && <p className="text-xs text-destructive">Last conversion failed: {hinglish.error}</p>}
              </div>
              {hinglish.state !== 'review' && (
                <Button variant="outline" size="sm" onClick={() => setLanguage('en')} disabled={hasChanges}>
                  English tab
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Stale warning (English continuity; Hindi chapters don't chain) */}
      {!isHindi && chapter.script?.status === 'stale' && (
        <Card className="mb-4 border-yellow-500">
          <CardContent className="py-3">
            <div className="flex items-center gap-2 text-yellow-600">
              <AlertTriangle className="h-5 w-5" />
              <span>This script's continuity may be outdated. A previous chapter was edited.</span>
              <Button variant="outline" size="sm" onClick={handleRegenerateSummary}>
                <RefreshCw className="h-4 w-4 mr-1" />
                Regenerate Summary
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex-1 flex gap-4 min-h-0">
        {/* Main Editor Area */}
        <div className="flex-1 flex flex-col min-h-0">
          <Tabs value={isHindi ? 'api' : mode} onValueChange={(v: string) => setMode(v as 'api' | 'manual')} className="flex-1 flex flex-col min-h-0">
            {!isHindi && (
              <TabsList className="mb-4">
                <TabsTrigger value="api" disabled={!aiStatus?.configured}>
                  <Wand2 className="h-4 w-4 mr-2" />
                  API Mode
                </TabsTrigger>
                <TabsTrigger value="manual">
                  <FileText className="h-4 w-4 mr-2" />
                  Manual Mode
                </TabsTrigger>
              </TabsList>
            )}

            <TabsContent value="api" className="flex-1 flex flex-col min-h-0 mt-0">
              <Card className="flex-1 flex flex-col min-h-0">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-lg">{isHindi ? 'Hinglish Script' : 'Script'}</CardTitle>

                    {/* Generating is English only; Hindi is converted from it */}
                    {!isHindi && (
                    <div className="flex items-center gap-2">
                      {isGenerating && (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          {getProgressLabel()}
                        </div>
                      )}
                      
                      <Button
                        onClick={handleGenerate}
                        disabled={!canGenerate || isGenerating}
                        variant={chapter.script?.content ? 'outline' : 'default'}
                      >
                        {isGenerating ? (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        ) : (
                          <Sparkles className="h-4 w-4 mr-2" />
                        )}
                        {chapter.script?.content ? 'Regenerate' : 'Generate'}
                      </Button>
                    </div>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="flex-1 min-h-0">
                  <Textarea
                    value={scriptContent}
                    onChange={(e) => handleScriptChange(e.target.value)}
                    placeholder={isHindi
                      ? 'The Hinglish script appears here once the English one is converted...'
                      : 'Script will appear here after generation...'}
                    className="h-full min-h-[300px] font-mono text-sm resize-none"
                  />
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent ref={manualStepsRef} value="manual" className="flex-1 min-h-0 mt-0 overflow-y-auto space-y-4 pr-1">
              {/* Step 1: Get prompt */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg">Step 1: Copy Prompt</CardTitle>
                  <CardDescription>
                    Copy this prompt and paste it into your AI chat (ChatGPT, Claude, etc.)
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {!manualPrompt ? (
                    <Button onClick={handleLoadManualPrompt}>
                      Load Prompt
                    </Button>
                  ) : (
                    <div className="space-y-3">
                      <div className="relative">
                        <Textarea
                          value={manualPrompt.prompt}
                          readOnly
                          className="h-32 font-mono text-xs pr-20"
                        />
                        <Button
                          size="sm"
                          className="absolute top-2 right-2"
                          onClick={handleCopyPrompt}
                        >
                          {copied ? (
                            <Check className="h-4 w-4" />
                          ) : (
                            <Copy className="h-4 w-4" />
                          )}
                        </Button>
                      </div>
                      
                      <div className="text-sm">
                        <p className="font-medium mb-1">Attach these images ({manualPrompt.imageFiles.length} files):</p>
                        <p className="text-muted-foreground text-xs truncate">
                          {manualPrompt.folderPath}
                        </p>
                        <Button
                          variant="link"
                          size="sm"
                          className="p-0 h-auto"
                          onClick={handleOpenFolder}
                        >
                          Open folder
                        </Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Step 2: Paste response */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg">Step 2: Paste AI Response</CardTitle>
                  <CardDescription>
                    Paste the complete response from the AI here
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <Textarea
                    value={manualResponse}
                    onChange={(e) => setManualResponse(e.target.value)}
                    placeholder="Paste the AI response here..."
                    className="min-h-[200px] font-mono text-sm"
                  />
                  <Button
                    onClick={handleSubmitManual}
                    disabled={!manualResponse.trim() || saving}
                  >
                    {saving ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Check className="h-4 w-4 mr-2" />
                    )}
                    Submit & Save
                  </Button>
                </CardContent>
              </Card>

              {/* Step 3: Hinglish, converted from the saved English script */}
              {chapter.script?.content && (
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-lg">Step 3: Hinglish</CardTitle>
                    <CardDescription>
                      Two steps in one AI chat: step 1 (it holds the saved English script) gets scene notes, step 2
                      gets the narration written from them in its own words. Paste the step 2 reply here; it is checked
                      before it is saved to the Hindi tab.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center gap-3">
                      <Button variant="outline" onClick={() => handleCopyHinglishPrompt('prompt')} disabled={hasChanges}>
                        {copiedHinglish === 'prompt' ? <Check className="h-4 w-4 mr-2" /> : <Copy className="h-4 w-4 mr-2" />}
                        Copy step 1 (scene notes)
                      </Button>
                      <Button variant="outline" onClick={() => handleCopyHinglishPrompt('write')} disabled={hasChanges}>
                        {copiedHinglish === 'write' ? <Check className="h-4 w-4 mr-2" /> : <Copy className="h-4 w-4 mr-2" />}
                        Copy step 2 (write)
                      </Button>
                      <span className="text-sm text-muted-foreground">
                        {hasChanges ? 'Save the English script first' : `Hindi: ${hinglishLabel[hinglish.state]}`}
                      </span>
                    </div>
                    <Textarea
                      value={hinglishReply}
                      onChange={(e) => {
                        setHinglishReply(e.target.value)
                        setHinglishIssues(null)
                      }}
                      placeholder="Paste the step 2 reply here (===SCRIPT=== with [SCENE 1: P1-P4], [SCENE 2: ...] ... then ===SUMMARY===)..."
                      className="min-h-[160px] font-mono text-sm"
                      lang="hi"
                    />
                    {hinglishIssues && (
                      <div className="rounded-md border border-amber-500 p-3 text-sm space-y-2">
                        <p className="font-medium text-amber-600 flex items-center gap-1">
                          <AlertTriangle className="h-4 w-4" />
                          The reply did not pass the check:
                        </p>
                        <ul className="list-disc pl-5 text-xs space-y-0.5">
                          {hinglishIssues.issues.map(line => <li key={line}>{line}</li>)}
                        </ul>
                        <div className="flex flex-wrap gap-2 pt-1">
                          <Button size="sm" variant="outline" onClick={() => copyText(hinglishIssues.followUp, 'fix')}>
                            {copiedHinglish === 'fix' ? <Check className="h-4 w-4 mr-2" /> : <Copy className="h-4 w-4 mr-2" />}
                            Copy fix prompt
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="border-amber-500 text-amber-600"
                            onClick={() => handleSubmitHinglish(true)}
                            disabled={submittingHinglish}
                          >
                            Save anyway (needs review)
                          </Button>
                        </div>
                      </div>
                    )}
                    <Button
                      onClick={() => handleSubmitHinglish(false)}
                      disabled={!hinglishReply.trim() || submittingHinglish || hasChanges}
                    >
                      {submittingHinglish ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Check className="h-4 w-4 mr-2" />}
                      Check & Save Hinglish
                    </Button>
                  </CardContent>
                </Card>
              )}

            </TabsContent>
          </Tabs>
        </div>

        {/* Side Panel */}
        <div className="w-80 space-y-4">
          {/* Hinglish (English tab): the converted script's status, and converting it */}
          {!isHindi && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Languages className="h-4 w-4" />
                  Hinglish
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm">
                  {hinglish.queued ? (
                    <span className="flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Converting...
                    </span>
                  ) : (
                    hinglishLabel[hinglish.state]
                  )}
                </p>
                {hinglish.state === 'review' && hinglish.review && (
                  <div className="text-xs text-amber-600 space-y-0.5">
                    {hinglish.review.map(line => <p key={line}>{line}</p>)}
                  </div>
                )}
                {hinglish.error && <p className="text-xs text-destructive">Last attempt: {hinglish.error}</p>}
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={handleConvertHinglish}
                  disabled={converting || hinglish.queued || hinglish.state === 'waiting' || hasChanges || !aiStatus?.configured}
                >
                  {converting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Languages className="h-4 w-4 mr-2" />}
                  {hinglish.state === 'pending' || hinglish.state === 'failed' ? 'Convert to Hinglish' : 'Convert again'}
                </Button>
                <p className="text-xs text-muted-foreground">
                  New English scripts convert by themselves. Manual mode has the Hinglish step 1 and step 2 prompts.
                </p>
              </CardContent>
            </Card>
          )}

          {/* Continuity Panel (what generating reads; Hindi isn't generated) */}
          {!isHindi && (
          <Collapsible open={showContinuity} onOpenChange={setShowContinuity}>
            <Card>
              <CollapsibleTrigger asChild>
                <CardHeader className="pb-3 cursor-pointer hover:bg-accent rounded-t-lg">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">Continuity Context</CardTitle>
                    {showContinuity ? (
                      <ChevronUp className="h-4 w-4" />
                    ) : (
                      <ChevronDown className="h-4 w-4" />
                    )}
                  </div>
                </CardHeader>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CardContent className="space-y-4">
                  {chapter.number === 1 ? (
                    <p className="text-sm text-muted-foreground">
                      This is Chapter 1. The script will start the story from the beginning.
                    </p>
                  ) : (
                    <>
                      {chapter.previousContext ? (
                        <>
                          <div>
                            <Label className="text-xs font-medium text-muted-foreground">
                              Story So Far (from Ch. {chapter.previousContext.chapterNumber})
                            </Label>
                            <p className="text-sm mt-1 line-clamp-4">
                              {chapter.previousContext.rollingSummary || 'Not yet generated'}
                            </p>
                          </div>
                          <Separator />
                          <div>
                            <Label className="text-xs font-medium text-muted-foreground">
                              Continuing From
                            </Label>
                            <p className="text-sm mt-1 italic line-clamp-3">
                              "{chapter.previousContext.closingParagraph || 'Not yet generated'}"
                            </p>
                          </div>
                        </>
                      ) : (
                        <div className="text-sm text-yellow-600">
                          <AlertTriangle className="h-4 w-4 inline mr-1" />
                          Previous chapter not scripted. Generate chapters in order.
                        </div>
                      )}
                    </>
                  )}
                  
                  {chapter.aboutSummary && (
                    <>
                      <Separator />
                      <div>
                        <Label className="text-xs font-medium text-muted-foreground">
                          About This Manhwa
                        </Label>
                        <p className="text-sm mt-1 line-clamp-3">
                          {chapter.aboutSummary}
                        </p>
                      </div>
                    </>
                  )}
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>
          )}

          {/* Summary Actions */}
          {chapter.script?.content && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Continuity</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={handleRegenerateSummary}
                  disabled={saving || !aiStatus?.configured}
                >
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Regenerate Summary
                </Button>
                <p className="text-xs text-muted-foreground">
                  Re-generates the rolling summary and closing paragraph from the current script.
                </p>
              </CardContent>
            </Card>
          )}

          {/* Part End Toggle */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Part Controls</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>End of Part</Label>
                  <p className="text-xs text-muted-foreground">
                    Mark this chapter as a Part ending
                  </p>
                </div>
                <Switch
                  checked={chapter.script?.isPartEnd || false}
                  onCheckedChange={handleTogglePartEnd}
                />
              </div>

              {chapter.script?.isPartEnd && (
                <>
                  <Separator />
                  <div className="space-y-2">
                    <Label>Part Outro</Label>
                    {chapter.script?.outroContent ? (
                      <p className="text-sm line-clamp-3">
                        {chapter.script.outroContent}
                      </p>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        No outro generated yet
                      </p>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      onClick={handleGenerateOutro}
                      disabled={generating || !chapter.script?.rollingSummary || !aiStatus?.configured}
                    >
                      {generating ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Flag className="h-4 w-4 mr-2" />
                      )}
                      {chapter.script?.outroContent ? 'Regenerate' : 'Generate'} Outro
                    </Button>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* Chapter Info */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Info</CardTitle>
            </CardHeader>
            <CardContent className="text-sm space-y-2">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Images</span>
                <span>{chapter.imageCount}</span>
              </div>
              {chapter.script?.tokensUsed && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Tokens Used</span>
                  <span>{chapter.script.tokensUsed.toLocaleString()}</span>
                </div>
              )}
              {chapter.script?.updatedAt && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Last Updated</span>
                  <span>{new Date(chapter.script.updatedAt).toLocaleDateString()}</span>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
