/**
 * Script Editor Page
 * 
 * The main workspace for generating and editing narration scripts.
 * Supports both API mode and Manual mode.
 */

import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { narrationApi, clipper2Api, ChapterScriptDetail, ManualPromptResponse, AIStatus } from '@/lib/api'
import { CopyPointerPromptButton, PointerJsonDrop } from '@/components/clipper2/PointerImport'
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
import { useToast } from '@/components/ui/use-toast'
import { useSocket } from '@/lib/socket'
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
  Locate,
  FileJson,
  Scissors
} from 'lucide-react'

export default function ScriptEditor() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { toast } = useToast()
  const { narrationProgress } = useSocket()

  const [chapter, setChapter] = useState<ChapterScriptDetail | null>(null)
  const [aiStatus, setAIStatus] = useState<AIStatus | null>(null)
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

  // Manual mode, steps 3-4: crop pointers. Only the count is held here — the
  // pointers themselves belong to Image Clipper 2.0, and this page links out to it
  // rather than growing a second viewer.
  const [pointerCropCount, setPointerCropCount] = useState<number | null>(null)

  // Continuity panel
  const [showContinuity, setShowContinuity] = useState(true)

  useEffect(() => {
    if (id) {
      loadData()
    }
  }, [id])

  // Best-effort: a chapter with no pointer file is the normal case, so a failure
  // here just means "none yet" rather than an error worth showing.
  useEffect(() => {
    if (!id) return
    let cancelled = false
    clipper2Api
      .getPoints(id)
      .then(set => {
        if (!cancelled) setPointerCropCount(set.file?.crops.length ?? null)
      })
      .catch(() => {
        if (!cancelled) setPointerCropCount(null)
      })
    return () => {
      cancelled = true
    }
  }, [id])

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
        narrationApi.getChapterDetail(id!),
        narrationApi.getAIStatus()
      ])
      setChapter(chapterData)
      setAIStatus(aiData)
      setScriptContent(chapterData.script?.content || '')
      setMode(aiData.configured ? 'api' : 'manual')
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
      const data = await narrationApi.getChapterDetail(id!)
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
      await narrationApi.saveScript(id!, scriptContent)
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
      await narrationApi.generateScript(id!)
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
      const data = await narrationApi.getManualPrompt(id!)
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
      const result = await narrationApi.submitManualResult(id!, manualResponse)
      
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
      await narrationApi.regenerateSummary(id!)
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
      const result = await narrationApi.togglePartEnd(id!)
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
      const result = await narrationApi.generateOutro(id!)
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
        <Button variant="link" onClick={() => navigate('/narration')}>
          Return to Library
        </Button>
      </div>
    )
  }

  const canGenerate = chapter.imagesValid && aiStatus?.configured && !generating && !hasChanges
  const isGenerating = generating || (narrationProgress?.chapterId === id && narrationProgress?.stage !== 'done' && narrationProgress?.stage !== 'failed')

  return (
    <div className="p-6 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-start gap-4 mb-4">
        <Button variant="ghost" size="icon" onClick={() => navigate(`/narration/series/${chapter.seriesId}`)}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        
        <div className="flex-1">
          <h1 className="text-2xl font-bold">
            {chapter.seriesTitle} - Chapter {chapter.number}
          </h1>
          {chapter.title && (
            <p className="text-muted-foreground">{chapter.title}</p>
          )}
        </div>

        <div className="flex items-center gap-2">
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
          
          {/* Chapter Navigation */}
          <div className="flex items-center gap-1 ml-2 border-l pl-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => chapter.prevChapterId && navigate(`/narration/chapter/${chapter.prevChapterId}`)}
              disabled={!chapter.prevChapterId || hasChanges}
              title={chapter.prevChapterId ? `Go to Chapter ${chapter.prevChapterNumber}` : 'No previous chapter'}
            >
              <ArrowLeft className="h-4 w-4 mr-1" />
              Prev
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => chapter.nextChapterId && navigate(`/narration/chapter/${chapter.nextChapterId}`)}
              disabled={!chapter.nextChapterId || hasChanges}
              title={chapter.nextChapterId ? `Go to Chapter ${chapter.nextChapterNumber}` : 'No next chapter'}
            >
              Next
              <ArrowRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        </div>
      </div>

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

      {/* Stale warning */}
      {chapter.script?.status === 'stale' && (
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
          <Tabs value={mode} onValueChange={(v: string) => setMode(v as 'api' | 'manual')} className="flex-1 flex flex-col min-h-0">
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

            <TabsContent value="api" className="flex-1 flex flex-col min-h-0 mt-0">
              <Card className="flex-1 flex flex-col min-h-0">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-lg">Script</CardTitle>
                    
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
                  </div>
                </CardHeader>
                <CardContent className="flex-1 min-h-0">
                  <Textarea
                    value={scriptContent}
                    onChange={(e) => handleScriptChange(e.target.value)}
                    placeholder="Script will appear here after generation..."
                    className="h-full min-h-[300px] font-mono text-sm resize-none"
                  />
                </CardContent>
              </Card>
            </TabsContent>

            {/* Four steps, one chat session: the pages are attached once at Step 1 and
                Step 3 reuses that same conversation, which is why the pointer prompt
                can say "the same above chapter" and carry no images of its own. */}
            <TabsContent value="manual" className="flex-1 min-h-0 mt-0 overflow-y-auto space-y-4 pr-1">
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

              <Separator />

              {/* Step 3: Crop pointers — same chat, same pages, different question. */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Locate className="h-4 w-4" />
                    Step 3: Copy Pointer Prompt
                  </CardTitle>
                  <CardDescription>
                    In the <strong>same chat</strong> — the chapter's pages are already attached from
                    Step 1 — paste this to get the crop pointers back as JSON.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <CopyPointerPromptButton />
                  <p className="text-xs text-muted-foreground">
                    This sends your Crop Detection Guidelines verbatim. Edit them in{' '}
                    <Button
                      variant="link"
                      size="sm"
                      className="p-0 h-auto text-xs"
                      onClick={() => navigate('/settings')}
                    >
                      Settings → Crop Pointers
                    </Button>
                    .
                  </p>
                </CardContent>
              </Card>

              {/* Step 4: Bring the JSON back */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg flex items-center gap-2">
                    <FileJson className="h-4 w-4" />
                    Step 4: Attach the Pointer JSON
                  </CardTitle>
                  <CardDescription>
                    Drop the AI's <code className="text-xs">crop_points.json</code> here — or paste its
                    raw reply. Near-miss edges, id order and reason casing are repaired on import, and
                    every change is listed.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {id && (
                    <PointerJsonDrop
                      chapterId={id}
                      hasExistingPoints={pointerCropCount !== null && pointerCropCount > 0}
                      onImported={set => setPointerCropCount(set.file?.crops.length ?? 0)}
                    />
                  )}

                  <div className="flex items-center justify-between gap-3 pt-1">
                    <p className="text-xs text-muted-foreground">
                      {pointerCropCount === null
                        ? 'No pointers imported for this chapter yet.'
                        : `This chapter has ${pointerCropCount} pointer${pointerCropCount === 1 ? '' : 's'} on file.`}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => navigate(`/clipper2/chapter/${id}`)}
                    >
                      <Scissors className="h-4 w-4 mr-2" />
                      Check in Image Clipper 2.0
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>

        {/* Side Panel */}
        <div className="w-80 space-y-4">
          {/* Continuity Panel */}
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
