/**
 * Text Normalizer for TTS
 * 
 * Normalizes text before sending to TTS to reduce over-dramatic delivery.
 * All normalization rules are toggleable via settings.
 */

// Default acronym allowlist - words that should stay uppercase
export const DEFAULT_ACRONYM_ALLOWLIST = ['AI', 'TV', 'CEO', 'OK', 'VIP', 'DNA', 'USA', 'UK', 'EU']

export interface NormalizationOptions {
  enabled: boolean
  stripExpressiveTags: boolean
  softenDashes: boolean
  softenEllipses: boolean
  calmPunctuation: boolean
  removeShouting: boolean
  tidyWhitespace: boolean
  acronymAllowlist: string[]
}

export const DEFAULT_NORMALIZATION_OPTIONS: NormalizationOptions = {
  enabled: true,
  stripExpressiveTags: true,
  softenDashes: true,
  softenEllipses: true,
  calmPunctuation: true,
  removeShouting: true,
  tidyWhitespace: true,
  acronymAllowlist: DEFAULT_ACRONYM_ALLOWLIST
}

/**
 * Normalize text for TTS to reduce dramatic delivery
 * 
 * @param text - Raw section text
 * @param options - Normalization options (all enabled by default)
 * @returns Normalized text for TTS
 */
export function normalizeTextForTTS(
  text: string,
  options: Partial<NormalizationOptions> = {}
): string {
  const opts: NormalizationOptions = { ...DEFAULT_NORMALIZATION_OPTIONS, ...options }
  
  // If normalization is disabled, return as-is
  if (!opts.enabled) {
    return text
  }
  
  let result = text
  
  // 1. Strip expressive/stage-direction tags
  // Remove [excited], [whisper], [laughs], etc.
  // Remove *sighs*, *gasps*, etc.
  if (opts.stripExpressiveTags) {
    result = result.replace(/\[[^\]]*\]/g, '')  // [anything]
    result = result.replace(/\*[^*]+\*/g, '')   // *anything*
  }
  
  // 2. Soften dramatic dashes
  // Replace em-dash —, en-dash –, and -- with ", "
  if (opts.softenDashes) {
    result = result.replace(/[—–]/g, ', ')
    result = result.replace(/--/g, ', ')
  }
  
  // 3. Soften ellipses
  // Replace … and runs of 3+ dots with ", "
  if (opts.softenEllipses) {
    result = result.replace(/…/g, ', ')
    result = result.replace(/\.{3,}/g, ', ')
  }
  
  // 4. Calm the punctuation
  // Replace ! with .
  // Collapse repeated !!!/???/... to single ./?./.
  if (opts.calmPunctuation) {
    result = result.replace(/!+/g, '.')
    result = result.replace(/\?{2,}/g, '?')
    result = result.replace(/\.{2,}/g, '.')
  }
  
  // 5. Remove shouting (ALL CAPS words)
  // Convert words with 3+ letters all uppercase to lowercase
  // Except for acronyms in the allowlist
  if (opts.removeShouting) {
    const allowlistSet = new Set(opts.acronymAllowlist.map(a => a.toUpperCase()))
    result = result.replace(/\b([A-Z]{3,})\b/g, (match) => {
      if (allowlistSet.has(match.toUpperCase())) {
        return match
      }
      return match.toLowerCase()
    })
  }
  
  // 6. Tidy whitespace
  // Collapse multiple spaces/newlines into single spaces and trim
  if (opts.tidyWhitespace) {
    result = result.replace(/\s+/g, ' ').trim()
  }
  
  return result
}

/**
 * Parse normalization options from settings
 */
export function parseNormalizationOptions(settings: Record<string, string>): NormalizationOptions {
  return {
    enabled: settings.ttsNormalizeText !== 'false',
    stripExpressiveTags: settings.ttsNormStripTags !== 'false',
    softenDashes: settings.ttsNormSoftenDashes !== 'false',
    softenEllipses: settings.ttsNormSoftenEllipses !== 'false',
    calmPunctuation: settings.ttsNormCalmPunctuation !== 'false',
    removeShouting: settings.ttsNormRemoveShouting !== 'false',
    tidyWhitespace: settings.ttsNormTidyWhitespace !== 'false',
    acronymAllowlist: settings.ttsNormAcronymAllowlist 
      ? settings.ttsNormAcronymAllowlist.split(',').map(s => s.trim())
      : DEFAULT_ACRONYM_ALLOWLIST
  }
}
