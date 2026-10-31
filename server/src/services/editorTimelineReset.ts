import { createHash } from 'crypto'
import type { NarrationLanguage } from './narrationLanguage.js'

interface Settings {
  findUnique(args: { where: { key: string } }): Promise<{ value: string } | null>
  upsert(args: { where: { key: string }; create: { key: string; value: string }; update: { value: string } }): Promise<unknown>
}
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex')
const resetKey = (id: string, language: NarrationLanguage) => `editor2-phone-timeline-reset:${id}:${language}`
function validRevision(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}

/** Empty edit intents from older Studio builds are already-authorized resets. */
export async function editorTimelineResetRevision(settings: Settings, id: string, language: NarrationLanguage): Promise<string | null> {
  const [saved, edit] = await Promise.all([
    settings.findUnique({ where: { key: resetKey(id, language) } }),
    settings.findUnique({ where: { key: `editor2-phone-timeline-edit:${id}:${language}` } })
  ])
  const record = saved ? JSON.parse(saved.value) : null
  const intent = edit ? JSON.parse(edit.value) : null
  if (record && (record.schema !== 'editor2-timeline-reset/1' || !validRevision(record.revision))) throw new Error('Invalid saved Editor reset revision')
  const revisions: string[] = record ? [record.revision] : []
  if (intent?.jsonSha256 === EMPTY_SHA256 && validRevision(intent.madeAt)) revisions.push(intent.madeAt)
  return revisions.sort().at(-1) ?? null
}

/** Called in the same transaction as a save, before replacing its prior edit intent.
 * Retains the reset when the empty row is later replaced by a generated/saved timeline. */
export async function retainEditorTimelineReset(settings: Settings, id: string, language: NarrationLanguage, resetAt?: string): Promise<void> {
  const previous = await editorTimelineResetRevision(settings, id, language)
  if (resetAt !== undefined && !validRevision(resetAt)) throw new Error('Invalid Editor reset time')
  const revision = [previous, resetAt].filter((value): value is string => !!value).sort().at(-1)
  if (!revision) return
  const key = resetKey(id, language)
  const value = JSON.stringify({ schema: 'editor2-timeline-reset/1', revision })
  await settings.upsert({ where: { key }, create: { key, value }, update: { value } })
}
