/**
 * Saving one chapter's Editor 2.0 timeline JSON (the Editor2Timeline row), the way a paste in
 * Editor 2.0 is saved: newest write wins, a changed timeline records its publication intent
 * (bound to the Editor inputs it was made from) and Editor's auto-publish sends it to the phones.
 * Used by PUT /video2/chapters/:id/timeline and by AntiGravity → Timeline.
 */

import { createHash } from 'crypto'
import { prisma } from '../index.js'
import { captureEditorTimelineSource } from './phoneEditor.js'
import { queueEditorPublish } from './editorAutoPublish.js'
import { retainEditorTimelineReset } from './editorTimelineReset.js'
import type { NarrationLanguage } from './narrationLanguage.js'

export interface StoreTimelineInput {
  chapterId: string
  language: NarrationLanguage
  json: string
  processedJson: string | null
  /** The writer's time (epoch ms): an older write than the stored row is ignored. */
  updatedAt: number
  /** An explicit reset (clear) of the timeline. */
  reset?: boolean
  /** Who made it (shown as the timeline's AI). Absent = kept while the JSON is unchanged, else cleared. */
  model?: string | null
}

type TimelineRow = NonNullable<Awaited<ReturnType<typeof prisma.editor2Timeline.findUnique>>>

/** Saves the timeline unless a newer write is stored; returns what is stored afterwards and whether it changed. */
export async function storeEditorTimeline(input: StoreTimelineInput): Promise<{ row: TimelineRow; changed: boolean }> {
  const { chapterId, language, json, processedJson, updatedAt, reset } = input
  const key = { chapterId_language: { chapterId, language } }
  const existing = await prisma.editor2Timeline.findUnique({ where: key })
  if (existing && existing.updatedAt.getTime() >= updatedAt) return { row: existing, changed: false }
  const changed = existing?.json !== json || reset === true
  const sourceSha256 = changed && json.trim() ? await captureEditorTimelineSource(chapterId, language) : null
  const model = input.model !== undefined ? input.model : existing?.json.trim() === json.trim() && json.trim() ? existing.model : null
  const data = { json, processedJson, model, updatedAt: new Date(updatedAt) }
  const outcome = await prisma.$transaction(async tx => {
    const latest = await tx.editor2Timeline.findUnique({ where: key })
    if (latest && latest.updatedAt.getTime() >= updatedAt) return { row: latest, changed: false }
    const saved = await tx.editor2Timeline.upsert({ where: key, create: { chapterId, language, ...data }, update: data })
    if (changed) {
      await retainEditorTimelineReset(tx.setting, chapterId, language, json.trim() ? undefined : saved.updatedAt.toISOString())
      const editKey = `editor2-phone-timeline-edit:${chapterId}:${language}`
      const value = JSON.stringify({ jsonSha256: createHash('sha256').update(json).digest('hex'), madeAt: saved.updatedAt.toISOString(), sourceSha256 })
      await tx.setting.upsert({ where: { key: editKey }, create: { key: editKey, value }, update: { value } })
    }
    return { row: saved, changed }
  })
  // The saved edit and its durable publication intent commit together.
  if (outcome.changed) queueEditorPublish(chapterId)
  return outcome
}
