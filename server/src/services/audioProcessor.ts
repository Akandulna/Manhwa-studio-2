/**
 * Audio Processing Service
 *
 * Reads audio file metadata with ffprobe, used to check the voiceover audio
 * fetched from the phones before it is attached.
 */

import { spawn } from 'child_process'
import fs from 'fs/promises'

export interface AudioMetadata {
  durationMs: number
  format: string
  sampleRate: number
  channels: number
  bitrate?: number
  bytes: number
}

/**
 * Get the ffprobe executable path
 */
function getFfprobePath(): string {
  return process.env.FFPROBE_PATH || 'ffprobe'
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
