/**
 * Narration language — English and Hindi run as two independent pipelines over
 * the same chapter images.
 *
 * Each language has its own script (with its own continuity chain and part
 * breaks), its own voiceover sections and audio, and its own Editor 2.0
 * timeline and renders. Crops are shared: Image Clipper works on the images,
 * which are the same in both.
 *
 * English keeps every file name it had before Hindi existed, so nothing on disk
 * moves; Hindi files sit beside them under a `hi` suffix.
 */

export type NarrationLanguage = 'en' | 'hi'

export const NARRATION_LANGUAGES: readonly NarrationLanguage[] = ['en', 'hi']

export const LANGUAGE_NAMES: Record<NarrationLanguage, string> = {
  en: 'English',
  hi: 'Hindi'
}

/** Anything that isn't exactly "hi" is English, so old clients keep working unchanged. */
export function parseLanguage(value: unknown): NarrationLanguage {
  return value === 'hi' ? 'hi' : 'en'
}

/** The language a request asks for, from `?lang=` or a `lang` body field. */
export function requestLanguage(req: { query: Record<string, unknown>; body?: unknown }): NarrationLanguage {
  const fromBody = (req.body as { lang?: unknown } | undefined)?.lang
  return parseLanguage(req.query.lang ?? fromBody)
}

/** Chapter-folder file holding the narration script. */
export function scriptFileName(lang: NarrationLanguage): string {
  return lang === 'en' ? 'script.md' : 'script.hi.md'
}

/**
 * Chapter-folder file holding the alignment document: every voiceover section's
 * "Script with Timeline", in section order. Narration writes it once the whole
 * chapter is aligned; Editor 2.0's checklist reads it.
 */
export function alignmentFileName(lang: NarrationLanguage): string {
  return lang === 'en' ? 'script-timeline.md' : 'script-timeline.hi.md'
}

/** Chapter sub-folder holding voiceover audio. */
export function audioFolderName(lang: NarrationLanguage): string {
  return lang === 'en' ? 'audio' : 'audio_hi'
}

/** Series sub-folder holding Editor 2.0 renders. */
export function video2FolderName(lang: NarrationLanguage): string {
  return lang === 'en' ? '_video2' : '_video2_hi'
}

/** Suffix for exported part scripts ("Part 01 - full script.md" / "... (Hindi).md"). */
export function partExportSuffix(lang: NarrationLanguage): string {
  return lang === 'en' ? '' : ' (Hindi)'
}
