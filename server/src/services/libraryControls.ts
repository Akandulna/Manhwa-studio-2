import fs from 'fs/promises'
import path from 'path'
import { DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { prisma, downloadManager } from '../index.js'
import { createClient, getR2Config, invalidateStorage } from './r2Service.js'
import { isSeriesObject, mergeControl, validControls, type LibraryControl } from './libraryControlModel.js'

const PREFIX = 'libraryControl:'
let saving: Promise<unknown> = Promise.resolve()
export async function libraryControls(): Promise<LibraryControl[]> {
  return (await prisma.setting.findMany({ where: { key: { startsWith: PREFIX } } })).map(s => JSON.parse(s.value))
}
export async function libraryControl(folder: string): Promise<LibraryControl> {
  const row = await prisma.setting.findUnique({ where: { key: PREFIX + folder } })
  return row ? JSON.parse(row.value) : { folder }
}
export async function isLibraryDeleted(folder: string): Promise<boolean> { return !!(await libraryControl(folder)).deleted }
export async function hiddenLibraryFolders(): Promise<string[]> { return (await libraryControls()).filter(c => c.deleted || c.archived?.done).map(c => c.folder) }
export async function hiddenLibrarySeriesIds(): Promise<string[]> { const folders=await hiddenLibraryFolders();return (await prisma.series.findMany({where:{rootFolder:{in:folders}},select:{id:true}})).map(s=>s.id) }
export function saveLibraryControls(incoming: LibraryControl[]): Promise<boolean> {
  if (!validControls(incoming)) return Promise.reject(new Error('Invalid library actions'))
  const next = saving.catch(() => {}).then(async () => {
    let changed = false
    for (const control of incoming) {
      const prior = await libraryControl(control.folder)
      const merged = mergeControl(prior, control)
      if (JSON.stringify(prior) === JSON.stringify(merged)) continue
      // A Part newly marked done: its R2 page zips and voiceovers go (partDoneCleanup.ts).
      if (Object.entries(merged.parts ?? {}).some(([n, d]) => d.done && !prior.parts?.[n]?.done)) {
        const folder = control.folder
        void import('./partDoneCleanup.js').then(m => m.schedulePartDoneCleanup(folder)).catch(() => {})
      }
      const key = PREFIX + control.folder, value = JSON.stringify(merged)
      await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
      changed = true
    }
    return changed
  })
  saving = next
  return next
}
/** Tombstones are saved first. Failed cleanup is retried on library sync and startup. */
export async function purgeDeletedLibrarySeries(): Promise<void> {
  for (const control of await libraryControls()) {
    if (!control.deleted) continue
    const rows = await prisma.series.findMany({ where: { rootFolder: control.folder } })
    for (const row of rows) {
      await downloadManager.cancelSeries(row.id)
      const watermarks = await prisma.watermarkTemplate.findMany({ where: { seriesId: row.id } })
      for (const watermark of watermarks) await fs.rm(watermark.imagePath, { force: true })
      await fs.rm(path.resolve(process.env.DOWNLOAD_ROOT || './downloads', control.folder), { recursive: true, force: true })
      await prisma.series.delete({ where: { id: row.id } })
      await prisma.setting.deleteMany({ where: { key: { in: [`libraryOwner:${row.id}`, `phoneAutoSend:${row.id}`, `phoneIndex:${row.id}`, `compressedCheckpoint:${row.id}`] } } })
    }
    // A delayed writer may have recreated a folder after its database row was removed.
    await fs.rm(path.resolve(process.env.DOWNLOAD_ROOT || './downloads', control.folder), { recursive: true, force: true })
    const finishedKey = `libraryDeletedCloud:${control.folder}`
    if (await prisma.setting.findUnique({ where: { key: finishedKey } })) continue
    const config = getR2Config()
    if (!config) throw new Error('Cloud storage is required to finish deleting the series')
    const client = createClient(config)
    try {
      let token: string | undefined
      const keys: string[] = []
      do {
        const list = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, ContinuationToken: token }))
        for (const object of list.Contents ?? []) if (object.Key && isSeriesObject(object.Key, control.folder)) keys.push(object.Key)
        token = list.NextContinuationToken
      } while (token)
      for (let i = 0; i < keys.length; i += 1000) {
        const deleted = await client.send(new DeleteObjectsCommand({ Bucket: config.bucket, Delete: { Objects: keys.slice(i, i + 1000).map(Key => ({ Key })) } }))
        if (deleted.Errors?.length) throw new Error('Some cloud files could not be deleted; cleanup will retry')
      }
      await prisma.setting.upsert({ where: { key: finishedKey }, create: { key: finishedKey, value: 'true' }, update: { value: 'true' } })
      invalidateStorage()
    } finally { client.destroy() }
  }
}
