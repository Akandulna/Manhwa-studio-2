import type { PrismaClient } from '@prisma/client'
import { RelayDeliveryPaused, relayPauseForDatabase } from './relayDeliveryPause.js'

let database: PrismaClient | null = null
const features = new Map<string, Set<string>>()
const origin = () => (process.env.RELAY_URL ?? '').trim().replace(/\/+$/, '')
export function configureRelayTraffic(db: PrismaClient): void { database = db }
export function relayTrafficPause(socketRole?:'desktop') {
  if (!database) throw new Error('Relay delivery is not initialized')
  return relayPauseForDatabase(database,socketRole)
}
export function learnRelayFeatures(value: unknown): void {
  if (!Array.isArray(value) || value.length > 16 || !value.every(v => typeof v === 'string' && v.length <= 64)) return
  features.set(origin(), new Set(value))
}
export function hasRelayFeature(feature: string): boolean { return features.get(origin())?.has(feature) === true }
export async function beforeRelaySend(): Promise<void> { await relayTrafficPause().beforeSend() }
export async function beforeRelaySocket():Promise<void> { await beforeRelaySend(); await relayTrafficPause('desktop').beforeSend() }
export async function recordRelayUpgrade(retryAfter:unknown,reason:unknown):Promise<void> {
  const pause=reason==='connection_limit'||reason==='device_limit'?relayTrafficPause('desktop'):relayTrafficPause()
  await pause.record(typeof retryAfter==='string'?retryAfter:null)
}
export async function relayRetryDelay(minimum = 30_000, socket = false): Promise<number> {
  const remaining=Math.max(await relayTrafficPause().remainingMs(),socket?await relayTrafficPause('desktop').remainingMs():0)
  return remaining>0?Math.max(minimum,remaining+1_000+Math.floor(Math.random()*5_000)):minimum
}
export async function recordRelayBudget(retryAfter: unknown): Promise<void> {
  await relayTrafficPause().record(typeof retryAfter === 'string' || typeof retryAfter === 'number' ? String(retryAfter) : null)
}
/** One request. Retry scheduling remains with the caller. */
export async function relayFetch(url: string, init?: RequestInit): Promise<Response> {
  await beforeRelaySend()
  const response = await fetch(url, { ...init, redirect: 'error' })
  const advertised = response.headers.get('X-Relay-Features')
  if (advertised) learnRelayFeatures(advertised.split(','))
  if (response.status === 429) {
    await response.body?.cancel()
    await recordRelayBudget(response.headers.get('Retry-After'))
    throw new RelayDeliveryPaused()
  }
  return response
}
