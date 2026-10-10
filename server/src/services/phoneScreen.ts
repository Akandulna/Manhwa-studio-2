/**
 * The phones' screens, from Phone Status: Wake, Screen off and Screenshot go
 * to Sleeper-Cell as relay requests (`screen_on`, `screen_off`, `screenshot`),
 * only through the relay (R2 would be far too slow, and costs operations).
 *
 * Each phone answers with two receipts that phoneRelay.ts keeps apart from the
 * status ones:
 *   screen       { device, deviceId, updatedAt, answers?, on, locked, appOpen, keptOn, canLock, remoteStart,
 *                  last?: { action, ok, note, at } }
 *   screenshot   { device, deviceId, takenAt, answers?, shots: [{ label, width, height, jpeg (base64) }] }
 * A screenshot is posted only when there is one, so a failed one (its note is
 * in `screen.last`) leaves the previous one in place.
 */

import { relayConfigured, relayPhones, relayScreens, sendPhoneRequest, type PhoneAction } from './phoneRelay.js'

export type ScreenCommand = 'on' | 'off' | 'shot'

const ACTION: Record<ScreenCommand, PhoneAction> = { on: 'screen_on', off: 'screen_off', shot: 'screenshot' }

interface ScreenReceipt {
  updatedAt?: unknown
  answers?: unknown
  on?: unknown
  locked?: unknown
  appOpen?: unknown
  keptOn?: unknown
  canLock?: unknown
  remoteStart?: unknown
  last?: { action?: unknown; ok?: unknown; note?: unknown; at?: unknown } | null
}

interface ScreenshotReceipt {
  takenAt?: unknown
  shots?: { label?: unknown; width?: unknown; height?: unknown; jpeg?: unknown }[]
}

export interface PhoneScreenState {
  /** When the phone sent it. */
  at: string
  /** The request it answers (sendScreenCommand's id), or null when it reported by itself. */
  answers: string | null
  on: boolean
  locked: boolean
  /** Sleeper-Cell is on screen (resumed). */
  appOpen: boolean
  /** Woken from here and kept on until Screen off. */
  keptOn: boolean
  /** Sleeper-Cell is a device admin, so Screen off locks at once; without it the screen times out by itself. */
  canLock: boolean
  remoteStart: boolean
  /** The last command it handled. */
  last: { action: string; ok: boolean; note: string; at: string } | null
}

export interface PhoneScreenshot {
  takenAt: string
  /** Where each image is served: GET /r2/phone/screens/:device/:index (with ?v= to bust the cache). */
  shots: { label: string; width: number; height: number; url: string }[]
}

export interface PhoneScreen {
  device: string
  screen: PhoneScreenState | null
  screenshot: PhoneScreenshot | null
}

const iso = (value: unknown, fallback: number): string =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : new Date(fallback).toISOString()

/** What every phone last said of its screen, and its last screenshot. */
export function getPhoneScreens(): PhoneScreen[] {
  const byDevice = new Map<string, PhoneScreen>()
  const entry = (device: string) => {
    let found = byDevice.get(device)
    if (!found) byDevice.set(device, (found = { device, screen: null, screenshot: null }))
    return found
  }
  for (const { device, at, body } of relayScreens<ScreenReceipt>('screen')) {
    const last = body.last && typeof body.last === 'object' && typeof body.last.action === 'string'
      ? { action: body.last.action, ok: body.last.ok === true, note: typeof body.last.note === 'string' ? body.last.note : '', at: iso(body.last.at, at) }
      : null
    entry(device).screen = {
      at: iso(body.updatedAt, at),
      answers: typeof body.answers === 'string' && body.answers ? body.answers : null,
      on: body.on === true,
      locked: body.locked === true,
      appOpen: body.appOpen === true,
      keptOn: body.keptOn === true,
      canLock: body.canLock === true,
      remoteStart: body.remoteStart === true,
      last
    }
  }
  for (const { device, at, body } of relayScreens<ScreenshotReceipt>('screenshot')) {
    const takenAt = iso(body.takenAt, at)
    const shots = (Array.isArray(body.shots) ? body.shots : [])
      .map((shot, index) => ({ shot, index }))
      .filter(({ shot }) => shot && typeof shot.jpeg === 'string' && shot.jpeg.length > 0)
      .map(({ shot, index }) => ({
        label: typeof shot.label === 'string' ? shot.label : `Tab ${index + 1}`,
        width: Number(shot.width) || 0,
        height: Number(shot.height) || 0,
        url: `/api/r2/phone/screens/${encodeURIComponent(device)}/${index}?v=${Date.parse(takenAt) || at}`
      }))
    if (shots.length) entry(device).screenshot = { takenAt, shots }
  }
  return [...byDevice.values()]
}

/** One screenshot image as JPEG bytes, or null when there's no such one. */
export function phoneScreenshotImage(device: string, index: number): Buffer | null {
  const receipt = relayScreens<ScreenshotReceipt>('screenshot').find(r => r.device === device)
  const jpeg = receipt?.body.shots?.[index]?.jpeg
  return typeof jpeg === 'string' && jpeg ? Buffer.from(jpeg, 'base64') : null
}

/**
 * Sends Wake, Screen off or Screenshot to one phone. `reached` is false when
 * it isn't connected: the relay keeps the request, and the phone acts on it if
 * it connects within 2 minutes.
 */
export async function sendScreenCommand(command: ScreenCommand, device: string): Promise<{ id: string; reached: boolean }> {
  if (!relayConfigured()) throw new Error('The phone’s screen controls need the phone relay (Settings → Cloudflare)')
  if (!device || !relayPhones().some(p => p.id === device)) throw new Error('That phone is not known to the relay')
  const sent = await sendPhoneRequest(ACTION[command], { device })
  return { id: sent.id, reached: sent.phones > 0 }
}
