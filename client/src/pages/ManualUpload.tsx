import { useState, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useToast } from '@/components/ui/use-toast'
import { 
  Upload, 
  Loader2, 
  Check, 
  X, 
  FolderPlus,
  Image,
  Trash2,
  RefreshCw,
  ChevronRight,
  FileImage,
  Plus
} from 'lucide-react'

const API_BASE = 'http://localhost:3002/api'

interface ManualSeries {
  id: string
  title: string
  rootFolder: string
  chapters: ManualChapter[]
}

interface ManualChapter {
  id: string
  number: number
  title: string
  status: string
  pageCount?: number
}

interface ChapterFiles {
  chapter: {
    id: string
    number: number
    title: string
    status: string
  }
  folderPath: string
  files: string[]
  pageCount: number
}

export default function ManualUpload() {
  const navigate = useNavigate()
  const { toast } = useToast()
  const fileInputRef = useRef<HTMLInputElement>(null)
  
  const [step, setStep] = useState<'create' | 'upload'>('create')
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  
  // Create step state
  const [title, setTitle] = useState('')
  const [chapterCount, setChapterCount] = useState('10')
  
  // Upload step state
  const [series, setSeries] = useState<ManualSeries | null>(null)
  const [selectedChapter, setSelectedChapter] = useState<number | null>(null)
  const [chapterFiles, setChapterFiles] = useState<ChapterFiles | null>(null)
  const [uploadProgress, setUploadProgress] = useState(0)
  
  // Add more chapters state
  const [addFromChapter, setAddFromChapter] = useState('')
  const [addToChapter, setAddToChapter] = useState('')

  const handleCreateSeries = async () => {
    if (!title.trim()) {
      toast({
        title: 'Error',
        description: 'Please enter a series title',
        variant: 'destructive'
      })
      return
    }
    
    const numChapters = parseInt(chapterCount) || 10
    if (numChapters < 1 || numChapters > 500) {
      toast({
        title: 'Error',
        description: 'Chapter count must be between 1 and 500',
        variant: 'destructive'
      })
      return
    }
    
    setLoading(true)
    
    try {
      const res = await fetch(`${API_BASE}/manual/series`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          chapterCount: numChapters
        })
      })
      
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Failed to create series')
      }
      
      const newSeries = await res.json()
      setSeries(newSeries)
      setStep('upload')
      
      toast({
        title: 'Success',
        description: `Created "${newSeries.title}" with ${numChapters} chapter folders`
      })
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
  
  const loadChapterFiles = useCallback(async (chapterNumber: number) => {
    if (!series) return
    
    try {
      const res = await fetch(
        `${API_BASE}/manual/series/${series.id}/chapters/${chapterNumber}/files`
      )
      
      if (!res.ok) throw new Error('Failed to load chapter')
      
      const data = await res.json()
      setChapterFiles(data)
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to load chapter files',
        variant: 'destructive'
      })
    }
  }, [series, toast])
  
  const handleSelectChapter = async (chapterNumber: number) => {
    setSelectedChapter(chapterNumber)
    await loadChapterFiles(chapterNumber)
  }
  
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0 || !series || selectedChapter === null) return
    
    setUploading(true)
    setUploadProgress(0)
    
    try {
      const formData = new FormData()
      
      // Sort files by name before upload
      const sortedFiles = Array.from(files).sort((a, b) => 
        a.name.localeCompare(b.name, undefined, { numeric: true })
      )
      
      sortedFiles.forEach(file => {
        formData.append('images', file)
      })
      
      const res = await fetch(
        `${API_BASE}/manual/series/${series.id}/chapters/${selectedChapter}/upload`,
        {
          method: 'POST',
          body: formData
        }
      )
      
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Failed to upload images')
      }
      
      const result = await res.json()
      
      toast({
        title: 'Upload Complete',
        description: `Uploaded ${result.uploadedCount} images to Chapter ${selectedChapter}`
      })
      
      // Refresh chapter files and series data
      await loadChapterFiles(selectedChapter)
      await refreshSeries()
      
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to upload images',
        variant: 'destructive'
      })
    } finally {
      setUploading(false)
      setUploadProgress(0)
      // Clear file input
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }
  
  const refreshSeries = async () => {
    if (!series) return
    
    try {
      const res = await fetch(`${API_BASE}/series/${series.id}`)
      if (res.ok) {
        const updated = await res.json()
        setSeries(updated)
      }
    } catch (e) {
      console.error('Failed to refresh series:', e)
    }
  }
  
  const handleDeleteFile = async (filename: string) => {
    if (!series || selectedChapter === null) return
    
    try {
      const res = await fetch(
        `${API_BASE}/manual/series/${series.id}/chapters/${selectedChapter}/files`,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filenames: [filename] })
        }
      )
      
      if (!res.ok) throw new Error('Failed to delete file')
      
      toast({
        title: 'Deleted',
        description: `Removed ${filename}`
      })
      
      await loadChapterFiles(selectedChapter)
      await refreshSeries()
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to delete file',
        variant: 'destructive'
      })
    }
  }
  
  const handleReindex = async () => {
    if (!series || selectedChapter === null) return
    
    setLoading(true)
    
    try {
      const res = await fetch(
        `${API_BASE}/manual/series/${series.id}/chapters/${selectedChapter}/reindex`,
        { method: 'POST' }
      )
      
      if (!res.ok) throw new Error('Failed to reindex')
      
      const result = await res.json()
      
      toast({
        title: 'Reindexed',
        description: result.message
      })
      
      await loadChapterFiles(selectedChapter)
      await refreshSeries()
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to reindex chapter',
        variant: 'destructive'
      })
    } finally {
      setLoading(false)
    }
  }
  
  const handleAddChapters = async () => {
    if (!series) return
    
    const from = parseInt(addFromChapter)
    const to = parseInt(addToChapter)
    
    if (!from || !to || from > to) {
      toast({
        title: 'Error',
        description: 'Enter a valid chapter range',
        variant: 'destructive'
      })
      return
    }
    
    setLoading(true)
    
    try {
      const res = await fetch(
        `${API_BASE}/manual/series/${series.id}/chapters`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fromChapter: from, toChapter: to })
        }
      )
      
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Failed to add chapters')
      }
      
      const result = await res.json()
      
      if (result.series) {
        setSeries(result.series)
      }
      
      toast({
        title: 'Success',
        description: result.message
      })
      
      setAddFromChapter('')
      setAddToChapter('')
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to add chapters',
        variant: 'destructive'
      })
    } finally {
      setLoading(false)
    }
  }
  
  const handleGoToSeries = () => {
    if (series) {
      navigate(`/series/${series.id}`)
    }
  }
  
  const renderCreateStep = () => (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FolderPlus className="h-5 w-5" />
          Manual Upload Mode
        </CardTitle>
        <CardDescription>
          Create a series with empty chapter folders, then upload images manually.
          Use this when automatic URL detection doesn't work.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="title">Series Title</Label>
          <Input
            id="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g., Solo Leveling"
          />
        </div>
        
        <div className="space-y-2">
          <Label htmlFor="chapters">Number of Chapters</Label>
          <Input
            id="chapters"
            type="number"
            min="1"
            max="500"
            value={chapterCount}
            onChange={(e) => setChapterCount(e.target.value)}
            placeholder="10"
          />
          <p className="text-xs text-muted-foreground">
            This creates empty chapter folders. You can add more chapters later.
          </p>
        </div>
        
        <Button 
          onClick={handleCreateSeries}
          disabled={loading || !title.trim()}
          className="w-full"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <FolderPlus className="h-4 w-4 mr-2" />
          )}
          Create Series & Folders
        </Button>
      </CardContent>
    </Card>
  )
  
  const renderUploadStep = () => {
    if (!series) return null
    
    const doneChapters = series.chapters.filter(c => c.status === 'done').length
    const totalChapters = series.chapters.length
    
    return (
      <div className="space-y-6">
        {/* Series header */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>{series.title}</CardTitle>
                <CardDescription>
                  {doneChapters} of {totalChapters} chapters have images
                </CardDescription>
              </div>
              <Button variant="outline" onClick={handleGoToSeries}>
                Go to Series
                <ChevronRight className="h-4 w-4 ml-2" />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <Progress value={(doneChapters / totalChapters) * 100} className="h-2" />
          </CardContent>
        </Card>
        
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Chapter list */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Chapters</CardTitle>
              <CardDescription>
                Select a chapter to upload images
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <ScrollArea className="h-80">
                <div className="space-y-1">
                  {series.chapters.map((chapter) => (
                    <button
                      key={chapter.id}
                      onClick={() => handleSelectChapter(chapter.number)}
                      className={`
                        w-full flex items-center justify-between p-3 rounded-lg text-left
                        transition-colors
                        ${selectedChapter === chapter.number 
                          ? 'bg-primary text-primary-foreground' 
                          : 'hover:bg-accent'
                        }
                      `}
                    >
                      <span className="font-medium">Chapter {chapter.number}</span>
                      <div className="flex items-center gap-2">
                        {chapter.status === 'done' ? (
                          <Badge variant="success" className="gap-1">
                            <Check className="h-3 w-3" />
                            {chapter.pageCount || 0} pages
                          </Badge>
                        ) : (
                          <Badge variant="secondary">Empty</Badge>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              </ScrollArea>
              
              {/* Add more chapters */}
              <div className="pt-4 border-t space-y-3">
                <Label className="text-sm font-medium">Add More Chapters</Label>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    placeholder="From"
                    value={addFromChapter}
                    onChange={(e) => setAddFromChapter(e.target.value)}
                    className="w-20"
                  />
                  <span className="text-muted-foreground">to</span>
                  <Input
                    type="number"
                    placeholder="To"
                    value={addToChapter}
                    onChange={(e) => setAddToChapter(e.target.value)}
                    className="w-20"
                  />
                  <Button 
                    size="sm" 
                    onClick={handleAddChapters}
                    disabled={loading || !addFromChapter || !addToChapter}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
          
          {/* Upload area */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">
                {selectedChapter !== null 
                  ? `Chapter ${selectedChapter}` 
                  : 'Select a Chapter'
                }
              </CardTitle>
              <CardDescription>
                {chapterFiles 
                  ? `${chapterFiles.files.length} images in folder`
                  : 'Click a chapter to manage its images'
                }
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {selectedChapter !== null ? (
                <>
                  {/* Upload zone */}
                  <div 
                    className="border-2 border-dashed rounded-lg p-8 text-center cursor-pointer
                      hover:border-primary hover:bg-primary/5 transition-colors"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      accept="image/*"
                      onChange={handleFileSelect}
                      className="hidden"
                    />
                    
                    {uploading ? (
                      <div className="space-y-3">
                        <Loader2 className="h-10 w-10 mx-auto animate-spin text-primary" />
                        <p className="text-sm text-muted-foreground">Uploading images...</p>
                        <Progress value={uploadProgress} className="h-2 w-48 mx-auto" />
                      </div>
                    ) : (
                      <>
                        <Upload className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
                        <p className="font-medium">Click to upload images</p>
                        <p className="text-sm text-muted-foreground mt-1">
                          or drag and drop files here
                        </p>
                        <p className="text-xs text-muted-foreground mt-2">
                          JPG, PNG, WebP, GIF (max 20MB each)
                        </p>
                      </>
                    )}
                  </div>
                  
                  {/* Actions */}
                  <div className="flex gap-2">
                    <Button 
                      variant="outline" 
                      size="sm"
                      onClick={handleReindex}
                      disabled={loading}
                    >
                      <RefreshCw className="h-4 w-4 mr-2" />
                      Reindex from Folder
                    </Button>
                  </div>
                  
                  {/* File list */}
                  {chapterFiles && chapterFiles.files.length > 0 && (
                    <div className="space-y-2">
                      <Label className="text-sm">Uploaded Files</Label>
                      <ScrollArea className="h-48 border rounded-lg">
                        <div className="p-2 space-y-1">
                          {chapterFiles.files.map((filename, idx) => (
                            <div 
                              key={filename}
                              className="flex items-center justify-between p-2 rounded hover:bg-accent group"
                            >
                              <div className="flex items-center gap-2">
                                <FileImage className="h-4 w-4 text-muted-foreground" />
                                <span className="text-sm">{filename}</span>
                              </div>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 opacity-0 group-hover:opacity-100"
                                onClick={() => handleDeleteFile(filename)}
                              >
                                <Trash2 className="h-3 w-3 text-destructive" />
                              </Button>
                            </div>
                          ))}
                        </div>
                      </ScrollArea>
                    </div>
                  )}
                </>
              ) : (
                <div className="py-12 text-center text-muted-foreground">
                  <Image className="h-12 w-12 mx-auto mb-3 opacity-50" />
                  <p>Select a chapter from the list to upload images</p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }
  
  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Back navigation */}
      <div className="mb-6">
        <Button 
          variant="ghost" 
          onClick={() => navigate('/add-series')}
          className="text-muted-foreground"
        >
          ← Back to Add Series
        </Button>
      </div>
      
      {step === 'create' && renderCreateStep()}
      {step === 'upload' && renderUploadStep()}
    </div>
  )
}
