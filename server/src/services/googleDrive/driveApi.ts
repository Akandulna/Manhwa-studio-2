/**
 * Thin Google Drive v3 REST client (PRD §4.5–4.6, §17).
 *
 * Plain HTTPS calls with an injectable fetch so every failure path can be
 * tested without Google. Handles one forced token refresh on 401, bounded
 * jittered retries for throttling / 5xx / network loss (honouring
 * Retry-After), per-request timeouts, and distinct errors for missing files,
 * denied access and a full Drive.
 * https://developers.google.com/workspace/drive/api/reference/rest/v3
 */

import { DriveError, redact } from './errors.js'
import type { FetchFn } from './oauth.js'

export const DRIVE_API = 'https://www.googleapis.com/drive/v3'
export const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3'
export const FOLDER_MIME = 'application/vnd.google-apps.folder'
const FILE_FIELDS = 'id,name,mimeType,parents,trashed,size,sha256Checksum,md5Checksum,appProperties,createdTime,webViewLink'

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  parents?: string[]
  trashed?: boolean
  size?: string
  sha256Checksum?: string
  md5Checksum?: string
  appProperties?: Record<string, string>
  createdTime?: string
  webViewLink?: string
}

export interface DriveAbout {
  user?: { emailAddress?: string; permissionId?: string; displayName?: string }
  storageQuota?: { limit?: string; usage?: string; usageInDrive?: string }
}

export interface DriveApiOptions {
  fetch: FetchFn
  /** Returns a current access token; `force` asks for a fresh one after a 401. */
  token: (force: boolean) => Promise<string>
  sleep?: (ms: number) => Promise<void>
  /** Attempts per request, including the first (PRD §17: 5). */
  maxAttempts?: number
  timeoutMs?: number
  random?: () => number
}

type Expect = 'json' | 'buffer' | 'none'

const RETRY_STATUS = new Set([429, 500, 502, 503, 504])
const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'sharingRateLimitExceeded'])

/** Escape a value for a Drive `q` string literal. */
export const escapeQuery = (value: string) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const at = Date.parse(header)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined
}

function errorInfo(body: unknown): { reason: string; message: string } {
  const err = (body as { error?: { message?: unknown; errors?: Array<{ reason?: unknown }> } })?.error
  const reason = typeof err?.errors?.[0]?.reason === 'string' ? (err.errors[0].reason as string) : ''
  const message = typeof err?.message === 'string' ? redact(err.message) : ''
  return { reason, message }
}

export class DriveApi {
  private readonly opts: Required<Omit<DriveApiOptions, 'fetch' | 'token'>> & Pick<DriveApiOptions, 'fetch' | 'token'>

  constructor(options: DriveApiOptions) {
    this.opts = {
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      maxAttempts: 5,
      timeoutMs: 60_000,
      random: Math.random,
      ...options
    }
  }

  private async request<T>(method: string, url: string, init: { body?: BodyInit; headers?: Record<string, string>; expect: Expect }): Promise<T> {
    let refreshed: string | null = null
    let lastError: DriveError | null = null
    for (let attempt = 1; attempt <= this.opts.maxAttempts; attempt++) {
      const token = refreshed ?? (await this.opts.token(false))
      let response: Response
      try {
        response = await this.opts.fetch(url, {
          method,
          headers: { Authorization: `Bearer ${token}`, ...init.headers },
          body: init.body,
          signal: AbortSignal.timeout(this.opts.timeoutMs)
        })
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
        lastError = timedOut
          ? new DriveError('timeout', 'Google Drive did not answer in time.')
          : new DriveError('network', 'Could not reach Google Drive. Check the internet connection.')
        await this.backoff(attempt)
        continue
      }

      if (response.status === 401 && refreshed === null) {
        await response.arrayBuffer().catch(() => undefined)
        refreshed = await this.opts.token(true)
        attempt-- // a forced refresh does not use up a retry
        continue
      }

      if (response.ok) {
        if (init.expect === 'buffer') return Buffer.from(await response.arrayBuffer()) as T
        if (init.expect === 'none' || response.status === 204) {
          await response.arrayBuffer().catch(() => undefined)
          return undefined as T
        }
        return (await response.json()) as T
      }

      const body = await response.json().catch(() => null)
      const { reason, message } = errorInfo(body)
      const wait = retryAfterMs(response.headers.get('retry-after'))

      if (response.status === 403 && reason === 'storageQuotaExceeded') {
        throw new DriveError('storage_full', 'The connected Google account\'s storage is full. Free up space or upgrade storage, then retry.')
      }
      if (RETRY_STATUS.has(response.status) || (response.status === 403 && RATE_REASONS.has(reason))) {
        lastError = new DriveError('rate_limited', `Google Drive is busy or throttling requests${message ? ` (${message})` : ''}.`, wait)
        await this.backoff(attempt, wait)
        continue
      }
      if (response.status === 401) {
        throw new DriveError('reconnect_required', 'Google Drive rejected Studio\'s authorization. Reconnect Google Drive.')
      }
      if (response.status === 404) throw new DriveError('not_found', message || 'That Drive file or folder no longer exists or Studio cannot see it.')
      if (response.status === 409) throw new DriveError('conflict', message || 'Drive reported a conflict for that file.')
      if (response.status === 403) {
        throw new DriveError(
          'forbidden',
          reason === 'accessNotConfigured' || /has not been used|is disabled/i.test(message)
            ? 'The Google Drive API is not enabled for this Google Cloud project. Enable it (setup step 2) and retry.'
            : `Google Drive denied access${message ? `: ${message}` : ''}.`
        )
      }
      throw new DriveError('google', `Google Drive request failed (HTTP ${response.status}${message ? `: ${message}` : ''}).`)
    }
    throw lastError ?? new DriveError('google', 'Google Drive request failed.')
  }

  private async backoff(attempt: number, retryAfter?: number) {
    if (attempt >= this.opts.maxAttempts) return
    const exponential = Math.min(30_000, 500 * 2 ** (attempt - 1))
    const jitter = exponential * 0.5 * this.opts.random()
    await this.opts.sleep(Math.min(60_000, Math.max(retryAfter ?? 0, exponential + jitter)))
  }

  about(): Promise<DriveAbout> {
    return this.request('GET', `${DRIVE_API}/about?fields=${encodeURIComponent('user(emailAddress,permissionId,displayName),storageQuota(limit,usage,usageInDrive)')}`, { expect: 'json' })
  }

  async generateIds(count: number): Promise<string[]> {
    const res = await this.request<{ ids?: string[] }>('GET', `${DRIVE_API}/files/generateIds?count=${count}&space=drive&type=files`, { expect: 'json' })
    if (!Array.isArray(res.ids) || res.ids.length !== count) throw new DriveError('google', 'Google Drive did not return file IDs.')
    return res.ids
  }

  getFile(id: string): Promise<DriveFile> {
    return this.request('GET', `${DRIVE_API}/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(FILE_FIELDS)}`, { expect: 'json' })
  }

  /** Get a file, or null when it does not exist / Studio cannot see it. */
  async findFile(id: string): Promise<DriveFile | null> {
    try {
      return await this.getFile(id)
    } catch (error) {
      if (error instanceof DriveError && error.code === 'not_found') return null
      throw error
    }
  }

  async list(q: string, pageSize = 20): Promise<DriveFile[]> {
    const params = new URLSearchParams({ q, spaces: 'drive', pageSize: String(pageSize), orderBy: 'createdTime', fields: `files(${FILE_FIELDS})` })
    const res = await this.request<{ files?: DriveFile[] }>('GET', `${DRIVE_API}/files?${params}`, { expect: 'json' })
    return res.files ?? []
  }

  createFolder(meta: { id?: string; name: string; parentId: string; appProperties?: Record<string, string> }): Promise<DriveFile> {
    const body = JSON.stringify({ ...(meta.id && { id: meta.id }), name: meta.name, mimeType: FOLDER_MIME, parents: [meta.parentId], appProperties: meta.appProperties })
    return this.request('POST', `${DRIVE_API}/files?fields=${encodeURIComponent(FILE_FIELDS)}`, { body, headers: { 'Content-Type': 'application/json' }, expect: 'json' })
  }

  /** Multipart upload (suitable for files up to 5 MB). */
  uploadMultipart(meta: { id?: string; name: string; parentId: string; mimeType: string; appProperties?: Record<string, string> }, bytes: Buffer): Promise<DriveFile> {
    const boundary = `studio-${Math.floor(this.opts.random() * 1e12).toString(36)}-${Date.now().toString(36)}`
    const metadata = JSON.stringify({ ...(meta.id && { id: meta.id }), name: meta.name, mimeType: meta.mimeType, parents: [meta.parentId], appProperties: meta.appProperties })
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${meta.mimeType}\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ])
    return this.request('POST', `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}`, {
      body,
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      expect: 'json'
    })
  }

  /**
   * Resumable upload (for files above the multipart limit): open a session,
   * then send the bytes. A lost response is reconciled by the caller through
   * the pre-generated file ID.
   */
  async uploadResumable(meta: { id?: string; name: string; parentId: string; mimeType: string; appProperties?: Record<string, string> }, bytes: Buffer): Promise<DriveFile> {
    const metadata = JSON.stringify({ ...(meta.id && { id: meta.id }), name: meta.name, mimeType: meta.mimeType, parents: [meta.parentId], appProperties: meta.appProperties })
    const token = await this.opts.token(false)
    const start = await this.opts.fetch(`${DRIVE_UPLOAD_API}/files?uploadType=resumable&fields=${encodeURIComponent(FILE_FIELDS)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': meta.mimeType, 'X-Upload-Content-Length': String(bytes.length) },
      body: metadata,
      signal: AbortSignal.timeout(this.opts.timeoutMs)
    }).catch(() => { throw new DriveError('network', 'Could not reach Google Drive to start an upload.') })
    const session = start.headers.get('location')
    await start.arrayBuffer().catch(() => undefined)
    if (!start.ok || !session || !session.startsWith(`${DRIVE_UPLOAD_API}/`)) {
      if (start.status === 401) throw new DriveError('reconnect_required', 'Google Drive rejected Studio\'s authorization. Reconnect Google Drive.')
      throw new DriveError('google', `Google Drive did not open an upload session (HTTP ${start.status}).`)
    }
    return this.request('PUT', session, { body: new Uint8Array(bytes), headers: { 'Content-Type': meta.mimeType }, expect: 'json' })
  }

  /** Multipart up to 4 MB, resumable above. */
  upload(meta: { id?: string; name: string; parentId: string; mimeType: string; appProperties?: Record<string, string> }, bytes: Buffer): Promise<DriveFile> {
    return bytes.length <= 4 * 1024 * 1024 ? this.uploadMultipart(meta, bytes) : this.uploadResumable(meta, bytes)
  }

  download(id: string): Promise<Buffer> {
    return this.request('GET', `${DRIVE_API}/files/${encodeURIComponent(id)}?alt=media`, { expect: 'buffer' })
  }

  /** Permanently delete one exact file ID (used only for Studio's own test fixture). */
  delete(id: string): Promise<void> {
    return this.request('DELETE', `${DRIVE_API}/files/${encodeURIComponent(id)}`, { expect: 'none' })
  }
}

export const folderUrl = (id: string) => `https://drive.google.com/drive/folders/${encodeURIComponent(id)}`
