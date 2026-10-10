/**
 * A phone's browser profiles, from Phone Status: which one is selected (the
 * one the next run starts in), and each one's ChatGPT settings for Image
 * Clipper (mode, model, effort), picked from what its account offers. Each
 * goes to Sleeper-Cell as a relay request (`profile_select`,
 * `chatgpt_settings`, `chatgpt_options`) naming the phone's own profile id.
 * The phone answers in its crops receipt's profiles (selected, chatGpt), and
 * with how it went in its screen receipt's `last`.
 */

import { relayConfigured, relayPhones, sendPhoneRequest, type PhoneRequestArgs } from './phoneRelay.js'

export type ProfileCommand = 'select' | 'settings' | 'options'

export type ChatGptSettings = NonNullable<PhoneRequestArgs['settings']>

const ACTION = { select: 'profile_select', settings: 'chatgpt_settings', options: 'chatgpt_options' } as const

const MAX_NAME = 100

/** `settings` from the browser: each a name or null; Chat or Work for the mode. */
export function parseChatGptSettings(value: unknown): ChatGptSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('settings must be { mode, model, effort }')
  const pick = (v: unknown, field: string): string | null => {
    if (v === null || v === undefined || v === '') return null
    if (typeof v !== 'string' || v.length > MAX_NAME) throw new Error(`${field} must be a name or null`)
    return v
  }
  const raw = value as Record<string, unknown>
  const mode = pick(raw.mode, 'mode')
  if (mode !== null && mode !== 'Chat' && mode !== 'Work') throw new Error('mode must be Chat, Work or null')
  return { mode, model: pick(raw.model, 'model'), effort: pick(raw.effort, 'effort') }
}

/**
 * Sends a profile command to one phone. `reached` is false when it isn't
 * connected: the relay keeps the request, and the phone acts on it if it
 * connects within 2 minutes.
 */
export async function sendProfileCommand(
  command: ProfileCommand,
  device: string,
  profile: string,
  settings?: ChatGptSettings
): Promise<{ id: string; reached: boolean }> {
  if (!relayConfigured()) throw new Error('The phone’s profile controls need the phone relay (Settings → Cloudflare)')
  if (!device || !relayPhones().some(p => p.id === device)) throw new Error('That phone is not known to the relay')
  if (!profile || profile.length > MAX_NAME) throw new Error('Pick a profile')
  if (command === 'settings' && !settings) throw new Error('settings are missing')
  const sent = await sendPhoneRequest(ACTION[command], { device, profile, ...(command === 'settings' ? { settings } : {}) })
  return { id: sent.id, reached: sent.phones > 0 }
}
