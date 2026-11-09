/** Validated handoff envelope. Unknown/invalid envelopes reject the entire start, never fall back to an ordinary run. */
export const COOPERATIVE_PROTOCOL = 'sleeper-cell-cooperation/1'
export interface CooperativeRequest {
  protocol: typeof COOPERATIVE_PROTOCOL
  token: string
  phase: 'freeze' | 'assign' | 'abort'
  kind: 'clipper' | 'metadata' | 'editor' | 'voiceover'
  series: string
  language: 'en' | 'hi'
  chapters?: string[]
  members?: string[]
}
const DEVICE = /^[A-Za-z0-9_-]{1,64}$/
const folder = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 200 &&
  s === s.trim() && s !== '.' && s !== '..' && !/[\x00-\x1f\\/]/.test(s)
export function cooperativeRequest(value: unknown, action: unknown, device: unknown, series: unknown): CooperativeRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const c = value as Record<string, unknown>
  if (c.protocol !== COOPERATIVE_PROTOCOL || !['freeze', 'assign', 'abort'].includes(String(c.phase)) ||
      !['clipper', 'metadata', 'editor', 'voiceover'].includes(String(c.kind)) || action !== `${c.kind}_start` ||
      typeof c.token !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(c.token) ||
      typeof device !== 'string' || !DEVICE.test(device) || !folder(c.series) || c.series !== series ||
      c.language !== 'en' && c.language !== 'hi' || !['editor', 'voiceover'].includes(String(c.kind)) && c.language !== 'en') return null
  const result: CooperativeRequest = {protocol: COOPERATIVE_PROTOCOL, token: c.token, phase: c.phase as CooperativeRequest['phase'],
    kind: c.kind as CooperativeRequest['kind'], series: c.series, language: c.language}
  if (c.phase === 'assign') {
    if (!Array.isArray(c.chapters) || c.chapters.length > 1000 || !c.chapters.every(folder) || new Set(c.chapters).size !== c.chapters.length ||
        !Array.isArray(c.members) || c.members.length < 2 || c.members.length > 32 ||
        !c.members.every(x => typeof x === 'string' && DEVICE.test(x)) || new Set(c.members).size !== c.members.length || !c.members.includes(device)) return null
    result.chapters = c.chapters
    result.members = c.members as string[]
  }
  return result
}
