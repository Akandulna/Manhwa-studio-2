import path from 'path'
import fs from 'fs/promises'
import { CopyObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3'
import { prisma } from '../index.js'
import { libraryControl, libraryControls } from './libraryControls.js'
import { createClient, getR2Config, phoneFolders, invalidateStorage } from './r2Service.js'
import { archiveRestartFiles, atomicRestartWrite } from './seriesRestartFiles.js'
import { restartRevision, restartCloudPrefixes } from './seriesRestartModel.js'
import { pendingAlignments } from './alignment/alignmentService.js'
import { seriesMutationBusy } from './seriesActivity.js'
import { scriptReplacementBusy } from './scriptReplacement.js'
import { notifySeriesProcessChanged } from './seriesProcess.js'

import { seriesRestartPending } from './seriesRestartGuard.js'
const key = (folder: string) => `libraryRestartReady:${folder}`
async function setting(name: string, value: string) {
  await prisma.setting.upsert({ where: { key: name }, create: { key: name, value }, update: { value } })
}
/** Library controls are durable first; all failures retry without touching a ready generation. */
export async function applySeriesRestarts(): Promise<void> {
  for (const control of await libraryControls()) {
    const revision = restartRevision(control)
    if (!revision || control.deleted || !await seriesRestartPending(control.folder)) continue
    const folder = control.folder
    const config = getR2Config()
    if (!config) throw new Error('Cloud storage is required to finish a series restart')
    const phase = `libraryRestartPhase:${folder}:${revision}`
    const state = await prisma.setting.findUnique({ where: { key: phase } })
    let stage = state?.value ?? ''
    const rows = await prisma.series.findMany({ where: { rootFolder: folder }, include: { chapters: { include: { scripts: true, audioSections: true, audioFiles: true, audioAnalyses: true } }, videoProjects: { include: { parts: { include: { images: true } }, exports: true, events: true } } } })
    if (!stage) {
      const { productionAutomation } = await import('./productionAutomation.js')
      const { stopSeriesExports } = await import('./editor2Export.js')
      for (const row of rows) {
        const job = (await productionAutomation.get(row.id)).job
        if (job && ['running', 'interrupted'].includes(job.status)) await productionAutomation.cancel(row.id)
        if (!stopSeriesExports(row.id)) throw new Error('Waiting for this series’ video export to stop')
        if (seriesMutationBusy(folder) || row.chapters.some(c => scriptReplacementBusy(c.id) || pendingAlignments(c.id, 'en') || pendingAlignments(c.id, 'hi') || c.scripts.some(s => s.status === 'generating') || c.audioSections.some(s => s.status === 'generating')) || row.videoProjects.some(p => p.status === 'rendering' || p.exports.some(e => e.status === 'rendering'))) throw new Error('Waiting for this series’ active desktop work to finish')
      }
      const ids = rows.flatMap(s => s.chapters.map(c => c.id))
      const timelines = await prisma.editor2Timeline.findMany({ where: { chapterId: { in: ids } } })
      const root = path.resolve(process.env.DOWNLOAD_ROOT || './downloads')
      await archiveRestartFiles(root, folder, revision, rows.flatMap(s => s.chapters.map(c => c.folderPath)), { rows, timelines, control })
      await prisma.$transaction(async tx => {
        await tx.audioFile.deleteMany({ where: { chapterId: { in: ids } } })
        await tx.audioSection.deleteMany({ where: { chapterId: { in: ids } } })
        await tx.audioAnalysis.deleteMany({ where: { chapterId: { in: ids } } })
        await tx.chapterScript.deleteMany({ where: { chapterId: { in: ids } } })
        await tx.chapter.updateMany({ where: { id: { in: ids } }, data: { completedAt: null, completedPart: null } })
        for (const row of rows) {
          await tx.series.update({ where: { id: row.id }, data: { aboutSummary: null } })
          // The complete project graph is backed up; fresh work starts without old drafts.
          await tx.videoProject.deleteMany({ where: { seriesId: row.id } })
          await tx.setting.deleteMany({ where: { key: { in: [`phoneScriptsImport:${row.id}`, `phoneScriptsImport:hi:${row.id}`] } } })
        }
        for (const chapterId of ids) for (const language of ['en', 'hi']) {
          const old = timelines.find(t => t.chapterId === chapterId && t.language === language)
          const updatedAt = new Date(Math.max(Date.now(), (old?.updatedAt.getTime() ?? 0) + 1))
          const data = { json: '', processedJson: null, model: null, updatedAt }
          await tx.editor2Timeline.upsert({ where: { chapterId_language: { chapterId, language } }, create: { chapterId, language, ...data }, update: data })
        }
        await tx.setting.upsert({ where: { key: phase }, create: { key: phase, value: 'local' }, update: { value: 'local' } })
      }, { timeout: 30_000 })
      stage = 'local'
      notifySeriesProcessChanged(true)
    }
    const client = createClient(config)
    try {
      const roots = [...new Set([config.prefix, '', ...await phoneFolders(client, config)])]
      if (stage === 'local') {
        // Save an exact listing before deletion. Every object is copied before an atomic conditional tombstone.
        const planFile = path.resolve(process.env.DOWNLOAD_ROOT || './downloads', '.restarts', revision, folder, 'cloud-plan.json')
        let plan: { key: string; etag: string; bytes: number }[]
        try { plan = JSON.parse(await fs.readFile(planFile, 'utf8')) } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
          plan = []
          for (const prefix of restartCloudPrefixes(roots, folder)) {
            let token: string | undefined
            do {
              const list = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix, ContinuationToken: token }))
              for (const item of list.Contents ?? []) if (item.Key && item.ETag && item.Size !== 0) plan.push({ key: item.Key, etag: item.ETag, bytes: item.Size ?? 0 })
              token = list.NextContinuationToken
            } while (token)
          }
          await atomicRestartWrite(planFile, JSON.stringify(plan))
        }
        for (const item of plan) {
          const archived = `${config.prefix}restarts/${folder}/${revision}/cloud/${item.key}`
          const saved = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: archived })).catch((e: any) => { if (e.$metadata?.httpStatusCode === 404 || e.name === 'NotFound') return null; throw e })
          if (!saved) await client.send(new CopyObjectCommand({ Bucket: config.bucket, Key: archived, CopySource: `${config.bucket}/${item.key.split('/').map(encodeURIComponent).join('/')}`, CopySourceIfMatch: item.etag, MetadataDirective: 'REPLACE', Metadata: { 'restart-source-etag': item.etag.replaceAll('"', '') } }))
          const verified = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: archived }))
          if (verified.ContentLength !== item.bytes || verified.Metadata?.['restart-source-etag'] !== item.etag.replaceAll('"', '')) throw new Error('Cloud restart backup could not be verified')
          // Conditional PUT is supported atomically by R2. A late upload is retained and
          // rejected by the generation fence; listing/import code ignores empty tombstones.
          await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: item.key, IfMatch: item.etag, Body: '', ContentType: 'application/x-series-restart-tombstone', Metadata: { 'series-restart-revision': revision } })).catch((e: any) => { if (![404, 412].includes(e.$metadata?.httpStatusCode)) throw e })
        }
        // Commit this phase BEFORE acknowledging phones. Never archive freshly regenerated files on retry.
        await setting(phase, 'cloud')
        invalidateStorage()
      }
      if (restartRevision(await libraryControl(folder)) !== revision) throw new Error('A newer restart superseded this request')
      const body = JSON.stringify({ schema: 'series-restart-ready/1', series: folder, revision, readyAt: new Date().toISOString() })
      for (const prefix of roots) await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: `${prefix}restarts/${folder}/${revision}/ready.json`, Body: body, ContentType: 'application/json' }))
      await setting(key(folder), revision)
      notifySeriesProcessChanged(true)
    } finally { client.destroy() }
  }
}
