/**
 * "Fetch from phone" runs in progress, by `seriesId:language`: the ones you
 * start in Narration and the automatic ones (phoneNarrationAutoSync.ts). Both
 * check here first, so they never import into the same series and language at
 * once, and a page opened mid-run shows it.
 */
import type { NarrationLanguage } from './narrationLanguage.js'
import type { PhoneImportResult } from './phoneScriptImport.js'
import type { PhoneVoiceoverFetch } from './phoneVoiceoverImport.js'

/** A fetch run, as emitted on `narration:fetch`. */
export interface PhoneFetchState {
  seriesId: string
  language: NarrationLanguage
  stage: 'scripts' | 'voiceover' | 'done' | 'failed'
  /** Voiceover: the chapter downloading now, as "current of total". */
  chapterNumber?: number
  current?: number
  total?: number
  /** Done: what each half did. */
  scripts?: PhoneImportResult | null
  voiceovers?: PhoneVoiceoverFetch | null
  error?: string
  /** Started by Studio itself, not from Narration's "Fetch from phone". */
  automatic?: boolean
}

export const phoneFetchJobs = new Map<string, PhoneFetchState>()

export const phoneFetchKey = (seriesId: string, language: NarrationLanguage) => `${seriesId}:${language}`
