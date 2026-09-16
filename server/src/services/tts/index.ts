/**
 * TTS Provider Factory
 * 
 * Manages TTS providers and provides a unified interface.
 */

import { 
  TTSProvider, 
  TTSProviderName, 
  TTSInput,
  TTSResult,
  GEMINI_TTS_VOICES, 
  DEFAULT_TTS_STYLE_PROMPT 
} from './types.js'
import { GeminiTTSProvider, createGeminiTTSProvider } from './geminiTTSProvider.js'
import { KokoroTTSProvider, createKokoroTTSProvider } from './kokoroTTSProvider.js'

class TTSProviderFactory {
  private providers: Map<TTSProviderName, TTSProvider | null> = new Map()
  
  constructor() {
    this.initialize()
  }
  
  private initialize() {
    // Initialize Gemini TTS provider
    this.providers.set('gemini', createGeminiTTSProvider())
    // Local Kokoro Gradio app - no API key, so it is always "configured";
    // reachability is checked at generation time.
    this.providers.set('kokoro', createKokoroTTSProvider())
    // Future providers:
    // this.providers.set('elevenlabs', createElevenLabsTTSProvider())
    // this.providers.set('openai', createOpenAITTSProvider())
    // this.providers.set('edge', createEdgeTTSProvider())
  }
  
  getProvider(name: TTSProviderName): TTSProvider | null {
    return this.providers.get(name) || null
  }
  
  getAvailableProviders(): TTSProviderName[] {
    const available: TTSProviderName[] = []
    
    for (const [name, provider] of this.providers) {
      if (provider?.isConfigured()) {
        available.push(name)
      }
    }
    
    return available
  }
  
  /**
   * Resolve the provider for a generation request.
   *
   * `preferred` comes from the `ttsProvider` setting in the database (set in
   * Settings > Voiceover). Falls back to env/default behaviour when the
   * requested provider is missing or unconfigured.
   */
  resolveProvider(preferred?: string | null): TTSProvider | null {
    if (preferred) {
      const provider = this.getProvider(preferred as TTSProviderName)
      if (provider?.isConfigured()) {
        return provider
      }
    }

    return this.getDefaultProvider()
  }

  getDefaultProvider(): TTSProvider | null {
    // Check env var for preferred TTS provider
    const preferred = (process.env.TTS_PROVIDER || 'gemini') as TTSProviderName
    
    const provider = this.getProvider(preferred)
    if (provider?.isConfigured()) {
      return provider
    }
    
    // Fall back to first available
    const available = this.getAvailableProviders()
    if (available.length > 0) {
      return this.getProvider(available[0])
    }
    
    return null
  }
  
  /**
   * Reinitialize providers (e.g., after config change)
   */
  reinitialize(): void {
    this.initialize()
  }
}

// Singleton instance
export const ttsProviderFactory = new TTSProviderFactory()

// Re-export types directly (use export type for interfaces)
export type { TTSProvider, TTSProviderName, TTSInput, TTSResult } from './types.js'
export { 
  GEMINI_TTS_VOICES, 
  KOKORO_TTS_VOICES, 
  DEFAULT_KOKORO_VOICE,
  DEFAULT_TTS_STYLE_PROMPT 
} from './types.js'

export { GeminiTTSProvider } from './geminiTTSProvider.js'
export { KokoroTTSProvider, toKokoroVoiceKey, resolveVoiceId } from './kokoroTTSProvider.js'
export { 
  normalizeTextForTTS, 
  parseNormalizationOptions,
  DEFAULT_ACRONYM_ALLOWLIST,
  DEFAULT_NORMALIZATION_OPTIONS
} from './textNormalizer.js'
export type { NormalizationOptions } from './textNormalizer.js'
