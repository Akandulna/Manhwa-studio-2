import fs from 'fs/promises'
import path from 'path'
import type { NarrationLanguage } from './narrationLanguage.js'
import { presentationIssues } from './narrationRules.js'
import { englishParagraphs, englishSourceIssues, hinglishBudget, hinglishWords, shortSceneIssue } from './hinglishRules.js'

/** The Hinglish length-window problem (geminiMcp/hinglish.ts replaces it with the counts). */
export const LENGTH_LIMITS = 'The pasted Hinglish narration is outside the chapter length limits. Complete or condense it before saving.'

export interface NarrationBlock {
  id: string
  chapter: string
  language: NarrationLanguage
  reason: string
  stage: string
  failedAt: string
  conversationUrl: string | null
  account: string | null
  sourceSha256: string | null
}
export interface PhoneNarrationBlock extends NarrationBlock {
  chapterId: string
  seriesId: string
  device: string | null
}

/** Receipts are external input; only retained AI Studio conversation links are clickable. */
export function parseNarrationBlock(value: unknown): NarrationBlock | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const text = (key: string, max = 500) => typeof v[key] === 'string' ? (v[key] as string).trim().slice(0, max) : ''
  const id = text('id', 100), chapter = text('chapter', 200), failedAt = text('failedAt', 100)
  if (!id || !chapter || /[/\\]|^\.{1,2}$/.test(chapter) || !Number.isFinite(Date.parse(failedAt)) || !['en', 'hi'].includes(String(v.language))) return null
  let conversationUrl: string | null = null
  try {
    const url = new URL(text('conversationUrl', 2000))
    if (url.origin === 'https://aistudio.google.com' && /^\/prompts\/(?!new_chat(?:\/|$))[A-Za-z0-9_-]+$/.test(url.pathname) && !url.username && !url.password) {
      conversationUrl = url.origin + url.pathname
    }
  } catch { /* An unsaved conversation can still be continued on the phone. */ }
  const source = text('sourceSha256', 64)
  return { id, chapter, language: v.language as NarrationLanguage, failedAt,
    reason: text('reason') || 'Prohibited content', stage: text('stage') || 'Script generation',
    conversationUrl, account: text('account', 200) || null, sourceSha256: /^[a-f0-9]{64}$/.test(source) ? source : null }
}

/** A successful save on any phone supersedes an older failure; a local manual save clears it immediately. */
export async function unresolvedNarrationBlocks(entries: { blocked?: unknown; chapters?: unknown; hi?: unknown; device?: string | null }[],
  chapters: { id: string; folderPath: string }[], seriesId: string, device: string | null): Promise<PhoneNarrationBlock[]> {
  const byFolder = new Map(chapters.map(c => [path.basename(c.folderPath), c]))
  const latest = new Map<string, { block: NarrationBlock; device: string | null }>()
  for (const entry of entries) for (const raw of Array.isArray(entry.blocked) ? entry.blocked : []) {
    const block = parseNarrationBlock(raw)
    if (!block) continue
    const key = `${block.chapter}:${block.language}`
    if (Date.parse(block.failedAt) > Date.parse(latest.get(key)?.block.failedAt ?? '1970-01-01')) latest.set(key, { block, device: entry.device ?? device })
  }
  const result: PhoneNarrationBlock[] = []
  for (const { block, device: owner } of latest.values()) {
    const chapter = byFolder.get(block.chapter)
    if (!chapter) continue
    const resolvedOnPhone = entries.some(entry => {
      const language = (block.language === 'hi' ? entry.hi : entry) as any
      const saved = language?.chapters?.[block.chapter]
      return ['done', 'review', 'needs_summary'].includes(saved?.status) && Date.parse(saved?.savedAt) >= Date.parse(block.failedAt)
    })
    if (resolvedOnPhone) continue
    const root = path.resolve(process.env.DOWNLOAD_ROOT || './downloads')
    const folder = path.resolve(root, chapter.folderPath)
    if (!folder.startsWith(root + path.sep)) continue
    try {
      const marker = JSON.parse(await fs.readFile(path.join(folder, `.script-replacement${block.language === 'hi' ? '.hi' : ''}.json`), 'utf-8'))
      if (marker.manualBlockId === block.id || Date.parse(marker.savedAt) >= Date.parse(block.failedAt)) continue
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
    result.push({ ...block, chapterId: chapter.id, seriesId, device: owner })
  }
  return result
}

/** Accept complete manually reviewed narration, never scene notes or an unresolved review result. */
export function parseManualNarration(response: string, language: NarrationLanguage, englishSource?: string | null): { script: string; summary: string; about: string | null } {
  const fail = (message: string): never => { throw new Error(message) }
  const input = response.trim().replace(/^```(?:json|text|markdown)?\s*\n/i, '').replace(/\n```\s*$/, '').trim()
  let script: string | null = null, summary: string | null = null, about: string | null = null
  if (input.startsWith('{')) {
    let value: any
    try { value = JSON.parse(input) } catch { return fail('The pasted review is not valid JSON. Paste its complete output.') }
    if (value.passed !== true || !Array.isArray(value.issues) || value.issues.length) return fail('This review still reports unresolved issues. Finish reviewing the narration before saving it.')
    if (typeof value.script !== 'string' || typeof value.summary !== 'string') return fail('The final review needs its complete script and summary.')
    script = value.script; summary = value.summary; about = typeof value.about === 'string' ? value.about : null
  } else {
    const marks = [...input.matchAll(/^[ \t*#_`>]*===\s*(SCRIPT|SUMMARY|CLOSING|ABOUT|SCENES)\s*===[ \t*_`]*$/gim)]
    const sections = new Map<string, string>()
    marks.forEach((m, i) => {
      const key = m[1].toUpperCase()
      if (sections.has(key)) fail(`The pasted output contains more than one ${key} section. Paste only the final complete response.`)
      sections.set(key, input.slice(m.index! + m[0].length, marks[i + 1]?.index ?? input.length).trim())
    })
    if (sections.has('SCENES')) return fail('These are scene notes. Continue to the full narration and paste the complete SCRIPT and SUMMARY sections.')
    script = sections.get('SCRIPT') ?? null; summary = sections.get('SUMMARY') ?? null; about = sections.get('ABOUT') ?? null
  }
  const markedScript = script ?? ''
  // Review JSON can retain a SCRIPT heading; section/scene bookkeeping must never be voiced.
  script = script?.replace(/^[ \t*#_`>]*===\s*SCRIPT\s*===[ \t*_`]*\r?\n?/gim, '')
    .replace(/^[ \t*_#>]*\[\s*SCENE\s*\d*\s*[:.\-–—]?\s*P\s*\d+\s*(?:(?:-|–|—|to)\s*P?\s*\d+\s*)?][ \t*_:.\-–—]*\r?\n?/gim, '').trim() ?? null
  if (!script || !summary?.trim()) return fail('Paste the complete narration with nonempty ===SCRIPT=== and ===SUMMARY=== sections, or a passed final review JSON.')
  if (/===|\[SCENE\s|<(?:Hinglish|note|script|summary)/i.test(script)) return fail('The narration contains unfinished output markers or placeholders. Paste the final complete script.')
  if (language === 'hi' && /[A-Za-z]/.test(script + summary)) return fail('Keep Hinglish narration and summary in Devanagari for voiceover and alignment.')
  if (language === 'hi' && englishSource) {
    // The phone's HinglishConvert.check: coverage, header/caption wording (narration and its English source), scenes
    // cut short, and the length window. Every problem is reported at once, one per line.
    const source = englishParagraphs(englishSource)
    const ranges = [...markedScript.matchAll(/^[ \t*_#>]*\[\s*SCENE\s*\d*\s*[:.\-–—]?\s*P\s*(\d+)\s*(?:(?:-|–|—|to)\s*P?\s*(\d+)\s*)?]/gim)]
    const scenes: { start: number; end: number; text: string }[] = []
    let next = 1
    for (const [index, range] of ranges.entries()) {
      const start = Number(range[1]), end = Number(range[2] ?? range[1])
      if (start !== next || end < start || end > source.length) return fail('The Hinglish scene ranges must cover every English paragraph once, in order.')
      const body = markedScript.slice(range.index! + range[0].length, ranges[index + 1]?.index ?? markedScript.length).trim()
      if (!body) return fail('Every Hinglish scene must contain its completed narration.')
      scenes.push({ start, end, text: body })
      next = end + 1
    }
    if (!ranges.length || next !== source.length + 1) return fail('Keep the Hinglish scene markers and cover every English source paragraph in the completed output.')
    const issues = [...presentationIssues(script), ...englishSourceIssues(englishSource)]
    const short = shortSceneIssue(scenes, source)
    if (short) issues.push(short)
    const count = hinglishWords(script), { floor, ceiling } = hinglishBudget(hinglishWords(englishSource))
    if (count < floor || count > ceiling) issues.push(LENGTH_LIMITS)
    if (issues.length) return fail(issues.join('\n'))
  }
  return { script, summary: summary.trim(), about: about?.trim() || null }
}
