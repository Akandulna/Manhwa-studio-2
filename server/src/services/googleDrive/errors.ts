/**
 * Google Drive errors and redaction (docs/PRD-antigravity-studio.md §4.4, §17).
 *
 * Every error that leaves the Drive services is a DriveError with a stable
 * code and a message written for the operator. Nothing here ever carries a
 * token, client secret, authorization code or raw callback URL: provider text
 * is passed through `redact` before it is stored, logged or returned.
 */

export type DriveErrorCode =
  | 'not_configured'
  | 'invalid_client'
  | 'not_connected'
  | 'connecting'
  | 'reconnect_required'
  | 'consent_denied'
  | 'state_mismatch'
  | 'expired'
  | 'scope_missing'
  | 'identity'
  | 'no_refresh_token'
  | 'switch_blocked'
  | 'root_missing'
  | 'not_found'
  | 'conflict'
  | 'forbidden'
  | 'storage_full'
  | 'rate_limited'
  | 'network'
  | 'timeout'
  | 'keychain'
  | 'verify_failed'
  | 'google'

const HTTP_STATUS: Record<DriveErrorCode, number> = {
  not_configured: 409,
  invalid_client: 400,
  not_connected: 409,
  connecting: 409,
  reconnect_required: 409,
  consent_denied: 409,
  state_mismatch: 400,
  expired: 410,
  scope_missing: 409,
  identity: 409,
  no_refresh_token: 409,
  switch_blocked: 409,
  root_missing: 409,
  not_found: 404,
  conflict: 409,
  forbidden: 403,
  storage_full: 507,
  rate_limited: 429,
  network: 502,
  timeout: 504,
  keychain: 503,
  verify_failed: 502,
  google: 502
}

export class DriveError extends Error {
  readonly code: DriveErrorCode
  readonly httpStatus: number
  /** When Google asked us to wait (Retry-After), in ms. */
  readonly retryAfterMs?: number

  constructor(code: DriveErrorCode, message: string, retryAfterMs?: number) {
    super(redact(message))
    this.name = 'DriveError'
    this.code = code
    this.httpStatus = HTTP_STATUS[code]
    this.retryAfterMs = retryAfterMs
  }
}

/** Patterns for Google credentials that must never be shown or logged. */
const SECRET_PATTERNS: RegExp[] = [
  /ya29\.[\w.-]+/g, // access tokens
  /1\/\/[\w.-]{10,}/g, // refresh tokens
  /GOCSPX-[\w-]+/g, // client secrets
  /\b4\/[\w.-]{10,}/g, // authorization codes
  /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, // JWTs (id tokens)
  /([?&](?:code|access_token|refresh_token|id_token|client_secret|code_verifier|state)=)[^&\s"']+/gi,
  /("(?:access_token|refresh_token|id_token|client_secret|code|code_verifier)"\s*:\s*")[^"]*"/gi
]

/** Remove anything that looks like a Google credential from free text. */
export function redact(text: string): string {
  let out = text
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, prefix?: string) =>
      typeof prefix === 'string' && match.startsWith(prefix) ? `${prefix}[redacted]` : '[redacted]'
    )
  }
  return out.length > 600 ? `${out.slice(0, 600)}…` : out
}

/** An operator-facing message for any thrown value, already redacted. */
export function driveErrorMessage(error: unknown): string {
  if (error instanceof DriveError) return error.message
  if (error instanceof Error) return redact(error.message || 'Unexpected Google Drive error')
  return 'Unexpected Google Drive error'
}

export function toDriveError(error: unknown): DriveError {
  if (error instanceof DriveError) return error
  return new DriveError('google', driveErrorMessage(error))
}
