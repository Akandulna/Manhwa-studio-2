/**
 * Gemini AI Provider for Narration Studio
 * 
 * Implements the AIProvider interface using Google's GenAI SDK (v2.0+).
 * Uses gemini-3.5-flash for script generation (multimodal: text + images).
 */

import { GoogleGenAI } from '@google/genai'
import {
  AIProvider,
  AIProviderConfig,
  ScriptGenerationInput,
  ScriptGenerationResult,
  SummaryGenerationInput,
  SummaryGenerationResult,
  OutroGenerationInput,
  OutroGenerationResult,
  BeatExtractionInput,
  BeatExtractionResult,
  ScriptFromBeatsInput,
  ImageInput
} from './types.js'
import {
  getScriptSystemPrompt,
  getChapter1ScriptPrompt,
  getChapterNScriptPrompt,
  getSummarySystemPrompt,
  getChapter1SummaryPrompt,
  getChapterNSummaryPrompt,
  getBeatExtractionSystemPrompt,
  getBeatExtractionPrompt,
  getBeatsToScriptSystemPrompt,
  getBeatsToScriptChapter1Prompt,
  getBeatsToScriptChapterNPrompt,
  getOutroSystemPrompt,
  getOutroPrompt,
  parseDelimitedResponse
} from './prompts.js'

const MAX_RETRIES = 3
const RETRY_DELAY_MS = 2000

export class GeminiProvider implements AIProvider {
  readonly name = 'gemini'
  readonly model: string
  
  private client: GoogleGenAI | null = null
  private apiKey: string
  private maxTokens: number
  
  constructor(config: AIProviderConfig) {
    this.apiKey = config.apiKey
    this.model = config.model || process.env.AI_MODEL || 'gemini-3.5-flash'
    this.maxTokens = config.maxTokens || 8192
    
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
      const result = await this.client!.models.generateContent({
        model: this.model,
        contents: [{ role: 'user', parts: [{ text: 'Say "OK" if you can read this.' }] }]
      })
      const text = result.text || ''
      return { success: text.toLowerCase().includes('ok') }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return { success: false, error: message }
    }
  }
  
  async generateScript(input: ScriptGenerationInput): Promise<ScriptGenerationResult> {
    if (!this.isConfigured()) {
      throw new Error('Gemini API key not configured')
    }
    
    // Build parts: system prompt first, then images in reading order, then user prompt
    const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = []
    
    // Add system prompt
    parts.push({ text: input.systemPrompt })
    
    // Add images in reading order
    for (const image of input.images) {
      parts.push({
        inlineData: {
          mimeType: image.mimeType,
          data: image.data.toString('base64')
        }
      })
    }
    
    // Add user prompt
    parts.push({ text: input.userPrompt })
    
    return this.callWithRetry(async () => {
      const result = await this.client!.models.generateContent({
        model: this.model,
        contents: [{ role: 'user', parts }],
        config: {
          maxOutputTokens: this.maxTokens
          // Note: Do NOT set temperature, top_p, top_k for Gemini 3.x models
        }
      })
      
      const text = result.text || ''
      
      // Check for safety blocks
      if (!text && result.candidates?.[0]?.finishReason === 'SAFETY') {
        throw new Error('Content was blocked by AI safety filters. Try Manual mode or different images.')
      }
      
      return {
        text,
        tokensUsed: result.usageMetadata?.totalTokenCount,
        finishReason: result.candidates?.[0]?.finishReason
      }
    })
  }
  
  async generateSummary(input: SummaryGenerationInput): Promise<SummaryGenerationResult> {
    if (!this.isConfigured()) {
      throw new Error('Gemini API key not configured')
    }
    
    const systemPrompt = getSummarySystemPrompt()
    const userPrompt = input.isFirstChapter
      ? getChapter1SummaryPrompt(input.scriptText)
      : getChapterNSummaryPrompt(input.scriptText, input.previousSummary || '')
    
    return this.callWithRetry(async () => {
      const result = await this.client!.models.generateContent({
        model: this.model,
        contents: [{
          role: 'user',
          parts: [
            { text: systemPrompt },
            { text: userPrompt }
          ]
        }],
        config: { maxOutputTokens: this.maxTokens }
      })
      
      const text = result.text || ''
      const parsed = parseDelimitedResponse(text)
      
      if (!parsed.summary || !parsed.closing) {
        throw new Error('Failed to parse summary response. Expected ===SUMMARY=== and ===CLOSING=== sections.')
      }
      
      return {
        rollingSummary: parsed.summary,
        closingParagraph: parsed.closing,
        aboutSummary: parsed.about,
        tokensUsed: result.usageMetadata?.totalTokenCount
      }
    })
  }
  
  async generateOutro(input: OutroGenerationInput): Promise<OutroGenerationResult> {
    if (!this.isConfigured()) {
      throw new Error('Gemini API key not configured')
    }
    
    const systemPrompt = getOutroSystemPrompt()
    const userPrompt = getOutroPrompt(
      input.seriesTitle,
      input.partNumber,
      input.aboutSummary,
      input.rollingSummary
    )
    
    return this.callWithRetry(async () => {
      const result = await this.client!.models.generateContent({
        model: this.model,
        contents: [{
          role: 'user',
          parts: [
            { text: systemPrompt },
            { text: userPrompt }
          ]
        }],
        config: { maxOutputTokens: this.maxTokens }
      })
      
      const text = result.text || ''
      const parsed = parseDelimitedResponse(text)
      
      return {
        outroText: parsed.outro || text.replace('===OUTRO===', '').trim(),
        tokensUsed: result.usageMetadata?.totalTokenCount
      }
    })
  }
  
  async extractBeats(input: BeatExtractionInput): Promise<BeatExtractionResult> {
    if (!this.isConfigured()) {
      throw new Error('Gemini API key not configured')
    }
    
    const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = []
    
    parts.push({ text: getBeatExtractionSystemPrompt() })
    
    for (const image of input.images) {
      parts.push({
        inlineData: {
          mimeType: image.mimeType,
          data: image.data.toString('base64')
        }
      })
    }
    
    parts.push({ text: getBeatExtractionPrompt(input.batchIndex, input.totalBatches) })
    
    return this.callWithRetry(async () => {
      const result = await this.client!.models.generateContent({
        model: this.model,
        contents: [{ role: 'user', parts }],
        config: { maxOutputTokens: this.maxTokens }
      })
      
      const text = result.text || ''
      
      if (!text && result.candidates?.[0]?.finishReason === 'SAFETY') {
        throw new Error('Content was blocked by AI safety filters.')
      }
      
      return {
        beats: text,
        tokensUsed: result.usageMetadata?.totalTokenCount
      }
    })
  }
  
  async generateScriptFromBeats(input: ScriptFromBeatsInput): Promise<ScriptGenerationResult> {
    if (!this.isConfigured()) {
      throw new Error('Gemini API key not configured')
    }
    
    const isChapter1 = !input.previousSummary && !input.previousClosingParagraph
    
    const systemPrompt = getBeatsToScriptSystemPrompt(input.systemPrompt)
    
    const userPrompt = isChapter1
      ? getBeatsToScriptChapter1Prompt(input.beats, 'this manhwa')
      : getBeatsToScriptChapterNPrompt(
          input.beats,
          'this manhwa',
          0,
          input.aboutSummary || '',
          input.previousSummary || '',
          input.previousClosingParagraph || ''
        )
    
    return this.callWithRetry(async () => {
      const result = await this.client!.models.generateContent({
        model: this.model,
        contents: [{
          role: 'user',
          parts: [
            { text: systemPrompt },
            { text: userPrompt }
          ]
        }],
        config: { maxOutputTokens: this.maxTokens }
      })
      
      return {
        text: result.text || '',
        tokensUsed: result.usageMetadata?.totalTokenCount,
        finishReason: result.candidates?.[0]?.finishReason
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
          message.includes('network')
        
        if (!isRetryable || attempt === MAX_RETRIES - 1) {
          throw lastError
        }
        
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt)
        console.log(`Retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms: ${lastError.message}`)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
    
    throw lastError || new Error('Max retries exceeded')
  }
}

// Factory function
export function createGeminiProvider(): GeminiProvider | null {
  const apiKey = process.env.GEMINI_API_KEY
  const model = process.env.AI_MODEL || 'gemini-3.5-flash'
  
  if (!apiKey) {
    return null
  }
  
  return new GeminiProvider({ apiKey, model })
}
