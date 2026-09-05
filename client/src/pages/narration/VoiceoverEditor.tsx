/**
 * Voiceover Editor Page
 * 
 * The main workspace for generating and managing voiceover audio.
 * Two-column layout: sections on left, audio player/files on right.
 */

import { useEffect, useState, useRef, useCallback } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { voiceoverApi, VoiceoverChapterDetail, AudioSection, AudioFile } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Slider } from '@/components/ui/slider'
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useToast } from '@/components/ui/use-toast'
import { useSocket } from '@/lib/socket'
import {
  ArrowLeft,
  ArrowRight,
  Play,
  Pause,
  Square,
  Volume2,
  VolumeX,
  Download,
  Upload,
  Trash2,
  Wand2,
  Loader2,
  Plus,
  Edit2,
  Copy,
  Check,
  X,
  AlertTriangle,
  CheckCircle,
  XCircle,
  HelpCircle,
  Merge,
  MoreVertical,
  RefreshCw,
  FileAudio,
  SkipBack,
  SkipForward
} from 'lucide-react'

// Voice options for Gemini TTS (male only)
const GEMINI_VOICES = [
  { id: 'Charon', name: 'Charon', description: 'Deep and resonant' },
  { id: 'Fenrir', name: 'Fenrir', description: 'Bold and powerful' },
  { id: 'Orus', name: 'Orus', description: 'Calm and measured' },
  { id: 'Puck', name: 'Puck', description: 'Playful and energetic' },
  { id: 'Zephyr', name: 'Zephyr', description: 'Light and airy' },
  { id: 'Algenib', name: 'Algenib', description: 'Gravelly and rugged' },
  { id: 'Algieba', name: 'Algieba', description: 'Smooth and silky' },
  { id: 'Bellatrix', name: 'Bellatrix', description: 'Crisp and articulate' },
  { id: 'Gacrux', name: 'Gacrux', description: 'Mature and wise' },
  { id: 'Iapetus', name: 'Iapetus', description: 'Versatile narrator' },
  { id: 'Keid', name: 'Keid', description: 'Upbeat and cheerful' },
  { id: 'Kopernicus', name: 'Kopernicus', description: 'Measured and scholarly' },
  { id: 'Pegasus', name: 'Pegasus', description: 'Storytelling narrative' },
  { id: 'Perseus', name: 'Perseus', description: 'Deep and commanding' },
  { id: 'Rasalhague', name: 'Rasalhague', description: 'Even and balanced' },
  { id: 'Sadaltager', name: 'Sadaltager', description: 'Knowledgeable' },
  { id: 'Sulafat', name: 'Sulafat', description: 'Warm and friendly' },
  { id: 'Zubenelgenubi', name: 'Zubenelgenubi', description: 'Casual conversational' }
]

export default function VoiceoverEditor() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { toast } = useToast()
  const { socket } = useSocket()
  
  // Chapter data
  const [chapter, setChapter] = useState<VoiceoverChapterDetail | null>(null)
  const [loading, setLoading] = useState(true)
  
  // Voice settings
  const [selectedVoice, setSelectedVoice] = useState('Iapetus')
  const [stylePrompt, setStylePrompt] = useState('')
  
  // Generation state
  const [generating, setGenerating] = useState(false)
  const [generatingAll, setGeneratingAll] = useState(false)
  const [joiningAudio, setJoiningAudio] = useState(false)
  const [batchProgress, setBatchProgress] = useState({ completed: 0, total: 0 })
  
  // Section editing
  const [editingSection, setEditingSection] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  
  // Selected section for playback
  const [selectedSection, setSelectedSection] = useState<string | null>(null)
  const [copiedText, setCopiedText] = useState(false)
  
  // Audio player state
  const audioRef = useRef<HTMLAudioElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(1)
  const [isMuted, setIsMuted] = useState(false)
  const [currentAudioFile, setCurrentAudioFile] = useState<AudioFile | null>(null)
  
  // Upload dialog
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false)
  const [uploadSectionId, setUploadSectionId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  
  // Add section dialog
  const [addSectionOpen, setAddSectionOpen] = useState(false)
  const [newSectionText, setNewSectionText] = useState('')
  const [addingSection, setAddingSection] = useState(false)
  
  // Voice consistency check
  const [checkingVoices, setCheckingVoices] = useState(false)
  const [mismatchedSectionIds, setMismatchedSectionIds] = useState<Set<string>>(new Set())

  // Load chapter data
  useEffect(() => {
    if (id) {
      loadChapter()
    }
  }, [id])

  // Socket event handlers
  useEffect(() => {
    if (!socket) return

    const handleSectionStart = (data: { chapterId: string; sectionId: string }) => {
      if (data.chapterId === id) {
        setChapter(prev => {
          if (!prev) return prev
          return {
            ...prev,
            sections: prev.sections.map(s =>
              s.id === data.sectionId ? { ...s, status: 'generating' } : s
            )
          }
        })
      }
    }

    const handleSectionComplete = (data: { chapterId: string; sectionId: string; audioFileId: string }) => {
      if (data.chapterId === id) {
        loadChapter()
      }
    }

    const handleSectionError = (data: { sectionId: string; error: string }) => {
      setChapter(prev => {
        if (!prev) return prev
        return {
          ...prev,
          sections: prev.sections.map(s =>
            s.id === data.sectionId ? { ...s, status: 'error', error: data.error } : s
          )
        }
      })
    }

    const handleBatchStart = (data: { chapterId: string; totalSections: number }) => {
      if (data.chapterId === id) {
        setGeneratingAll(true)
        setBatchProgress({ completed: 0, total: data.totalSections })
      }
    }

    const handleBatchProgress = (data: { chapterId: string; completed: number; total: number }) => {
      if (data.chapterId === id) {
        setBatchProgress({ completed: data.completed, total: data.total })
      }
    }

    const handleBatchComplete = (data: { chapterId: string; successful: number; failed: number }) => {
      if (data.chapterId === id) {
        setGeneratingAll(false)
        setBatchProgress({ completed: 0, total: 0 })
        loadChapter()
        toast({
          title: 'Batch Generation Complete',
          description: `${data.successful} succeeded, ${data.failed} failed`
        })
      }
    }

    const handleJoinComplete = (data: { chapterId: string }) => {
      if (data.chapterId === id) {
        setJoiningAudio(false)
        loadChapter()
        toast({
          title: 'Audio Joined',
          description: 'Chapter audio file created successfully'
        })
      }
    }

    socket.on('voiceover:section-start', handleSectionStart)
    socket.on('voiceover:section-complete', handleSectionComplete)
    socket.on('voiceover:section-error', handleSectionError)
    socket.on('voiceover:batch-start', handleBatchStart)
    socket.on('voiceover:batch-progress', handleBatchProgress)
    socket.on('voiceover:batch-complete', handleBatchComplete)
    socket.on('voiceover:join-complete', handleJoinComplete)

    return () => {
      socket.off('voiceover:section-start', handleSectionStart)
      socket.off('voiceover:section-complete', handleSectionComplete)
      socket.off('voiceover:section-error', handleSectionError)
      socket.off('voiceover:batch-start', handleBatchStart)
      socket.off('voiceover:batch-progress', handleBatchProgress)
      socket.off('voiceover:batch-complete', handleBatchComplete)
      socket.off('voiceover:join-complete', handleJoinComplete)
    }
  }, [socket, id])

  // Audio player effects
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const handleTimeUpdate = () => setCurrentTime(audio.currentTime)
    const handleLoadedMetadata = () => setDuration(audio.duration)
    const handleEnded = () => setIsPlaying(false)

    audio.addEventListener('timeupdate', handleTimeUpdate)
    audio.addEventListener('loadedmetadata', handleLoadedMetadata)
    audio.addEventListener('ended', handleEnded)

    return () => {
      audio.removeEventListener('timeupdate', handleTimeUpdate)
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata)
      audio.removeEventListener('ended', handleEnded)
    }
  }, [])

  const loadChapter = async () => {
    try {
      const data = await voiceoverApi.getChapterDetail(id!)
      setChapter(data)
      
      // Select first section if none selected
      if (!selectedSection && data.sections.length > 0) {
        setSelectedSection(data.sections[0].id)
      }
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

  // Section operations
  const handleInitializeSections = async () => {
    try {
      const result = await voiceoverApi.initializeSections(id!)
      toast({
        title: 'Sections Created',
        description: `Created ${result.count} sections from script`
      })
      loadChapter()
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to create sections',
        variant: 'destructive'
      })
    }
  }

  const handleStartEdit = (section: AudioSection) => {
    setEditingSection(section.id)
    setEditText(section.text)
  }

  const handleSaveEdit = async () => {
    if (!editingSection) return
    
    try {
      await voiceoverApi.updateSection(editingSection, editText)
      setEditingSection(null)
      loadChapter()
      toast({
        title: 'Section Updated',
        description: 'Section text saved'
      })
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to update section',
        variant: 'destructive'
      })
    }
  }

  const handleDeleteSection = async (sectionId: string) => {
    try {
      await voiceoverApi.deleteSection(sectionId)
      loadChapter()
      if (selectedSection === sectionId) {
        setSelectedSection(null)
      }
      toast({
        title: 'Section Deleted'
      })
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to delete section',
        variant: 'destructive'
      })
    }
  }

  const handleAddSection = async () => {
    if (!newSectionText.trim()) return
    
    setAddingSection(true)
    try {
      await voiceoverApi.addSection(id!, newSectionText.trim())
      setNewSectionText('')
      setAddSectionOpen(false)
      loadChapter()
      toast({
        title: 'Section Added'
      })
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to add section',
        variant: 'destructive'
      })
    } finally {
      setAddingSection(false)
    }
  }

  // Generation
  const handleGenerateSection = async (sectionId: string) => {
    setGenerating(true)
    try {
      await voiceoverApi.generateSectionAudio(sectionId, selectedVoice, stylePrompt || undefined)
      loadChapter()
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to generate audio',
        variant: 'destructive'
      })
    } finally {
      setGenerating(false)
    }
  }

  const handleGenerateAll = async () => {
    setGeneratingAll(true)
    try {
      await voiceoverApi.generateAllSections(id!, selectedVoice, stylePrompt || undefined)
    } catch (error) {
      setGeneratingAll(false)
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to generate audio',
        variant: 'destructive'
      })
    }
  }

  // Join audio
  const handleJoinAudio = async () => {
    setJoiningAudio(true)
    try {
      await voiceoverApi.joinChapterAudio(id!, true, 'mp3')
    } catch (error) {
      setJoiningAudio(false)
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to join audio',
        variant: 'destructive'
      })
    }
  }

  // Check voice consistency
  const handleCheckVoices = async () => {
    setCheckingVoices(true)
    try {
      const result = await voiceoverApi.checkVoiceConsistency(id!, selectedVoice)
      
      if (result.consistent) {
        setMismatchedSectionIds(new Set())
        toast({
          title: 'Voices Consistent',
          description: result.expectedVoice 
            ? `All sections use "${result.expectedVoice}" voice`
            : result.message
        })
      } else {
        // Store mismatched section IDs to show tags
        const mismatchIds = new Set(
          result.mismatchedSections
            .map(s => s.sectionId)
            .filter((id): id is string => !!id)
        )
        setMismatchedSectionIds(mismatchIds)
        toast({
          title: 'Voice Mismatch Found',
          description: `${result.mismatchedSections.length} section(s) have different voices. Regenerate them to fix.`,
          variant: 'destructive'
        })
      }
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to check voices',
        variant: 'destructive'
      })
    } finally {
      setCheckingVoices(false)
    }
  }

  // Clear mismatch tag when section is regenerated
  const handleGenerateSectionWithClear = async (sectionId: string) => {
    await handleGenerateSection(sectionId)
    // Remove from mismatched set after regeneration
    setMismatchedSectionIds(prev => {
      const next = new Set(prev)
      next.delete(sectionId)
      return next
    })
  }

  const handleCopyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedText(true)
      setTimeout(() => setCopiedText(false), 1500)
    } catch {
      toast({
        title: 'Copy Failed',
        description: 'Could not copy text to clipboard',
        variant: 'destructive'
      })
    }
  }

  // Upload
  const handleUploadClick = (sectionId: string | null) => {
    setUploadSectionId(sectionId)
    fileInputRef.current?.click()
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    
    try {
      if (uploadSectionId) {
        await voiceoverApi.uploadSectionAudio(uploadSectionId, file)
      } else {
        await voiceoverApi.uploadChapterAudio(id!, file)
      }
      loadChapter()
      toast({
        title: 'Upload Complete',
        description: 'Audio file uploaded successfully'
      })
    } catch (error) {
      toast({
        title: 'Upload Failed',
        description: 'Failed to upload audio file',
        variant: 'destructive'
      })
    }
    
    // Reset
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
    setUploadSectionId(null)
  }

  // Audio playback
  const playAudio = (audioFile: AudioFile) => {
    setCurrentAudioFile(audioFile)
    if (audioRef.current) {
      audioRef.current.src = voiceoverApi.getAudioStreamUrl(audioFile.id)
      audioRef.current.load()
      audioRef.current.play()
      setIsPlaying(true)
    }
  }

  const togglePlayPause = () => {
    if (!audioRef.current) return
    
    if (isPlaying) {
      audioRef.current.pause()
    } else {
      audioRef.current.play()
    }
    setIsPlaying(!isPlaying)
  }

  const stopAudio = () => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
    }
    setIsPlaying(false)
  }

  const handleSeek = (value: number[]) => {
    if (audioRef.current) {
      audioRef.current.currentTime = value[0]
    }
  }

  const handleVolumeChange = (value: number[]) => {
    const vol = value[0]
    setVolume(vol)
    if (audioRef.current) {
      audioRef.current.volume = vol
    }
    setIsMuted(vol === 0)
  }

  const toggleMute = () => {
    if (audioRef.current) {
      audioRef.current.muted = !isMuted
      setIsMuted(!isMuted)
    }
  }

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  // Get audio file for a section
  const getAudioForSection = (sectionId: string) => {
    return chapter?.audioFiles.find(af => af.sectionId === sectionId)
  }

  // Get joined audio
  const getJoinedAudio = () => {
    return chapter?.audioFiles.find(af => af.kind === 'joined')
  }

  // Get status badge color
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'done': return 'bg-green-500'
      case 'generating': return 'bg-blue-500'
      case 'error': return 'bg-red-500'
      case 'uploaded': return 'bg-purple-500'
      default: return 'bg-gray-400'
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    )
  }

  if (!chapter) {
    return (
      <div className="p-8">
        <p>Chapter not found</p>
      </div>
    )
  }

  const selectedSectionData = chapter.sections.find(s => s.id === selectedSection)
  const selectedSectionIndex = selectedSectionData ? chapter.sections.indexOf(selectedSectionData) : -1
  const selectedAudioFile = selectedSection ? getAudioForSection(selectedSection) : null
  const joinedAudio = getJoinedAudio()
  const allSectionsGenerated = chapter.sections.every(s => s.status === 'done' || s.status === 'uploaded')

  // Detect uploaded audio files that share the same source filename — a common
  // sign the same file was uploaded to more than one section by mistake.
  const duplicateNames = (() => {
    const counts = new Map<string, number>()
    for (const af of chapter.audioFiles) {
      const name = af.originalName?.trim().toLowerCase()
      if (!name) continue
      counts.set(name, (counts.get(name) || 0) + 1)
    }
    return new Set([...counts.entries()].filter(([, n]) => n > 1).map(([name]) => name))
  })()
  const isDuplicateName = (af: AudioFile) => {
    const name = af.originalName?.trim().toLowerCase()
    return !!name && duplicateNames.has(name)
  }

  return (
    <div className="flex flex-col h-screen">
      {/* Hidden audio element */}
      <audio ref={audioRef} />
      
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={handleFileChange}
      />

      {/* Header */}
      <div className="border-b p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to={`/narration/series/${chapter.series.id}`}>
              <Button variant="ghost" size="sm">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back
              </Button>
            </Link>
            <div>
              <h1 className="text-lg font-semibold">
                Chapter {chapter.number}: {chapter.title || 'Voiceover'}
              </h1>
              <p className="text-sm text-muted-foreground">{chapter.series.title}</p>
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            {chapter.prevChapterId && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate(`/narration/voiceover/${chapter.prevChapterId}`)}
              >
                <ArrowLeft className="h-4 w-4 mr-1" />
                Prev
              </Button>
            )}
            {chapter.nextChapterId && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate(`/narration/voiceover/${chapter.nextChapterId}`)}
              >
                Next
                <ArrowRight className="h-4 w-4 ml-1" />
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left column: Sections */}
        <div className="w-1/2 border-r flex flex-col">
          {/* Section controls */}
          <div className="p-4 border-b space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-medium">Sections ({chapter.sections.length})</h2>
              <div className="flex gap-2">
                {chapter.sections.length === 0 ? (
                  <Button onClick={handleInitializeSections} disabled={!chapter.script}>
                    <Wand2 className="h-4 w-4 mr-2" />
                    Auto-Split Script
                  </Button>
                ) : (
                  <>
                    <Dialog open={addSectionOpen} onOpenChange={setAddSectionOpen}>
                      <DialogTrigger asChild>
                        <Button variant="outline" size="sm">
                          <Plus className="h-4 w-4 mr-1" />
                          Add
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Add Section</DialogTitle>
                          <DialogDescription>
                            Add a new text section for voiceover generation.
                          </DialogDescription>
                        </DialogHeader>
                        <Textarea
                          value={newSectionText}
                          onChange={(e) => setNewSectionText(e.target.value)}
                          placeholder="Enter section text..."
                          rows={6}
                        />
                        <DialogFooter>
                          <Button
                            onClick={handleAddSection}
                            disabled={addingSection || !newSectionText.trim()}
                          >
                            {addingSection && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                            Add Section
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                    
                    <Button
                      onClick={handleGenerateAll}
                      disabled={generatingAll || chapter.sections.every(s => s.status === 'done')}
                    >
                      {generatingAll ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          {batchProgress.completed}/{batchProgress.total}
                        </>
                      ) : (
                        <>
                          <Wand2 className="h-4 w-4 mr-2" />
                          Generate All
                        </>
                      )}
                    </Button>
                  </>
                )}
              </div>
            </div>

            {/* Voice settings */}
            <div className="flex gap-4">
              <div className="flex-1">
                <Label className="text-xs text-muted-foreground mb-1 block">Voice</Label>
                <Select value={selectedVoice} onValueChange={setSelectedVoice}>
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {GEMINI_VOICES.map(voice => (
                      <SelectItem key={voice.id} value={voice.id}>
                        {voice.name} - {voice.description}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {generatingAll && (
              <Progress 
                value={(batchProgress.completed / batchProgress.total) * 100} 
                className="h-2"
              />
            )}
          </div>

          {/* Section list */}
          <ScrollArea className="flex-1">
            <div className="p-4 space-y-2">
              {chapter.sections.map((section, index) => {
                const audioFile = getAudioForSection(section.id)
                const isSelected = section.id === selectedSection
                const isEditing = section.id === editingSection
                
                return (
                  <Card
                    key={section.id}
                    className={`cursor-pointer transition-colors ${
                      isSelected ? 'ring-2 ring-primary' : 'hover:bg-accent/50'
                    }`}
                    onClick={() => !isEditing && setSelectedSection(section.id)}
                  >
                    <CardContent className="p-3">
                      <div className="flex items-start gap-2">
                        <Badge variant="secondary" className="shrink-0">
                          {index + 1}
                        </Badge>
                        
                        <div className="flex-1 min-w-0 overflow-hidden pr-2">
                          {isEditing ? (
                            <div className="space-y-2" onClick={e => e.stopPropagation()}>
                              <Textarea
                                value={editText}
                                onChange={(e) => setEditText(e.target.value)}
                                rows={4}
                                autoFocus
                              />
                              <div className="flex gap-2">
                                <Button size="sm" onClick={handleSaveEdit}>
                                  <Check className="h-3 w-3 mr-1" />
                                  Save
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => setEditingSection(null)}
                                >
                                  <X className="h-3 w-3 mr-1" />
                                  Cancel
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <p className="text-sm line-clamp-3">{section.text}</p>
                          )}
                        </div>
                        
                        <div className="flex items-center gap-1 shrink-0">
                          <div className={`w-2 h-2 rounded-full ${getStatusColor(section.status)}`} />
                          
                          {audioFile && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-6 w-6"
                              onClick={(e) => {
                                e.stopPropagation()
                                playAudio(audioFile)
                              }}
                            >
                              <Play className="h-3 w-3" />
                            </Button>
                          )}
                          
                          <DropdownMenu modal={false}>
                            <DropdownMenuTrigger asChild>
                              <Button 
                                size="icon" 
                                variant="ghost" 
                                className="h-6 w-6"
                                onClick={e => e.stopPropagation()}
                              >
                                <MoreVertical className="h-3 w-3" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" sideOffset={5}>
                              <DropdownMenuItem onClick={() => handleStartEdit(section)}>
                                <Edit2 className="h-4 w-4 mr-2" />
                                Edit Text
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => handleGenerateSectionWithClear(section.id)}
                                disabled={generating || section.status === 'generating'}
                              >
                                <Wand2 className="h-4 w-4 mr-2" />
                                Generate Audio
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handleUploadClick(section.id)}>
                                <Upload className="h-4 w-4 mr-2" />
                                Upload Audio
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="text-red-600"
                                onClick={() => handleDeleteSection(section.id)}
                              >
                                <Trash2 className="h-4 w-4 mr-2" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>
                      
                      {/* Voice mismatch tag */}
                      {mismatchedSectionIds.has(section.id) && (
                        <Badge variant="destructive" className="mt-2 text-xs">
                          <AlertTriangle className="h-3 w-3 mr-1" />
                          Voice Mismatch - Regenerate
                        </Badge>
                      )}
                      
                      {section.error && (
                        <p className="text-xs text-red-500 mt-2">{section.error}</p>
                      )}
                      
                      {audioFile && (
                        <p className="text-xs text-muted-foreground mt-2">
                          {audioFile.voice} • {audioFile.durationMs ? `${(audioFile.durationMs / 1000).toFixed(1)}s` : ''}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                )
              })}
              
              {chapter.sections.length === 0 && (
                <div className="text-center py-12 text-muted-foreground">
                  <FileAudio className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No sections yet</p>
                  <p className="text-sm">
                    {chapter.script ? 'Click "Auto-Split Script" to create sections' : 'Generate a script first'}
                  </p>
                </div>
              )}
            </div>
          </ScrollArea>
        </div>

        {/* Right column: Audio player & files */}
        <div className="w-1/2 flex flex-col">
          {/* Audio player */}
          <Card className="m-4">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Audio Player</CardTitle>
            </CardHeader>
            <CardContent>
              {currentAudioFile ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Badge variant="outline">{currentAudioFile.kind}</Badge>
                    {currentAudioFile.voice && <span>{currentAudioFile.voice}</span>}
                  </div>
                  
                  {/* Progress bar */}
                  <div className="space-y-2">
                    <Slider
                      value={[currentTime]}
                      max={duration || 100}
                      step={0.1}
                      onValueChange={handleSeek}
                      className="cursor-pointer"
                    />
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>{formatTime(currentTime)}</span>
                      <span>{formatTime(duration)}</span>
                    </div>
                  </div>
                  
                  {/* Controls */}
                  <div className="flex items-center justify-center gap-2">
                    <Button
                      size="icon"
                      variant="outline"
                      onClick={stopAudio}
                    >
                      <Square className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      onClick={togglePlayPause}
                    >
                      {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                    </Button>
                  </div>
                  
                  {/* Volume */}
                  <div className="flex items-center gap-2">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={toggleMute}
                    >
                      {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                    </Button>
                    <Slider
                      value={[isMuted ? 0 : volume]}
                      max={1}
                      step={0.01}
                      onValueChange={handleVolumeChange}
                      className="w-24"
                    />
                  </div>
                </div>
              ) : (
                <div className="py-8 text-center text-muted-foreground">
                  <Volume2 className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">Select a section or audio file to play</p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Selected section preview */}
          {selectedSectionData && (
            <Card className="mx-4 mb-4">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-sm">
                    Section {selectedSectionIndex + 1} of {chapter.sections.length}
                  </CardTitle>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      onClick={() => {
                        if (selectedSectionIndex > 0) setSelectedSection(chapter.sections[selectedSectionIndex - 1].id)
                      }}
                      disabled={selectedSectionIndex <= 0}
                      title="Previous section"
                    >
                      <ArrowLeft className="h-4 w-4 mr-1" />
                      Prev
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      onClick={() => {
                        if (selectedSectionIndex < chapter.sections.length - 1) setSelectedSection(chapter.sections[selectedSectionIndex + 1].id)
                      }}
                      disabled={selectedSectionIndex >= chapter.sections.length - 1}
                      title="Next section"
                    >
                      Next
                      <ArrowRight className="h-4 w-4 ml-1" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      onClick={() => handleCopyText(selectedSectionData.text)}
                      title="Copy text"
                    >
                      {copiedText ? (
                        <>
                          <Check className="h-4 w-4 mr-1 text-green-500" />
                          Copied
                        </>
                      ) : (
                        <>
                          <Copy className="h-4 w-4 mr-1" />
                          Copy
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm mb-4">{selectedSectionData.text}</p>
                
                <div className="flex gap-2">
                  {selectedAudioFile ? (
                    <>
                      <Button
                        size="sm"
                        onClick={() => playAudio(selectedAudioFile)}
                      >
                        <Play className="h-4 w-4 mr-2" />
                        Play
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleGenerateSectionWithClear(selectedSectionData.id)}
                        disabled={generating || selectedSectionData.status === 'generating'}
                      >
                        <RefreshCw className="h-4 w-4 mr-2" />
                        Regenerate
                      </Button>
                      <a
                        href={voiceoverApi.getAudioDownloadUrl(selectedAudioFile.id)}
                        download
                      >
                        <Button size="sm" variant="outline">
                          <Download className="h-4 w-4 mr-2" />
                          Download
                        </Button>
                      </a>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleUploadClick(selectedSectionData.id)}
                        title="Replace the audio for this section with a new file"
                      >
                        <Upload className="h-4 w-4 mr-2" />
                        Re-upload
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        onClick={() => handleGenerateSectionWithClear(selectedSectionData.id)}
                        disabled={generating || selectedSectionData.status === 'generating'}
                      >
                        {selectedSectionData.status === 'generating' ? (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        ) : (
                          <Wand2 className="h-4 w-4 mr-2" />
                        )}
                        Generate Audio
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleUploadClick(selectedSectionData.id)}
                      >
                        <Upload className="h-4 w-4 mr-2" />
                        Upload
                      </Button>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Join & Export */}
          <Card className="mx-4 mb-4">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Final Audio</CardTitle>
              <CardDescription>
                Join all section audio into a single file
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {joinedAudio ? (
                  <div className="flex items-center justify-between p-3 bg-green-50 dark:bg-green-950 rounded-lg">
                    <div className="flex items-center gap-2">
                      <CheckCircle className="h-5 w-5 text-green-600" />
                      <div>
                        <p className="font-medium text-sm">Chapter Audio Ready</p>
                        <p className="text-xs text-muted-foreground">
                          {joinedAudio.durationMs ? `${(joinedAudio.durationMs / 1000 / 60).toFixed(1)} min` : ''} • {joinedAudio.format.toUpperCase()}
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => playAudio(joinedAudio)}
                      >
                        <Play className="h-4 w-4" />
                      </Button>
                      <a href={voiceoverApi.getAudioDownloadUrl(joinedAudio.id)} download>
                        <Button size="sm">
                          <Download className="h-4 w-4 mr-2" />
                          Download
                        </Button>
                      </a>
                    </div>
                  </div>
                ) : (
                  <Button
                    onClick={handleJoinAudio}
                    disabled={!allSectionsGenerated || joiningAudio}
                    className="w-full"
                  >
                    {joiningAudio ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Merge className="h-4 w-4 mr-2" />
                    )}
                    Join All Sections
                  </Button>
                )}
                
                {/* Voice consistency check button */}
                {chapter.audioFiles.filter(af => af.kind === 'generated').length > 1 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCheckVoices}
                    disabled={checkingVoices}
                    className="w-full"
                  >
                    {checkingVoices ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <AlertTriangle className="h-4 w-4 mr-2" />
                    )}
                    Check Voice Consistency
                  </Button>
                )}
                
                {!allSectionsGenerated && (
                  <p className="text-xs text-muted-foreground text-center">
                    Generate audio for all sections first ({chapter.status.generatedSections}/{chapter.status.totalSections})
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* All audio files */}
          <div className="flex-1 mx-4 mb-4 overflow-hidden">
            <Card className="h-full flex flex-col">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-sm">Audio Files ({chapter.audioFiles.length})</CardTitle>
                    {duplicateNames.size > 0 && (
                      <Badge variant="destructive" className="flex items-center gap-1">
                        <AlertTriangle className="h-3 w-3" />
                        Matching files detected
                      </Badge>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleUploadClick(null)}
                  >
                    <Upload className="h-4 w-4 mr-1" />
                    Upload
                  </Button>
                </div>
              </CardHeader>
              <ScrollArea className="flex-1">
                <div className="p-4 pt-0 space-y-2">
                  {chapter.audioFiles.map(af => {
                    const dup = isDuplicateName(af)
                    return (
                    <div
                      key={af.id}
                      className={`flex items-center justify-between p-2 rounded hover:bg-accent cursor-pointer ${
                        dup ? 'border border-destructive bg-destructive/5' : ''
                      }`}
                      onClick={() => playAudio(af)}
                    >
                      <div className="flex items-center gap-2">
                        <FileAudio className={`h-4 w-4 ${dup ? 'text-destructive' : 'text-muted-foreground'}`} />
                        <div>
                          <p className="text-sm font-medium">
                            {af.kind === 'joined' ? 'Full Chapter' : `Section ${
                              chapter.sections.findIndex(s => s.id === af.sectionId) + 1
                            }`}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {af.voice || af.kind} • {af.durationMs ? `${(af.durationMs / 1000).toFixed(1)}s` : ''}
                          </p>
                          {dup && (
                            <p className="text-xs text-destructive flex items-center gap-1">
                              <AlertTriangle className="h-3 w-3" />
                              Duplicate file: {af.originalName}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={(e) => {
                            e.stopPropagation()
                            playAudio(af)
                          }}
                        >
                          <Play className="h-3 w-3" />
                        </Button>
                        <a
                          href={voiceoverApi.getAudioDownloadUrl(af.id)}
                          download
                          onClick={e => e.stopPropagation()}
                        >
                          <Button size="icon" variant="ghost" className="h-7 w-7">
                            <Download className="h-3 w-3" />
                          </Button>
                        </a>
                        {af.kind !== 'joined' && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-red-500"
                            onClick={async (e) => {
                              e.stopPropagation()
                              await voiceoverApi.deleteAudioFile(af.id)
                              loadChapter()
                            }}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        )}
                      </div>
                    </div>
                    )
                  })}

                  {chapter.audioFiles.length === 0 && (
                    <div className="text-center py-8 text-muted-foreground">
                      <p className="text-sm">No audio files yet</p>
                    </div>
                  )}
                </div>
              </ScrollArea>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
