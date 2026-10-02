/**
 * Editor 2.0 — the timeline JSON handoff between the chapter list and the
 * preview screen, plus the record of what has already been processed.
 *
 * Both live in localStorage and are keyed per chapter: processing one
 * chapter must never change what another chapter's card offers. The JSON is
 * far too large for a query string, and keeping it here lets the preview be
 * reloaded (or reopened later) without re-pasting.
 *
 * localStorage rather than sessionStorage deliberately: a chapter that was
 * already processed must keep showing Preview even after the tab or browser
 * is closed and reopened, not just for the rest of the current session.
 *
 * A chapter is "processed" once its preview built successfully from a given
 * paste. That state is what turns Start Processing into Preview, and it is
 * cleared the moment a different JSON is pasted, so a new paste always has to
 * be processed before it can be previewed.
 *
 * localStorage is per browser, though — Chrome and the desktop app each have
 * their own — so it is only a synchronous cache. Every change is also pushed
 * to the server (one row per chapter), and syncSeriesTimelines /
 * syncChapterTimeline reconcile the two before a screen reads the cache.
 * Each chapter carries the time of its last local change; whichever side
 * changed last wins, in both directions.
 */

import { videoApi2, type StoredTimeline2 } from '@/lib/api'

const JSON_PREFIX = 'editor2:timeline-json:'
const PROCESSED_PREFIX = 'editor2:processed:'
const SCROLL_PREFIX = 'editor2:scroll:'
const EXPANDED_PREFIX = 'editor2:expanded:'
/** Epoch ms of a chapter's last local change, compared against the server's. */
const UPDATED_PREFIX = 'editor2:updated:'

/** Read a value, treating unavailable storage as simply "nothing stored". */
function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

function remove(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // Nothing to do — the value is already effectively gone.
  }
}

/**
 * One-time carry-over from the old sessionStorage-backed version of this
 * module. Without this, anyone with an already-"processed" chapter sitting in
 * the current tab's session would see its Preview button silently revert to
 * Start Processing the moment this file switched storages under them.
 */
;(function migrateFromSessionStorage() {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i)
      if (!key || !(key.startsWith(JSON_PREFIX) || key.startsWith(PROCESSED_PREFIX))) continue
      if (localStorage.getItem(key) === null) {
        const value = sessionStorage.getItem(key)
        if (value !== null) localStorage.setItem(key, value)
      }
      sessionStorage.removeItem(key)
    }
  } catch {
    // Best-effort only — an unavailable session/local storage just means
    // nothing to carry over.
  }
})()

/** The JSON handed to the preview screen for one chapter. */
export function getTimelineJson(chapterId: string): string | null {
  return read(`${JSON_PREFIX}${chapterId}`)
}

/**
 * Hand a chapter's JSON over for processing.
 *
 * Storing a JSON that differs from what was last processed clears the
 * processed marker: the new paste has not been through the processor yet, so
 * the card must ask for processing rather than offering a stale preview.
 */
export function setTimelineJson(chapterId: string, json: string): boolean {
  if (getProcessedJson(chapterId) !== json) clearProcessed(chapterId)
  const ok = write(`${JSON_PREFIX}${chapterId}`, json)
  if (ok) touch(chapterId)
  return ok
}

/** The exact JSON that last processed successfully, if any. */
export function getProcessedJson(chapterId: string): string | null {
  return read(`${PROCESSED_PREFIX}${chapterId}`)
}

/** Record that this JSON processed successfully for this chapter. */
export function markProcessed(chapterId: string, json: string): void {
  write(`${PROCESSED_PREFIX}${chapterId}`, json)
  touch(chapterId)
}

export function clearProcessed(chapterId: string): void {
  if (getProcessedJson(chapterId) === null) return
  remove(`${PROCESSED_PREFIX}${chapterId}`)
  touch(chapterId)
}

/** Forget a chapter's paste entirely (used by the card's Clear button). */
export function clearTimeline(chapterId: string): void {
  remove(`${JSON_PREFIX}${chapterId}`)
  clearProcessed(chapterId)
  // Pushed as an empty paste rather than deleted, so another browser still
  // holding the old one drops it instead of uploading it back.
  touch(chapterId)
}

/**
 * Whether this chapter's current content has already been processed.
 *
 * Compared by content, not by a flag, so editing the pasted text in the box
 * correctly sends it back to needing processing.
 */
export function isProcessed(chapterId: string, content: string): boolean {
  const processed = getProcessedJson(chapterId)
  return processed !== null && processed === content
}

/**
 * The JSON of every chapter here that has been processed, in the order given.
 *
 * "Processed" is the same test the cards use — the stored paste still matches
 * what last processed successfully — so the export can only ever be offered
 * the exact content the user has already previewed.
 */
export function collectProcessed(chapterIds: string[]): { chapterId: string; json: string }[] {
  const out: { chapterId: string; json: string }[] = []
  for (const chapterId of chapterIds) {
    const json = getTimelineJson(chapterId)
    if (json && isProcessed(chapterId, json)) out.push({ chapterId, json })
  }
  return out
}

// ============ Server sync ============

const PUSH_DELAY_MS = 800
const pushTimers = new Map<string, ReturnType<typeof setTimeout>>()

function localUpdatedAt(chapterId: string): number {
  const n = Number(read(`${UPDATED_PREFIX}${chapterId}`))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Whether this browser holds anything for the chapter, cleared state included. */
function hasLocalState(chapterId: string): boolean {
  return (
    read(`${UPDATED_PREFIX}${chapterId}`) !== null ||
    read(`${JSON_PREFIX}${chapterId}`) !== null ||
    read(`${PROCESSED_PREFIX}${chapterId}`) !== null
  )
}

/** Stamp a local change and schedule pushing it (debounced: the box autosaves per keystroke). */
function touch(chapterId: string): void {
  write(`${UPDATED_PREFIX}${chapterId}`, String(Date.now()))
  const pending = pushTimers.get(chapterId)
  if (pending) clearTimeout(pending)
  pushTimers.set(chapterId, setTimeout(() => {
    pushTimers.delete(chapterId)
    void pushLocal(chapterId)
  }, PUSH_DELAY_MS))
}

/**
 * Send this browser's copy of a chapter to the server. A failure is left
 * alone: the local stamp stays newer, so the next sync pushes it again.
 */
async function pushLocal(chapterId: string): Promise<void> {
  let updatedAt = localUpdatedAt(chapterId)
  if (updatedAt === 0) {
    // Written before the server copy existed — stamp it now so it uploads.
    updatedAt = Date.now()
    write(`${UPDATED_PREFIX}${chapterId}`, String(updatedAt))
  }
  try {
    await videoApi2.saveStoredTimeline(chapterId, {
      json: getTimelineJson(chapterId) ?? '',
      processedJson: getProcessedJson(chapterId),
      updatedAt
    })
  } catch (err) {
    console.warn('[editor2] could not save the timeline to the server:', err)
  }
}

/** Overwrite this browser's copy with the server's. */
function applyStored(row: StoredTimeline2): void {
  if (row.json) write(`${JSON_PREFIX}${row.chapterId}`, row.json)
  else remove(`${JSON_PREFIX}${row.chapterId}`)
  if (row.processedJson !== null) write(`${PROCESSED_PREFIX}${row.chapterId}`, row.processedJson)
  else remove(`${PROCESSED_PREFIX}${row.chapterId}`)
  write(`${UPDATED_PREFIX}${row.chapterId}`, String(row.updatedAt))
}

/** Settle one chapter between the cache and the server row, newest winning. */
function reconcile(chapterId: string, row: StoredTimeline2 | undefined): Promise<void> | void {
  // A push still waiting on its debounce is newer than anything stored.
  if (pushTimers.has(chapterId)) return
  const local = localUpdatedAt(chapterId)
  if (row && row.updatedAt > local) return applyStored(row)
  if (hasLocalState(chapterId) && (!row || local > row.updatedAt)) return pushLocal(chapterId)
}

/**
 * Bring the cache in line with the server for these chapters — call before
 * reading any of them. Downloads what another browser processed, and uploads
 * what only this browser has (including pastes from before the server copy
 * existed). If the server cannot be reached the cache is used as it is.
 */
export async function syncSeriesTimelines(seriesId: string, chapterIds: string[]): Promise<void> {
  let rows: StoredTimeline2[]
  try {
    rows = await videoApi2.getStoredTimelines(seriesId)
  } catch (err) {
    console.warn('[editor2] could not load stored timelines:', err)
    return
  }
  const byChapter = new Map(rows.map(r => [r.chapterId, r]))
  // Uploads don't hold up the screen: the cache already has what they send.
  for (const chapterId of chapterIds) void reconcile(chapterId, byChapter.get(chapterId))
}

/** syncSeriesTimelines for a single chapter (the preview opened directly). */
export async function syncChapterTimeline(chapterId: string): Promise<void> {
  let row: StoredTimeline2 | null
  try {
    row = await videoApi2.getStoredTimeline(chapterId)
  } catch (err) {
    console.warn('[editor2] could not load the stored timeline:', err)
    return
  }
  void reconcile(chapterId, row ?? undefined)
}

// ============ View state: where the user was on the list ============
//
// Leaving for the preview and coming back should land where it left off, not
// at the top of a hundred-chapter list. Both the scroll offset and which row
// was open are remembered per series, so returning restores the whole view
// rather than just its scroll position.

/** Remember how far down the chapter list of one series is scrolled. */
export function saveScrollTop(seriesId: string, top: number): void {
  write(`${SCROLL_PREFIX}${seriesId}`, String(Math.max(0, Math.round(top))))
}

export function getScrollTop(seriesId: string): number {
  const raw = read(`${SCROLL_PREFIX}${seriesId}`)
  const n = raw === null ? NaN : Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

/** Remember which chapter row is expanded, if any. */
export function saveExpanded(seriesId: string, chapterId: string | null): void {
  if (chapterId) write(`${EXPANDED_PREFIX}${seriesId}`, chapterId)
  else remove(`${EXPANDED_PREFIX}${seriesId}`)
}

export function getExpanded(seriesId: string): string | null {
  return read(`${EXPANDED_PREFIX}${seriesId}`)
}
