/**
 * Script Generation Service for Narration Studio
 * 
 * The core continuity engine that:
 * - Generates narration scripts from chapter images
 * - Maintains story continuity across chapters
 * - Handles map-reduce batching for large chapters
 * - Manages the two-call design (script + summary)
 */

import fs from 'fs/promises'
import path from 'path'
import { Server } from 'socket.io'
import PQueue from 'p-queue'
import { prisma } from '../index.js'
import { 
  aiProviderFactory, 
  AIProvider,
  parseDelimitedResponse,
  getScriptSystemPrompt,
  getChapter1ScriptPrompt,
  getChapterNScriptPrompt,
  getBeatsToScriptChapter1Prompt,
  getBeatsToScriptChapterNPrompt,
  getBeatsToScriptSystemPrompt,
  DEFAULT_BASE_STYLE_PROMPT
} from './ai/index.js'
import {
  preprocessChapterImages,
  toImageInputs,
  batchImages,
  validateChapterImages,
  ProcessedImage,
  ImageProcessingConfig
} from './imageProcessor.js'

// Helper to get full folder path by prepending DOWNLOAD_ROOT
function getFullFolderPath(relativePath: string): string {
  const downloadRoot = process.env.DOWNLOAD_ROOT || './downloads'
  return path.join(downloadRoot, relativePath)
}

export interface GenerationConfig {
  singleCallImageCap: number    // Max images for single multimodal call
  batchSize: number             // Images per batch in map-reduce
  imageMaxWidth: number         // Max image width
  imageMaxHeight: number        // Max image height before slicing
  summaryTargetLength: number   // Target summary length in words
}

export interface GenerationProgress {
  chapterId: string
  chapterNumber: number
  stage: 'preprocessing' | 'extracting-beats' | 'generating-script' | 'generating-summary' | 'saving' | 'done' | 'failed'
  batchCurrent?: number
  batchTotal?: number
  preprocessPercent?: number
  error?: string
}

export interface RangeGenerationProgress extends GenerationProgress {
  overallCurrent: number
  overallTotal: number
}

const DEFAULT_CONFIG: GenerationConfig = {
  singleCallImageCap: 30,
  batchSize: 20,
  imageMaxWidth: 1080,
  imageMaxHeight: 4096,
  summaryTargetLength: 200
}

export class ScriptGenerationService {
  private io: Server
  private queue: PQueue
  private isRunning: boolean = false
  private currentChapterId: string | null = null
  
  constructor(io: Server) {
    this.io = io
    this.queue = new PQueue({ concurrency: 1 })
  }
  
  /**
   * Generate script for a single chapter
   */
  async generateChapterScript(
    chapterId: string,
    mode: 'api' | 'manual' = 'api',
    config: Partial<GenerationConfig> = {}
  ): Promise<{ success: boolean; error?: string }> {
    const cfg = { ...DEFAULT_CONFIG, ...config }
    
    try {
      // Get chapter with series and previous chapter info
      const chapter = await prisma.chapter.findUnique({
        where: { id: chapterId },
        include: {
          series: true,
          script: true
        }
      })
      
      if (!chapter) {
        throw new Error('Chapter not found')
      }
      
      if (chapter.status !== 'done') {
        throw new Error('Chapter must be fully downloaded before generating script')
      }
      
      // Validate images exist
      const fullFolderPath = getFullFolderPath(chapter.folderPath)
      const validation = await validateChapterImages(fullFolderPath)
      if (!validation.valid) {
        throw new Error(validation.error || 'No valid images in chapter folder')
      }
      
      this.emitProgress({
        chapterId,
        chapterNumber: chapter.number,
        stage: 'preprocessing',
        preprocessPercent: 0
      })
      
      // Create or update script record
      const scriptRecord = await prisma.chapterScript.upsert({
        where: { chapterId },
        create: {
          chapterId,
          mode,
          status: 'generating'
        },
        update: {
          mode,
          status: 'generating',
          error: null
        }
      })
      
      // Get continuity context
      const { previousSummary, previousClosing, aboutSummary } = await this.getContinuityContext(chapter)
      
      if (chapter.number > 1 && !previousSummary) {
        throw new Error(`Cannot generate Chapter ${chapter.number}: previous chapter's summary is missing. Generate chapters in order.`)
      }
      
      // Get base style prompt from settings
      const baseStylePrompt = await this.getBaseStylePrompt()
      
      if (mode === 'api') {
        return await this.generateWithAPI(
          chapter,
          scriptRecord.id,
          baseStylePrompt,
          aboutSummary,
          previousSummary,
          previousClosing,
          cfg
        )
      } else {
        // Manual mode just returns the prompt - actual generation happens when user pastes result
        return { success: true }
      }
      
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      
      await prisma.chapterScript.update({
        where: { chapterId },
        data: { 
          status: 'failed',
          error: message
        }
      }).catch(() => {})
      
      this.emitProgress({
        chapterId,
        chapterNumber: 0,
        stage: 'failed',
        error: message
      })
      
      return { success: false, error: message }
    }
  }
  
  /**
   * Generate scripts for a range of chapters
   */
  async generateRange(
    seriesId: string,
    fromChapter: number,
    toChapter: number,
    config: Partial<GenerationConfig> = {}
  ): Promise<{ success: boolean; completed: number; failed: number; errors: string[] }> {
    // Get all chapters in range
    const chapters = await prisma.chapter.findMany({
      where: {
        seriesId,
        number: { gte: fromChapter, lte: toChapter },
        status: 'done'  // Only downloaded chapters
      },
      orderBy: { number: 'asc' },
      include: { script: true }
    })
    
    if (chapters.length === 0) {
      return { 
        success: false, 
        completed: 0, 
        failed: 0, 
        errors: ['No downloaded chapters found in range'] 
      }
    }
    
    // Check if first chapter in range has previous context (if not chapter 1)
    if (chapters[0].number > 1) {
      const prevChapter = await prisma.chapter.findFirst({
        where: {
          seriesId,
          number: chapters[0].number - 1
        },
        include: { script: true }
      })
      
      if (!prevChapter?.script?.rollingSummary) {
        return {
          success: false,
          completed: 0,
          failed: 0,
          errors: [`Chapter ${chapters[0].number - 1} must be scripted first to provide continuity context`]
        }
      }
    }
    
    let completed = 0
    let failed = 0
    const errors: string[] = []
    
    for (let i = 0; i < chapters.length; i++) {
      const chapter = chapters[i]
      
      this.io.emit('narration:range-progress', {
        overallCurrent: i + 1,
        overallTotal: chapters.length,
        chapterId: chapter.id,
        chapterNumber: chapter.number
      })
      
      const result = await this.generateChapterScript(chapter.id, 'api', config)
      
      if (result.success) {
        completed++
      } else {
        failed++
        errors.push(`Chapter ${chapter.number}: ${result.error}`)
        
        // Stop on first failure to prevent cascading continuity issues
        break
      }
    }
    
    return {
      success: failed === 0,
      completed,
      failed,
      errors
    }
  }
  
  /**
   * Regenerate summary and closing from edited script
   */
  async regenerateSummary(chapterId: string): Promise<{ success: boolean; error?: string }> {
    const provider = aiProviderFactory.getDefaultProvider()
    if (!provider) {
      return { success: false, error: 'No AI provider configured' }
    }
    
    try {
      const chapter = await prisma.chapter.findUnique({
        where: { id: chapterId },
        include: { 
          series: true,
          script: true 
        }
      })
      
      if (!chapter?.script?.scriptPath) {
        return { success: false, error: 'No script found for this chapter' }
      }
      
      // Read the script file
      const scriptText = await fs.readFile(chapter.script.scriptPath, 'utf-8')
      
      // Get previous summary for context
      const { previousSummary } = await this.getContinuityContext(chapter)
      
      // Generate new summary
      const result = await provider.generateSummary({
        scriptText,
        previousSummary: previousSummary ?? undefined,
        isFirstChapter: chapter.number === 1
      })
      
      // Update database
      const updateData: any = {
        rollingSummary: result.rollingSummary,
        closingParagraph: result.closingParagraph,
        status: 'edited',
        updatedAt: new Date()
      }
      
      if (chapter.number === 1 && result.aboutSummary) {
        // Also update series about summary
        await prisma.series.update({
          where: { id: chapter.seriesId },
          data: { aboutSummary: result.aboutSummary }
        })
      }
      
      await prisma.chapterScript.update({
        where: { id: chapter.script.id },
        data: updateData
      })
      
      // Mark downstream chapters as stale
      await this.markDownstreamStale(chapter.seriesId, chapter.number)
      
      return { success: true }
      
    } catch (error) {
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }
    }
  }
  
  /**
   * Generate outro for a part-end chapter
   */
  async generateOutro(chapterId: string): Promise<{ success: boolean; outroText?: string; error?: string }> {
    const provider = aiProviderFactory.getDefaultProvider()
    if (!provider) {
      return { success: false, error: 'No AI provider configured' }
    }
    
    try {
      const chapter = await prisma.chapter.findUnique({
        where: { id: chapterId },
        include: { 
          series: true,
          script: true 
        }
      })
      
      if (!chapter?.script) {
        return { success: false, error: 'No script found for this chapter' }
      }
      
      if (!chapter.script.isPartEnd) {
        return { success: false, error: 'Chapter is not marked as part end' }
      }
      
      if (!chapter.script.rollingSummary) {
        return { success: false, error: 'Chapter summary not generated yet' }
      }
      
      // Calculate part number
      const partNumber = await this.calculatePartNumber(chapter.seriesId, chapter.number)
      
      const result = await provider.generateOutro({
        seriesTitle: chapter.series.title,
        partNumber,
        aboutSummary: chapter.series.aboutSummary || '',
        rollingSummary: chapter.script.rollingSummary
      })
      
      // Save outro to disk
      const outroPath = path.join(getFullFolderPath(chapter.folderPath), 'outro.md')
      await fs.writeFile(outroPath, result.outroText, 'utf-8')
      
      // Update database
      await prisma.chapterScript.update({
        where: { id: chapter.script.id },
        data: { 
          outroText: result.outroText,
          tokensUsed: (chapter.script.tokensUsed || 0) + (result.tokensUsed || 0)
        }
      })
      
      return { success: true, outroText: result.outroText }
      
    } catch (error) {
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }
    }
  }
  
  /**
   * Export a Part's scripts concatenated
   */
  async exportPart(seriesId: string, partNumber: number): Promise<{ success: boolean; path?: string; error?: string }> {
    try {
      const series = await prisma.series.findUnique({
        where: { id: seriesId }
      })
      
      if (!series) {
        return { success: false, error: 'Series not found' }
      }
      
      // Find all chapters in this part
      const chapters = await this.getPartChapters(seriesId, partNumber)
      
      if (chapters.length === 0) {
        return { success: false, error: 'No chapters found for this part' }
      }
      
      // Concatenate scripts
      const scriptParts: string[] = []
      let outroText = ''
      
      for (const chapter of chapters) {
        if (!chapter.script?.scriptPath) {
          return { success: false, error: `Chapter ${chapter.number} has no script` }
        }
        
        const script = await fs.readFile(chapter.script.scriptPath, 'utf-8')
        scriptParts.push(`## Chapter ${chapter.number}\n\n${script}`)
        
        if (chapter.script.isPartEnd && chapter.script.outroText) {
          outroText = chapter.script.outroText
        }
      }
      
      // Build final content
      let content = `# ${series.title} - Part ${partNumber}\n\n`
      content += scriptParts.join('\n\n---\n\n')
      
      if (outroText) {
        content += '\n\n---\n\n## Outro\n\n' + outroText
      }
      
      // Save to series folder
      const paddedPart = String(partNumber).padStart(2, '0')
      const exportPath = path.join(getFullFolderPath(series.rootFolder), `Part ${paddedPart} - full script.md`)
      await fs.writeFile(exportPath, content, 'utf-8')
      
      return { success: true, path: exportPath }
      
    } catch (error) {
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }
    }
  }
  
  // ============ Private Methods ============
  
  private async generateWithAPI(
    chapter: any,
    scriptRecordId: string,
    baseStylePrompt: string,
    aboutSummary: string | null,
    previousSummary: string | null,
    previousClosing: string | null,
    config: GenerationConfig
  ): Promise<{ success: boolean; error?: string }> {
    const provider = aiProviderFactory.getDefaultProvider()
    if (!provider) {
      throw new Error('No AI provider configured. Set GEMINI_API_KEY in .env or use Manual mode.')
    }
    
    // Preprocess images
    this.emitProgress({
      chapterId: chapter.id,
      chapterNumber: chapter.number,
      stage: 'preprocessing',
      preprocessPercent: 0
    })
    
    const imageConfig: Partial<ImageProcessingConfig> = {
      maxWidth: config.imageMaxWidth,
      maxHeight: config.imageMaxHeight
    }
    
    const processedResult = await preprocessChapterImages(
      getFullFolderPath(chapter.folderPath),
      imageConfig,
      (current, total) => {
        this.emitProgress({
          chapterId: chapter.id,
          chapterNumber: chapter.number,
          stage: 'preprocessing',
          preprocessPercent: Math.round((current / total) * 100)
        })
      }
    )
    
    let scriptText: string
    let tokensUsed = 0
    
    // Decide: single call or map-reduce
    if (processedResult.totalProcessedImages <= config.singleCallImageCap) {
      // Single call
      this.emitProgress({
        chapterId: chapter.id,
        chapterNumber: chapter.number,
        stage: 'generating-script'
      })
      
      const systemPrompt = getScriptSystemPrompt(baseStylePrompt)
      const userPrompt = chapter.number === 1
        ? getChapter1ScriptPrompt(chapter.series.title)
        : getChapterNScriptPrompt(
            chapter.series.title,
            chapter.number,
            aboutSummary || '',
            previousSummary || '',
            previousClosing || ''
          )
      
      const result = await provider.generateScript({
        images: toImageInputs(processedResult.images),
        systemPrompt,
        userPrompt
      })
      
      scriptText = result.text
      tokensUsed = result.tokensUsed || 0
      
    } else {
      // Map-reduce: extract beats in batches, then combine
      const batches = batchImages(processedResult.images, config.batchSize)
      const allBeats: string[] = []
      
      for (let i = 0; i < batches.length; i++) {
        this.emitProgress({
          chapterId: chapter.id,
          chapterNumber: chapter.number,
          stage: 'extracting-beats',
          batchCurrent: i + 1,
          batchTotal: batches.length
        })
        
        const batchResult = await provider.extractBeats({
          images: toImageInputs(batches[i]),
          batchIndex: i,
          totalBatches: batches.length
        })
        
        allBeats.push(batchResult.beats)
        tokensUsed += batchResult.tokensUsed || 0
      }
      
      // Combine beats into final script
      this.emitProgress({
        chapterId: chapter.id,
        chapterNumber: chapter.number,
        stage: 'generating-script'
      })
      
      const result = await provider.generateScriptFromBeats({
        beats: allBeats,
        systemPrompt: baseStylePrompt,
        aboutSummary: aboutSummary || undefined,
        previousSummary: previousSummary || undefined,
        previousClosingParagraph: previousClosing || undefined
      })
      
      scriptText = result.text
      tokensUsed += result.tokensUsed || 0
    }
    
    // Parse the response
    const parsed = parseDelimitedResponse(scriptText)
    
    if (!parsed.script) {
      // Try to use the whole response as script
      parsed.script = scriptText
    }
    
    // Generate/extract summary
    this.emitProgress({
      chapterId: chapter.id,
      chapterNumber: chapter.number,
      stage: 'generating-summary'
    })
    
    let rollingSummary = parsed.summary
    let closingParagraph = parsed.closing
    let newAboutSummary = parsed.about
    
    // If we didn't get summary from the script call, make a separate call
    if (!rollingSummary || !closingParagraph) {
      const summaryResult = await provider.generateSummary({
        scriptText: parsed.script,
        previousSummary: previousSummary || undefined,
        isFirstChapter: chapter.number === 1
      })
      
      rollingSummary = summaryResult.rollingSummary
      closingParagraph = summaryResult.closingParagraph
      newAboutSummary = summaryResult.aboutSummary || newAboutSummary
      tokensUsed += summaryResult.tokensUsed || 0
    }
    
    // Save script to disk
    this.emitProgress({
      chapterId: chapter.id,
      chapterNumber: chapter.number,
      stage: 'saving'
    })
    
    const scriptPath = path.join(getFullFolderPath(chapter.folderPath), 'script.md')
    await fs.writeFile(scriptPath, parsed.script, 'utf-8')
    
    // Update chapter script record
    await prisma.chapterScript.update({
      where: { id: scriptRecordId },
      data: {
        provider: provider.name,
        model: provider.model,
        scriptPath,
        status: 'done',
        rollingSummary,
        closingParagraph,
        tokensUsed,
        error: null
      }
    })
    
    // Update series aboutSummary if this is chapter 1
    if (chapter.number === 1 && newAboutSummary) {
      await prisma.series.update({
        where: { id: chapter.seriesId },
        data: { aboutSummary: newAboutSummary }
      })
      
      // Also save about.md to series folder
      const aboutPath = path.join(getFullFolderPath(chapter.series.rootFolder), 'about.md')
      await fs.writeFile(aboutPath, newAboutSummary, 'utf-8')
    }
    
    this.emitProgress({
      chapterId: chapter.id,
      chapterNumber: chapter.number,
      stage: 'done'
    })
    
    return { success: true }
  }
  
  private async getContinuityContext(chapter: any): Promise<{
    previousSummary: string | null
    previousClosing: string | null
    aboutSummary: string | null
  }> {
    if (chapter.number === 1) {
      return {
        previousSummary: null,
        previousClosing: null,
        aboutSummary: chapter.series?.aboutSummary || null
      }
    }
    
    // Find previous chapter
    const prevChapter = await prisma.chapter.findFirst({
      where: {
        seriesId: chapter.seriesId,
        number: { lt: chapter.number }
      },
      orderBy: { number: 'desc' },
      include: { script: true }
    })
    
    return {
      previousSummary: prevChapter?.script?.rollingSummary || null,
      previousClosing: prevChapter?.script?.closingParagraph || null,
      aboutSummary: chapter.series?.aboutSummary || null
    }
  }
  
  private async getBaseStylePrompt(): Promise<string> {
    const setting = await prisma.setting.findUnique({
      where: { key: 'narrationBasePrompt' }
    })
    
    return setting?.value || DEFAULT_BASE_STYLE_PROMPT
  }
  
  private async markDownstreamStale(seriesId: string, afterChapterNumber: number): Promise<void> {
    // Find all scripts for chapters after this one
    const downstreamChapters = await prisma.chapter.findMany({
      where: {
        seriesId,
        number: { gt: afterChapterNumber }
      },
      include: { script: true }
    })
    
    const scriptsToMark = downstreamChapters
      .filter(c => c.script && c.script.status === 'done')
      .map(c => c.script!.id)
    
    if (scriptsToMark.length > 0) {
      await prisma.chapterScript.updateMany({
        where: { id: { in: scriptsToMark } },
        data: { status: 'stale' }
      })
    }
  }
  
  private async calculatePartNumber(seriesId: string, upToChapterNumber: number): Promise<number> {
    // Count how many part-end chapters come before this one, plus 1
    const partEnds = await prisma.chapterScript.count({
      where: {
        chapter: {
          seriesId,
          number: { lt: upToChapterNumber }
        },
        isPartEnd: true
      }
    })
    
    return partEnds + 1
  }
  
  private async getPartChapters(seriesId: string, partNumber: number): Promise<any[]> {
    // Get all chapters with scripts, in order
    const chapters = await prisma.chapter.findMany({
      where: { seriesId },
      orderBy: { number: 'asc' },
      include: { script: true }
    })
    
    // Find part boundaries
    let currentPart = 1
    const partChapters: any[] = []
    
    for (const chapter of chapters) {
      if (currentPart === partNumber) {
        partChapters.push(chapter)
      }
      
      if (chapter.script?.isPartEnd) {
        if (currentPart === partNumber) {
          break  // We've collected all chapters for this part
        }
        currentPart++
      }
    }
    
    return partChapters
  }
  
  private emitProgress(progress: GenerationProgress): void {
    this.io.emit('narration:progress', progress)
  }
  
  /**
   * Pause/cancel running generation
   */
  pause(): void {
    this.queue.pause()
    this.isRunning = false
  }
  
  resume(): void {
    this.queue.start()
    this.isRunning = true
  }
  
  clear(): void {
    this.queue.clear()
    this.isRunning = false
  }
  
  getStatus(): { isRunning: boolean; pending: number; currentChapterId: string | null } {
    return {
      isRunning: this.isRunning,
      pending: this.queue.pending,
      currentChapterId: this.currentChapterId
    }
  }
}
