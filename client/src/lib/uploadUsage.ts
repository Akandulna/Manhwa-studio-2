/**
 * How close each Sleeper-Cell profile is to ChatGPT's upload limit, and when,
 * at the pace it is uploading, the limit will be used up.
 *
 * ChatGPT lets an account upload 80 files in any 3 hours. The window rolls:
 * each upload counts until 3 hours after it was made, so room comes back slot
 * by slot as the oldest uploads age out. The phone reports uploads in 5-minute
 * slots stamped with their start, so a slot counts until 3 hours after its end.
 * A limit ChatGPT puts on a profile anyway (the phone's `limitedUntil`) still
 * wins; flags for suspicious activity are not upload limits.
 */

import type { PhoneUploadLimit, PhoneUploadProfile } from './api'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** Files ChatGPT takes from one account in any `UPLOAD_WINDOW_MS`. */
export const UPLOAD_LIMIT = 80
export const UPLOAD_WINDOW_MS = 3 * HOUR
/** The phone's upload slots. */
const SLOT_MS = 5 * MINUTE

/** Uploads within this long count as the profile being in use. */
const ACTIVE_MS = 20 * MINUTE
/** The pace is read over at most the last hour, and at least this long, so one burst doesn't read as a flood. */
const MIN_PACE_WINDOW_MS = 10 * MINUTE

export interface UploadUsage {
  profile: PhoneUploadProfile
  /** While the profile can't upload: ChatGPT's limit, or the window full; null otherwise. */
  limitedUntil: number | null
  /** Images uploaded in the last 3 hours. */
  used: number
  limit: number
  /** Images left in the window; 0 while limited. */
  left: number
  /** When the oldest upload in the window ages out and frees room; null with nothing in the window. */
  nextFreeAt: number | null
  /** Images that `nextFreeAt` frees. */
  nextFree: number
  lastHour: number
  lastDay: number
  /** Images per hour while in use; null when it hasn't uploaded in the last 20 minutes. */
  pace: number | null
  /** When `left` runs out at `pace`; null when idle or limited. */
  exhaustsAt: number | null
  /** The latest limit ChatGPT put on it (not flag). */
  lastLimit: PhoneUploadLimit | null
}

export function uploadUsage(profile: PhoneUploadProfile, now = Date.now()): UploadUsage {
  const uploads = profile.uploads.map(u => ({ at: Date.parse(u.at), images: u.images }))
  const since = (from: number) => uploads.filter(u => u.at >= from).reduce((sum, u) => sum + u.images, 0)

  const limits = profile.limits.filter(l => !l.flagged)
  const lastLimit = limits[limits.length - 1] ?? null

  // Oldest first, as the phone sends them; each counts until `expires`.
  const inWindow = uploads
    .map(u => ({ ...u, expires: u.at + SLOT_MS + UPLOAD_WINDOW_MS }))
    .filter(u => u.expires > now && u.images > 0)
  const used = inWindow.reduce((sum, u) => sum + u.images, 0)
  const oldest = inWindow[0] ?? null

  // Full window: room comes back once enough of the oldest uploads age out to drop below the limit.
  let fullUntil: number | null = null
  if (used >= UPLOAD_LIMIT) {
    let count = used
    for (const u of inWindow) {
      count -= u.images
      if (count < UPLOAD_LIMIT) { fullUntil = u.expires; break }
    }
  }
  const until = profile.limitedUntil ? Date.parse(profile.limitedUntil) : NaN
  const chatGptUntil = until > now ? until : null
  const limitedUntil = chatGptUntil !== null || fullUntil !== null
    ? Math.max(chatGptUntil ?? 0, fullUntil ?? 0)
    : null
  const left = limitedUntil ? 0 : Math.max(0, UPLOAD_LIMIT - used)

  const recent = uploads.filter(u => u.at >= now - HOUR)
  const lastHour = recent.reduce((sum, u) => sum + u.images, 0)
  const active = uploads.some(u => u.at >= now - ACTIVE_MS)
  // 5-minute slots are stamped with their start: the window runs from the first of them.
  const windowMs = recent.length ? Math.max(MIN_PACE_WINDOW_MS, now - recent[0].at) : HOUR
  const pace = active && lastHour > 0 ? (lastHour * HOUR) / windowMs : null
  const exhaustsAt = pace && !limitedUntil ? now + (left / pace) * HOUR : null

  return {
    profile,
    limitedUntil,
    used,
    limit: UPLOAD_LIMIT,
    left,
    nextFreeAt: oldest?.expires ?? null,
    nextFree: oldest?.images ?? 0,
    lastHour,
    lastDay: since(now - 24 * HOUR),
    pace,
    exhaustsAt,
    lastLimit
  }
}

export interface UploadOverview {
  /** Images left across the profiles not limited. */
  left: number
  /** The run's pace: it uploads on one profile at a time. */
  pace: number | null
  /**
   * When every profile is used up at `pace`, the run moving on from one to the
   * next as it does; null when idle.
   */
  allUsedAt: number | null
  /** The soonest a limited profile is free again. */
  nextLiftAt: number | null
}

export function uploadOverview(usages: UploadUsage[], now = Date.now()): UploadOverview {
  const left = usages.reduce((sum, u) => sum + u.left, 0)
  const paces = usages.map(u => u.pace).filter((p): p is number => p !== null)
  const pace = paces.length ? Math.max(...paces) : null
  const lifts = usages.map(u => u.limitedUntil).filter((t): t is number => t !== null)
  return {
    left,
    pace,
    allUsedAt: pace ? now + (left / pace) * HOUR : null,
    nextLiftAt: lifts.length ? Math.min(...lifts) : null
  }
}
