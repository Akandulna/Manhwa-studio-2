/**
 * TTS Provider Types for Voiceover Studio
 * 
 * Defines the interface for Text-to-Speech providers.
 */

export interface TTSProviderConfig {
  apiKey: string
  model: string
  defaultVoice: string
  stylePrompt?: string
}

export interface TTSInput {
  text: string
  voice?: string        // Override default voice
  stylePrompt?: string  // Override default style prompt
}

export interface TTSResult {
  audioData: Buffer     // Raw audio data (PCM or encoded)
  format: 'pcm' | 'wav' | 'mp3'
  sampleRate: number
  channels: number
  bitsPerSample: number
  durationMs?: number
}

export interface TTSProvider {
  readonly name: string
  readonly model: string
  readonly defaultVoice: string
  
  isConfigured(): boolean
  testConnection(): Promise<{ success: boolean; error?: string }>
  
  /**
   * Generate speech from text
   */
  generateSpeech(input: TTSInput): Promise<TTSResult>
  
  /**
   * Get available voices
   */
  getAvailableVoices(): string[]
}

// Gemini TTS prebuilt voices (male only)
export const GEMINI_TTS_VOICES = [
  'Charon',   // Deep, authoritative
  'Fenrir',   // Energetic, powerful
  'Orus',     // Balanced, calm
  'Puck',     // Playful, expressive
  'Zephyr',   // Calm, measured
  'Algenib',  // Gravelly, rugged
  'Algieba',  // Smooth, silky
  'Bellatrix',// Crisp, articulate
  'Gacrux',   // Mature, wise
  'Iapetus',  // Versatile narrator
  'Keid',     // Upbeat, cheerful
  'Kopernicus', // Measured, scholarly
  'Pegasus',  // Storytelling, narrative
  'Perseus',  // Deep, commanding
  'Rasalhague', // Even, balanced
  'Sadaltager', // Knowledgeable
  'Sulafat',    // Warm, friendly
  'Zubenelgenubi', // Casual, conversational
] as const

export type GeminiTTSVoice = typeof GEMINI_TTS_VOICES[number]

// Default TTS style prompt for narration - calm, steady narrator
export const DEFAULT_TTS_STYLE_PROMPT = `Narrate in a calm, steady, neutral voice, like an audiobook narrator. Keep an even tone and a measured, consistent pace. Use minimal emotional inflection and smooth, natural phrasing. Do not dramatize, perform, or over-emphasize, and do not raise pitch for excitement. Read straight through.`

export type TTSProviderName = 'gemini' | 'elevenlabs' | 'openai' | 'edge'
