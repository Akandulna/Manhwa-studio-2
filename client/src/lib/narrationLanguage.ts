/**
 * Narration language — the English / Hindi tabs of Narration Studio and
 * Editor 2.0.
 *
 * The same manhwa is narrated twice: each language has its own script,
 * voiceover and Editor 2.0 timeline, while the chapter images and Image
 * Clipper crops are shared. The active tab lives in the URL (`?lang=hi`) so a
 * chapter link opens in the language it was clicked from and the back button
 * returns to the same tab. With no `?lang`, a module falls back to the tab it
 * was last on.
 */

import { useCallback, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'

export type NarrationLanguage = 'en' | 'hi'

export const NARRATION_LANGUAGES: NarrationLanguage[] = ['en', 'hi']

export const LANGUAGE_LABEL: Record<NarrationLanguage, string> = {
  en: 'English',
  hi: 'Hindi'
}

/** Modules that remember their last tab separately. */
export type LanguageScope = 'narration' | 'editor2'

const STORAGE_PREFIX = 'narration-language:'

function parseLanguage(value: string | null | undefined): NarrationLanguage | null {
  return value === 'hi' || value === 'en' ? value : null
}

function rememberedLanguage(scope: LanguageScope): NarrationLanguage | null {
  try {
    return parseLanguage(localStorage.getItem(STORAGE_PREFIX + scope))
  } catch {
    return null
  }
}

/**
 * The active language tab and a setter that switches it.
 *
 * Switching replaces the URL entry rather than pushing one, so flipping tabs
 * back and forth doesn't fill the back-button history.
 */
export function useNarrationLanguage(scope: LanguageScope): [NarrationLanguage, (next: NarrationLanguage) => void] {
  const [params, setParams] = useSearchParams()
  const language = parseLanguage(params.get('lang')) ?? rememberedLanguage(scope) ?? 'en'

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_PREFIX + scope, language)
    } catch {
      // Only a convenience — the URL still carries the tab.
    }
  }, [scope, language])

  const setLanguage = useCallback((next: NarrationLanguage) => {
    setParams(prev => {
      const updated = new URLSearchParams(prev)
      updated.set('lang', next)
      return updated
    }, { replace: true })
  }, [setParams])

  return [language, setLanguage]
}

/** An in-app path carrying the language tab, e.g. withLang('/narration', 'hi') → '/narration?lang=hi'. */
export function withLang(path: string, language: NarrationLanguage): string {
  return `${path}${path.includes('?') ? '&' : '?'}lang=${language}`
}
