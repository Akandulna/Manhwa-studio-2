/**
 * How close each Sleeper-Cell profile is to ChatGPT's upload limit, and when,
 * at the pace it is uploading, the limit will be used up.
 *
 * ChatGPT doesn't say how many images an account may upload, so the limit is
 * learnt: each time it stops a profile, the phone notes how many images that
 * profile uploaded since its limit before (`used`). The latest of those is
 * taken as the profile's limit. The first limit after tracking began may have
 * been counted from mid-window, so until a second one it is only a lower
 * bound. Flags for suspicious activity are not upload limits and are skipped.
 */

import type { PhoneUploadLimit, PhoneUploadProfile } from './api'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** Uploads within this long count as the profile being in use. */
const ACTIVE_MS = 20 * MINUTE
/** The pace is read over at most the last hour, and at least this long, so one burst doesn't read as a flood. */
const MIN_PACE_WINDOW_MS = 10 * MINUTE

export interface UploadUsage {
  profile: PhoneUploadProfile
  /** When ChatGPT's limit lifts, while it is still running; null otherwise. */
  limitedUntil: number | null
  /** Images uploaded towards the next limit. */
  used: number
  /** Since when `used` counts. */
  countingSince: number | null
  /** Images ChatGPT took before its last limit; null when no limit has been seen yet. */
  limit: number | null
  /** True when `limit` is only a lower bound (counted from when tracking began, perhaps mid-window). */
  limitAtLeast: boolean
  /** Images left before the limit, by `limit`; 0 while limited; null when the limit is unknown. */
  left: number | null
  lastHour: number
  lastDay: number
  /** Images per hour while in use; null when it hasn't uploaded in the last 20 minutes. */
  pace: number | null
  /** When `left` runs out at `pace`; null when idle, limited or the limit is unknown. */
  exhaustsAt: number | null
  /** The latest upload limit (not flag). */
  lastLimit: PhoneUploadLimit | null
}

export function uploadUsage(profile: PhoneUploadProfile, now = Date.now()): UploadUsage {
  const uploads = profile.uploads.map(u => ({ at: Date.parse(u.at), images: u.images }))
  const since = (from: number) => uploads.filter(u => u.at >= from).reduce((sum, u) => sum + u.images, 0)

  const limits = profile.limits.filter(l => !l.flagged)
  const lastLimit = limits[limits.length - 1] ?? null
  const complete = [...limits].reverse().find(l => l.complete)
  const limit = complete?.used ?? (limits.length ? Math.max(...limits.map(l => l.used)) : null)
  const limitAtLeast = !complete && limit !== null

  const until = profile.limitedUntil ? Date.parse(profile.limitedUntil) : NaN
  const limitedUntil = until > now ? until : null
  const used = profile.counting?.images ?? 0
  const left = limitedUntil ? 0 : limit === null ? null : Math.max(0, limit - used)

  const recent = uploads.filter(u => u.at >= now - HOUR)
  const lastHour = recent.reduce((sum, u) => sum + u.images, 0)
  const active = uploads.some(u => u.at >= now - ACTIVE_MS)
  // 5-minute slots are stamped with their start: the window runs from the first of them.
  const windowMs = recent.length ? Math.max(MIN_PACE_WINDOW_MS, now - recent[0].at) : HOUR
  const pace = active && lastHour > 0 ? (lastHour * HOUR) / windowMs : null
  const exhaustsAt = pace && left !== null && !limitedUntil ? now + (left / pace) * HOUR : null

  return {
    profile,
    limitedUntil,
    used,
    countingSince: profile.counting ? Date.parse(profile.counting.since) : null,
    limit,
    limitAtLeast,
    left,
    lastHour,
    lastDay: since(now - 24 * HOUR),
    pace,
    exhaustsAt,
    lastLimit
  }
}

export interface UploadOverview {
  /** Images left across the profiles not limited, by their known limits. */
  left: number
  /** Profiles whose limit hasn't been seen yet, so `left` leaves them out. */
  unknown: number
  /** The run's pace: it uploads on one profile at a time. */
  pace: number | null
  /**
   * When every profile is used up at `pace`, the run moving on from one to the
   * next as it does; null when idle or a limit is unknown.
   */
  allUsedAt: number | null
  /** The soonest a limited profile is free again. */
  nextLiftAt: number | null
}

export function uploadOverview(usages: UploadUsage[], now = Date.now()): UploadOverview {
  const open = usages.filter(u => !u.limitedUntil)
  const left = open.reduce((sum, u) => sum + (u.left ?? 0), 0)
  const unknown = open.filter(u => u.left === null).length
  const paces = usages.map(u => u.pace).filter((p): p is number => p !== null)
  const pace = paces.length ? Math.max(...paces) : null
  const lifts = usages.map(u => u.limitedUntil).filter((t): t is number => t !== null)
  return {
    left,
    unknown,
    pace,
    allUsedAt: pace && !unknown ? now + (left / pace) * HOUR : null,
    nextLiftAt: lifts.length ? Math.min(...lifts) : null
  }
}
