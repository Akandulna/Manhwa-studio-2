/**
 * Studio-owned Drive folders and the connection test transfer (PRD §4.5–4.6).
 *
 * Folder IDs are authoritative; names are presentation. Every folder Studio
 * creates carries bounded appProperties (app, kind, entity) so it can be
 * found again by identity, never by name. Creates use a pre-generated Drive
 * file ID that is saved before the request, so an uncertain create is
 * reconciled by ID instead of producing a duplicate. Creation is serialized
 * per mapping.
 */

import crypto from 'node:crypto'
import sharp from 'sharp'
import { DriveApi, escapeQuery, FOLDER_MIME, type DriveFile } from './driveApi.js'
import { DriveError } from './errors.js'
import type { DriveStore, FolderKind } from './store.js'

export const ROOT_FOLDER_NAME = 'Manhwa Studio'
export const STUDIO_APP = 'manhwa-studio'
/** Entity key stored under the root mapping. */
export const ROOT_ENTITY = 'root'

const sha256 = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex')

/** appProperties values must fit Drive's 124-byte key+value limit. */
export function entityProperty(entityKey: string): string {
  return /^[\w.:-]{1,64}$/.test(entityKey) ? entityKey : `h:${crypto.createHash('sha256').update(entityKey).digest('hex').slice(0, 40)}`
}

const locks = new Map<string, Promise<unknown>>()
async function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(task)
  locks.set(key, run)
  try {
    return await run
  } finally {
    if (locks.get(key) === run) locks.delete(key)
  }
}

export interface EnsureFolderResult {
  folderId: string
  parentId: string | null
  name: string
  /** True when this call created the folder in Drive. */
  created: boolean
  /** Other visible Studio folders with the same identity (older duplicates are kept, never touched). */
  duplicates: number
}

export async function ensureFolder(
  api: DriveApi,
  store: DriveStore,
  opts: { connectionId: string; kind: FolderKind; entityKey: string; name: string; parentId: string; repair?: boolean; now?: () => Date }
): Promise<EnsureFolderResult> {
  const now = opts.now ?? (() => new Date())
  const { connectionId, kind, entityKey, name, parentId } = opts
  return serialized(`${connectionId}|${kind}|${entityKey}`, async () => {
    const props = { studioApp: STUDIO_APP, studioKind: kind, studioEntity: entityProperty(entityKey) }
    let mapping = await store.getMapping(connectionId, kind, entityKey)

    const finalize = async (file: DriveFile, created: boolean, duplicates = 0): Promise<EnsureFolderResult> => {
      const parent = file.parents?.[0] ?? (parentId === 'root' ? null : parentId)
      await store.upsertMapping(connectionId, kind, entityKey, { folderId: file.id, intentId: null, parentId: parent, name: file.name || name, verifiedAt: now() })
      return { folderId: file.id, parentId: parent, name: file.name || name, created, duplicates }
    }

    if (mapping?.folderId) {
      const file = await api.findFile(mapping.folderId)
      if (file && !file.trashed && file.mimeType === FOLDER_MIME) return finalize(file, false)
      if (!opts.repair) {
        throw new DriveError(
          kind === 'root' ? 'root_missing' : 'not_found',
          `Studio's "${mapping.name}" folder in Google Drive was deleted, trashed or is no longer accessible. Use Repair to create a new one; nothing was uploaded elsewhere.`
        )
      }
      mapping = await store.upsertMapping(connectionId, kind, entityKey, { name, folderId: null, verifiedAt: null })
    }

    // An earlier create whose response was lost: the pre-generated ID tells.
    if (mapping?.intentId) {
      const file = await api.findFile(mapping.intentId)
      if (file && !file.trashed) return finalize(file, false)
    }

    // A Studio folder for this identity that the database lost track of.
    const q = [
      `mimeType='${FOLDER_MIME}'`,
      'trashed=false',
      `'${escapeQuery(parentId)}' in parents`,
      `appProperties has { key='studioApp' and value='${STUDIO_APP}' }`,
      `appProperties has { key='studioKind' and value='${escapeQuery(kind)}' }`,
      `appProperties has { key='studioEntity' and value='${escapeQuery(props.studioEntity)}' }`
    ].join(' and ')
    const found = await api.list(q, 10)
    if (found.length > 0) return finalize(found[0], false, found.length - 1)

    const id = mapping?.intentId ?? (await api.generateIds(1))[0]
    await store.upsertMapping(connectionId, kind, entityKey, { name, intentId: id, parentId: parentId === 'root' ? null : parentId })
    let file: DriveFile
    try {
      file = await api.createFolder({ id, name, parentId, appProperties: props })
    } catch (error) {
      const existing = await api.findFile(id).catch(() => null)
      if (!existing) throw error
      file = existing
    }
    return finalize(file, true)
  })
}

export function ensureRootFolder(api: DriveApi, store: DriveStore, connectionId: string, repair = false) {
  return ensureFolder(api, store, { connectionId, kind: 'root', entityKey: ROOT_ENTITY, name: ROOT_FOLDER_NAME, parentId: 'root', repair })
}

export interface DriveTestResult {
  ok: boolean
  at: string
  fileName: string
  bytes: number
  localSha256: string
  downloadedSha256: string | null
  /** Drive's own SHA-256 of the stored bytes, when it reported one. */
  remoteSha256: string | null
  rootFolderId: string
  cleanedUp: boolean
  durationMs: number
  error: string | null
}

/** A small lossless PNG with random pixels, so every test transfers new content. */
export async function makeTestImage(): Promise<Buffer> {
  const width = 48
  const height = 32
  return sharp(crypto.randomBytes(width * height * 3), { raw: { width, height, channels: 3 } }).png().toBuffer()
}

/**
 * Upload an app-owned test image into the root, download it, compare SHA-256,
 * then delete exactly that file ID. Retrying with the same pre-generated ID
 * never leaves a duplicate.
 */
export async function runTransferTest(api: DriveApi, rootFolderId: string, opts: { image?: Buffer; now?: () => Date } = {}): Promise<DriveTestResult> {
  const started = Date.now()
  const at = (opts.now ?? (() => new Date()))()
  const bytes = opts.image ?? (await makeTestImage())
  const localSha256 = sha256(bytes)
  const fileName = `studio-connection-test-${at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.png`
  const result: DriveTestResult = {
    ok: false,
    at: at.toISOString(),
    fileName,
    bytes: bytes.length,
    localSha256,
    downloadedSha256: null,
    remoteSha256: null,
    rootFolderId,
    cleanedUp: false,
    durationMs: 0,
    error: null
  }
  const [id] = await api.generateIds(1)
  let uploaded: DriveFile
  try {
    uploaded = await api.uploadMultipart(
      { id, name: fileName, parentId: rootFolderId, mimeType: 'image/png', appProperties: { studioApp: STUDIO_APP, studioKind: 'connection-test' } },
      bytes
    )
  } catch (error) {
    const existing = await api.findFile(id).catch(() => null)
    if (!existing) throw error
    uploaded = existing
  }
  try {
    const downloaded = await api.download(id)
    result.downloadedSha256 = sha256(downloaded)
    result.remoteSha256 = uploaded.sha256Checksum ?? (await api.findFile(id))?.sha256Checksum ?? null
    const problems: string[] = []
    if (downloaded.length !== bytes.length) problems.push(`downloaded ${downloaded.length} bytes, uploaded ${bytes.length}`)
    if (result.downloadedSha256 !== localSha256) problems.push('downloaded SHA-256 differs from the uploaded image')
    if (result.remoteSha256 && result.remoteSha256 !== localSha256) problems.push("Drive's reported SHA-256 differs from the uploaded image")
    result.ok = problems.length === 0
    result.error = problems.length ? `Verification failed: ${problems.join('; ')}.` : null
  } finally {
    try {
      await api.delete(id)
      result.cleanedUp = true
    } catch {
      result.cleanedUp = false
    }
    result.durationMs = Date.now() - started
  }
  return result
}
