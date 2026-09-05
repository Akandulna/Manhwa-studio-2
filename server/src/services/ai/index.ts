/**
 * AI Provider Factory
 * 
 * Manages AI providers and provides a unified interface to get the configured provider.
 */

import { AIProvider, ProviderName, ProviderFactory } from './types.js'
import { GeminiProvider, createGeminiProvider } from './geminiProvider.js'

class AIProviderFactory implements ProviderFactory {
  private providers: Map<ProviderName, AIProvider | null> = new Map()
  
  constructor() {
    // Initialize providers
    this.providers.set('gemini', createGeminiProvider())
    // Future providers can be added here:
    // this.providers.set('openai', createOpenAIProvider())
    // this.providers.set('anthropic', createAnthropicProvider())
  }
  
  getProvider(name: ProviderName): AIProvider | null {
    return this.providers.get(name) || null
  }
  
  getAvailableProviders(): ProviderName[] {
    const available: ProviderName[] = []
    
    for (const [name, provider] of this.providers) {
      if (provider?.isConfigured()) {
        available.push(name)
      }
    }
    
    return available
  }
  
  getDefaultProvider(): AIProvider | null {
    // Check env var for preferred provider
    const preferred = (process.env.AI_PROVIDER || 'gemini') as ProviderName
    
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
   * Refresh provider instances (e.g., if API keys change)
   */
  refresh(): void {
    this.providers.set('gemini', createGeminiProvider())
  }
  
  /**
   * Reinitialize all providers (called when API keys are updated)
   */
  reinitialize(): void {
    this.refresh()
  }
}

// Singleton instance
export const aiProviderFactory = new AIProviderFactory()

// Re-export types
export * from './types.js'
export * from './prompts.js'
export { GeminiProvider } from './geminiProvider.js'
