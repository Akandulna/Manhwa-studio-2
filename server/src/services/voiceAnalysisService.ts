/**
 * Voice Analysis Service
 * 
 * Analyzes voice consistency across audio files in a chapter.
 * Uses two layers:
 * 1. Metadata layer (cheap, exact): Compare voice names for generated files
 * 2. Acoustic layer (optional): Use Python sidecar for voice embedding comparison
 */

import { spawn } from 'child_process'
import path from 'path'
import { prisma } from '../index.js'

export interface VoiceAnalysisResult {
  verdict: 'consistent' | 'mismatch' | 'inconclusive'
  metadataConsistent: boolean
  acousticAnalysisAvailable: boolean
  acousticResult?: AcousticAnalysisResult
  perFileResults: PerFileResult[]
  warnings: string[]
}

export interface AcousticAnalysisResult {
  referenceFileId: string
  threshold: number
  scores: { fileId: string; similarity: number; isOutlier: boolean }[]
}

export interface PerFileResult {
  fileId: string
  kind: 'generated' | 'uploaded' | 'joined'
  voice?: string
  metadataMatch: boolean
  acousticSimilarity?: number
  isOutlier: boolean
  warning?: string
}

const DEFAULT_SIMILARITY_THRESHOLD = 0.75

/**
 * Check if the Python voice analysis sidecar is available
 */
export async function checkAnalysisSidecarAvailable(): Promise<{
  available: boolean
  error?: string
}> {
  const pythonPath = process.env.PYTHON_PATH || 'python3'
  const scriptPath = path.join(process.cwd(), 'scripts', 'voice_analysis.py')
  
  try {
    return new Promise((resolve) => {
      const proc = spawn(pythonPath, [scriptPath, '--check'])
      
      let stdout = ''
      let stderr = ''
      
      proc.stdout.on('data', (data) => {
        stdout += data.toString()
      })
      
      proc.stderr.on('data', (data) => {
        stderr += data.toString()
      })
      
      proc.on('close', (code) => {
        if (code === 0 && stdout.includes('ok')) {
          resolve({ available: true })
        } else {
          resolve({
            available: false,
            error: stderr || 'Voice analysis sidecar not available. Install resemblyzer or speechbrain for acoustic analysis.'
          })
        }
      })
      
      proc.on('error', () => {
        resolve({
          available: false,
          error: 'Python not found or voice_analysis.py script missing. Acoustic analysis disabled.'
        })
      })
      
      // Timeout after 10 seconds
      setTimeout(() => {
        proc.kill()
        resolve({
          available: false,
          error: 'Voice analysis check timed out'
        })
      }, 10000)
    })
  } catch {
    return {
      available: false,
      error: 'Failed to check voice analysis sidecar'
    }
  }
}

/**
 * Run acoustic analysis on audio files using Python sidecar
 */
async function runAcousticAnalysis(
  audioPaths: string[],
  threshold: number
): Promise<AcousticAnalysisResult | null> {
  const pythonPath = process.env.PYTHON_PATH || 'python3'
  const scriptPath = path.join(process.cwd(), 'scripts', 'voice_analysis.py')
  
  return new Promise((resolve) => {
    const input = JSON.stringify({
      audio_paths: audioPaths,
      threshold
    })
    
    const proc = spawn(pythonPath, [scriptPath, '--analyze'])
    
    let stdout = ''
    let stderr = ''
    
    proc.stdin.write(input)
    proc.stdin.end()
    
    proc.stdout.on('data', (data) => {
      stdout += data.toString()
    })
    
    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })
    
    proc.on('close', (code) => {
      if (code !== 0) {
        console.error('Acoustic analysis failed:', stderr)
        resolve(null)
        return
      }
      
      try {
        const result = JSON.parse(stdout)
        resolve(result)
      } catch (error) {
        console.error('Failed to parse acoustic analysis result:', error)
        resolve(null)
      }
    })
    
    proc.on('error', (error) => {
      console.error('Acoustic analysis process error:', error)
      resolve(null)
    })
    
    // Timeout after 60 seconds
    setTimeout(() => {
      proc.kill()
      resolve(null)
    }, 60000)
  })
}

/**
 * Analyze voice consistency for a chapter
 */
export async function analyzeChapterVoices(
  chapterId: string,
  options: {
    threshold?: number
    includeAcoustic?: boolean
  } = {}
): Promise<VoiceAnalysisResult> {
  const threshold = options.threshold ?? DEFAULT_SIMILARITY_THRESHOLD
  const includeAcoustic = options.includeAcoustic ?? true
  
  const warnings: string[] = []
  
  // Get all audio files for the chapter (excluding joined)
  const audioFiles = await prisma.audioFile.findMany({
    where: {
      chapterId,
      kind: { not: 'joined' },
      status: 'done'
    },
    orderBy: { createdAt: 'asc' }
  })
  
  if (audioFiles.length === 0) {
    return {
      verdict: 'inconclusive',
      metadataConsistent: true,
      acousticAnalysisAvailable: false,
      perFileResults: [],
      warnings: ['No audio files to analyze']
    }
  }
  
  if (audioFiles.length === 1) {
    warnings.push('Only one audio file - nothing to compare for consistency')
    return {
      verdict: 'inconclusive',
      metadataConsistent: true,
      acousticAnalysisAvailable: false,
      perFileResults: [{
        fileId: audioFiles[0].id,
        kind: audioFiles[0].kind as 'generated' | 'uploaded',
        voice: audioFiles[0].voice || undefined,
        metadataMatch: true,
        isOutlier: false,
        warning: 'Single file - no comparison possible'
      }],
      warnings
    }
  }
  
  // Metadata layer analysis
  const generatedFiles = audioFiles.filter(f => f.kind === 'generated')
  const uploadedFiles = audioFiles.filter(f => f.kind === 'uploaded')
  
  // Check if all generated files use the same voice
  const voices = new Set(generatedFiles.map(f => f.voice).filter(Boolean))
  const metadataConsistent = voices.size <= 1
  const referenceVoice = generatedFiles[0]?.voice
  
  const perFileResults: PerFileResult[] = audioFiles.map(file => {
    const result: PerFileResult = {
      fileId: file.id,
      kind: file.kind as 'generated' | 'uploaded',
      voice: file.voice || undefined,
      metadataMatch: file.kind === 'generated' 
        ? file.voice === referenceVoice 
        : true, // Uploaded files can't be checked by metadata
      isOutlier: false
    }
    
    if (file.kind === 'uploaded') {
      result.warning = 'Uploaded file - cannot verify voice by metadata'
    }
    
    return result
  })
  
  if (!metadataConsistent) {
    // Mark files with different voices as outliers
    for (const result of perFileResults) {
      if (result.kind === 'generated' && result.voice !== referenceVoice) {
        result.isOutlier = true
      }
    }
  }
  
  // Acoustic layer analysis (optional)
  let acousticResult: AcousticAnalysisResult | null = null
  let acousticAnalysisAvailable = false
  
  if (includeAcoustic && (uploadedFiles.length > 0 || !metadataConsistent)) {
    const sidecarCheck = await checkAnalysisSidecarAvailable()
    
    if (sidecarCheck.available) {
      acousticAnalysisAvailable = true
      
      // Check for short clips
      const shortClips = audioFiles.filter(f => f.durationMs && f.durationMs < 3000)
      if (shortClips.length > 0) {
        warnings.push(`${shortClips.length} clips are under 3 seconds - acoustic analysis may be unreliable`)
      }
      
      // Run acoustic analysis
      const audioPaths = audioFiles.map(f => f.filePath)
      acousticResult = await runAcousticAnalysis(audioPaths, threshold)
      
      if (acousticResult) {
        // Map acoustic results to per-file results
        for (const score of acousticResult.scores) {
          const fileResult = perFileResults.find(r => 
            audioFiles.find(f => f.id === r.fileId)?.filePath === audioPaths[parseInt(score.fileId)]
          )
          if (fileResult) {
            fileResult.acousticSimilarity = score.similarity
            if (score.isOutlier) {
              fileResult.isOutlier = true
            }
          }
        }
      }
    } else {
      warnings.push(sidecarCheck.error || 'Acoustic analysis not available')
    }
  }
  
  // Determine final verdict
  let verdict: 'consistent' | 'mismatch' | 'inconclusive'
  
  const hasOutliers = perFileResults.some(r => r.isOutlier)
  const hasUploadedWithoutAcoustic = uploadedFiles.length > 0 && !acousticResult
  
  if (hasOutliers) {
    verdict = 'mismatch'
  } else if (hasUploadedWithoutAcoustic) {
    verdict = 'inconclusive'
    warnings.push('Uploaded files present but acoustic analysis not available - cannot verify consistency')
  } else if (metadataConsistent && (!uploadedFiles.length || acousticResult)) {
    verdict = 'consistent'
  } else {
    verdict = 'inconclusive'
  }
  
  // Save analysis result to database
  await prisma.audioAnalysis.upsert({
    where: { chapterId },
    create: {
      chapterId,
      threshold,
      verdict,
      details: JSON.stringify({
        metadataConsistent,
        acousticAnalysisAvailable,
        perFileResults,
        warnings,
        acousticResult
      })
    },
    update: {
      threshold,
      verdict,
      details: JSON.stringify({
        metadataConsistent,
        acousticAnalysisAvailable,
        perFileResults,
        warnings,
        acousticResult
      })
    }
  })
  
  return {
    verdict,
    metadataConsistent,
    acousticAnalysisAvailable,
    acousticResult: acousticResult || undefined,
    perFileResults,
    warnings
  }
}

/**
 * Get the last analysis result for a chapter
 */
export async function getLastAnalysisResult(chapterId: string): Promise<VoiceAnalysisResult | null> {
  const analysis = await prisma.audioAnalysis.findUnique({
    where: { chapterId }
  })
  
  if (!analysis) {
    return null
  }
  
  try {
    const details = JSON.parse(analysis.details)
    return {
      verdict: analysis.verdict as 'consistent' | 'mismatch' | 'inconclusive',
      ...details
    }
  } catch {
    return null
  }
}
