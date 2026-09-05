/**
 * Audio Processing Service
 * 
 * Handles audio file operations using ffmpeg:
 * - Converting raw PCM to WAV/MP3
 * - Normalizing audio for consistent levels
 * - Concatenating multiple audio files
 * - Getting audio metadata (duration, format, etc.)
 */

import { spawn, execSync } from 'child_process'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

export interface AudioMetadata {
  durationMs: number
  format: string
  sampleRate: number
  channels: number
  bitrate?: number
  bytes: number
}

export interface ConcatOptions {
  outputFormat?: 'wav' | 'mp3'
  sampleRate?: number
  normalize?: boolean
}

/**
 * Check if ffmpeg is installed and available
 */
export function checkFfmpegInstalled(): { installed: boolean; version?: string; error?: string } {
  try {
    const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg'
    const result = execSync(`${ffmpegPath} -version`, { encoding: 'utf-8', timeout: 5000 })
    const versionMatch = result.match(/ffmpeg version ([^\s]+)/)
    return { 
      installed: true, 
      version: versionMatch?.[1] || 'unknown' 
    }
  } catch (error) {
    return { 
      installed: false, 
      error: 'ffmpeg is not installed or not in PATH. Please install ffmpeg to use audio features.' 
    }
  }
}

/**
 * Get the ffmpeg executable path
 */
function getFfmpegPath(): string {
  return process.env.FFMPEG_PATH || 'ffmpeg'
}

/**
 * Get the ffprobe executable path
 */
function getFfprobePath(): string {
  return process.env.FFPROBE_PATH || 'ffprobe'
}

/**
 * Convert raw PCM audio to WAV format
 */
export async function pcmToWav(
  pcmData: Buffer,
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
  outputPath: string
): Promise<void> {
  // Create WAV header
  const byteRate = sampleRate * channels * (bitsPerSample / 8)
  const blockAlign = channels * (bitsPerSample / 8)
  const dataSize = pcmData.length
  const headerSize = 44
  const fileSize = headerSize + dataSize - 8
  
  const header = Buffer.alloc(headerSize)
  
  // RIFF header
  header.write('RIFF', 0)
  header.writeUInt32LE(fileSize, 4)
  header.write('WAVE', 8)
  
  // fmt chunk
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)  // chunk size
  header.writeUInt16LE(1, 20)   // audio format (PCM)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  
  // data chunk
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)
  
  // Combine header and data
  const wavData = Buffer.concat([header, pcmData])
  
  // Ensure directory exists
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  
  // Write to file
  await fs.writeFile(outputPath, wavData)
}

/**
 * Convert raw PCM to WAV using ffmpeg (more robust)
 */
export async function pcmToWavFfmpeg(
  pcmData: Buffer,
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
  outputPath: string
): Promise<void> {
  // Ensure directory exists
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  
  // Create a temporary file for the PCM data
  const tempPcmPath = path.join(os.tmpdir(), `pcm_${Date.now()}.raw`)
  await fs.writeFile(tempPcmPath, pcmData)
  
  try {
    const ffmpegPath = getFfmpegPath()
    const sampleFormat = bitsPerSample === 16 ? 's16le' : 's32le'
    
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegPath, [
        '-f', sampleFormat,
        '-ar', String(sampleRate),
        '-ac', String(channels),
        '-i', tempPcmPath,
        '-y',  // Overwrite output
        outputPath
      ])
      
      let stderr = ''
      proc.stderr.on('data', (data) => {
        stderr += data.toString()
      })
      
      proc.on('close', (code) => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`))
        }
      })
      
      proc.on('error', reject)
    })
  } finally {
    // Cleanup temp file
    await fs.unlink(tempPcmPath).catch(() => {})
  }
}

/**
 * Get audio file metadata using ffprobe
 */
export async function getAudioMetadata(filePath: string): Promise<AudioMetadata> {
  const ffprobePath = getFfprobePath()
  
  return new Promise((resolve, reject) => {
    const proc = spawn(ffprobePath, [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath
    ])
    
    let stdout = ''
    let stderr = ''
    
    proc.stdout.on('data', (data) => {
      stdout += data.toString()
    })
    
    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })
    
    proc.on('close', async (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe failed: ${stderr}`))
        return
      }
      
      try {
        const info = JSON.parse(stdout)
        const audioStream = info.streams?.find((s: any) => s.codec_type === 'audio')
        const format = info.format
        
        // Get file size
        const stats = await fs.stat(filePath)
        
        resolve({
          durationMs: Math.round(parseFloat(format?.duration || '0') * 1000),
          format: format?.format_name || 'unknown',
          sampleRate: parseInt(audioStream?.sample_rate || '44100'),
          channels: parseInt(audioStream?.channels || '1'),
          bitrate: format?.bit_rate ? parseInt(format.bit_rate) : undefined,
          bytes: stats.size
        })
      } catch (error) {
        reject(new Error(`Failed to parse ffprobe output: ${error}`))
      }
    })
    
    proc.on('error', reject)
  })
}

/**
 * Normalize audio levels
 */
export async function normalizeAudio(
  inputPath: string,
  outputPath: string,
  targetLoudness: number = -16  // LUFS
): Promise<void> {
  const ffmpegPath = getFfmpegPath()
  
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegPath, [
      '-i', inputPath,
      '-af', `loudnorm=I=${targetLoudness}:TP=-1.5:LRA=11`,
      '-y',
      outputPath
    ])
    
    let stderr = ''
    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })
    
    proc.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Normalization failed: ${stderr}`))
      }
    })
    
    proc.on('error', reject)
  })
}

/**
 * Convert audio to a specific format and sample rate
 */
export async function convertAudio(
  inputPath: string,
  outputPath: string,
  options: {
    format?: 'wav' | 'mp3'
    sampleRate?: number
    channels?: number
    bitrate?: string  // For mp3, e.g., "192k"
  } = {}
): Promise<void> {
  const ffmpegPath = getFfmpegPath()
  const { format = 'wav', sampleRate = 44100, channels = 1, bitrate = '192k' } = options
  
  const args = [
    '-i', inputPath,
    '-ar', String(sampleRate),
    '-ac', String(channels)
  ]
  
  if (format === 'mp3') {
    args.push('-b:a', bitrate)
  }
  
  args.push('-y', outputPath)
  
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegPath, args)
    
    let stderr = ''
    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })
    
    proc.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Conversion failed: ${stderr}`))
      }
    })
    
    proc.on('error', reject)
  })
}

/**
 * Concatenate multiple audio files into one
 */
export async function concatenateAudio(
  inputPaths: string[],
  outputPath: string,
  options: ConcatOptions = {}
): Promise<AudioMetadata> {
  const ffmpegPath = getFfmpegPath()
  const { outputFormat = 'wav', sampleRate = 44100, normalize = true } = options
  
  if (inputPaths.length === 0) {
    throw new Error('No input files to concatenate')
  }
  
  if (inputPaths.length === 1) {
    // Single file - just convert if needed
    await convertAudio(inputPaths[0], outputPath, { format: outputFormat, sampleRate })
    return getAudioMetadata(outputPath)
  }
  
  // Create a temp directory for intermediate files
  const tempDir = path.join(os.tmpdir(), `concat_${Date.now()}`)
  await fs.mkdir(tempDir, { recursive: true })
  
  try {
    // First, normalize all inputs to the same format
    const normalizedPaths: string[] = []
    
    for (let i = 0; i < inputPaths.length; i++) {
      const normalizedPath = path.join(tempDir, `input_${i.toString().padStart(3, '0')}.wav`)
      
      const args = [
        '-i', inputPaths[i],
        '-ar', String(sampleRate),
        '-ac', '1',
        '-acodec', 'pcm_s16le'
      ]
      
      if (normalize) {
        args.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11')
      }
      
      args.push('-y', normalizedPath)
      
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(ffmpegPath, args)
        
        let stderr = ''
        proc.stderr.on('data', (data) => {
          stderr += data.toString()
        })
        
        proc.on('close', (code) => {
          if (code === 0) {
            resolve()
          } else {
            reject(new Error(`Failed to normalize ${inputPaths[i]}: ${stderr}`))
          }
        })
        
        proc.on('error', reject)
      })
      
      normalizedPaths.push(normalizedPath)
    }
    
    // Create a concat list file
    const listPath = path.join(tempDir, 'concat_list.txt')
    const listContent = normalizedPaths
      .map(p => `file '${p.replace(/'/g, "'\\''")}'`)
      .join('\n')
    await fs.writeFile(listPath, listContent)
    
    // Concatenate
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    
    const outputArgs = [
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath
    ]
    
    if (outputFormat === 'mp3') {
      outputArgs.push('-acodec', 'libmp3lame', '-b:a', '192k')
    } else {
      outputArgs.push('-acodec', 'pcm_s16le')
    }
    
    outputArgs.push('-y', outputPath)
    
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegPath, outputArgs)
      
      let stderr = ''
      proc.stderr.on('data', (data) => {
        stderr += data.toString()
      })
      
      proc.on('close', (code) => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`Concatenation failed: ${stderr}`))
        }
      })
      
      proc.on('error', reject)
    })
    
    return getAudioMetadata(outputPath)
    
  } finally {
    // Cleanup temp directory
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Validate an audio file (check if it's playable)
 */
export async function validateAudioFile(filePath: string): Promise<{
  valid: boolean
  error?: string
  metadata?: AudioMetadata
}> {
  try {
    const metadata = await getAudioMetadata(filePath)
    
    if (metadata.durationMs < 100) {
      return { valid: false, error: 'Audio file is too short (less than 100ms)' }
    }
    
    return { valid: true, metadata }
  } catch (error) {
    return { 
      valid: false, 
      error: error instanceof Error ? error.message : 'Invalid or corrupt audio file' 
    }
  }
}

/**
 * Get audio duration in milliseconds
 */
export async function getAudioDuration(filePath: string): Promise<number> {
  const metadata = await getAudioMetadata(filePath)
  return metadata.durationMs
}
