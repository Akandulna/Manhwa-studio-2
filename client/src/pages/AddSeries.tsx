import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { seriesApi, PatternResult, DiscoveredChapter, QuickValidationResult } from '@/lib/api'
import { useSocket } from '@/lib/socket'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useToast } from '@/components/ui/use-toast'
import { 
  Search, 
  Loader2, 
  Check, 
  X, 
  AlertTriangle,
  Link as LinkIcon,
  BookOpen,
  List,
  CheckCircle,
  Upload,
  SkipForward
} from 'lucide-react'

type Mode = 'pattern' | 'manual'
type Step = 'urls' | 'pattern' | 'range' | 'chapters' | 'confirm'

export default function AddSeries() {
  const navigate = useNavigate()
  const { toast } = useToast()
  const { discoveryProgress } = useSocket()
  
  const [mode, setMode] = useState<Mode>('pattern')
  const [step, setStep] = useState<Step>('urls')
  const [loading, setLoading] = useState(false)
  
  // Form state
  const [seedUrls, setSeedUrls] = useState(['', '', ''])
  const [manualUrls, setManualUrls] = useState('')
  const [title, setTitle] = useState('')
  const [pattern, setPattern] = useState<PatternResult | null>(null)
  const [editedTemplate, setEditedTemplate] = useState('')
  const [chapters, setChapters] = useState<DiscoveredChapter[]>([])
  const [selectedChapters, setSelectedChapters] = useState<Set<number>>(new Set())
  const [sourceSite, setSourceSite] = useState('')
  
  // Range state
  const [patternValidated, setPatternValidated] = useState(false)
  const [validationResult, setValidationResult] = useState<QuickValidationResult | null>(null)
  const [fromChapter, setFromChapter] = useState('1')
  const [toChapter, setToChapter] = useState('20')
  
  const handleInferPattern = async () => {
    const urls = seedUrls.filter(u => u.trim())
    
    if (urls.length < 2) {
      toast({
        title: 'Error',
        description: 'Please enter at least 2 seed URLs',
        variant: 'destructive'
      })
      return
    }
    
    setLoading(true)
    
    try {
      const result = await seriesApi.inferPattern(urls)
      setPattern(result)
      setEditedTemplate(result.template)
      setSourceSite(result.sourceSite || '')
      
      if (result.suggestedTitle && !title) {
        setTitle(result.suggestedTitle)
      }
      
      if (result.confidence === 'low') {
        toast({
          title: 'Pattern Detection',
          description: result.message || 'Low confidence in detected pattern. Please verify or edit.',
          variant: 'destructive'
        })
      }
      
      setStep('pattern')
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to detect pattern',
        variant: 'destructive'
      })
    } finally {
      setLoading(false)
    }
  }
  
  const handleValidatePattern = async () => {
    setLoading(true)
    
    try {
      const result = await seriesApi.validatePattern({
        template: editedTemplate,
        startNumber: pattern?.startNumber || 1,
        padding: pattern?.padding || 0
      })
      
      setValidationResult(result)
      setPatternValidated(result.isValid)
      
      if (result.isValid) {
        setFromChapter(String(result.firstChapter || 1))
        toast({
          title: 'Pattern Validated',
          description: result.message
        })
        setStep('range')
      } else {
        toast({
          title: 'Validation Failed',
          description: result.message,
          variant: 'destructive'
        })
      }
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to validate pattern',
        variant: 'destructive'
      })
    } finally {
      setLoading(false)
    }
  }
  
  const handleDiscoverChapters = async () => {
    setLoading(true)
    setChapters([])
    
    try {
      let result
      
      if (mode === 'manual') {
        const urls = manualUrls.split('\n').map(u => u.trim()).filter(Boolean)
        if (urls.length === 0) {
          throw new Error('Please enter at least one URL')
        }
        result = await seriesApi.discoverChapters({ manualUrls: urls })
      } else {
        if (!editedTemplate || !editedTemplate.includes('{n}')) {
          throw new Error('Invalid URL template')
        }
        
        const from = parseInt(fromChapter) || 1
        const to = parseInt(toChapter) || from + 19
        
        if (to < from) {
          throw new Error('End chapter must be greater than or equal to start chapter')
        }
        
        if (to - from > 200) {
          throw new Error('Maximum 200 chapters at once. Add chapters in smaller batches.')
        }
        
        result = await seriesApi.discoverChapters({
          template: editedTemplate,
          fromChapter: from,
          toChapter: to,
          padding: pattern?.padding || 0
        })
      }
      
      setChapters(result.chapters)
      setSelectedChapters(new Set(result.chapters.map(c => c.number)))
      setStep('chapters')
      
      toast({
        title: 'Discovery Complete',
        description: `Found ${result.chapters.length} chapters`
      })
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to discover chapters',
        variant: 'destructive'
      })
    } finally {
      setLoading(false)
    }
  }
  
  const handleSelectRange = (start: number, end: number) => {
    const newSelected = new Set<number>()
    chapters.forEach(c => {
      if (c.number >= start && c.number <= end) {
        newSelected.add(c.number)
      }
    })
    setSelectedChapters(newSelected)
  }
  
  const handleToggleChapter = (num: number) => {
    const newSelected = new Set(selectedChapters)
    if (newSelected.has(num)) {
      newSelected.delete(num)
    } else {
      newSelected.add(num)
    }
    setSelectedChapters(newSelected)
  }
  
  const handleSelectAll = () => {
    setSelectedChapters(new Set(chapters.map(c => c.number)))
  }
  
  const handleSelectNone = () => {
    setSelectedChapters(new Set())
  }
  
  const handleCreateSeries = async () => {
    if (!title.trim()) {
      toast({
        title: 'Error',
        description: 'Please enter a series title',
        variant: 'destructive'
      })
      return
    }
    
    if (selectedChapters.size === 0) {
      toast({
        title: 'Error',
        description: 'Please select at least one chapter',
        variant: 'destructive'
      })
      return
    }
    
    setLoading(true)
    
    try {
      const chaptersToAdd = chapters
        .filter(c => selectedChapters.has(c.number))
        .map(c => ({
          number: c.number,
          url: c.url,
          title: c.title
        }))
      
      const series = await seriesApi.create({
        title: title.trim(),
        sourceSite,
        urlTemplate: mode === 'pattern' ? editedTemplate : undefined,
        chapters: chaptersToAdd
      })
      
      toast({
        title: 'Success',
        description: `Created "${series.title}" with ${chaptersToAdd.length} chapters`
      })
      
      navigate(`/series/${series.id}`)
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to create series',
        variant: 'destructive'
      })
    } finally {
      setLoading(false)
    }
  }
  
  const renderUrlStep = () => (
    <Card>
      <CardHeader>
        <CardTitle>Add New Series</CardTitle>
        <CardDescription>
          Enter seed URLs to detect the chapter pattern, or manually paste a list of chapter URLs
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Mode selection */}
        <div className="flex gap-4">
          <Button
            variant={mode === 'pattern' ? 'default' : 'outline'}
            onClick={() => setMode('pattern')}
            className="flex-1"
          >
            <LinkIcon className="h-4 w-4 mr-2" />
            Auto-Detect Pattern
          </Button>
          <Button
            variant={mode === 'manual' ? 'default' : 'outline'}
            onClick={() => setMode('manual')}
            className="flex-1"
          >
            <List className="h-4 w-4 mr-2" />
            Manual URL List
          </Button>
        </div>
        
        {/* Manual upload option */}
        <div className="p-4 rounded-lg bg-muted/50 border border-dashed">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">URL detection not working?</p>
              <p className="text-xs text-muted-foreground">
                Create folders manually and upload images directly
              </p>
            </div>
            <Button 
              variant="outline" 
              size="sm"
              onClick={() => navigate('/add/manual')}
            >
              <Upload className="h-4 w-4 mr-2" />
              Manual Upload
            </Button>
          </div>
        </div>
        
        {/* Title field */}
        <div className="space-y-2">
          <Label htmlFor="title">Series Title (optional - will auto-detect)</Label>
          <Input
            id="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g., Solo Leveling"
          />
        </div>
        
        {mode === 'pattern' ? (
          <>
            <div className="space-y-4">
              <Label>Seed URLs (enter 3 consecutive chapter URLs)</Label>
              {seedUrls.map((url, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground w-20">
                    Chapter {i + 1}:
                  </span>
                  <Input
                    value={url}
                    onChange={(e) => {
                      const newUrls = [...seedUrls]
                      newUrls[i] = e.target.value
                      setSeedUrls(newUrls)
                    }}
                    placeholder={`https://example.com/manga/series-name/chapter-${i + 1}`}
                  />
                </div>
              ))}
            </div>
            
            <Button 
              onClick={handleInferPattern}
              disabled={loading || seedUrls.filter(u => u.trim()).length < 2}
              className="w-full"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Search className="h-4 w-4 mr-2" />
              )}
              Detect Pattern
            </Button>
          </>
        ) : (
          <>
            <div className="space-y-2">
              <Label htmlFor="manual-urls">Chapter URLs (one per line)</Label>
              <textarea
                id="manual-urls"
                value={manualUrls}
                onChange={(e) => setManualUrls(e.target.value)}
                placeholder={`https://example.com/manga/series/chapter-1\nhttps://example.com/manga/series/chapter-2\nhttps://example.com/manga/series/chapter-3`}
                className="w-full h-48 px-3 py-2 text-sm rounded-md border border-input bg-background resize-y"
              />
              <p className="text-xs text-muted-foreground">
                Paste each chapter URL on a separate line
              </p>
            </div>
            
            <Button 
              onClick={handleDiscoverChapters}
              disabled={loading || !manualUrls.trim()}
              className="w-full"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Search className="h-4 w-4 mr-2" />
              )}
              Validate URLs
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  )
  
  const renderPatternStep = () => (
    <Card>
      <CardHeader>
        <CardTitle>URL Pattern Detected</CardTitle>
        <CardDescription>
          Review the detected pattern and validate it works
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="p-4 rounded-lg bg-muted space-y-3">
          <div className="flex items-center gap-2">
            <Badge 
              variant={
                pattern?.confidence === 'high' ? 'success' :
                pattern?.confidence === 'medium' ? 'warning' : 'destructive'
              }
            >
              {pattern?.confidence} confidence
            </Badge>
            <span className="text-sm text-muted-foreground">
              Starting at chapter {pattern?.startNumber}, increment {pattern?.increment}
            </span>
          </div>
          
          {pattern?.message && (
            <div className="flex items-start gap-2 text-sm text-amber-600">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{pattern.message}</span>
            </div>
          )}
        </div>
        
        <div className="space-y-2">
          <Label htmlFor="template">URL Template</Label>
          <Input
            id="template"
            value={editedTemplate}
            onChange={(e) => setEditedTemplate(e.target.value)}
            placeholder="https://example.com/manga/series/chapter-{n}"
          />
          <p className="text-xs text-muted-foreground">
            Use {'{n}'} as the placeholder for the chapter number
          </p>
        </div>
        
        <div className="space-y-2">
          <Label htmlFor="title-confirm">Series Title</Label>
          <Input
            id="title-confirm"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Enter series title"
          />
        </div>
        
        <div className="flex gap-4">
          <Button 
            variant="outline"
            onClick={() => setStep('urls')}
            className="flex-1"
          >
            Back
          </Button>
          <Button 
            onClick={handleValidatePattern}
            disabled={loading || !editedTemplate.includes('{n}')}
            className="flex-1"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <CheckCircle className="h-4 w-4 mr-2" />
            )}
            Validate Pattern
          </Button>
        </div>
        
        {/* Skip validation option */}
        <div className="pt-2 border-t">
          <Button 
            variant="ghost"
            onClick={() => {
              setPatternValidated(true)
              setStep('range')
            }}
            disabled={loading || !editedTemplate.includes('{n}')}
            className="w-full text-muted-foreground hover:text-foreground"
          >
            <SkipForward className="h-4 w-4 mr-2" />
            Skip Validation (I trust this pattern)
          </Button>
          <p className="text-xs text-muted-foreground text-center mt-1">
            Use if validation is blocked by site protection
          </p>
        </div>
        
        {/* Validation progress */}
        {loading && discoveryProgress && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span>
                Validating chapter {discoveryProgress.currentNumber}...
              </span>
              <span>{discoveryProgress.discovered}/{discoveryProgress.total} found</span>
            </div>
            <Progress value={(discoveryProgress.discovered / discoveryProgress.total) * 100} className="h-2" />
          </div>
        )}
      </CardContent>
    </Card>
  )
  
  const renderRangeStep = () => {
    const wasSkipped = !validationResult
    
    return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {wasSkipped ? (
            <SkipForward className="h-5 w-5 text-amber-500" />
          ) : (
            <CheckCircle className="h-5 w-5 text-green-500" />
          )}
          {wasSkipped ? 'Validation Skipped' : 'Pattern Validated'}
        </CardTitle>
        <CardDescription>
          {wasSkipped 
            ? 'Enter the chapter range you want to add. Invalid URLs will be skipped during discovery.'
            : (validationResult?.message || 'The URL pattern is working. Enter the chapter range you want to add.')
          }
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className={`p-4 rounded-lg border ${wasSkipped ? 'bg-amber-500/10 border-amber-500/20' : 'bg-green-500/10 border-green-500/20'}`}>
          <div className={`flex items-center gap-2 ${wasSkipped ? 'text-amber-700 dark:text-amber-400' : 'text-green-700 dark:text-green-400'}`}>
            {wasSkipped ? <AlertTriangle className="h-4 w-4" /> : <Check className="h-4 w-4" />}
            <span className="font-medium">Template: {editedTemplate}</span>
          </div>
        </div>
        
        <div className="space-y-4">
          <Label>Chapter Range</Label>
          <div className="flex items-center gap-4">
            <div className="flex-1 space-y-2">
              <Label htmlFor="from-chapter" className="text-xs text-muted-foreground">From Chapter</Label>
              <Input
                id="from-chapter"
                type="number"
                min="1"
                value={fromChapter}
                onChange={(e) => setFromChapter(e.target.value)}
                placeholder="1"
              />
            </div>
            <div className="pt-6">to</div>
            <div className="flex-1 space-y-2">
              <Label htmlFor="to-chapter" className="text-xs text-muted-foreground">To Chapter</Label>
              <Input
                id="to-chapter"
                type="number"
                min="1"
                value={toChapter}
                onChange={(e) => setToChapter(e.target.value)}
                placeholder="20"
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Max 200 chapters per batch. You can add more chapters later from the series page.
          </p>
        </div>
        
        <div className="flex gap-4">
          <Button 
            variant="outline"
            onClick={() => setStep('pattern')}
            className="flex-1"
          >
            Back
          </Button>
          <Button 
            onClick={handleDiscoverChapters}
            disabled={loading || !fromChapter || !toChapter}
            className="flex-1"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Search className="h-4 w-4 mr-2" />
            )}
            Find Chapters ({parseInt(toChapter) - parseInt(fromChapter) + 1 || 0})
          </Button>
        </div>
        
        {/* Discovery progress */}
        {loading && discoveryProgress && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span>
                Checking chapter {discoveryProgress.currentNumber}...
              </span>
              <span>{discoveryProgress.discovered}/{discoveryProgress.total} found</span>
            </div>
            <Progress value={(discoveryProgress.currentNumber - parseInt(fromChapter) + 1) / discoveryProgress.total * 100} className="h-2" />
          </div>
        )}
      </CardContent>
    </Card>
  )}
  
  const renderChaptersStep = () => {
    const minChapter = Math.min(...chapters.map(c => c.number))
    const maxChapter = Math.max(...chapters.map(c => c.number))
    
    return (
      <Card>
        <CardHeader>
          <CardTitle>Select Chapters</CardTitle>
          <CardDescription>
            Found {chapters.length} chapters. Select which ones to add to your library.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Quick select controls */}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={handleSelectAll}>
              Select All
            </Button>
            <Button variant="outline" size="sm" onClick={handleSelectNone}>
              Select None
            </Button>
            <Button 
              variant="outline" 
              size="sm" 
              onClick={() => handleSelectRange(minChapter, Math.min(minChapter + 9, maxChapter))}
            >
              First 10
            </Button>
            <Button 
              variant="outline" 
              size="sm" 
              onClick={() => handleSelectRange(Math.max(maxChapter - 9, minChapter), maxChapter)}
            >
              Last 10
            </Button>
          </div>
          
          {/* Range selector */}
          <div className="flex items-center gap-2">
            <Label>Range:</Label>
            <Input
              type="number"
              className="w-20"
              placeholder="From"
              onChange={(e) => {
                const from = parseInt(e.target.value) || minChapter
                const to = maxChapter
                handleSelectRange(from, to)
              }}
            />
            <span>to</span>
            <Input
              type="number"
              className="w-20"
              placeholder="To"
              onChange={(e) => {
                const from = minChapter
                const to = parseInt(e.target.value) || maxChapter
                handleSelectRange(from, to)
              }}
            />
          </div>
          
          {/* Chapter list */}
          <ScrollArea className="h-64 border rounded-lg">
            <div className="p-4 space-y-2">
              {chapters.map((chapter) => (
                <div 
                  key={chapter.number}
                  className="flex items-center gap-3 p-2 rounded hover:bg-accent"
                >
                  <Checkbox
                    checked={selectedChapters.has(chapter.number)}
                    onCheckedChange={() => handleToggleChapter(chapter.number)}
                  />
                  <span className="font-medium">Chapter {chapter.number}</span>
                  {chapter.title && (
                    <span className="text-sm text-muted-foreground truncate flex-1">
                      {chapter.title}
                    </span>
                  )}
                  <Badge variant="secondary" className="shrink-0">
                    {chapter.pageCount} pages
                  </Badge>
                </div>
              ))}
            </div>
          </ScrollArea>
          
          <div className="text-sm text-muted-foreground">
            {selectedChapters.size} of {chapters.length} chapters selected
          </div>
          
          <div className="flex gap-4">
            <Button 
              variant="outline"
              onClick={() => setStep(mode === 'pattern' ? 'range' : 'urls')}
              className="flex-1"
            >
              Back
            </Button>
            <Button 
              onClick={handleCreateSeries}
              disabled={loading || selectedChapters.size === 0 || !title.trim()}
              className="flex-1"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Check className="h-4 w-4 mr-2" />
              )}
              Create Series ({selectedChapters.size} chapters)
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }
  
  const steps = mode === 'pattern' 
    ? ['urls', 'pattern', 'range', 'chapters'] 
    : ['urls', 'chapters']
  
  return (
    <div className="p-6 max-w-2xl mx-auto">
      {/* Progress indicator */}
      <div className="flex items-center gap-2 mb-6">
        {steps.map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <div className={`
              w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium
              ${step === s 
                ? 'bg-primary text-primary-foreground' 
                : steps.indexOf(step) > i
                  ? 'bg-primary/20 text-primary'
                  : 'bg-muted text-muted-foreground'
              }
            `}>
              {i + 1}
            </div>
            {i < steps.length - 1 && (
              <div className={`w-8 h-0.5 ${
                steps.indexOf(step) > i
                  ? 'bg-primary'
                  : 'bg-muted'
              }`} />
            )}
          </div>
        ))}
      </div>
      
      {step === 'urls' && renderUrlStep()}
      {step === 'pattern' && mode === 'pattern' && renderPatternStep()}
      {step === 'range' && mode === 'pattern' && renderRangeStep()}
      {step === 'chapters' && renderChaptersStep()}
    </div>
  )
}
