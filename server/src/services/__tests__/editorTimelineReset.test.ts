import { createHash } from 'crypto'
import { describe, expect, it } from 'vitest'
import { editorTimelineResetRevision, retainEditorTimelineReset } from '../editorTimelineReset.js'
function store() {
  const rows = new Map<string, string>()
  return { rows, async findUnique({ where }: { where: { key: string } }) { const value = rows.get(where.key); return value ? { value } : null },
    async upsert({ where, create }: { where: { key: string }; create: { value: string } }) { rows.set(where.key, create.value) } }
}
const first = '2026-10-31T06:06:36.950Z', second = '2026-10-31T07:00:00.000Z'
const empty = (at: string) => JSON.stringify({ jsonSha256: createHash('sha256').update('').digest('hex'), madeAt: at, sourceSha256: null })
describe('durable per-language Editor resets', () => {
  it('does not assign resets to untouched or nonempty timeline edits', async () => {
    const db = store()
    expect(await editorTimelineResetRevision(db, 'c3', 'en')).toBeNull()
    db.rows.set('editor2-phone-timeline-edit:c3:en', JSON.stringify({ jsonSha256: 'nonempty', madeAt: first }))
    expect(await editorTimelineResetRevision(db, 'c3', 'en')).toBeNull()
  })
  it('recognizes already-saved empty intents and retains the reset before a replacement save', async () => {
    const db = store()
    db.rows.set('editor2-phone-timeline-edit:c3:en', empty(first))
    expect(await editorTimelineResetRevision(db, 'c3', 'en')).toBe(first)
    expect(await editorTimelineResetRevision(db, 'c3', 'hi')).toBeNull()
    await retainEditorTimelineReset(db, 'c3', 'en')
    db.rows.set('editor2-phone-timeline-edit:c3:en', JSON.stringify({ jsonSha256: 'new-result', madeAt: second }))
    expect(await editorTimelineResetRevision(db, 'c3', 'en')).toBe(first)
  })
  it('takes the newest reset and never rolls it back to an older retained intent', async () => {
    const db = store()
    await retainEditorTimelineReset(db, 'c3', 'en', second)
    db.rows.set('editor2-phone-timeline-edit:c3:en', empty(first))
    await retainEditorTimelineReset(db, 'c3', 'en', first)
    expect(await editorTimelineResetRevision(db, 'c3', 'en')).toBe(second)
    expect(await editorTimelineResetRevision(db, 'c4', 'en')).toBeNull()
  })
})
