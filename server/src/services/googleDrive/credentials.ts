/**
 * Secret storage for Google Drive (PRD §4.4).
 *
 * The OAuth client secret and every refresh token live in the macOS Keychain
 * (through @napi-rs/keyring, which works both when Studio is launched from
 * Finder and when the backend runs directly). The database only stores an
 * opaque reference to the Keychain item. If the Keychain refuses access the
 * operation fails: there is deliberately no plaintext fallback.
 */

import { DriveError } from './errors.js'

export interface SecretStore {
  get(ref: string): Promise<string | null>
  set(ref: string, value: string): Promise<void>
  /** True when an item was removed, false when there was none. */
  delete(ref: string): Promise<boolean>
}

/** Keychain service name shown in Keychain Access. */
export const KEYCHAIN_SERVICE = 'Manhwa Studio · Google Drive'

type KeyringModule = typeof import('@napi-rs/keyring')
let keyring: Promise<KeyringModule> | null = null
const loadKeyring = () => (keyring ??= import('@napi-rs/keyring'))

function keychainFailure(action: string): DriveError {
  return new DriveError(
    'keychain',
    `macOS Keychain refused to ${action} Studio's Google Drive credential. Unlock the login keychain (or click Allow when macOS asks) and try again. Studio never falls back to storing it in plain text.`
  )
}

export function keychainSecretStore(service = KEYCHAIN_SERVICE): SecretStore {
  const entry = async (ref: string) => new (await loadKeyring()).AsyncEntry(service, ref)
  return {
    async get(ref) {
      try {
        return await (await entry(ref)).getPassword()
      } catch {
        throw keychainFailure('read')
      }
    },
    async set(ref, value) {
      try {
        await (await entry(ref)).setPassword(value)
      } catch {
        throw keychainFailure('save')
      }
    },
    async delete(ref) {
      try {
        return await (await entry(ref)).deleteCredential()
      } catch {
        throw keychainFailure('delete')
      }
    }
  }
}

/** In-memory store for tests. */
export function memorySecretStore(): SecretStore & { readonly items: Map<string, string>; failNext?: 'get' | 'set' | 'delete' } {
  const items = new Map<string, string>()
  const store = {
    items,
    failNext: undefined as 'get' | 'set' | 'delete' | undefined,
    async get(ref: string) {
      if (store.failNext === 'get') { store.failNext = undefined; throw keychainFailure('read') }
      return items.get(ref) ?? null
    },
    async set(ref: string, value: string) {
      if (store.failNext === 'set') { store.failNext = undefined; throw keychainFailure('save') }
      items.set(ref, value)
    },
    async delete(ref: string) {
      if (store.failNext === 'delete') { store.failNext = undefined; throw keychainFailure('delete') }
      return items.delete(ref)
    }
  }
  return store
}
