/**
 * Google Drive connection for Studio AntiGravity (PRD §4).
 *
 * Owns the OAuth client configuration, account authorization, access-token
 * refresh, the app-owned "Manhwa Studio" root, the test transfer and
 * disconnect. Everything it returns is sanitized: no client secret, token,
 * authorization code or callback URL ever leaves this module. Access tokens
 * stay in memory; refresh tokens and the client secret stay in the Keychain.
 */

import crypto from 'node:crypto'
import { DriveApi, folderUrl, type DriveAbout } from './driveApi.js'
import { DriveError, driveErrorMessage, toDriveError } from './errors.js'
import { ensureRootFolder, ROOT_ENTITY, ROOT_FOLDER_NAME, runTransferTest, type DriveTestResult } from './files.js'
import {
  buildAuthUrl,
  createPkcePair,
  createState,
  DRIVE_FILE_SCOPE,
  exchangeAuthorizationCode,
  grantedScopes,
  parseDesktopClientJson,
  readIdToken,
  refreshAccessToken,
  revokeToken,
  startLoopbackListener,
  type DesktopClientConfig,
  type FetchFn,
  type LoopbackListener
} from './oauth.js'
import type { SecretStore } from './credentials.js'
import type { DriveConnectionRecord, DriveStore } from './store.js'

export type DriveConnectionState = 'not_configured' | 'disconnected' | 'connecting' | 'connected' | 'reconnect_required' | 'error'
export type ConnectRequestStatus = 'pending' | 'completed' | 'denied' | 'rejected' | 'expired' | 'cancelled' | 'error'

export interface DriveStatus {
  state: DriveConnectionState
  client: { clientId: string; projectId: string | null; importedAt: string } | null
  account: { connectionId: string; email: string; scopes: string[]; connectedAt: string } | null
  storage: { limit: number | null; usage: number | null; usageInDrive: number | null } | null
  storageNote: string | null
  root: { folderId: string | null; name: string; url: string | null; verifiedAt: string | null; state: 'ok' | 'missing' | 'unverified' | 'none' } | null
  lastTest: DriveTestResult | null
  lastError: string | null
  pendingRequestId: string | null
  otherAccounts: { connectionId: string; email: string; status: string }[]
  /** Whether this response includes a live check against Google. */
  checked: boolean
}

export interface ConnectRequestView {
  requestId: string
  status: ConnectRequestStatus
  message: string | null
  email: string | null
}

interface PendingConnect {
  id: string
  status: ConnectRequestStatus
  message: string | null
  email: string | null
  listener: LoopbackListener | null
  createdAt: number
}

export interface GoogleDriveServiceDeps {
  store: DriveStore
  secrets: SecretStore
  fetch?: FetchFn
  /** Opens a URL in the operator's system browser; resolves false if it could not. */
  openBrowser?: (url: string) => Promise<boolean>
  /** True while AntiGravity work is running (switching accounts is then refused). */
  hasActiveWork?: () => boolean | Promise<boolean>
  oauthTimeoutMs?: number
  now?: () => number
  /** Overrides for DriveApi (tests). */
  driveOptions?: { sleep?: (ms: number) => Promise<void>; maxAttempts?: number; timeoutMs?: number }
  testImage?: () => Promise<Buffer>
}

const OAUTH_SESSION_MS = 10 * 60_000
const TOKEN_SKEW_MS = 60_000
const FINISHED_REQUEST_TTL_MS = 30 * 60_000

const opaqueRef = (kind: string, ...parts: string[]) =>
  `${kind}:${crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32)}`

const toNumber = (value: string | undefined) => (value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null)

export class GoogleDriveService {
  private readonly store: DriveStore
  private readonly secrets: SecretStore
  private readonly fetchFn: FetchFn
  private readonly now: () => number
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>()
  private readonly refreshes = new Map<string, Promise<string>>()
  private readonly requests = new Map<string, PendingConnect>()

  constructor(private readonly deps: GoogleDriveServiceDeps) {
    this.store = deps.store
    this.secrets = deps.secrets
    this.fetchFn = deps.fetch ?? fetch
    this.now = deps.now ?? Date.now
  }

  // ─── OAuth client configuration ───

  async importClient(json: unknown): Promise<DriveStatus['client']> {
    const config = parseDesktopClientJson(json)
    const secretRef = opaqueRef('client-secret', config.clientId)
    await this.secrets.set(secretRef, config.clientSecret)
    const previous = await this.store.getClient()
    const saved = await this.store.saveClient({ clientId: config.clientId, projectId: config.projectId, secretRef })
    if (previous && previous.clientId !== config.clientId) {
      // Tokens belong to the client that issued them.
      const active = await this.store.activeConnection()
      if (active && active.clientId !== config.clientId) {
        this.tokens.delete(active.id)
        await this.store.updateConnection(active.id, {
          status: 'reconnect_required',
          lastError: 'A different OAuth client was imported. Reconnect Google Drive to authorize it.'
        })
      }
    }
    return { clientId: saved.clientId, projectId: saved.projectId, importedAt: saved.importedAt.toISOString() }
  }

  private async clientConfig(): Promise<DesktopClientConfig> {
    const client = await this.store.getClient()
    if (!client) throw new DriveError('not_configured', 'Import the Desktop app OAuth client JSON first (AntiGravity → Settings → Google Drive).')
    const clientSecret = await this.secrets.get(client.secretRef)
    if (!clientSecret) throw new DriveError('not_configured', 'The OAuth client secret is missing from the Keychain. Import the client JSON again.')
    return { clientId: client.clientId, clientSecret, projectId: client.projectId }
  }

  // ─── Connect (system browser + loopback) ───

  async connect(opts: { loginHint?: string } = {}): Promise<{ requestId: string; authUrl: string; opened: boolean }> {
    const client = await this.clientConfig()
    for (const pending of this.requests.values()) {
      if (pending.status === 'pending') this.finishRequest(pending, 'cancelled', 'A newer Connect request replaced this one.')
    }
    const state = createState()
    const { verifier, challenge } = createPkcePair()
    const request: PendingConnect = { id: crypto.randomUUID(), status: 'pending', message: null, email: null, listener: null, createdAt: this.now() }
    this.requests.set(request.id, request)
    this.pruneRequests()

    let redirectUri = ''
    const listener = await startLoopbackListener({
      state,
      timeoutMs: this.deps.oauthTimeoutMs ?? OAUTH_SESSION_MS,
      onCode: async code => {
        if (request.status !== 'pending') return { ok: false, message: 'This sign-in was cancelled in Studio. Start Connect again.' }
        try {
          const connection = await this.completeAuthorization(client, code, verifier, redirectUri)
          request.email = connection.email
          this.finishRequest(request, 'completed', null)
          return { ok: true, message: `Connected ${connection.email}. You can close this tab and return to Manhwa Studio.` }
        } catch (error) {
          const err = toDriveError(error)
          this.finishRequest(request, 'error', err.message)
          return { ok: false, message: `${err.message} You can close this tab and return to Studio.` }
        }
      }
    })
    request.listener = listener
    redirectUri = listener.redirectUri
    void listener.done.then(outcome => {
      if (request.status !== 'pending') return
      if (outcome.kind === 'denied') this.finishRequest(request, 'denied', 'Google Drive access was not granted, so Studio stays disconnected.')
      else if (outcome.kind === 'state_mismatch') this.finishRequest(request, 'rejected', 'A sign-in callback did not match this request and was rejected. Nothing was saved; start Connect again.')
      else if (outcome.kind === 'timeout') this.finishRequest(request, 'expired', 'The sign-in window expired after 10 minutes. Start Connect again.')
      else if (outcome.kind === 'closed') this.finishRequest(request, 'cancelled', null)
    })

    const authUrl = buildAuthUrl({ clientId: client.clientId, redirectUri, state, challenge, loginHint: opts.loginHint })
    const opened = this.deps.openBrowser ? await this.deps.openBrowser(authUrl).catch(() => false) : false
    return { requestId: request.id, authUrl, opened }
  }

  connectStatus(requestId: string): ConnectRequestView {
    const request = this.requests.get(requestId)
    if (!request) throw new DriveError('not_found', 'That connect request is unknown or finished long ago. Start Connect again.')
    return { requestId, status: request.status, message: request.message, email: request.email }
  }

  cancelConnect(requestId: string): ConnectRequestView {
    const request = this.requests.get(requestId)
    if (!request) throw new DriveError('not_found', 'That connect request is unknown.')
    if (request.status === 'pending') this.finishRequest(request, 'cancelled', 'Cancelled in Studio.')
    return this.connectStatus(requestId)
  }

  private finishRequest(request: PendingConnect, status: ConnectRequestStatus, message: string | null) {
    request.status = status
    request.message = message
    request.listener?.close()
  }

  private pruneRequests() {
    const cutoff = this.now() - FINISHED_REQUEST_TTL_MS
    for (const [id, request] of this.requests) {
      if (request.status !== 'pending' && request.createdAt < cutoff) this.requests.delete(id)
    }
  }

  /** Exchange the code, verify identity and scopes, store the refresh token, activate, create the root. */
  private async completeAuthorization(client: DesktopClientConfig, code: string, verifier: string, redirectUri: string): Promise<DriveConnectionRecord> {
    const tokens = await exchangeAuthorizationCode(this.fetchFn, { client, code, verifier, redirectUri })
    const scopes = grantedScopes(tokens.scope)
    if (!scopes.includes(DRIVE_FILE_SCOPE)) {
      await revokeToken(this.fetchFn, tokens.access_token)
      throw new DriveError('scope_missing', 'The Google Drive permission was not granted (its checkbox was left unticked). Connect again and allow "See, edit, create, and delete only the specific Google Drive files you use with this app".')
    }
    const identity = readIdToken(tokens.id_token, client.clientId, this.now())
    const probe = this.apiWithToken(tokens.access_token)
    const about = await probe.about()
    if ((about.user?.emailAddress ?? '').toLowerCase() !== identity.email.toLowerCase()) {
      throw new DriveError('identity', 'Google Drive reported a different account than the one that signed in. Nothing was saved; connect again.')
    }

    const active = await this.store.activeConnection()
    const switching = !!active && (active.clientId !== client.clientId || active.googleSubject !== identity.subject) && active.status !== 'disconnected'
    if (switching && (await this.deps.hasActiveWork?.())) {
      throw new DriveError('switch_blocked', 'AntiGravity work is still running on the current Drive account. Stop or let it finish before switching accounts.')
    }

    const secretRef = opaqueRef('drive-refresh', client.clientId, identity.subject)
    if (tokens.refresh_token) {
      await this.secrets.set(secretRef, tokens.refresh_token)
    } else if (!(await this.secrets.get(secretRef))) {
      throw new DriveError(
        'no_refresh_token',
        'Google did not return a long-lived authorization. Remove "Manhwa Studio" at myaccount.google.com/permissions, then connect again.'
      )
    }

    const connection = await this.store.upsertConnection({
      clientId: client.clientId,
      googleSubject: identity.subject,
      email: about.user?.emailAddress ?? identity.email,
      scopes: scopes.join(' '),
      secretRef,
      status: 'connected'
    })
    await this.store.setActive(connection.id)
    this.tokens.set(connection.id, { token: tokens.access_token, expiresAt: this.now() + tokens.expires_in * 1000 })

    try {
      await ensureRootFolder(this.api(connection.id), this.store, connection.id)
    } catch (error) {
      await this.store.updateConnection(connection.id, { lastError: `Connected, but the ${ROOT_FOLDER_NAME} folder could not be prepared: ${driveErrorMessage(error)}` })
    }
    return connection
  }

  // ─── Tokens ───

  /** A current access token for the connection, refreshing at most once at a time. */
  async accessToken(connectionId: string, force = false): Promise<string> {
    const cached = this.tokens.get(connectionId)
    if (!force && cached && cached.expiresAt - TOKEN_SKEW_MS > this.now()) return cached.token
    const inflight = this.refreshes.get(connectionId)
    if (inflight) return inflight
    const run = this.refresh(connectionId).finally(() => this.refreshes.delete(connectionId))
    this.refreshes.set(connectionId, run)
    return run
  }

  private async refresh(connectionId: string): Promise<string> {
    const connection = await this.store.getConnection(connectionId)
    if (!connection || connection.status === 'disconnected') throw new DriveError('not_connected', 'Google Drive is not connected.')
    const client = await this.clientConfig()
    if (client.clientId !== connection.clientId) {
      await this.markReconnect(connectionId, 'A different OAuth client was imported. Reconnect Google Drive to authorize it.')
      throw new DriveError('reconnect_required', 'Reconnect Google Drive: the OAuth client changed.')
    }
    const refreshToken = await this.secrets.get(connection.secretRef)
    if (!refreshToken) {
      await this.markReconnect(connectionId, 'Studio\'s saved Drive authorization is missing from the Keychain. Reconnect Google Drive.')
      throw new DriveError('reconnect_required', 'Reconnect Google Drive: the saved authorization is missing.')
    }
    try {
      const tokens = await refreshAccessToken(this.fetchFn, { client, refreshToken })
      // Keep the existing refresh token unless Google rotated it.
      if (tokens.refresh_token && tokens.refresh_token !== refreshToken) await this.secrets.set(connection.secretRef, tokens.refresh_token)
      this.tokens.set(connectionId, { token: tokens.access_token, expiresAt: this.now() + tokens.expires_in * 1000 })
      if (connection.status !== 'connected') await this.store.updateConnection(connectionId, { status: 'connected', lastError: null })
      return tokens.access_token
    } catch (error) {
      if (error instanceof DriveError && error.code === 'reconnect_required') await this.markReconnect(connectionId, error.message)
      throw error
    }
  }

  private async markReconnect(connectionId: string, message: string) {
    this.tokens.delete(connectionId)
    await this.store.updateConnection(connectionId, { status: 'reconnect_required', lastError: message })
  }

  private apiWithToken(token: string) {
    return new DriveApi({ fetch: this.fetchFn, token: async () => token, ...this.deps.driveOptions })
  }

  /** A Drive client bound to one connection (later phases use this for uploads). */
  api(connectionId: string): DriveApi {
    return new DriveApi({ fetch: this.fetchFn, token: force => this.accessToken(connectionId, force), ...this.deps.driveOptions })
  }

  async requireActiveConnection(): Promise<DriveConnectionRecord> {
    const client = await this.store.getClient()
    if (!client) throw new DriveError('not_configured', 'Import the Desktop app OAuth client JSON first.')
    const connection = await this.store.activeConnection()
    if (!connection || connection.status === 'disconnected') throw new DriveError('not_connected', 'Connect Google Drive first.')
    if (connection.status === 'reconnect_required' || connection.clientId !== client.clientId) {
      throw new DriveError('reconnect_required', connection.lastError ?? 'Reconnect Google Drive.')
    }
    return connection
  }

  // ─── Root, test, disconnect ───

  async ensureRoot(opts: { repair?: boolean } = {}) {
    const connection = await this.requireActiveConnection()
    const root = await ensureRootFolder(this.api(connection.id), this.store, connection.id, opts.repair)
    if (connection.lastError) await this.store.updateConnection(connection.id, { lastError: null })
    return { ...root, url: folderUrl(root.folderId) }
  }

  async testConnection(): Promise<DriveTestResult> {
    const connection = await this.requireActiveConnection()
    const api = this.api(connection.id)
    const root = await ensureRootFolder(api, this.store, connection.id)
    const image = this.deps.testImage ? await this.deps.testImage() : undefined
    let result: DriveTestResult
    try {
      result = await runTransferTest(api, root.folderId, { image, now: () => new Date(this.now()) })
    } catch (error) {
      const err = toDriveError(error)
      const failed: DriveTestResult = {
        ok: false, at: new Date(this.now()).toISOString(), fileName: '', bytes: 0, localSha256: '', downloadedSha256: null,
        remoteSha256: null, rootFolderId: root.folderId, cleanedUp: false, durationMs: 0, error: err.message
      }
      await this.store.updateConnection(connection.id, { lastTestJson: JSON.stringify(failed) })
      throw err
    }
    await this.store.updateConnection(connection.id, { lastTestJson: JSON.stringify(result) })
    return result
  }

  async disconnect(): Promise<{ disconnected: boolean; revoked: boolean; message: string }> {
    const connection = await this.store.activeConnection()
    if (!connection) return { disconnected: false, revoked: false, message: 'Google Drive was not connected.' }
    const refreshToken = await this.secrets.get(connection.secretRef)
    await this.secrets.delete(connection.secretRef)
    this.tokens.delete(connection.id)
    await this.store.updateConnection(connection.id, { status: 'disconnected', lastError: null })
    await this.store.setActive(null)
    const revoked = refreshToken ? await revokeToken(this.fetchFn, refreshToken) : false
    return {
      disconnected: true,
      revoked,
      message: revoked
        ? `Disconnected ${connection.email} and revoked Studio's access. Files already in Drive were kept.`
        : `Disconnected ${connection.email} locally; Google did not confirm revocation (offline?). Remove "Manhwa Studio" at myaccount.google.com/permissions to be sure. Files already in Drive were kept.`
    }
  }

  // ─── Status ───

  async status(opts: { check?: boolean } = {}): Promise<DriveStatus> {
    const client = await this.store.getClient()
    const pending = [...this.requests.values()].find(r => r.status === 'pending') ?? null
    const connections = await this.store.listConnections()
    let connection = connections.find(c => c.active) ?? null
    const status: DriveStatus = {
      state: 'not_configured',
      client: client && { clientId: client.clientId, projectId: client.projectId, importedAt: client.importedAt.toISOString() },
      account: null,
      storage: null,
      storageNote: null,
      root: null,
      lastTest: null,
      lastError: null,
      pendingRequestId: pending?.id ?? null,
      otherAccounts: connections.filter(c => !c.active).map(c => ({ connectionId: c.id, email: c.email, status: c.status })),
      checked: false
    }
    if (!client) return status

    if (connection && connection.status !== 'disconnected') {
      let rootChecked: 'ok' | 'missing' | null = null
      if (opts.check && (connection.status === 'connected' || connection.status === 'error')) {
        status.checked = true
        try {
          const about: DriveAbout = await this.api(connection.id).about()
          status.storage = {
            limit: toNumber(about.storageQuota?.limit),
            usage: toNumber(about.storageQuota?.usage),
            usageInDrive: toNumber(about.storageQuota?.usageInDrive)
          }
          if (status.storage.limit === null) status.storageNote = 'Google did not report a storage limit for this account.'
          try {
            await ensureRootFolder(this.api(connection.id), this.store, connection.id)
            rootChecked = 'ok'
          } catch (error) {
            if (!(error instanceof DriveError && error.code === 'root_missing')) throw error
            rootChecked = 'missing'
          }
          if (connection.status === 'error') await this.store.updateConnection(connection.id, { status: 'connected', lastError: null })
        } catch (error) {
          const err = toDriveError(error)
          if (err.code !== 'reconnect_required') {
            status.storageNote = `Live check failed: ${err.message}`
            if (err.code !== 'network' && err.code !== 'timeout' && err.code !== 'rate_limited') {
              await this.store.updateConnection(connection.id, { status: 'error', lastError: err.message })
            }
          }
        }
        connection = (await this.store.getConnection(connection.id)) ?? connection
      }

      const clientMatches = connection.clientId === client.clientId
      status.account = { connectionId: connection.id, email: connection.email, scopes: grantedScopes(connection.scopes), connectedAt: connection.connectedAt.toISOString() }
      status.lastError = connection.lastError
      status.state = !clientMatches || connection.status === 'reconnect_required' ? 'reconnect_required' : connection.status === 'error' ? 'error' : 'connected'
      if (connection.lastTestJson) {
        try { status.lastTest = JSON.parse(connection.lastTestJson) as DriveTestResult } catch { status.lastTest = null }
      }
      const mapping = await this.store.getMapping(connection.id, 'root', ROOT_ENTITY)
      status.root = mapping
        ? {
            folderId: mapping.folderId,
            name: mapping.name,
            url: mapping.folderId ? folderUrl(mapping.folderId) : null,
            verifiedAt: mapping.verifiedAt?.toISOString() ?? null,
            state: !mapping.folderId ? 'missing' : rootChecked ?? (mapping.verifiedAt ? 'ok' : 'unverified')
          }
        : { folderId: null, name: ROOT_FOLDER_NAME, url: null, verifiedAt: null, state: 'none' }
    } else {
      status.state = 'disconnected'
    }
    if (pending) status.state = 'connecting'
    return status
  }
}
