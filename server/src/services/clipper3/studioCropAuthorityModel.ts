import { createHash } from 'crypto'

export const sha256 = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex')
export const normalizeScript = (text: string): string => text.replace(/\r\n/g, '\n').trim()
/** Check semantic shape and exact current script references, not merely the presence of a linking header. */
export function storyLinksCurrent(text: string, script: string, sourceSha256?: string): boolean {
  try {
    const value = JSON.parse(text), normalized = normalizeScript(script)
    const header = value.storyLinking
    if (!normalized || header?.schema_version !== 'crop-script-links/1' || header.scriptSha256 !== sha256(normalized) || !Array.isArray(value.crops)) return false
    if (!/^[a-f0-9]{64}$/.test(header.inputRevision ?? '') || !/^[a-f0-9]{64}$/.test(header.sourceSha256 ?? '') || (sourceSha256 && header.sourceSha256 !== sourceSha256)) return false
    const segments = normalized.split('\n').map(s => s.trim()).filter(Boolean)
    const ids = new Map(segments.map((s, i) => [`P${String(i + 1).padStart(4, '0')}`, s]))
    if (!Array.isArray(header.scriptSegments) || !header.scriptSegments.every((s: any) => ids.get(s.id) === s.text)) return false
    const included = new Set(header.scriptSegments.map((s: any) => s.id))
    return value.crops.every((c: any) => {
      if (!Array.isArray(c.scriptRefs) || new Set(c.scriptRefs).size !== c.scriptRefs.length) return false
      if (c.matchType === 'unmatched') return c.scriptRefs.length === 0 && !c.storyContext && typeof c.reviewReason === 'string' && !!c.reviewReason.trim()
      return ['direct', 'context'].includes(c.matchType) && c.scriptRefs.length > 0 && c.scriptRefs.every((id: string) => ids.has(id) && included.has(id)) &&
        typeof c.storyContext === 'string' && !!c.storyContext.trim() && typeof c.evidence === 'string' && !!c.evidence.trim() && !c.reviewReason
    })
  } catch { return false }
}
