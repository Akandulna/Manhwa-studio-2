/**
 * Murgaa API Routes
 *
 * Backs the "Murgaa" popup shown in the narration Script Editor, Voiceover
 * Editor, and Image Clipper 3.0 image-list headers. Each page has ONE global
 * config (scope 'script' / 'voice' / 'clipper3') shared across every
 * series/chapter — the popup is a per-page reference card, not per-manhwa data.
 *
 * Config is stored in the Setting key-value table under `murgaa:<scope>`, with
 * the uploaded image + application file living on disk in DOWNLOAD_ROOT/_murgaa.
 */

import { Router, Request, Response, RequestHandler, NextFunction } from 'express'
import { exec } from 'child_process'
import { existsSync } from 'fs'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import multer from 'multer'
import { prisma } from '../index.js'

const router = Router()

/** The pages that can carry a Murgaa popup. */
const SCOPES = ['script', 'voice', 'clipper3'] as const
type Scope = (typeof SCOPES)[number]

function isScope(v: string): v is Scope {
  return (SCOPES as readonly string[]).includes(v)
}

function settingKey(scope: Scope): string {
  return `murgaa:${scope}`
}

function getMurgaaDir(): string {
  return path.join(process.env.DOWNLOAD_ROOT || './downloads', '_murgaa')
}

/** One launchable application, user-named and independently replaceable. */
interface MurgaaApp {
  id: string
  name: string
  path: string
  /** The file as uploaded, kept only to show if `name` was never customized. */
  originalName: string
}

/** Shape persisted as JSON in the Setting row. Paths are absolute on disk. */
interface MurgaaConfig {
  imagePath: string | null
  imageName: string | null
  description: string
  apps: MurgaaApp[]
  updatedAt: string | null
}

const EMPTY_CONFIG: MurgaaConfig = {
  imagePath: null,
  imageName: null,
  description: '',
  apps: [],
  updatedAt: null
}

/** Pre-multi-app shape, still present in rows written before this migration. */
interface LegacyMurgaaConfig {
  appPath?: string | null
  appName?: string | null
}

async function readConfig(scope: Scope): Promise<MurgaaConfig> {
  const row = await prisma.setting.findUnique({ where: { key: settingKey(scope) } })
  if (!row) return { ...EMPTY_CONFIG }
  try {
    const raw = JSON.parse(row.value) as Partial<MurgaaConfig> & LegacyMurgaaConfig
    const config: MurgaaConfig = {
      ...EMPTY_CONFIG,
      ...raw,
      apps: Array.isArray(raw.apps) ? raw.apps : []
    }
    // One-time upgrade path: a config saved before multi-app support carries a
    // single appPath/appName instead of an apps[] array. Written back
    // immediately (not just folded in for this response) so the generated id
    // is stable — a rename/launch/remove call made against the id from THIS
    // read must still resolve on the next one, and a fresh random id per read
    // would never do that for an unmigrated row.
    if (config.apps.length === 0 && raw.appPath) {
      config.apps = [{
        id: crypto.randomUUID(),
        name: raw.appName || 'Application',
        path: raw.appPath,
        originalName: raw.appName || 'Application'
      }]
      delete (config as Partial<LegacyMurgaaConfig>).appPath
      delete (config as Partial<LegacyMurgaaConfig>).appName
      return writeConfig(scope, config)
    }
    return config
  } catch {
    // A hand-edited / corrupt row shouldn't break the popup — fall back to empty.
    return { ...EMPTY_CONFIG }
  }
}

async function writeConfig(scope: Scope, config: MurgaaConfig): Promise<MurgaaConfig> {
  const next = { ...config, updatedAt: new Date().toISOString() }
  const value = JSON.stringify(next)
  await prisma.setting.upsert({
    where: { key: settingKey(scope) },
    create: { key: settingKey(scope), value },
    update: { value }
  })
  return next
}

/**
 * The client never sees absolute disk paths — it gets booleans + display names
 * and fetches the image through /image. Keeps the popup honest about what is
 * actually still on disk (a file removed outside the app reads as missing).
 */
function toPublic(scope: Scope, config: MurgaaConfig) {
  return {
    scope,
    description: config.description,
    imageName: config.imageName,
    hasImage: !!(config.imagePath && existsSync(config.imagePath)),
    apps: config.apps.map(app => ({
      id: app.id,
      name: app.name,
      missing: !existsSync(app.path)
    })),
    updatedAt: config.updatedAt
  }
}

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp'
}

// Uploads land in DOWNLOAD_ROOT/_murgaa, prefixed by scope + kind so the two
// pages' files never collide.
const murgaaStorage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    const dir = getMurgaaDir()
    await fs.mkdir(dir, { recursive: true })
    cb(null, dir)
  },
  filename: (req, file, cb) => {
    const scope = req.params.scope || 'unknown'
    const kind = req.path.includes('app') ? 'app' : 'image'
    const safe = file.originalname.replace(/[^\w.\-]+/g, '_')
    cb(null, `${scope}_${kind}_${Date.now()}_${safe}`)
  }
})

const imageUpload = multer({
  storage: murgaaStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    const ok = file.mimetype.startsWith('image/') || IMAGE_EXTENSIONS.includes(ext)
    if (ok) cb(null, true)
    else cb(new Error('Unsupported image file type'))
  }
})

// The application can be any local artifact the user wants to launch (.app
// bundle zipped, .exe, .dmg, .sh, …), so no type filter — just a size ceiling.
const appUpload = multer({
  storage: murgaaStorage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }
})

/**
 * Run a multer middleware and translate its rejections (unsupported type, file
 * too large) into JSON — the default Express handler returns an HTML stack
 * trace, which the popup can't surface usefully.
 */
function runUpload(mw: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    mw(req, res, (err: unknown) => {
      if (err) {
        const message = err instanceof Error ? err.message : 'Upload failed'
        const tooLarge = (err as { code?: string })?.code === 'LIMIT_FILE_SIZE'
        return res.status(400).json({ error: tooLarge ? 'File is too large' : message })
      }
      next()
    })
  }
}

/** Delete a file we previously stored, ignoring "already gone". */
async function removeIfPresent(filePath: string | null) {
  if (!filePath) return
  try {
    await fs.unlink(filePath)
  } catch {
    /* already gone — nothing to clean up */
  }
}

function requireScope(req: Request, res: Response): Scope | null {
  const { scope } = req.params
  if (!isScope(scope)) {
    res.status(400).json({ error: `Unknown Murgaa scope '${scope}'` })
    return null
  }
  return scope
}

// Get the config for one page
router.get('/:scope', async (req: Request, res: Response) => {
  const scope = requireScope(req, res)
  if (!scope) return
  try {
    res.json(toPublic(scope, await readConfig(scope)))
  } catch (error) {
    console.error('Error reading Murgaa config:', error)
    res.status(500).json({ error: 'Failed to read Murgaa config' })
  }
})

// Update the description
router.put('/:scope', async (req: Request, res: Response) => {
  const scope = requireScope(req, res)
  if (!scope) return
  try {
    const { description } = req.body
    if (typeof description !== 'string') {
      return res.status(400).json({ error: 'description must be a string' })
    }
    const config = await readConfig(scope)
    const next = await writeConfig(scope, { ...config, description })
    res.json(toPublic(scope, next))
  } catch (error) {
    console.error('Error updating Murgaa config:', error)
    res.status(500).json({ error: 'Failed to update Murgaa config' })
  }
})

// Stream the configured image (used by both the inline preview and fullscreen)
router.get('/:scope/image', async (req: Request, res: Response) => {
  const scope = requireScope(req, res)
  if (!scope) return
  try {
    const config = await readConfig(scope)
    if (!config.imagePath || !existsSync(config.imagePath)) {
      return res.status(404).json({ error: 'No Murgaa image configured' })
    }
    const ext = path.extname(config.imagePath).toLowerCase()
    res.type(IMAGE_MIME[ext] || 'application/octet-stream')
    res.sendFile(path.resolve(config.imagePath))
  } catch (error) {
    console.error('Error serving Murgaa image:', error)
    res.status(500).json({ error: 'Failed to serve Murgaa image' })
  }
})

// Upload / replace the image
router.post('/:scope/image', runUpload(imageUpload.single('file')), async (req: Request, res: Response) => {
  const scope = requireScope(req, res)
  if (!scope) return
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' })
    const config = await readConfig(scope)
    await removeIfPresent(config.imagePath)
    const next = await writeConfig(scope, {
      ...config,
      imagePath: req.file.path,
      imageName: req.file.originalname
    })
    res.json(toPublic(scope, next))
  } catch (error) {
    console.error('Error uploading Murgaa image:', error)
    res.status(500).json({ error: 'Failed to upload Murgaa image' })
  }
})

// Add a new application to the list. Never replaces an existing one — each
// upload is its own entry, which is the whole point of moving to a list.
router.post('/:scope/apps', runUpload(appUpload.single('file')), async (req: Request, res: Response) => {
  const scope = requireScope(req, res)
  if (!scope) return
  try {
    if (!req.file) return res.status(400).json({ error: 'No application file uploaded' })
    const config = await readConfig(scope)
    const app: MurgaaApp = {
      id: crypto.randomUUID(),
      name: req.file.originalname,
      path: req.file.path,
      originalName: req.file.originalname
    }
    const next = await writeConfig(scope, { ...config, apps: [...config.apps, app] })
    res.json(toPublic(scope, next))
  } catch (error) {
    console.error('Error uploading Murgaa application:', error)
    res.status(500).json({ error: 'Failed to upload Murgaa application' })
  }
})

// Rename one application. The uploaded file itself is untouched — only the
// display name (and what shows on the launch button) changes.
router.put('/:scope/apps/:appId', async (req: Request, res: Response) => {
  const scope = requireScope(req, res)
  if (!scope) return
  try {
    const { name } = req.body
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name (non-empty string) is required' })
    }
    const config = await readConfig(scope)
    if (!config.apps.some(a => a.id === req.params.appId)) {
      return res.status(404).json({ error: 'No such application' })
    }
    const next = await writeConfig(scope, {
      ...config,
      apps: config.apps.map(a => (a.id === req.params.appId ? { ...a, name: name.trim() } : a))
    })
    res.json(toPublic(scope, next))
  } catch (error) {
    console.error('Error renaming Murgaa application:', error)
    res.status(500).json({ error: 'Failed to rename Murgaa application' })
  }
})

// Remove one application from the list and delete its uploaded file.
router.delete('/:scope/apps/:appId', async (req: Request, res: Response) => {
  const scope = requireScope(req, res)
  if (!scope) return
  try {
    const config = await readConfig(scope)
    const target = config.apps.find(a => a.id === req.params.appId)
    if (!target) return res.status(404).json({ error: 'No such application' })

    await removeIfPresent(target.path)
    const next = await writeConfig(scope, {
      ...config,
      apps: config.apps.filter(a => a.id !== req.params.appId)
    })
    res.json(toPublic(scope, next))
  } catch (error) {
    console.error('Error removing Murgaa application:', error)
    res.status(500).json({ error: 'Failed to remove Murgaa application' })
  }
})

// Launch one application on the machine running the server
router.post('/:scope/apps/:appId/launch', async (req: Request, res: Response) => {
  const scope = requireScope(req, res)
  if (!scope) return
  try {
    const config = await readConfig(scope)
    const target = config.apps.find(a => a.id === req.params.appId)
    if (!target) {
      return res.status(400).json({ error: 'No such application' })
    }
    if (!existsSync(target.path)) {
      return res.status(404).json({ error: 'Configured Murgaa application is missing from disk' })
    }

    const fullPath = path.resolve(target.path)
    const platform = os.platform()
    let command: string
    if (platform === 'darwin') {
      command = `open "${fullPath}"`
    } else if (platform === 'win32') {
      command = `start "" "${fullPath}"`
    } else {
      command = `xdg-open "${fullPath}"`
    }

    exec(command, (error) => {
      if (error) {
        console.error('Error launching Murgaa application:', error)
        return res.status(500).json({ error: 'Failed to launch application' })
      }
      res.json({ message: 'Application launched' })
    })
  } catch (error) {
    console.error('Error launching Murgaa application:', error)
    res.status(500).json({ error: 'Failed to launch application' })
  }
})

export function initMurgaaRoutes(): Router {
  return router
}

export default router
