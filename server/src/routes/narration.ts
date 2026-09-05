/**
 * Narration API Routes for Narration Studio
 */

import { Router, Request, Response } from 'express'
import fs from 'fs/promises'
import path from 'path'
import { prisma } from '../index.js'
import { ScriptGenerationService } from '../services/scriptGenerator.js'
import { validateChapterImages } from '../services/imageProcessor.js'
import { getChapterVoiceoverStatus } from '../services/voiceoverService.js'
import { 
  aiProviderFactory, 
  buildManualModePrompt,
  parseDelimitedResponse,
  DEFAULT_BASE_STYLE_PROMPT
} from '../services/ai/index.js'
import { Server } from 'socket.io'

const router = Router()

// Store script generator instance
let scriptGenerator: ScriptGenerationService | null = null

// Helper to get the full folder path by prepending DOWNLOAD_ROOT
function getFullFolderPath(relativePath: string): string {
  const downloadRoot = process.env.DOWNLOAD_ROOT || './downloads'
  return path.join(downloadRoot, relativePath)
}

export function initNarrationRoutes(io: Server): Router {
  scriptGenerator = new ScriptGenerationService(io)
  return router
}

// ============ Series/Chapter Listing (reuse existing data) ============

/**
 * Get all series with script progress info
 */
router.get('/series', async (req: Request, res: Response) => {
  try {
    const series = await prisma.series.findMany({
      include: {
        chapters: {
          where: { status: 'done' },  // Only show downloaded chapters
          include: { script: true },
          orderBy: { number: 'asc' }
        },
        _count: {
          select: {
            chapters: { where: { status: 'done' } }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    })
    
    // Add script progress stats
    const result = series.map(s => {
      const downloadedCount = s._count.chapters
      const scriptedCount = s.chapters.filter(c => 
        c.script?.status === 'done' || c.script?.status === 'edited'
      ).length
      
      return {
        id: s.id,
        title: s.title,
        sourceSite: s.sourceSite,
        coverPath: s.coverPath,
        rootFolder: s.rootFolder,
        aboutSummary: s.aboutSummary,
        createdAt: s.createdAt,
        downloadedChapterCount: downloadedCount,
        scriptedChapterCount: scriptedCount
      }
    })
    
    res.json(result)
  } catch (error) {
    console.error('Error fetching series for narration:', error)
    res.status(500).json({ error: 'Failed to fetch series' })
  }
})

/**
 * Get a series with all chapters and script status
 */
router.get('/series/:id', async (req: Request, res: Response) => {
  try {
    const series = await prisma.series.findUnique({
      where: { id: req.params.id },
      include: {
        chapters: {
          where: { status: 'done' },
          include: {
            script: true,
            audioSections: { select: { status: true } }
          },
          orderBy: { number: 'asc' }
        }
      }
    })
    
    if (!series) {
      return res.status(404).json({ error: 'Series not found' })
    }
    
    // Calculate part numbers for chapters
    let currentPart = 1
    const chaptersWithParts = series.chapters.map(chapter => {
      const partNum = currentPart
      if (chapter.script?.isPartEnd) {
        currentPart++
      }

      // Voiceover progress (none/partial/done) — reuse the shared reducer so the
      // "what counts as voiced" rule lives in one place. audioFiles aren't needed
      // here (only the section-derived status), so pass an empty list.
      const vo = getChapterVoiceoverStatus(chapter.audioSections, [])

      return {
        id: chapter.id,
        number: chapter.number,
        title: chapter.title,
        folderPath: chapter.folderPath,
        pageCount: chapter.pageCount,
        voiceover: {
          status: vo.status,
          totalSections: vo.totalSections,
          withAudio: vo.generatedSections
        },
        script: chapter.script ? {
          id: chapter.script.id,
          status: chapter.script.status,
          mode: chapter.script.mode,
          isPartEnd: chapter.script.isPartEnd,
          hasOutro: !!chapter.script.outroText,
          error: chapter.script.error,
          updatedAt: chapter.script.updatedAt
        } : null,
        partNumber: partNum
      }
    })
    
    res.json({
      id: series.id,
      title: series.title,
      sourceSite: series.sourceSite,
      coverPath: series.coverPath,
      rootFolder: series.rootFolder,
      aboutSummary: series.aboutSummary,
      createdAt: series.createdAt,
      chapters: chaptersWithParts
    })
  } catch (error) {
    console.error('Error fetching series:', error)
    res.status(500).json({ error: 'Failed to fetch series' })
  }
})

// ============ Chapter Script Operations ============

/**
 * Get chapter script details (including continuity context)
 */
router.get('/chapters/:id', async (req: Request, res: Response) => {
  try {
    const chapter = await prisma.chapter.findUnique({
      where: { id: req.params.id },
      include: {
        series: true,
        script: true
      }
    })
    
    if (!chapter) {
      return res.status(404).json({ error: 'Chapter not found' })
    }
    
    // Validate images
    const fullFolderPath = getFullFolderPath(chapter.folderPath)
    const imageValidation = await validateChapterImages(fullFolderPath)
    
    // Get previous chapter's continuity
    let previousContext = null
    if (chapter.number > 1) {
      const prevChapter = await prisma.chapter.findFirst({
        where: {
          seriesId: chapter.seriesId,
          number: { lt: chapter.number }
        },
        orderBy: { number: 'desc' },
        include: { script: true }
      })
      
      if (prevChapter?.script) {
        previousContext = {
          chapterNumber: prevChapter.number,
          rollingSummary: prevChapter.script.rollingSummary,
          closingParagraph: prevChapter.script.closingParagraph
        }
      }
    }
    
    // Read script content if exists
    let scriptContent = null
    if (chapter.script?.scriptPath) {
      try {
        scriptContent = await fs.readFile(chapter.script.scriptPath, 'utf-8')
      } catch {
        // File might not exist
      }
    }
    
    // Read outro if exists
    let outroContent = null
    if (chapter.script?.isPartEnd) {
      const outroPath = path.join(fullFolderPath, 'outro.md')
      try {
        outroContent = await fs.readFile(outroPath, 'utf-8')
      } catch {
        outroContent = chapter.script.outroText || null
      }
    }
    
    // Get adjacent chapter IDs for navigation
    const [prevChapterNav, nextChapterNav] = await Promise.all([
      prisma.chapter.findFirst({
        where: {
          seriesId: chapter.seriesId,
          number: { lt: chapter.number },
          status: 'done'
        },
        orderBy: { number: 'desc' },
        select: { id: true, number: true }
      }),
      prisma.chapter.findFirst({
        where: {
          seriesId: chapter.seriesId,
          number: { gt: chapter.number },
          status: 'done'
        },
        orderBy: { number: 'asc' },
        select: { id: true, number: true }
      })
    ])
    
    res.json({
      id: chapter.id,
      number: chapter.number,
      title: chapter.title,
      seriesId: chapter.seriesId,
      seriesTitle: chapter.series.title,
      folderPath: chapter.folderPath,
      imageCount: imageValidation.imageCount,
      imagesValid: imageValidation.valid,
      imageError: imageValidation.error,
      aboutSummary: chapter.series.aboutSummary,
      script: chapter.script ? {
        ...chapter.script,
        content: scriptContent,
        outroContent
      } : null,
      previousContext,
      prevChapterId: prevChapterNav?.id || null,
      prevChapterNumber: prevChapterNav?.number || null,
      nextChapterId: nextChapterNav?.id || null,
      nextChapterNumber: nextChapterNav?.number || null
    })
  } catch (error) {
    console.error('Error fetching chapter:', error)
    res.status(500).json({ error: 'Failed to fetch chapter' })
  }
})

/**
 * Generate script for a chapter (API mode)
 */
router.post('/chapters/:id/generate', async (req: Request, res: Response) => {
  if (!scriptGenerator) {
    return res.status(500).json({ error: 'Script generator not initialized' })
  }
  
  try {
    const { config } = req.body || {}
    
    const result = await scriptGenerator.generateChapterScript(
      req.params.id,
      'api',
      config
    )
    
    if (result.success) {
      res.json({ success: true })
    } else {
      res.status(400).json({ error: result.error })
    }
  } catch (error) {
    console.error('Error generating script:', error)
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Failed to generate script' 
    })
  }
})

/**
 * Get manual mode prompt for a chapter
 */
router.get('/chapters/:id/manual-prompt', async (req: Request, res: Response) => {
  try {
    const chapter = await prisma.chapter.findUnique({
      where: { id: req.params.id },
      include: {
        series: true,
        script: true
      }
    })
    
    if (!chapter) {
      return res.status(404).json({ error: 'Chapter not found' })
    }
    
    // Get base style prompt
    const styleSetting = await prisma.setting.findUnique({
      where: { key: 'narrationBasePrompt' }
    })
    const baseStylePrompt = styleSetting?.value || DEFAULT_BASE_STYLE_PROMPT
    
    // Get continuity context
    let previousSummary: string | undefined
    let previousClosing: string | undefined
    
    if (chapter.number > 1) {
      const prevChapter = await prisma.chapter.findFirst({
        where: {
          seriesId: chapter.seriesId,
          number: { lt: chapter.number }
        },
        orderBy: { number: 'desc' },
        include: { script: true }
      })
      
      previousSummary = prevChapter?.script?.rollingSummary || undefined
      previousClosing = prevChapter?.script?.closingParagraph || undefined
    }
    
    const prompt = buildManualModePrompt(
      baseStylePrompt,
      chapter.series.title,
      chapter.number,
      chapter.series.aboutSummary || undefined,
      previousSummary,
      previousClosing
    )
    
    // Get list of image files
    const imageFiles = await getImageFileList(getFullFolderPath(chapter.folderPath))
    
    res.json({
      prompt,
      folderPath: getFullFolderPath(chapter.folderPath),
      imageFiles,
      chapterNumber: chapter.number,
      seriesTitle: chapter.series.title
    })
  } catch (error) {
    console.error('Error building manual prompt:', error)
    res.status(500).json({ error: 'Failed to build manual prompt' })
  }
})

/**
 * Submit manual mode result
 */
router.post('/chapters/:id/manual-submit', async (req: Request, res: Response) => {
  try {
    const { response } = req.body
    
    if (!response) {
      return res.status(400).json({ error: 'Response text required' })
    }
    
    const chapter = await prisma.chapter.findUnique({
      where: { id: req.params.id },
      include: {
        series: true,
        script: true
      }
    })
    
    if (!chapter) {
      return res.status(404).json({ error: 'Chapter not found' })
    }
    
    // Parse the response
    const parsed = parseDelimitedResponse(response)
    
    // Validate we got at least a script
    const scriptContent = parsed.script || response
    
    // Save script to disk
    const scriptPath = path.join(getFullFolderPath(chapter.folderPath), 'script.md')
    await fs.writeFile(scriptPath, scriptContent, 'utf-8')
    
    // Create or update script record
    const scriptData = {
      mode: 'manual' as const,
      scriptPath,
      status: 'done',
      rollingSummary: parsed.summary || null,
      closingParagraph: parsed.closing || null,
      error: null
    }
    
    if (chapter.script) {
      await prisma.chapterScript.update({
        where: { id: chapter.script.id },
        data: scriptData
      })
    } else {
      await prisma.chapterScript.create({
        data: {
          chapterId: chapter.id,
          ...scriptData
        }
      })
    }
    
    // Update series about if this is chapter 1 and we got an about
    if (chapter.number === 1 && parsed.about) {
      await prisma.series.update({
        where: { id: chapter.seriesId },
        data: { aboutSummary: parsed.about }
      })
      
      // Save about.md
      const aboutPath = path.join(getFullFolderPath(chapter.series.rootFolder), 'about.md')
      await fs.writeFile(aboutPath, parsed.about, 'utf-8')
    }
    
    res.json({
      success: true,
      parsed: {
        hasScript: !!parsed.script,
        hasSummary: !!parsed.summary,
        hasClosing: !!parsed.closing,
        hasAbout: !!parsed.about
      },
      needsSummaryRegeneration: !parsed.summary || !parsed.closing
    })
  } catch (error) {
    console.error('Error submitting manual result:', error)
    res.status(500).json({ error: 'Failed to save manual result' })
  }
})

/**
 * Save edited script
 */
router.put('/chapters/:id/script', async (req: Request, res: Response) => {
  try {
    const { content } = req.body
    
    if (content === undefined) {
      return res.status(400).json({ error: 'Script content required' })
    }
    
    const chapter = await prisma.chapter.findUnique({
      where: { id: req.params.id },
      include: { script: true }
    })
    
    if (!chapter) {
      return res.status(404).json({ error: 'Chapter not found' })
    }
    
    const scriptPath = path.join(getFullFolderPath(chapter.folderPath), 'script.md')
    await fs.writeFile(scriptPath, content, 'utf-8')
    
    if (chapter.script) {
      await prisma.chapterScript.update({
        where: { id: chapter.script.id },
        data: {
          scriptPath,
          status: 'edited'
        }
      })
    } else {
      await prisma.chapterScript.create({
        data: {
          chapterId: chapter.id,
          scriptPath,
          mode: 'manual',
          status: 'edited'
        }
      })
    }
    
    res.json({ success: true })
  } catch (error) {
    console.error('Error saving script:', error)
    res.status(500).json({ error: 'Failed to save script' })
  }
})

/**
 * Regenerate summary from edited script
 */
router.post('/chapters/:id/regenerate-summary', async (req: Request, res: Response) => {
  if (!scriptGenerator) {
    return res.status(500).json({ error: 'Script generator not initialized' })
  }
  
  try {
    const result = await scriptGenerator.regenerateSummary(req.params.id)
    
    if (result.success) {
      res.json({ success: true })
    } else {
      res.status(400).json({ error: result.error })
    }
  } catch (error) {
    console.error('Error regenerating summary:', error)
    res.status(500).json({ error: 'Failed to regenerate summary' })
  }
})

/**
 * Toggle part end status
 */
router.post('/chapters/:id/toggle-part-end', async (req: Request, res: Response) => {
  try {
    const chapter = await prisma.chapter.findUnique({
      where: { id: req.params.id },
      include: { script: true }
    })
    
    if (!chapter) {
      return res.status(404).json({ error: 'Chapter not found' })
    }
    
    const newIsPartEnd = !chapter.script?.isPartEnd
    
    if (chapter.script) {
      await prisma.chapterScript.update({
        where: { id: chapter.script.id },
        data: { isPartEnd: newIsPartEnd }
      })
    } else {
      await prisma.chapterScript.create({
        data: {
          chapterId: chapter.id,
          mode: 'manual',
          status: 'none',
          isPartEnd: newIsPartEnd
        }
      })
    }
    
    res.json({ success: true, isPartEnd: newIsPartEnd })
  } catch (error) {
    console.error('Error toggling part end:', error)
    res.status(500).json({ error: 'Failed to toggle part end' })
  }
})

/**
 * Generate outro for part-end chapter
 */
router.post('/chapters/:id/generate-outro', async (req: Request, res: Response) => {
  if (!scriptGenerator) {
    return res.status(500).json({ error: 'Script generator not initialized' })
  }
  
  try {
    const result = await scriptGenerator.generateOutro(req.params.id)
    
    if (result.success) {
      res.json({ success: true, outroText: result.outroText })
    } else {
      res.status(400).json({ error: result.error })
    }
  } catch (error) {
    console.error('Error generating outro:', error)
    res.status(500).json({ error: 'Failed to generate outro' })
  }
})

// ============ Range Generation ============

/**
 * Generate scripts for a range of chapters
 */
router.post('/series/:id/generate-range', async (req: Request, res: Response) => {
  if (!scriptGenerator) {
    return res.status(500).json({ error: 'Script generator not initialized' })
  }
  
  try {
    const { fromChapter, toChapter, config } = req.body
    
    if (fromChapter === undefined || toChapter === undefined) {
      return res.status(400).json({ error: 'fromChapter and toChapter required' })
    }
    
    // Start generation in background and return immediately
    scriptGenerator.generateRange(
      req.params.id,
      fromChapter,
      toChapter,
      config
    ).then(result => {
      const io = req.app.get('io') as Server
      io.emit('narration:range-complete', result)
    }).catch(error => {
      const io = req.app.get('io') as Server
      io.emit('narration:range-complete', {
        success: false,
        completed: 0,
        failed: 1,
        errors: [error.message]
      })
    })
    
    res.json({ started: true })
  } catch (error) {
    console.error('Error starting range generation:', error)
    res.status(500).json({ error: 'Failed to start range generation' })
  }
})

// ============ Part Export ============

/**
 * Export a part's scripts
 */
router.post('/series/:id/export-part', async (req: Request, res: Response) => {
  if (!scriptGenerator) {
    return res.status(500).json({ error: 'Script generator not initialized' })
  }
  
  try {
    const { partNumber } = req.body
    
    if (!partNumber) {
      return res.status(400).json({ error: 'partNumber required' })
    }
    
    const result = await scriptGenerator.exportPart(req.params.id, partNumber)
    
    if (result.success) {
      res.json({ success: true, path: result.path })
    } else {
      res.status(400).json({ error: result.error })
    }
  } catch (error) {
    console.error('Error exporting part:', error)
    res.status(500).json({ error: 'Failed to export part' })
  }
})

// ============ AI Provider Status ============

/**
 * Get AI provider status
 */
router.get('/ai/status', async (req: Request, res: Response) => {
  try {
    const defaultProvider = aiProviderFactory.getDefaultProvider()
    const availableProviders = aiProviderFactory.getAvailableProviders()
    
    let connectionTest = null
    if (defaultProvider) {
      connectionTest = await defaultProvider.testConnection()
    }
    
    // Check if API key exists (don't return the actual value)
    const hasApiKey = !!process.env.GEMINI_API_KEY
    
    res.json({
      configured: !!defaultProvider,
      defaultProvider: defaultProvider?.name || null,
      model: defaultProvider?.model || null,
      availableProviders,
      connectionTest,
      hasApiKey
    })
  } catch (error) {
    console.error('Error getting AI status:', error)
    res.status(500).json({ error: 'Failed to get AI status' })
  }
})

/**
 * Save Gemini API Key
 */
router.post('/ai/api-key', async (req: Request, res: Response) => {
  try {
    const { apiKey } = req.body
    
    if (!apiKey || typeof apiKey !== 'string') {
      return res.status(400).json({ error: 'API key is required' })
    }
    
    // Read current .env file
    const envPath = path.join(process.cwd(), '.env')
    let envContent = ''
    
    try {
      envContent = await fs.readFile(envPath, 'utf-8')
    } catch {
      // .env doesn't exist, create a new one
      envContent = ''
    }
    
    // Update or add GEMINI_API_KEY
    const lines = envContent.split('\n')
    let keyFound = false
    
    const updatedLines = lines.map(line => {
      if (line.startsWith('GEMINI_API_KEY=')) {
        keyFound = true
        return `GEMINI_API_KEY=${apiKey}`
      }
      return line
    })
    
    if (!keyFound) {
      updatedLines.push(`GEMINI_API_KEY=${apiKey}`)
    }
    
    // Also ensure AI_PROVIDER and AI_MODEL are set
    if (!updatedLines.some(l => l.startsWith('AI_PROVIDER='))) {
      updatedLines.push('AI_PROVIDER=gemini')
    }
    if (!updatedLines.some(l => l.startsWith('AI_MODEL='))) {
      updatedLines.push('AI_MODEL=gemini-3.5-flash')
    }
    
    // Write back to .env
    await fs.writeFile(envPath, updatedLines.join('\n'), 'utf-8')
    
    // Update process.env so it takes effect immediately
    process.env.GEMINI_API_KEY = apiKey
    process.env.AI_PROVIDER = process.env.AI_PROVIDER || 'gemini'
    process.env.AI_MODEL = process.env.AI_MODEL || 'gemini-3.5-flash'
    
    // Reinitialize the AI provider
    aiProviderFactory.reinitialize()
    
    // Test the connection
    const provider = aiProviderFactory.getDefaultProvider()
    let connectionTest = null
    if (provider) {
      connectionTest = await provider.testConnection()
    }
    
    res.json({
      success: true,
      configured: !!provider,
      connectionTest
    })
  } catch (error) {
    console.error('Error saving API key:', error)
    res.status(500).json({ error: 'Failed to save API key' })
  }
})

/**
 * Save AI Model Settings
 */
router.post('/ai/models', async (req: Request, res: Response) => {
  try {
    const { scriptModel, summaryModel } = req.body
    
    // Read current .env file
    const envPath = path.join(process.cwd(), '.env')
    let envContent = ''
    
    try {
      envContent = await fs.readFile(envPath, 'utf-8')
    } catch {
      envContent = ''
    }
    
    const lines = envContent.split('\n')
    
    // Helper to update or add a line
    const updateEnvLine = (key: string, value: string) => {
      const idx = lines.findIndex(l => l.startsWith(`${key}=`))
      if (idx >= 0) {
        lines[idx] = `${key}=${value}`
      } else {
        lines.push(`${key}=${value}`)
      }
    }
    
    if (scriptModel) {
      updateEnvLine('AI_MODEL', scriptModel)
      process.env.AI_MODEL = scriptModel
    }
    
    if (summaryModel) {
      updateEnvLine('AI_SUMMARY_MODEL', summaryModel)
      process.env.AI_SUMMARY_MODEL = summaryModel
    }
    
    // Write back
    await fs.writeFile(envPath, lines.join('\n'), 'utf-8')
    
    // Reinitialize providers
    aiProviderFactory.reinitialize()
    
    res.json({ success: true })
  } catch (error) {
    console.error('Error saving AI models:', error)
    res.status(500).json({ error: 'Failed to save AI model settings' })
  }
})

// ============ Helpers ============

async function getImageFileList(folderPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(folderPath)
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif']
    
    return entries
      .filter(name => {
        const ext = path.extname(name).toLowerCase()
        return imageExtensions.includes(ext)
      })
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  } catch {
    return []
  }
}

export default router
