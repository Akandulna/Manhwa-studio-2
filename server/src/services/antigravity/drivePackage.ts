/**
 * Upload one prepared page to Drive (PRD §4.5–4.6, §8):
 *   My Drive / Manhwa Studio / <Series> / Chapters / <Exact Chapter Folder> / <stem>__<hash>/
 * Folders are found by stable library identity, never by name. Each file's
 * Drive ID is reserved and saved before the upload, so a retry or a lost
 * response reconciles to the same file instead of creating a duplicate.
 * Every upload is checked against Drive's own SHA-256 (or a download).
 */

import crypto from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import type { DriveApi, DriveFile } from '../googleDrive/driveApi.js'
import { DriveError } from '../googleDrive/errors.js'
import { ensureFolder, ensureRootFolder, STUDIO_APP } from '../googleDrive/files.js'
import type { PreparedPage } from './preparation.js'

const sha256 = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex')

export interface PackageFile {
  /** Stable key within the page generation: slice id, "handoff", "crop-prompt", "review-prompt". */
  key: string
  name: string
  mime: string
  data: Buffer
}

export interface UploadedPackage {
  rootFolderId: string
  seriesFolderId: string
  chapterFolderId: string
  pageFolderId: string
  files: Record<string, { fileId: string; sha256: string; bytes: number }>
}

export async function ensurePageFolders(api: DriveApi, prisma: PrismaClient, opts: {
  connectionId: string
  seriesId: string
  seriesTitle: string
  chapterId: string
  chapterFolder: string
  filename: string
  page: Pick<PreparedPage, 'pageStem' | 'sourceSha256'>
}) {
  const { prismaDriveStore } = await import('../googleDrive/store.js')
  const store = prismaDriveStore(prisma)
  const root = await ensureRootFolder(api, store, opts.connectionId)
  const series = await ensureFolder(api, store, { connectionId: opts.connectionId, kind: 'series', entityKey: opts.seriesId, name: opts.seriesTitle, parentId: root.folderId })
  const chapters = await ensureFolder(api, store, { connectionId: opts.connectionId, kind: 'chapters', entityKey: opts.seriesId, name: 'Chapters', parentId: series.folderId })
  const chapter = await ensureFolder(api, store, { connectionId: opts.connectionId, kind: 'chapter', entityKey: opts.chapterId, name: opts.chapterFolder, parentId: chapters.folderId })
  const page = await ensureFolder(api, store, {
    connectionId: opts.connectionId,
    kind: 'page',
    entityKey: `${opts.chapterId}:${opts.filename}:${opts.page.sourceSha256}`,
    name: `${opts.page.pageStem}__${opts.page.sourceSha256.slice(0, 12)}`,
    parentId: chapter.folderId
  })
  return { rootFolderId: root.folderId, seriesFolderId: series.folderId, chapterFolderId: chapter.folderId, pageFolderId: page.folderId }
}

async function verify(api: DriveApi, file: DriveFile, expected: { sha256: string; bytes: number }) {
  if (file.trashed) return false
  if (file.size !== undefined && Number(file.size) !== expected.bytes) return false
  if (file.sha256Checksum) return file.sha256Checksum === expected.sha256
  return sha256(await api.download(file.id)) === expected.sha256
}

export async function uploadPackage(api: DriveApi, prisma: PrismaClient, opts: {
  connectionId: string
  jobId: string
  folders: Awaited<ReturnType<typeof ensurePageFolders>>
  files: PackageFile[]
  signal?: AbortSignal
}): Promise<UploadedPackage> {
  const out: UploadedPackage = { ...opts.folders, files: {} }
  for (const file of opts.files) {
    if (opts.signal?.aborted) throw new DriveError('google', 'Preparation was stopped.')
    const digest = sha256(file.data)
    const expected = { sha256: digest, bytes: file.data.length }
    let row = await prisma.driveInputFile.findUnique({ where: { jobId_sliceId: { jobId: opts.jobId, sliceId: file.key } } })
    if (row && (row.sha256 !== digest || row.connectionId !== opts.connectionId || row.parentId !== opts.folders.pageFolderId)) {
      // Different content or destination for the same key: never reuse that Drive file.
      await prisma.driveInputFile.delete({ where: { id: row.id } })
      row = null
    }
    if (row?.state === 'verified') {
      const existing = await api.findFile(row.fileId)
      if (existing && (await verify(api, existing, expected))) {
        out.files[file.key] = { fileId: row.fileId, ...expected }
        continue
      }
    }
    if (!row) {
      // Same bytes, same name, same page folder, already verified for another job (e.g. the page was prepared
      // under another model): share that Drive file instead of uploading a duplicate (PRD §13.2, AG-04).
      const twin = await prisma.driveInputFile.findFirst({
        where: { connectionId: opts.connectionId, parentId: opts.folders.pageFolderId, name: file.name, sha256: digest, state: 'verified' },
        orderBy: { createdAt: 'asc' }
      })
      const existing = twin ? await api.findFile(twin.fileId) : null
      if (twin && existing && (await verify(api, existing, expected))) {
        await prisma.driveInputFile.create({
          data: { connectionId: opts.connectionId, jobId: opts.jobId, sliceId: file.key, fileId: twin.fileId, parentId: opts.folders.pageFolderId, name: file.name, mime: file.mime, bytes: file.data.length, sha256: digest, state: 'verified' }
        })
        out.files[file.key] = { fileId: twin.fileId, ...expected }
        continue
      }
    }
    const fileId = row?.fileId ?? (await api.generateIds(1))[0]
    if (!row) {
      row = await prisma.driveInputFile.create({
        data: { connectionId: opts.connectionId, jobId: opts.jobId, sliceId: file.key, fileId, parentId: opts.folders.pageFolderId, name: file.name, mime: file.mime, bytes: file.data.length, sha256: digest, state: 'reserved' }
      })
    }
    let uploaded = await api.findFile(fileId)
    if (!uploaded) {
      try {
        uploaded = await api.upload({ id: fileId, name: file.name, parentId: opts.folders.pageFolderId, mimeType: file.mime, appProperties: { studioApp: STUDIO_APP, studioKind: 'antigravity-input', studioJob: opts.jobId.slice(0, 36), studioKey: file.key.slice(0, 40) } }, file.data)
      } catch (error) {
        uploaded = await api.findFile(fileId).catch(() => null)
        if (!uploaded) throw error
      }
    }
    await prisma.driveInputFile.update({ where: { id: row.id }, data: { state: 'uploaded' } })
    if (!(await verify(api, uploaded, expected))) {
      throw new DriveError('verify_failed', `Drive's copy of ${file.name} does not match the prepared bytes.`)
    }
    await prisma.driveInputFile.update({ where: { id: row.id }, data: { state: 'verified' } })
    out.files[file.key] = { fileId, ...expected }
  }
  return out
}
