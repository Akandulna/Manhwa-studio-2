/**
 * AI Provider Types for Narration Studio
 * 
 * Defines the interface for AI providers that generate narration scripts.
 * Providers must support both multimodal (images + text) and text-only calls.
 */

export interface AIProviderConfig {
  apiKey: string
  model: string
  maxTokens?: number
  temperature?: number
}

export interface ImageInput {
  data: Buffer
  mimeType: 'image/webp' | 'image/jpeg' | 'image/png'
}

export interface ScriptGenerationInput {
  images: ImageInput[]
  systemPrompt: string
  userPrompt: string
}

export interface ScriptGenerationResult {
  text: string
  tokensUsed?: number
  finishReason?: string
}

export interface SummaryGenerationInput {
  scriptText: string
  previousSummary?: string
  isFirstChapter: boolean
}

export interface SummaryGenerationResult {
  rollingSummary: string
  closingParagraph: string
  aboutSummary?: string  // Only for chapter 1
  tokensUsed?: number
}

export interface OutroGenerationInput {
  seriesTitle: string
  aboutSummary: string
  rollingSummary: string
  partNumber: number
}

export interface OutroGenerationResult {
  outroText: string
  tokensUsed?: number
}

// Beat extraction for map-reduce batching
export interface BeatExtractionInput {
  images: ImageInput[]
  batchIndex: number
  totalBatches: number
}

export interface BeatExtractionResult {
  beats: string  // Ordered beats for this batch
  tokensUsed?: number
}

export interface ScriptFromBeatsInput {
  beats: string[]  // All batch beats in order
  systemPrompt: string
  aboutSummary?: string
  previousSummary?: string
  previousClosingParagraph?: string
}

export interface AIProvider {
  readonly name: string
  readonly model: string
  
  /**
   * Generate a narration script from chapter images (multimodal call)
   */
  generateScript(input: ScriptGenerationInput): Promise<ScriptGenerationResult>
  
  /**
   * Generate rolling summary and closing paragraph from script text (text-only call)
   */
  generateSummary(input: SummaryGenerationInput): Promise<SummaryGenerationResult>
  
  /**
   * Generate part outro/epilogue text
   */
  generateOutro(input: OutroGenerationInput): Promise<OutroGenerationResult>
  
  /**
   * Extract beats from a batch of images (for map-reduce)
   */
  extractBeats(input: BeatExtractionInput): Promise<BeatExtractionResult>
  
  /**
   * Combine beats into final script (for map-reduce)
   */
  generateScriptFromBeats(input: ScriptFromBeatsInput): Promise<ScriptGenerationResult>
  
  /**
   * Check if the provider is properly configured
   */
  isConfigured(): boolean
  
  /**
   * Test the connection/API key
   */
  testConnection(): Promise<{ success: boolean; error?: string }>
}

export type ProviderName = 'gemini' | 'openai' | 'anthropic'

export interface ProviderFactory {
  getProvider(name: ProviderName): AIProvider | null
  getAvailableProviders(): ProviderName[]
  getDefaultProvider(): AIProvider | null
}
