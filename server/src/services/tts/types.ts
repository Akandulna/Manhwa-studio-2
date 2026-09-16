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
  stylePrompt?: string  // Override default style prompt (ignored by pure TTS models like Kokoro)
  speed?: number        // Speech rate multiplier (supported by Kokoro; ignored by Gemini)
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


/**
 * Kokoro TTS voices (local Gradio app).
 *
 * `id` is what we persist in the database and expose in our API.
 * `key` is the exact emoji-decorated label the Gradio dropdown requires -
 * it must match the server's enum verbatim or the call is rejected.
 */
export const KOKORO_TTS_VOICES = [
  { id: 'hf_alpha', key: '\u{1F1EE}\u{1F1F3} \u{1F6BA} Hindi Alpha (hf_alpha)', name: 'Hindi Alpha', language: 'Hindi', gender: 'female' },
  { id: 'hf_beta', key: '\u{1F1EE}\u{1F1F3} \u{1F6BA} Hindi Beta (hf_beta)', name: 'Hindi Beta', language: 'Hindi', gender: 'female' },
  { id: 'hm_omega', key: '\u{1F1EE}\u{1F1F3} \u{1F6B9} Hindi Omega (hm_omega)', name: 'Hindi Omega', language: 'Hindi', gender: 'male' },
  { id: 'hm_psi', key: '\u{1F1EE}\u{1F1F3} \u{1F6B9} Hindi Psi (hm_psi)', name: 'Hindi Psi', language: 'Hindi', gender: 'male' },
  { id: 'af_heart', key: '\u{1F1FA}\u{1F1F8} \u{1F6BA} Heart \u2764\uFE0F (af_heart)', name: 'Heart', language: 'English (US)', gender: 'female' },
  { id: 'af_bella', key: '\u{1F1FA}\u{1F1F8} \u{1F6BA} Bella \u{1F525} (af_bella)', name: 'Bella', language: 'English (US)', gender: 'female' },
  { id: 'af_nicole', key: '\u{1F1FA}\u{1F1F8} \u{1F6BA} Nicole \u{1F3A7} (af_nicole)', name: 'Nicole', language: 'English (US)', gender: 'female' },
  { id: 'af_sarah', key: '\u{1F1FA}\u{1F1F8} \u{1F6BA} Sarah (af_sarah)', name: 'Sarah', language: 'English (US)', gender: 'female' },
  { id: 'af_sky', key: '\u{1F1FA}\u{1F1F8} \u{1F6BA} Sky (af_sky)', name: 'Sky', language: 'English (US)', gender: 'female' },
  { id: 'am_michael', key: '\u{1F1FA}\u{1F1F8} \u{1F6B9} Michael (am_michael)', name: 'Michael', language: 'English (US)', gender: 'male' },
  { id: 'am_fenrir', key: '\u{1F1FA}\u{1F1F8} \u{1F6B9} Fenrir (am_fenrir)', name: 'Fenrir', language: 'English (US)', gender: 'male' },
  { id: 'am_echo', key: '\u{1F1FA}\u{1F1F8} \u{1F6B9} Echo (am_echo)', name: 'Echo', language: 'English (US)', gender: 'male' },
  { id: 'am_eric', key: '\u{1F1FA}\u{1F1F8} \u{1F6B9} Eric (am_eric)', name: 'Eric', language: 'English (US)', gender: 'male' },
  { id: 'bf_emma', key: '\u{1F1EC}\u{1F1E7} \u{1F6BA} Emma (bf_emma)', name: 'Emma', language: 'English (UK)', gender: 'female' },
  { id: 'bf_isabella', key: '\u{1F1EC}\u{1F1E7} \u{1F6BA} Isabella (bf_isabella)', name: 'Isabella', language: 'English (UK)', gender: 'female' },
  { id: 'bm_george', key: '\u{1F1EC}\u{1F1E7} \u{1F6B9} George (bm_george)', name: 'George', language: 'English (UK)', gender: 'male' },
  { id: 'bm_lewis', key: '\u{1F1EC}\u{1F1E7} \u{1F6B9} Lewis (bm_lewis)', name: 'Lewis', language: 'English (UK)', gender: 'male' },
  { id: 'ef_dora', key: '\u{1F1EA}\u{1F1F8} \u{1F6BA} Spanish Dora (ef_dora)', name: 'Spanish Dora', language: 'Spanish', gender: 'female' },
  { id: 'em_alex', key: '\u{1F1EA}\u{1F1F8} \u{1F6B9} Spanish Alex (em_alex)', name: 'Spanish Alex', language: 'Spanish', gender: 'male' },
  { id: 'ff_siwis', key: '\u{1F1EB}\u{1F1F7} \u{1F6BA} French Siwis (ff_siwis)', name: 'French Siwis', language: 'French', gender: 'female' },
  { id: 'if_sara', key: '\u{1F1EE}\u{1F1F9} \u{1F6BA} Italian Sara (if_sara)', name: 'Italian Sara', language: 'Italian', gender: 'female' },
  { id: 'im_nicola', key: '\u{1F1EE}\u{1F1F9} \u{1F6B9} Italian Nicola (im_nicola)', name: 'Italian Nicola', language: 'Italian', gender: 'male' },
  { id: 'pf_dora', key: '\u{1F1E7}\u{1F1F7} \u{1F6BA} Portuguese Dora (pf_dora)', name: 'Portuguese Dora', language: 'Portuguese', gender: 'female' },
  { id: 'pm_alex', key: '\u{1F1E7}\u{1F1F7} \u{1F6B9} Portuguese Alex (pm_alex)', name: 'Portuguese Alex', language: 'Portuguese', gender: 'male' },
] as const

export type KokoroTTSVoiceId = typeof KOKORO_TTS_VOICES[number]['id']

export const DEFAULT_KOKORO_VOICE: KokoroTTSVoiceId = 'hf_alpha'

export type TTSProviderName = 'gemini' | 'kokoro' | 'elevenlabs' | 'openai' | 'edge'
