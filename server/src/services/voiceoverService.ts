/**
 * Voiceover Service
 * 
 * Handles:
 * - Splitting scripts into sections for TTS
 * - Generating audio for sections
 * - Managing audio files
 * - Joining sections into chapter audio
 */

import fs from 'fs/promises'
import path from 'path'
import { Server } from 'socket.io'
import PQueue from 'p-queue'
import { prisma } from '../index.js'
import { ttsProviderFactory } from './tts/index.js'
import { normalizeTextForTTS, NormalizationOptions } from './tts/textNormalizer.js'
import {
  pcmToWav,
  concatenateAudio,
  getAudioMetadata,
  checkFfmpegInstalled,
  validateAudioFile
} from './audioProcessor.js'

// Default configuration
const DEFAULT_TARGET_LENGTH = 500  // characters per section
const DEFAULT_GENERATION_CONCURRENCY = 2
const DEFAULT_OUTPUT_FORMAT = 'mp3'
const DEFAULT_SAMPLE_RATE = 44100

// Helper to get full folder path
function getFullFolderPath(relativePath: string): string {
  const downloadRoot = process.env.DOWNLOAD_ROOT || './downloads'
  return path.join(downloadRoot, relativePath)
}

/**
 * Backup an audio file before overwriting
 * Saves to: chapter_folder/audio/backup/
 */
async function backupAudioFile(filePath: string, chapterFolder: string): Promise<void> {
  try {
    // Check if file exists
    await fs.access(filePath)
    
    // Create backup folder
    const backupFolder = path.join(chapterFolder, 'audio', 'backup')
    await fs.mkdir(backupFolder, { recursive: true })
    
    // Generate backup filename with timestamp
    const originalName = path.basename(filePath)
    const ext = path.extname(originalName)
    const baseName = path.basename(originalName, ext)
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupName = `${baseName}_${timestamp}${ext}`
    const backupPath = path.join(backupFolder, backupName)
    
    // Copy file to backup
    await fs.copyFile(filePath, backupPath)
    console.log(`Backed up audio: ${backupPath}`)
  } catch (error) {
    // Silently fail if file doesn't exist or backup fails
    console.log(`Backup skipped: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}

export interface VoiceoverSettings {
  voice?: string
  stylePrompt?: string
  normalizeText?: boolean
  normalizationOptions?: Partial<NormalizationOptions>
}

export interface AudioSection {
  id: string
  index: number
  text: string
  status: string
}

export interface GenerationResult {
  sectionId: string
  success: boolean
  audioFileId?: string
  error?: string
}

/**
 * Split script text into sections based on target character length
 * Handles: paragraphs (double newlines), single newlines, and sentences
 */
export function splitScriptIntoSections(
  scriptText: string,
  targetLength: number = DEFAULT_TARGET_LENGTH
): { index: number; text: string }[] {
  const trimmedText = scriptText.trim()
  if (!trimmedText) {
    return []
  }

  // First try to split by paragraphs (double newlines)
  let chunks = trimmedText
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(p => p.length > 0)
  
  // If only one chunk and it's big, try splitting by single newlines
  if (chunks.length === 1 && chunks[0].length > targetLength) {
    const lineChunks = chunks[0]
      .split(/\n/)
      .map(p => p.trim())
      .filter(p => p.length > 0)
    if (lineChunks.length > 1) {
      chunks = lineChunks
    }
  }
  
  // Process chunks, splitting long ones by sentences if needed
  const processedChunks: string[] = []
  for (const chunk of chunks) {
    if (chunk.length <= targetLength) {
      processedChunks.push(chunk)
    } else {
      // Split long chunk by sentences
      const sentenceChunks = splitBySentences(chunk, targetLength)
      processedChunks.push(...sentenceChunks)
    }
  }
  
  if (processedChunks.length === 0) {
    return []
  }
  
  // Now group processed chunks into sections
  const sections: { index: number; text: string }[] = []
  let currentSection: string[] = []
  let currentLength = 0
  let sectionIndex = 0
  
  for (const chunk of processedChunks) {
    // If adding this chunk exceeds target and we have content, create a section
    if (currentLength + chunk.length > targetLength && currentSection.length > 0) {
      sections.push({
        index: sectionIndex,
        text: currentSection.join('\n\n')
      })
      currentSection = []
      currentLength = 0
      sectionIndex++
    }
    
    currentSection.push(chunk)
    currentLength += chunk.length
  }
  
  // Add remaining content as final section
  if (currentSection.length > 0) {
    sections.push({
      index: sectionIndex,
      text: currentSection.join('\n\n')
    })
  }
  
  return sections
}

/**
 * Split text by sentences, grouping them to stay under target length
 */
function splitBySentences(text: string, targetLength: number): string[] {
  // Match sentences ending with . ! ? followed by space or end
  const sentenceRegex = /[^.!?]*[.!?]+(?:\s+|$)/g
  const sentences: string[] = []
  let match: RegExpExecArray | null
  
  while ((match = sentenceRegex.exec(text)) !== null) {
    sentences.push(match[0].trim())
  }
  
  // If regex didn't find sentences, just return the text as-is
  if (sentences.length === 0) {
    return [text]
  }
  
  // Group sentences into chunks under target length
  const result: string[] = []
  let currentChunk: string[] = []
  let currentLen = 0
  
  for (const sentence of sentences) {
    if (currentLen + sentence.length > targetLength && currentChunk.length > 0) {
      result.push(currentChunk.join(' '))
      currentChunk = []
      currentLen = 0
    }
    currentChunk.push(sentence)
    currentLen += sentence.length + 1 // +1 for space
  }
  
  if (currentChunk.length > 0) {
    result.push(currentChunk.join(' '))
  }
  
  return result
}

/**
 * Initialize sections for a chapter from split script
 */
export async function initializeSections(
  chapterId: string,
  sections: { index: number; text: string }[]
): Promise<AudioSection[]> {
  // Delete existing sections
  await prisma.audioSection.deleteMany({
    where: { chapterId }
  })
  
  // Create new sections
  const createdSections = await Promise.all(
    sections.map(section =>
      prisma.audioSection.create({
        data: {
          chapterId,
          index: section.index,
          text: section.text,
          status: 'pending'
        }
      })
    )
  )
  
  return createdSections.map(s => ({
    id: s.id,
    index: s.index,
    text: s.text,
    status: s.status
  }))
}

/**
 * Generate audio for a single section
 */
export async function generateSectionAudio(
  sectionId: string,
  folderPath: string,
  settings: VoiceoverSettings
): Promise<any> {
  // Check ffmpeg
  const ffmpegCheck = checkFfmpegInstalled()
  if (!ffmpegCheck.installed) {
    throw new Error(ffmpegCheck.error || 'FFmpeg not installed')
  }
  
  // Get TTS provider
  const provider = ttsProviderFactory.getDefaultProvider()
  if (!provider) {
    throw new Error('TTS not configured. Add GEMINI_API_KEY to your .env file.')
  }
  
  // Get section
  const section = await prisma.audioSection.findUnique({
    where: { id: sectionId },
    include: { audioFile: true }
  })
  
  if (!section) {
    throw new Error('Section not found')
  }
  
  // Update status
  await prisma.audioSection.update({
    where: { id: sectionId },
    data: { status: 'generating', error: null }
  })
  
  try {
    // Get voice
    const voice = settings.voice || process.env.TTS_DEFAULT_VOICE || 'Kore'
    
    // Normalize text if enabled (default: enabled)
    let textForTTS = section.text
    if (settings.normalizeText !== false) {
      textForTTS = normalizeTextForTTS(textForTTS, {
        enabled: true,
        ...settings.normalizationOptions
      })
    }
    
    // Generate speech - stylePrompt is prepended by the provider
    const result = await provider.generateSpeech({
      text: textForTTS,
      voice,
      stylePrompt: settings.stylePrompt
    })
    
    // Create audio folder
    const chapterFolder = getFullFolderPath(folderPath)
    const audioFolder = path.join(chapterFolder, 'audio')
    await fs.mkdir(audioFolder, { recursive: true })
    
    // Save as WAV
    const sectionNum = String(section.index + 1).padStart(2, '0')
    const outputPath = path.join(audioFolder, `section_${sectionNum}.wav`)
    
    await pcmToWav(
      result.audioData,
      result.sampleRate,
      result.channels,
      result.bitsPerSample,
      outputPath
    )
    
    // Get metadata
    const metadata = await getAudioMetadata(outputPath)
    
    // Backup and delete old audio file if exists
    if (section.audioFile) {
      // Create backup before deleting
      await backupAudioFile(section.audioFile.filePath, chapterFolder)
      
      await prisma.audioFile.delete({
        where: { id: section.audioFile.id }
      }).catch(() => {})
    }
    
    // Create audio file record
    const audioFile = await prisma.audioFile.create({
      data: {
        chapterId: section.chapterId,
        sectionId: section.id,
        kind: 'generated',
        provider: provider.name,
        model: provider.model,
        voice,
        filePath: outputPath,
        format: 'wav',
        durationMs: metadata.durationMs,
        sampleRate: metadata.sampleRate,
        bytes: metadata.bytes,
        status: 'done'
      }
    })
    
    // Update section status
    await prisma.audioSection.update({
      where: { id: sectionId },
      data: { status: 'done', error: null }
    })
    
    return audioFile
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    
    await prisma.audioSection.update({
      where: { id: sectionId },
      data: { status: 'error', error: errorMessage }
    }).catch(() => {})
    
    throw error
  }
}

/**
 * Generate audio for all pending sections in a chapter
 */
export async function generateAllSections(
  chapterId: string,
  folderPath: string,
  settings: VoiceoverSettings,
  concurrency: number = DEFAULT_GENERATION_CONCURRENCY,
  io?: Server
): Promise<GenerationResult[]> {
  // Get pending sections
  const sections = await prisma.audioSection.findMany({
    where: { 
      chapterId,
      status: { in: ['pending', 'error'] }
    },
    orderBy: { index: 'asc' }
  })
  
  if (sections.length === 0) {
    return []
  }
  
  const queue = new PQueue({ concurrency })
  const results: GenerationResult[] = []
  let completed = 0
  
  const promises = sections.map(section =>
    queue.add(async () => {
      try {
        // Emit progress
        if (io) {
          io.emit('voiceover:batch-progress', {
            chapterId,
            completed: completed + 1,
            total: sections.length
          })
        }
        
        const audioFile = await generateSectionAudio(section.id, folderPath, settings)
        completed++
        
        results.push({
          sectionId: section.id,
          success: true,
          audioFileId: audioFile.id
        })
      } catch (error) {
        completed++
        results.push({
          sectionId: section.id,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        })
      }
    })
  )
  
  await Promise.all(promises)
  
  return results
}

/**
 * Upload audio file for a section
 */
export async function uploadSectionAudio(
  sectionId: string,
  filePath: string,
  folderPath: string,
  originalName?: string
): Promise<any> {
  // Validate the audio file
  const validation = await validateAudioFile(filePath)
  if (!validation.valid) {
    throw new Error(validation.error || 'Invalid audio file')
  }
  
  // Get section
  const section = await prisma.audioSection.findUnique({
    where: { id: sectionId },
    include: { audioFile: true }
  })
  
  if (!section) {
    throw new Error('Section not found')
  }
  
  // Create audio folder
  const chapterFolder = getFullFolderPath(folderPath)
  const audioFolder = path.join(chapterFolder, 'audio')
  await fs.mkdir(audioFolder, { recursive: true })
  
  // Copy file
  const ext = path.extname(filePath) || '.wav'
  const sectionNum = String(section.index + 1).padStart(2, '0')
  const destPath = path.join(audioFolder, `section_${sectionNum}_upload${ext}`)
  
  await fs.copyFile(filePath, destPath)
  
  // Get metadata
  const metadata = await getAudioMetadata(destPath)
  
  // Delete old audio file if exists
  if (section.audioFile) {
    await prisma.audioFile.delete({
      where: { id: section.audioFile.id }
    }).catch(() => {})
  }
  
  // Create audio file record
  const audioFile = await prisma.audioFile.create({
    data: {
      chapterId: section.chapterId,
      sectionId: section.id,
      kind: 'uploaded',
      filePath: destPath,
      originalName: originalName || null,
      format: ext.replace('.', ''),
      durationMs: metadata.durationMs,
      sampleRate: metadata.sampleRate,
      bytes: metadata.bytes,
      status: 'done'
    }
  })
  
  // Update section status
  await prisma.audioSection.update({
    where: { id: sectionId },
    data: { status: 'uploaded', error: null }
  })
  
  return audioFile
}

/**
 * Join all section audio into a single chapter audio file
 */
export async function joinChapterAudio(
  chapterId: string,
  folderPath: string,
  options: { normalize?: boolean; outputFormat?: string } = {}
): Promise<any> {
  // Check ffmpeg
  const ffmpegCheck = checkFfmpegInstalled()
  if (!ffmpegCheck.installed) {
    throw new Error(ffmpegCheck.error || 'FFmpeg not installed')
  }
  
  // Get sections with audio
  const sections = await prisma.audioSection.findMany({
    where: { chapterId },
    orderBy: { index: 'asc' },
    include: { audioFile: true }
  })
  
  if (sections.length === 0) {
    throw new Error('No sections found')
  }
  
  // Check all sections have audio
  const missingSections = sections.filter(s => !s.audioFile || s.audioFile.status !== 'done')
  if (missingSections.length > 0) {
    throw new Error(`Missing audio for sections: ${missingSections.map(s => s.index + 1).join(', ')}`)
  }
  
  // Get audio paths
  const audioPaths = sections.map(s => s.audioFile!.filePath)
  
  // Create output path
  const chapterFolder = getFullFolderPath(folderPath)
  const audioFolder = path.join(chapterFolder, 'audio')
  const outputFormat = (options.outputFormat || DEFAULT_OUTPUT_FORMAT) as 'wav' | 'mp3'
  
  // Get chapter number for filename
  const chapter = await prisma.chapter.findUnique({
    where: { id: chapterId }
  })
  
  const chapterNum = String(chapter?.number || 0).padStart(3, '0')
  const outputPath = path.join(audioFolder, `chapter_${chapterNum}_full.${outputFormat}`)
  
  // Concatenate
  const metadata = await concatenateAudio(audioPaths, outputPath, {
    outputFormat,
    sampleRate: DEFAULT_SAMPLE_RATE,
    normalize: options.normalize !== false
  })
  
  // Delete old joined file
  await prisma.audioFile.deleteMany({
    where: { chapterId, kind: 'joined' }
  })
  
  // Create audio file record
  const audioFile = await prisma.audioFile.create({
    data: {
      chapterId,
      sectionId: null,
      kind: 'joined',
      filePath: outputPath,
      format: outputFormat,
      durationMs: metadata.durationMs,
      sampleRate: metadata.sampleRate,
      bytes: metadata.bytes,
      status: 'done'
    }
  })
  
  return audioFile
}

/**
 * Get voiceover status for a chapter
 */
export function getChapterVoiceoverStatus(
  sections: any[],
  audioFiles: any[]
): {
  totalSections: number
  generatedSections: number
  hasJoinedAudio: boolean
  status: 'none' | 'partial' | 'done'
} {
  const generatedSections = sections.filter(
    s => s.status === 'done' || s.status === 'uploaded'
  ).length

  const hasJoinedAudio = audioFiles.some(f => f.kind === 'joined')

  const status: 'none' | 'partial' | 'done' =
    sections.length === 0 || generatedSections === 0 ? 'none'
      : generatedSections >= sections.length ? 'done'
        : 'partial'

  return {
    totalSections: sections.length,
    generatedSections,
    hasJoinedAudio,
    status
  }
}
