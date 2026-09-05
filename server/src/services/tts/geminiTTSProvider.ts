/**
 * Gemini TTS Provider
 * 
 * Uses Google's Gemini TTS model for text-to-speech generation.
 * Model: gemini-3.1-flash-tts-preview
 * The model outputs raw PCM audio which needs to be wrapped into WAV format.
 */

import { GoogleGenAI } from '@google/genai'
import {
  TTSProvider,
  TTSProviderConfig,
  TTSInput,
  TTSResult,
  GEMINI_TTS_VOICES,
  DEFAULT_TTS_STYLE_PROMPT
} from './types.js'

const MAX_RETRIES = 3
const RETRY_DELAY_MS = 2000

export class GeminiTTSProvider implements TTSProvider {
  readonly name = 'gemini'
  readonly model: string
  readonly defaultVoice: string
  
  private client: GoogleGenAI | null = null
  private apiKey: string
  private stylePrompt: string
  
  constructor(config: TTSProviderConfig) {
    this.apiKey = config.apiKey
    this.model = config.model || process.env.TTS_MODEL || 'gemini-3.1-flash-tts-preview'
    this.defaultVoice = config.defaultVoice || 'Iapetus'
    this.stylePrompt = config.stylePrompt || DEFAULT_TTS_STYLE_PROMPT
    
    if (this.apiKey) {
      this.client = new GoogleGenAI({ apiKey: this.apiKey })
    }
  }
  
  isConfigured(): boolean {
    return !!this.apiKey && !!this.client
  }
  
  async testConnection(): Promise<{ success: boolean; error?: string }> {
    if (!this.isConfigured()) {
      return { success: false, error: 'API key not configured' }
    }
    
    try {
      // Test with a very short phrase
      const result = await this.generateSpeech({
        text: 'Test',
        voice: this.defaultVoice
      })
      return { success: result.audioData.length > 0 }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return { success: false, error: message }
    }
  }
  
  getAvailableVoices(): string[] {
    return [...GEMINI_TTS_VOICES]
  }
  
  async generateSpeech(input: TTSInput): Promise<TTSResult> {
    if (!this.isConfigured()) {
      throw new Error('Gemini TTS not configured - missing API key')
    }
    
    const voice = input.voice || this.defaultVoice
    const stylePrompt = input.stylePrompt || this.stylePrompt
    
    // Combine style prompt with the text
    const fullText = `${stylePrompt}\n\n${input.text}`
    
    return this.callWithRetry(async () => {
      // Generate content with audio output using new SDK
      const response = await this.client!.models.generateContent({
        model: this.model,
        contents: [{ 
          role: 'user',
          parts: [{ text: fullText }] 
        }],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: voice }
            }
          }
        } as any
      })
      
      const candidate = response.candidates?.[0]
      
      if (!candidate?.content?.parts?.[0]) {
        throw new Error('No audio content in response')
      }
      
      const part = candidate.content.parts[0] as any
      
      if (!part.inlineData?.data) {
        // Check for safety/content blocking
        if (candidate.finishReason === 'SAFETY') {
          throw new Error('Content was blocked by safety filters. Consider modifying the text.')
        }
        throw new Error('No audio data in response')
      }
      
      // Decode base64 audio data
      const audioData = Buffer.from(part.inlineData.data, 'base64')
      
      // Gemini TTS outputs raw PCM audio
      // Default: 24000 Hz, 16-bit, mono (based on documentation)
      return {
        audioData,
        format: 'pcm' as const,
        sampleRate: 24000,
        channels: 1,
        bitsPerSample: 16
      }
    })
  }
  
  private async callWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | null = null
    
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await fn()
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        
        const message = lastError.message.toLowerCase()
        const isRetryable = 
          message.includes('rate limit') ||
          message.includes('429') ||
          message.includes('500') ||
          message.includes('503') ||
          message.includes('timeout') ||
          message.includes('network') ||
          message.includes('quota')
        
        if (!isRetryable || attempt === MAX_RETRIES - 1) {
          throw lastError
        }
        
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt)
        console.log(`TTS retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms: ${lastError.message}`)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
    
    throw lastError || new Error('Max retries exceeded')
  }
}

// Factory function
export function createGeminiTTSProvider(): GeminiTTSProvider | null {
  const apiKey = process.env.GEMINI_API_KEY
  const model = process.env.TTS_MODEL || 'gemini-3.1-flash-tts-preview'
  const defaultVoice = process.env.TTS_DEFAULT_VOICE || 'Iapetus'
  const stylePrompt = process.env.TTS_STYLE_PROMPT
  
  if (!apiKey) {
    return null
  }
  
  return new GeminiTTSProvider({ 
    apiKey, 
    model, 
    defaultVoice,
    stylePrompt 
  })
}
