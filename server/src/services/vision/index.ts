/**
 * Vision provider factory.
 *
 * Mirrors the TTS factory's resolveProvider() contract: a caller passes the
 * preferred provider from settings, and the factory falls back to env/default
 * when that one is missing or unconfigured.
 *
 * One difference from TTS worth knowing: the local Qwen provider is ALWAYS
 * "configured" (no key to check), so it can never be filtered out of the
 * available list by a missing credential. Whether Ollama is actually running is
 * only knowable by calling testConnection().
 */

import { VisionProvider, VisionProviderName, VISION_PROVIDER_LABELS } from './types.js'
import { createQwenVisionProvider } from './qwenProvider.js'
import {
  GeminiVisionProvider,
  OpenAIVisionProvider,
  AnthropicVisionProvider
} from './cloudProviders.js'

class VisionProviderFactory {
  private providers: Map<VisionProviderName, VisionProvider | null> = new Map()

  constructor() {
    this.initialize()
  }

  private initialize() {
    this.providers.set('qwen', createQwenVisionProvider())
    this.providers.set('gemini', new GeminiVisionProvider(process.env.GEMINI_API_KEY || ''))
    this.providers.set('openai', new OpenAIVisionProvider(process.env.OPENAI_API_KEY || ''))
    this.providers.set('anthropic', new AnthropicVisionProvider(process.env.ANTHROPIC_API_KEY || ''))
  }

  getProvider(name: VisionProviderName): VisionProvider | null {
    return this.providers.get(name) || null
  }

  getAvailableProviders(): VisionProviderName[] {
    const available: VisionProviderName[] = []
    for (const [name, provider] of this.providers) {
      if (provider?.isConfigured()) available.push(name)
    }
    return available
  }

  /**
   * Resolve the provider for one request. `preferred` comes from the
   * `visionProvider` setting (Settings > AI Providers) or a per-request
   * override, so a user can run one page on Qwen and the next on Gemini.
   */
  resolveProvider(preferred?: string | null): VisionProvider | null {
    if (preferred) {
      const provider = this.getProvider(preferred as VisionProviderName)
      if (provider?.isConfigured()) return provider
    }
    return this.getDefaultProvider()
  }

  getDefaultProvider(): VisionProvider | null {
    const preferred = (process.env.VISION_PROVIDER || 'qwen') as VisionProviderName
    const provider = this.getProvider(preferred)
    if (provider?.isConfigured()) return provider

    const available = this.getAvailableProviders()
    return available.length > 0 ? this.getProvider(available[0]) : null
  }

  /** Describe every provider for the Settings UI, without calling any backend. */
  describe() {
    return (Array.from(this.providers.entries()) as Array<[VisionProviderName, VisionProvider | null]>)
      .map(([name, provider]) => ({
        name,
        label: VISION_PROVIDER_LABELS[name],
        model: provider?.model ?? null,
        isLocal: provider?.isLocal ?? false,
        configured: provider?.isConfigured() ?? false
      }))
  }

  /** Re-read env (API keys can change while the server is up). */
  reinitialize(): void {
    this.initialize()
  }
}

export const visionProviderFactory = new VisionProviderFactory()

export * from './types.js'
export { QwenVisionProvider } from './qwenProvider.js'
