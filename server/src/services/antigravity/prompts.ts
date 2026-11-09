/**
 * AntiGravity prompt pack (docs/PRD-antigravity-studio.md §9.1).
 *
 * Three editable, versioned texts: the Crop Rules, the Crop Pointer (analysis)
 * template and the Review template. They are seeded once from Sleeper-Cell's
 * bundled defaults (branch v2: BrowserDatabase CROP_RULES_PROMPT,
 * GeometryWorkflow.prompt, CropReview.geometryReviewPrompt) — the phone's own
 * edited Crop Rules may differ, so Settings shows the origin and lets the
 * operator paste the phone's text. Versions are immutable; each run pins the
 * version ids and hashes, so editing affects future jobs only.
 */

import crypto from 'node:crypto'
import type { PrismaClient } from '@prisma/client'

export const PROMPT_KINDS = ['crop_rules', 'analysis', 'review'] as const
export type PromptKind = (typeof PROMPT_KINDS)[number]

export const SEED_ORIGIN = 'Sleeper-Cell v2 bundled default'
const CURRENT_KEY = 'antigravityPromptCurrent'
const MAX_PROMPT_CHARS = 200_000

/** Loaded on first use so this module stays importable on its own. */
async function defaults(): Promise<Record<PromptKind, string>> {
  const t = await import('./review/templates.js')
  return { crop_rules: t.DEFAULT_CROP_RULES, analysis: t.DEFAULT_ANALYSIS_TEMPLATE, review: t.DEFAULT_REVIEW_TEMPLATE }
}

export interface PromptPack {
  ids: Record<PromptKind, string>
  hashes: Record<PromptKind, string>
  texts: Record<PromptKind, string>
  origins: Record<PromptKind, string>
}

export const promptHash = (text: string) => crypto.createHash('sha256').update(text).digest('hex')

export class PromptStore {
  constructor(private readonly prisma: PrismaClient) {}

  private async currentIds(): Promise<Partial<Record<PromptKind, string>>> {
    const row = await this.prisma.setting.findUnique({ where: { key: CURRENT_KEY } })
    try { return row ? JSON.parse(row.value) : {} } catch { return {} }
  }

  private async setCurrent(kind: PromptKind, id: string) {
    const ids = { ...(await this.currentIds()), [kind]: id }
    const value = JSON.stringify(ids)
    await this.prisma.setting.upsert({ where: { key: CURRENT_KEY }, create: { key: CURRENT_KEY, value }, update: { value } })
  }

  async save(kind: PromptKind, content: string, origin: string) {
    if (!PROMPT_KINDS.includes(kind)) throw new Error('Unknown prompt kind.')
    const text = content.replace(/\r\n/g, '\n')
    if (!text.trim()) throw new Error('The prompt is empty.')
    if (text.length > MAX_PROMPT_CHARS) throw new Error('The prompt is too long.')
    const hash = promptHash(text)
    const pack = await this.pack().catch(() => null)
    if (pack && pack.hashes[kind] === hash) return { id: pack.ids[kind], kind, sha256: hash, unchanged: true }
    const version = await this.prisma.antigravityPromptVersion.create({ data: { kind, content: text, sha256: hash, origin: origin.slice(0, 200) } })
    await this.setCurrent(kind, version.id)
    return { id: version.id, kind, sha256: hash, unchanged: false }
  }

  /** The current pack, seeding the Sleeper-Cell defaults the first time. */
  async pack(): Promise<PromptPack> {
    const ids = await this.currentIds()
    const out = { ids: {}, hashes: {}, texts: {}, origins: {} } as PromptPack
    for (const kind of PROMPT_KINDS) {
      let version = ids[kind] ? await this.prisma.antigravityPromptVersion.findUnique({ where: { id: ids[kind] } }) : null
      if (!version) {
        const text = (await defaults())[kind]
        version = await this.prisma.antigravityPromptVersion.create({ data: { kind, content: text, sha256: promptHash(text), origin: SEED_ORIGIN } })
        await this.setCurrent(kind, version.id)
      }
      out.ids[kind] = version.id
      out.hashes[kind] = version.sha256
      out.texts[kind] = version.content
      out.origins[kind] = version.origin
    }
    return out
  }

  async history(kind: PromptKind) {
    const versions = await this.prisma.antigravityPromptVersion.findMany({ where: { kind }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, sha256: true, origin: true, createdAt: true } })
    return { versions, defaultSha256: promptHash((await defaults())[kind]) }
  }

  async version(id: string) {
    return this.prisma.antigravityPromptVersion.findUnique({ where: { id } })
  }
}
