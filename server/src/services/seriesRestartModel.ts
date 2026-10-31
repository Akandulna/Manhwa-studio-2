import type { LibraryControl } from './libraryControlModel.js'

export const preservedRestartStages = new Set(['download', 'cleanup', 'stitch', 'review', 'crop'])
export const restartRevision = (control: LibraryControl): string | null => control.restart ? `${control.restart.at}-${control.restart.deviceId}` : null
export const sameRestart = (expected: string | null, incoming: unknown): boolean => expected === (typeof incoming === 'string' && incoming && incoming !== 'null' ? incoming : null)
export function stripCropStory(text: string): string {
  let value: any
  try { value = JSON.parse(text) } catch { return text } // Legacy visual descriptions may be plain text.
  if (!value || typeof value !== 'object' || !Array.isArray(value.crops)) return text
  delete value.storyLinking
  for (const crop of value.crops) if (crop && typeof crop === 'object') {
    for (const key of ['storyContext', 'scriptRefs', 'matchType', 'evidence', 'reviewReason']) delete crop[key]
  }
  return JSON.stringify(value, null, 2) + '\n'
}
/** Prefixes are discovered phone roots; no crops, source ZIPs, unrelated series or backup keys. */
export function restartCloudPrefixes(roots: string[], folder: string): string[] {
  return [...new Set(roots)].flatMap(root => ['scripts', 'voiceover', 'editor', 'shared/scripts'].map(kind => `${root}${kind}/${folder}/`))
}
