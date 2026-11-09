/**
 * Google Drive connection API for Studio AntiGravity (PRD §16.1).
 *
 * The OAuth callback itself is received by a temporary 127.0.0.1 listener
 * (services/googleDrive/oauth.ts), not by this router. These routes only ever
 * return sanitized data and are restricted to this Mac: Studio's API port is
 * reachable on the LAN (phones use it), so the guard below refuses non-loopback
 * clients, foreign browser origins, and mutations without Studio's header.
 */

import { execFile } from 'node:child_process'
import { Router, type NextFunction, type Request, type Response } from 'express'
import type { PrismaClient } from '@prisma/client'
import { keychainSecretStore } from '../services/googleDrive/credentials.js'
import { DriveError, driveErrorMessage, redact } from '../services/googleDrive/errors.js'
import { AUTH_ENDPOINT } from '../services/googleDrive/oauth.js'
import { GoogleDriveService, type GoogleDriveServiceDeps } from '../services/googleDrive/service.js'
import { prismaDriveStore } from '../services/googleDrive/store.js'

/** Header the Studio client sends on every mutation (forces a CORS preflight for other sites). */
export const STUDIO_CLIENT_HEADER = 'x-studio-client'

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

export function isLoopback(address: string | undefined) {
  return !!address && LOOPBACK.has(address)
}

/** Studio's own browser origins: the Vite dev client and the API port serving client/dist. */
export function allowedOrigins(port = process.env.PORT || '3001'): Set<string> {
  const hosts = ['localhost', '127.0.0.1']
  return new Set(hosts.flatMap(host => [`http://${host}:5173`, `http://${host}:${port}`]))
}

export function localOnlyGuard(origins = allowedOrigins()) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!isLoopback(req.socket.remoteAddress)) {
      return res.status(403).json({ error: 'Google Drive settings are only available on the Mac running Studio.', code: 'forbidden' })
    }
    const origin = req.get('origin')
    if (origin && !origins.has(origin)) {
      return res.status(403).json({ error: 'Request origin not allowed.', code: 'forbidden' })
    }
    if (req.method !== 'GET' && req.get(STUDIO_CLIENT_HEADER) !== '1') {
      return res.status(403).json({ error: 'Missing Studio client header.', code: 'forbidden' })
    }
    res.setHeader('Cache-Control', 'no-store')
    next()
  }
}

function openInSystemBrowser(url: string): Promise<boolean> {
  if (!url.startsWith(`${AUTH_ENDPOINT}?`) || process.platform !== 'darwin') return Promise.resolve(false)
  return new Promise(resolve => execFile('open', [url], error => resolve(!error)))
}

let instance: GoogleDriveService | null = null

/** The running Drive service (later AntiGravity phases upload through it). */
export function googleDriveService(): GoogleDriveService {
  if (!instance) throw new Error('Google Drive service not initialized')
  return instance
}

function sendError(res: Response, error: unknown) {
  if (error instanceof DriveError) {
    if (error.httpStatus >= 500) console.error('[google-drive]', error.code, redact(error.message))
    return res.status(error.httpStatus).json({ error: error.message, code: error.code })
  }
  console.error('[google-drive] unexpected:', driveErrorMessage(error))
  return res.status(500).json({ error: driveErrorMessage(error), code: 'google' })
}

export function initGoogleDriveRoutes(prisma: PrismaClient, overrides: Partial<GoogleDriveServiceDeps> = {}): Router {
  instance = new GoogleDriveService({
    store: prismaDriveStore(prisma),
    secrets: keychainSecretStore(),
    openBrowser: openInSystemBrowser,
    ...overrides
  })
  return createGoogleDriveRouter(instance)
}

export function createGoogleDriveRouter(service: GoogleDriveService, origins = allowedOrigins()): Router {
  const router = Router()
  router.use(localOnlyGuard(origins))

  router.get('/status', async (req, res) => {
    try {
      res.json(await service.status({ check: req.query.check === '1' }))
    } catch (error) {
      sendError(res, error)
    }
  })

  router.put('/oauth-client', async (req, res) => {
    try {
      const json = req.body?.json
      if (json === undefined) throw new DriveError('invalid_client', 'Choose the OAuth client JSON file to import.')
      res.json({ client: await service.importClient(json) })
    } catch (error) {
      sendError(res, error)
    }
  })

  router.post('/connect', async (req, res) => {
    try {
      const loginHint = typeof req.body?.loginHint === 'string' && /^[^\s@]{1,64}@[^\s@]{1,190}$/.test(req.body.loginHint) ? req.body.loginHint : undefined
      res.json(await service.connect({ loginHint }))
    } catch (error) {
      sendError(res, error)
    }
  })

  router.get('/connect/:requestId', (req, res) => {
    try {
      res.json(service.connectStatus(req.params.requestId))
    } catch (error) {
      sendError(res, error)
    }
  })

  router.post('/connect/:requestId/cancel', (req, res) => {
    try {
      res.json(service.cancelConnect(req.params.requestId))
    } catch (error) {
      sendError(res, error)
    }
  })

  router.post('/ensure-root', async (req, res) => {
    try {
      res.json(await service.ensureRoot({ repair: req.body?.repair === true }))
    } catch (error) {
      sendError(res, error)
    }
  })

  router.post('/test', async (_req, res) => {
    try {
      res.json(await service.testConnection())
    } catch (error) {
      sendError(res, error)
    }
  })

  router.post('/disconnect', async (_req, res) => {
    try {
      res.json(await service.disconnect())
    } catch (error) {
      sendError(res, error)
    }
  })

  return router
}
