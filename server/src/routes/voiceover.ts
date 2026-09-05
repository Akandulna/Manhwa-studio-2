/**
 * Voiceover API Routes for Narration Studio
 * 
 * Handles TTS generation, audio processing, and voice analysis
 */

import { Router, Request, Response } from 'express'
import fs from 'fs/promises'
import { createReadStream, existsSync } from 'fs'
import path from 'path'
import multer from 'multer'
import { Server } from 'socket.io'
import { prisma } from '../index.js'
import { 
  splitScriptIntoSections,
  initializeSections,
  generateSectionAudio,
  generateAllSections,
  uploadSectionAudio,
  joinChapterAudio,
  getChapterVoiceoverStatus,
  VoiceoverSettings,
  GenerationResult
} from '../services/voiceoverService.js'
import { 
  analyzeChapterVoices, 
  getLastAnalysisResult,
  checkAnalysisSidecarAvailable 
} from '../services/voiceAnalysisService.js'
import { ttsProviderFactory, DEFAULT_TTS_STYLE_PROMPT } from '../services/tts/index.js'
import { parseNormalizationOptions } from '../services/tts/textNormalizer.js'
import { GEMINI_TTS_VOICES } from '../services/tts/types.js'
import { getAudioMetadata } from '../services/audioProcessor.js'

const router = Router()

// Configure multer for audio uploads. The destination resolves the chapter's
// audio folder from EITHER :chapterId (chapter upload) or :id (section upload),
// wrapped in try/catch so a lookup error never becomes an unhandled rejection.
const uploadStorage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      let folderPath: string | null = null

      if (req.params.chapterId) {
        const chapter = await prisma.chapter.findUnique({ where: { id: req.params.chapterId } })
        folderPath = chapter?.folderPath ?? null
      } else if (req.params.id) {
        const section = await prisma.audioSection.findUnique({
          where: { id: req.params.id },
          include: { chapter: true }
        })
        folderPath = section?.chapter.folderPath ?? null
      }

      if (!folderPath) {
        cb(new Error('Target chapter/section not found'), '')
        return
      }

      const downloadRoot = process.env.DOWNLOAD_ROOT || './downloads'
      const audioDir = path.join(downloadRoot, folderPath, 'audio')
      await fs.mkdir(audioDir, { recursive: true })
      cb(null, audioDir)
    } catch (error) {
      cb(error instanceof Error ? error : new Error('Upload destination error'), '')
    }
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now()
    const ext = path.extname(file.originalname) || '.wav'
    cb(null, `upload_${timestamp}${ext}`)
  }
})

const AUDIO_UPLOAD_EXTENSIONS = ['.wav', '.mp3', '.ogg', '.flac', '.aac', '.m4a', '.opus', '.weba']
const upload = multer({
  storage: uploadStorage,
  fileFilter: (req, file, cb) => {
    // MIME for .wav varies by browser/OS (audio/wav, audio/x-wav, audio/wave,
    // application/octet-stream, …), so accept by audio MIME OR by extension.
    const ext = path.extname(file.originalname).toLowerCase()
    if (file.mimetype.startsWith('audio/') || AUDIO_UPLOAD_EXTENSIONS.includes(ext)) {
      cb(null, true)
    } else {
      cb(new Error('Unsupported audio file type'))
    }
  },
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB max
  }
})

// Helper to get the full folder path
function getFullFolderPath(relativePath: string): string {
  const downloadRoot = process.env.DOWNLOAD_ROOT || './downloads'
  return path.join(downloadRoot, relativePath)
}

let io: Server | null = null

export function initVoiceoverRoutes(socketIo: Server): Router {
  io = socketIo
  return router
}

/**
 * Helper to get TTS settings from database
 * Returns merged settings with defaults
 */
async function getTTSSettings(): Promise<Record<string, string>> {
  const dbSettings = await prisma.setting.findMany({
    where: {
      key: {
        in: [
          'ttsStylePrompt',
          'ttsNormalizeText',
          'ttsNormStripTags',
          'ttsNormSoftenDashes',
          'ttsNormSoftenEllipses',
          'ttsNormCalmPunctuation',
          'ttsNormRemoveShouting',
          'ttsNormTidyWhitespace',
          'ttsNormAcronymAllowlist',
          'ttsVoice'
        ]
      }
    }
  })
  
  const settings: Record<string, string> = {}
  dbSettings.forEach(s => {
    settings[s.key] = s.value
  })
  
  return settings
}

// ============ Series/Chapter Listing with Audio Progress ============

/**
 * Get all series with audio progress info
 */
router.get('/series', async (req: Request, res: Response) => {
  try {
    const series = await prisma.series.findMany({
      include: {
        chapters: {
          where: { status: 'done' },
          include: { 
            script: true,
            audioSections: true,
            audioFiles: {
              where: { kind: 'joined' }
            }
          },
          orderBy: { number: 'asc' }
        }
      },
      orderBy: { createdAt: 'desc' }
    })
    
    const result = series.map(s => {
      // Count chapters with scripts
      const scriptedChapters = s.chapters.filter(c => 
        c.script?.status === 'done' || c.script?.status === 'edited'
      )
      
      // Count chapters with audio
      const audioChapters = s.chapters.filter(c => 
        c.audioFiles.length > 0 // Has joined audio
      )
      
      // Count chapters with all sections generated
      const sectionsGeneratedChapters = s.chapters.filter(c => {
        if (c.audioSections.length === 0) return false
        return c.audioSections.every(sec => sec.status === 'done' || sec.status === 'uploaded')
      })
      
      return {
        id: s.id,
        title: s.title,
        sourceSite: s.sourceSite,
        coverPath: s.coverPath,
        rootFolder: s.rootFolder,
        downloadedChapterCount: s.chapters.length,
        scriptedChapterCount: scriptedChapters.length,
        audioGeneratedCount: sectionsGeneratedChapters.length,
        audioJoinedCount: audioChapters.length
      }
    })
    
    res.json(result)
  } catch (error) {
    console.error('Error fetching series for voiceover:', error)
    res.status(500).json({ error: 'Failed to fetch series' })
  }
})

/**
 * Get chapter voiceover details
 */
router.get('/chapters/:id', async (req: Request, res: Response) => {
  try {
    const chapter = await prisma.chapter.findUnique({
      where: { id: req.params.id },
      include: {
        series: true,
        script: true,
        audioSections: {
          orderBy: { index: 'asc' }
        },
        audioFiles: {
          orderBy: { createdAt: 'asc' }
        },
        audioAnalysis: true
      }
    })
    
    if (!chapter) {
      return res.status(404).json({ error: 'Chapter not found' })
    }
    
    // Read script content
    let scriptContent = null
    if (chapter.script?.scriptPath) {
      try {
        scriptContent = await fs.readFile(chapter.script.scriptPath, 'utf-8')
      } catch {
        // File might not exist
      }
    }
    
    // Get prev/next chapter IDs
    const allChapters = await prisma.chapter.findMany({
      where: { seriesId: chapter.seriesId, status: 'done' },
      orderBy: { number: 'asc' },
      select: { id: true, number: true }
    })
    
    const currentIndex = allChapters.findIndex(c => c.id === chapter.id)
    const prevChapterId = currentIndex > 0 ? allChapters[currentIndex - 1].id : null
    const nextChapterId = currentIndex < allChapters.length - 1 ? allChapters[currentIndex + 1].id : null
    
    // Calculate status
    const status = getChapterVoiceoverStatus(chapter.audioSections, chapter.audioFiles)
    
    res.json({
      id: chapter.id,
      number: chapter.number,
      title: chapter.title,
      folderPath: chapter.folderPath,
      series: {
        id: chapter.series.id,
        title: chapter.series.title
      },
      script: chapter.script ? {
        id: chapter.script.id,
        status: chapter.script.status,
        content: scriptContent
      } : null,
      sections: chapter.audioSections.map(sec => ({
        id: sec.id,
        index: sec.index,
        text: sec.text,
        status: sec.status,
        error: sec.error
      })),
      audioFiles: chapter.audioFiles.map(af => ({
        id: af.id,
        kind: af.kind,
        sectionId: af.sectionId,
        provider: af.provider,
        model: af.model,
        voice: af.voice,
        durationMs: af.durationMs,
        format: af.format,
        filePath: af.filePath,
        originalName: af.originalName,
        createdAt: af.createdAt
      })),
      analysis: chapter.audioAnalysis ? {
        verdict: chapter.audioAnalysis.verdict,
        updatedAt: chapter.audioAnalysis.createdAt
      } : null,
      status,
      prevChapterId,
      nextChapterId
    })
  } catch (error) {
    console.error('Error fetching chapter voiceover:', error)
    res.status(500).json({ error: 'Failed to fetch chapter' })
  }
})

// ============ Section Operations ============

/**
 * Initialize sections from script (auto-split)
 */
router.post('/chapters/:id/init-sections', async (req: Request, res: Response) => {
  try {
    const { targetLength = 500 } = req.body
    
    const chapter = await prisma.chapter.findUnique({
      where: { id: req.params.id },
      include: { script: true }
    })
    
    if (!chapter) {
      return res.status(404).json({ error: 'Chapter not found' })
    }
    
    if (!chapter.script?.scriptPath) {
      return res.status(400).json({ error: 'Chapter has no script' })
    }
    
    // Read script content
    const scriptContent = await fs.readFile(chapter.script.scriptPath, 'utf-8')
    
    // Split into sections
    const sections = splitScriptIntoSections(scriptContent, targetLength)
    
    // Initialize in database
    const dbSections = await initializeSections(chapter.id, sections)
    
    res.json({
      message: 'Sections initialized',
      count: dbSections.length,
      sections: dbSections
    })
  } catch (error) {
    console.error('Error initializing sections:', error)
    res.status(500).json({ error: 'Failed to initialize sections' })
  }
})

/**
 * Update a section's text
 */
router.patch('/sections/:id', async (req: Request, res: Response) => {
  try {
    const { text } = req.body
    
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Invalid text' })
    }
    
    const section = await prisma.audioSection.update({
      where: { id: req.params.id },
      data: { 
        text,
        status: 'pending' // Reset status when text changes
      }
    })
    
    res.json(section)
  } catch (error) {
    console.error('Error updating section:', error)
    res.status(500).json({ error: 'Failed to update section' })
  }
})

/**
 * Delete a section
 */
router.delete('/sections/:id', async (req: Request, res: Response) => {
  try {
    // Delete associated audio files first
    await prisma.audioFile.deleteMany({
      where: { sectionId: req.params.id }
    })
    
    await prisma.audioSection.delete({
      where: { id: req.params.id }
    })
    
    res.json({ message: 'Section deleted' })
  } catch (error) {
    console.error('Error deleting section:', error)
    res.status(500).json({ error: 'Failed to delete section' })
  }
})

/**
 * Check voice consistency - just returns mismatch info, doesn't delete files
 */
router.post('/chapters/:id/check-voices', async (req: Request, res: Response) => {
  try {
    const { targetVoice } = req.body
    
    // Get all audio files for this chapter's sections
    const audioFiles = await prisma.audioFile.findMany({
      where: {
        section: { chapterId: req.params.id },
        kind: 'generated'
      },
      include: { section: true }
    })
    
    if (audioFiles.length === 0) {
      return res.json({
        consistent: true,
        message: 'No generated audio files found',
        expectedVoice: targetVoice || null,
        mismatchedSections: []
      })
    }
    
    // Count voice occurrences
    const voiceCounts: Record<string, number> = {}
    for (const af of audioFiles) {
      if (af.voice) {
        voiceCounts[af.voice] = (voiceCounts[af.voice] || 0) + 1
      }
    }
    
    // Determine expected voice (target voice or most common)
    const expectedVoice = targetVoice || Object.entries(voiceCounts)
      .sort((a, b) => b[1] - a[1])[0]?.[0] || null
    
    if (!expectedVoice) {
      return res.json({
        consistent: true,
        message: 'No voice metadata found',
        expectedVoice: null,
        mismatchedSections: []
      })
    }
    
    // Find mismatched audio files - just report them, don't delete
    const mismatchedAudioFiles = audioFiles.filter(af => af.voice !== expectedVoice)
    
    if (mismatchedAudioFiles.length === 0) {
      return res.json({
        consistent: true,
        message: 'All voices are consistent',
        expectedVoice,
        mismatchedSections: []
      })
    }
    
    const mismatchedInfo = mismatchedAudioFiles.map(af => ({
      sectionId: af.sectionId,
      sectionIndex: af.section?.index,
      currentVoice: af.voice,
      expectedVoice
    }))
    
    res.json({
      consistent: false,
      message: `Found ${mismatchedAudioFiles.length} section(s) with different voices`,
      expectedVoice,
      mismatchedSections: mismatchedInfo
    })
  } catch (error) {
    console.error('Error checking voices:', error)
    res.status(500).json({ error: 'Failed to check voice consistency' })
  }
})

/**
 * Add a new section (manual)
 */
router.post('/chapters/:id/sections', async (req: Request, res: Response) => {
  try {
    const { text, index } = req.body
    
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Invalid text' })
    }
    
    // If index specified, shift other sections
    if (typeof index === 'number') {
      await prisma.audioSection.updateMany({
        where: {
          chapterId: req.params.id,
          index: { gte: index }
        },
        data: {
          index: { increment: 1 }
        }
      })
    }
    
    // Get max index if not specified
    const maxSection = await prisma.audioSection.findFirst({
      where: { chapterId: req.params.id },
      orderBy: { index: 'desc' }
    })
    
    const newIndex = typeof index === 'number' ? index : ((maxSection?.index ?? -1) + 1)
    
    const section = await prisma.audioSection.create({
      data: {
        chapterId: req.params.id,
        index: newIndex,
        text,
        status: 'pending'
      }
    })
    
    res.json(section)
  } catch (error) {
    console.error('Error adding section:', error)
    res.status(500).json({ error: 'Failed to add section' })
  }
})

// ============ TTS Generation ============

/**
 * Generate audio for a single section
 */
router.post('/sections/:id/generate', async (req: Request, res: Response) => {
  try {
    const { voice, stylePrompt } = req.body
    
    const section = await prisma.audioSection.findUnique({
      where: { id: req.params.id },
      include: { chapter: true }
    })
    
    if (!section) {
      return res.status(404).json({ error: 'Section not found' })
    }
    
    // Emit start event
    if (io) {
      io.emit('voiceover:section-start', {
        chapterId: section.chapterId,
        sectionId: section.id,
        index: section.index
      })
    }
    
    // Get TTS settings from database
    const ttsSettings = await getTTSSettings()
    const normalizationOptions = parseNormalizationOptions(ttsSettings)
    
    const settings: VoiceoverSettings = {
      voice: voice || ttsSettings.ttsVoice || process.env.TTS_DEFAULT_VOICE || 'Iapetus',
      stylePrompt: stylePrompt || ttsSettings.ttsStylePrompt || DEFAULT_TTS_STYLE_PROMPT,
      normalizeText: ttsSettings.ttsNormalizeText !== 'false',
      normalizationOptions
    }
    
    const audioFile = await generateSectionAudio(section.id, section.chapter.folderPath, settings)
    
    // Emit complete event
    if (io) {
      io.emit('voiceover:section-complete', {
        chapterId: section.chapterId,
        sectionId: section.id,
        audioFileId: audioFile.id
      })
    }
    
    res.json(audioFile)
  } catch (error: any) {
    console.error('Error generating audio:', error)
    
    // Emit error event
    if (io) {
      io.emit('voiceover:section-error', {
        sectionId: req.params.id,
        error: error.message
      })
    }
    
    res.status(500).json({ error: error.message || 'Failed to generate audio' })
  }
})

/**
 * Generate audio for all pending sections in a chapter
 */
router.post('/chapters/:id/generate-all', async (req: Request, res: Response) => {
  try {
    const { voice, stylePrompt, concurrency = 3 } = req.body
    
    const chapter = await prisma.chapter.findUnique({
      where: { id: req.params.id },
      include: { audioSections: true }
    })
    
    if (!chapter) {
      return res.status(404).json({ error: 'Chapter not found' })
    }
    
    const pendingSections = chapter.audioSections.filter(
      s => s.status === 'pending' || s.status === 'error'
    )
    
    if (pendingSections.length === 0) {
      return res.json({ message: 'No pending sections', generated: 0 })
    }
    
    // Emit batch start
    if (io) {
      io.emit('voiceover:batch-start', {
        chapterId: chapter.id,
        totalSections: pendingSections.length
      })
    }
    
    // Get TTS settings from database
    const ttsSettings = await getTTSSettings()
    const normalizationOptions = parseNormalizationOptions(ttsSettings)
    
    const settings: VoiceoverSettings = {
      voice: voice || ttsSettings.ttsVoice || process.env.TTS_DEFAULT_VOICE || 'Iapetus',
      stylePrompt: stylePrompt || ttsSettings.ttsStylePrompt || DEFAULT_TTS_STYLE_PROMPT,
      normalizeText: ttsSettings.ttsNormalizeText !== 'false',
      normalizationOptions
    }
    
    const results = await generateAllSections(
      chapter.id,
      chapter.folderPath,
      settings,
      concurrency,
      io || undefined
    )
    
    // Emit batch complete
    if (io) {
      io.emit('voiceover:batch-complete', {
        chapterId: chapter.id,
        successful: results.filter((r: GenerationResult) => r.success).length,
        failed: results.filter((r: GenerationResult) => !r.success).length
      })
    }
    
    res.json({
      message: 'Generation complete',
      results
    })
  } catch (error) {
    console.error('Error generating all audio:', error)
    res.status(500).json({ error: 'Failed to generate audio' })
  }
})

// ============ Audio Upload ============

/**
 * Upload audio file for a section
 */
router.post('/sections/:id/upload', upload.single('audio'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' })
    }
    
    const section = await prisma.audioSection.findUnique({
      where: { id: req.params.id },
      include: { chapter: true }
    })
    
    if (!section) {
      // Clean up uploaded file
      await fs.unlink(req.file.path)
      return res.status(404).json({ error: 'Section not found' })
    }
    
    const audioFile = await uploadSectionAudio(
      section.id,
      req.file.path,
      section.chapter.folderPath,
      req.file.originalname
    )
    
    res.json(audioFile)
  } catch (error) {
    console.error('Error uploading audio:', error)
    res.status(500).json({ error: 'Failed to upload audio' })
  }
})

/**
 * Upload standalone audio (not tied to a section)
 */
router.post('/chapters/:chapterId/upload', upload.single('audio'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' })
    }
    
    const chapter = await prisma.chapter.findUnique({
      where: { id: req.params.chapterId }
    })
    
    if (!chapter) {
      await fs.unlink(req.file.path)
      return res.status(404).json({ error: 'Chapter not found' })
    }
    
    // Get metadata
    const metadata = await getAudioMetadata(req.file.path)
    
    // Create audio file record
    const audioFile = await prisma.audioFile.create({
      data: {
        chapterId: chapter.id,
        kind: 'uploaded',
        filePath: req.file.path,
        originalName: req.file.originalname,
        format: path.extname(req.file.filename).slice(1).toLowerCase(),
        durationMs: metadata.durationMs,
        status: 'done'
      }
    })
    
    res.json(audioFile)
  } catch (error) {
    console.error('Error uploading audio:', error)
    res.status(500).json({ error: 'Failed to upload audio' })
  }
})

// ============ Join Audio ============

/**
 * Join all section audio into a single file
 */
router.post('/chapters/:id/join', async (req: Request, res: Response) => {
  try {
    const { normalize = true, outputFormat = 'mp3' } = req.body
    
    const chapter = await prisma.chapter.findUnique({
      where: { id: req.params.id }
    })
    
    if (!chapter) {
      return res.status(404).json({ error: 'Chapter not found' })
    }
    
    // Emit join start
    if (io) {
      io.emit('voiceover:join-start', {
        chapterId: chapter.id
      })
    }
    
    const audioFile = await joinChapterAudio(
      chapter.id,
      chapter.folderPath,
      { normalize, outputFormat }
    )
    
    // Emit join complete
    if (io) {
      io.emit('voiceover:join-complete', {
        chapterId: chapter.id,
        audioFileId: audioFile.id
      })
    }
    
    res.json(audioFile)
  } catch (error: any) {
    console.error('Error joining audio:', error)
    
    if (io) {
      io.emit('voiceover:join-failed', {
        chapterId: req.params.id,
        error: error.message
      })
    }
    
    res.status(500).json({ error: error.message || 'Failed to join audio' })
  }
})

// ============ Voice Analysis ============

/**
 * Analyze voice consistency for a chapter
 */
router.post('/chapters/:id/analyze', async (req: Request, res: Response) => {
  try {
    const { threshold = 0.75, includeAcoustic = true } = req.body
    
    const result = await analyzeChapterVoices(req.params.id, {
      threshold,
      includeAcoustic
    })
    
    res.json(result)
  } catch (error) {
    console.error('Error analyzing voices:', error)
    res.status(500).json({ error: 'Failed to analyze voices' })
  }
})

/**
 * Get last analysis result
 */
router.get('/chapters/:id/analysis', async (req: Request, res: Response) => {
  try {
    const result = await getLastAnalysisResult(req.params.id)
    
    if (!result) {
      return res.status(404).json({ error: 'No analysis found' })
    }
    
    res.json(result)
  } catch (error) {
    console.error('Error getting analysis:', error)
    res.status(500).json({ error: 'Failed to get analysis' })
  }
})

/**
 * Check if acoustic analysis is available
 */
router.get('/analysis/status', async (req: Request, res: Response) => {
  try {
    const status = await checkAnalysisSidecarAvailable()
    res.json(status)
  } catch (error) {
    res.json({ available: false, error: 'Check failed' })
  }
})

// ============ Audio Streaming ============

/**
 * Stream an audio file
 */
router.get('/audio/:id/stream', async (req: Request, res: Response) => {
  try {
    const audioFile = await prisma.audioFile.findUnique({
      where: { id: req.params.id }
    })
    
    if (!audioFile) {
      return res.status(404).json({ error: 'Audio file not found' })
    }
    
    if (!existsSync(audioFile.filePath)) {
      return res.status(404).json({ error: 'Audio file missing from disk' })
    }
    
    const stat = await fs.stat(audioFile.filePath)
    const ext = path.extname(audioFile.filePath).slice(1).toLowerCase()
    
    const mimeTypes: Record<string, string> = {
      'wav': 'audio/wav',
      'mp3': 'audio/mpeg',
      'ogg': 'audio/ogg',
      'flac': 'audio/flac'
    }
    
    const contentType = mimeTypes[ext] || 'audio/mpeg'
    
    // Handle range requests for seeking
    const range = req.headers.range
    
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-')
      const start = parseInt(parts[0], 10)
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1
      const chunksize = (end - start) + 1
      
      const stream = createReadStream(audioFile.filePath, { start, end })
      
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': contentType
      })
      
      stream.pipe(res)
    } else {
      res.writeHead(200, {
        'Content-Length': stat.size,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes'
      })
      
      createReadStream(audioFile.filePath).pipe(res)
    }
  } catch (error) {
    console.error('Error streaming audio:', error)
    res.status(500).json({ error: 'Failed to stream audio' })
  }
})

/**
 * Download an audio file
 */
router.get('/audio/:id/download', async (req: Request, res: Response) => {
  try {
    const audioFile = await prisma.audioFile.findUnique({
      where: { id: req.params.id },
      include: { chapter: { include: { series: true } } }
    })
    
    if (!audioFile) {
      return res.status(404).json({ error: 'Audio file not found' })
    }
    
    if (!existsSync(audioFile.filePath)) {
      return res.status(404).json({ error: 'Audio file missing from disk' })
    }
    
    const ext = path.extname(audioFile.filePath)
    const filename = `${audioFile.chapter.series.title} - Ch${audioFile.chapter.number}${ext}`
    
    res.download(audioFile.filePath, filename)
  } catch (error) {
    console.error('Error downloading audio:', error)
    res.status(500).json({ error: 'Failed to download audio' })
  }
})

// ============ TTS Settings ============

/**
 * Get available voices
 */
router.get('/voices', async (req: Request, res: Response) => {
  try {
    const provider = ttsProviderFactory.getDefaultProvider()
    
    res.json({
      provider: provider?.name || 'none',
      voices: GEMINI_TTS_VOICES.map(v => ({
        id: v,
        name: v,
        provider: 'gemini'
      }))
    })
  } catch (error) {
    console.error('Error getting voices:', error)
    res.status(500).json({ error: 'Failed to get voices' })
  }
})

/**
 * Delete an audio file
 */
router.delete('/audio/:id', async (req: Request, res: Response) => {
  try {
    const audioFile = await prisma.audioFile.findUnique({
      where: { id: req.params.id }
    })
    
    if (!audioFile) {
      return res.status(404).json({ error: 'Audio file not found' })
    }
    
    // Delete file from disk
    if (existsSync(audioFile.filePath)) {
      await fs.unlink(audioFile.filePath)
    }
    
    // Delete database record
    await prisma.audioFile.delete({
      where: { id: req.params.id }
    })
    
    res.json({ message: 'Audio file deleted' })
  } catch (error) {
    console.error('Error deleting audio:', error)
    res.status(500).json({ error: 'Failed to delete audio' })
  }
})

export default router
