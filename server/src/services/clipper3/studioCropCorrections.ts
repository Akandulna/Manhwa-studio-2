import fs from 'fs/promises'
import path from 'path'
import { GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { extractCrops, getSourceFolderPath, readImagePoints, readImageMetadata, validateMetadata, expectedExportedFilenames } from './perImageStore.js'
import { stripCropStory } from '../seriesRestartModel.js'
import { withUnmanagedCropChapter } from '../managedCropProjection.js'
import { sha256, normalizeScript, storyLinksCurrent } from './studioCropAuthorityModel.js'
import type { SyncChapterInput, ChapterSyncResult } from './processedSync.js'

export interface CorrectionReport { queued: number; pending: number; deviceApplied: number; failed: { filename: string; reason: string }[] }
export interface CorrectionTransport { publish(key: string, body: Record<string, unknown>): Promise<{ applied: number; pending?: boolean }>; refresh?(series: string): Promise<void>; close?(): void }

/** Only the real Sync json uses this transport. Preview remains read-only, including cloud storage. */
export async function createCorrectionTransport(): Promise<CorrectionTransport> {
  const { createClient, getR2Config, phoneFolders } = await import('../r2Service.js')
  const config = getR2Config()
  if (!config) throw new Error('Configure cloud storage to send reviewed crops to phones')
  const { relayPhones, sendPhoneRequest } = await import('../phoneRelay.js')
  const expectedDevices = relayPhones().map(p => p.id).filter(Boolean)
  const client = createClient(config)
  const roots = [...new Set([config.prefix, '', ...await phoneFolders(client, config)])]
  return { close: () => client.destroy(), refresh: async series => { await sendPhoneRequest('sync', { series }) }, async publish(relative, body) {
    const appliedDevices = new Set<string>()
    for (const prefix of roots) {
      const key = `${prefix}shared/studio-crops/${relative}`
      const old = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key })).catch((e: any) => {
        if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null
        throw e
      })
      const previous = old?.Body ? JSON.parse(await old.Body.transformToString()) : null
      if (previous?.revision !== body.revision) await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: key,
        Body: JSON.stringify(body), ContentType: 'application/json' }))
      // Acknowledgements are per device and revision. A queued command is never reported as applied.
      let token: string | undefined
      do {
        const list = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: `${prefix}shared/studio-crop-acks/`, ContinuationToken: token }))
        for (const item of list.Contents ?? []) {
          if (!item.Key?.endsWith('/' + relative.replace(/\.page\.json$/, '.json'))) continue
          const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: item.Key }))
          const ack = JSON.parse(await response.Body!.transformToString())
          if (ack.revision === body.revision && ack.status === 'applied' && typeof ack.deviceId === 'string') appliedDevices.add(ack.deviceId)
        }
        token = list.NextContinuationToken
      } while (token)
    }
    return { applied: appliedDevices.size, pending: expectedDevices.length === 0 || expectedDevices.some(id => !appliedDevices.has(id)) }
  } }
}

/** Publish only approved attached pages needing links, after valid incoming links have been imported. */
export async function sendStudioCropCorrections(input: SyncChapterInput, result: ChapterSyncResult,
  transport: CorrectionTransport, generation: { restartRevision: string | null; pageRevision: string | null }): Promise<CorrectionReport> {
  return withUnmanagedCropChapter(input.folderPath, async () => {
    const report: CorrectionReport = { queued: 0, pending: 0, deviceApplied: 0, failed: [] }
    const dir = getSourceFolderPath(input.folderPath), chapter = path.basename(dir), series = path.basename(path.dirname(dir))
    const script = await fs.readFile(path.join(dir, 'script.md'), 'utf8').then(normalizeScript).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return ''; throw e
    })
    const incomingPages = await (await import('./processedSync.js')).readProcessedDir(input.folderPath)
    for (const image of input.images) {
      try {
        const points = await readImagePoints(input.folderPath, image.filename), metadata = await readImageMetadata(input.folderPath, image.filename)
        if (!points?.file || metadata == null) continue // Never invent geometry for an unapproved page.
        const bytes = await fs.readFile(path.join(dir, image.filename))
        const rejected = result.pages.find(p => p.filename === image.filename && (p.status === 'failed' || p.linkingRequired))
        if (!rejected && storyLinksCurrent(metadata, script, sha256(bytes))) continue // Accepted pages remain done.
        if (!script) throw new Error('Complete/synchronize the English chapter script before sending crops for linking')
        const crops = extractCrops(points.file)
        const validation = validateMetadata(metadata, crops.map(c => c.id), expectedExportedFilenames(input.seriesSlug, image.filename, crops), input.seriesSlug)
        if (!validation.isValid) throw new Error('Studio metadata is not valid: ' + validation.errors.join(' '))
        const pointersText = JSON.stringify({ ...points.file, format: 'four-point-crop', version: '1.0', coordinateSystem: 'normalized', image, crops }, null, 2) + '\n'
        const metadataText = stripCropStory(metadata)
        const visualSha256 = sha256(pointersText + '\n' + metadataText), sourceSha256 = sha256(bytes), scriptSha256 = sha256(script)
        // Repeated syncs of the same rejected output are idempotent. A subsequent rejected attempt gets a fresh reset.
        let rejectedAttempt = ''
        if (rejected) {
          const incoming = incomingPages?.find(p => p.folder === rejected.folder)
          rejectedAttempt = sha256((incoming?.pointersText ?? '') + '\n' + (incoming?.metadataText ?? ''))
        }
        const revision = sha256(JSON.stringify([visualSha256, sourceSha256, scriptSha256, generation, rejectedAttempt]))
        const body = { schema: 'studio-crop-authority/1', series, chapter, page: image.filename, chapterNumber: String(input.chapterNumber),
          ...generation, sourceSha256, sourceBytes: bytes.length, scriptSha256, visualSha256, pointersText, metadataText, revision }
        const status = await transport.publish(`${series}/${chapter}/${path.parse(image.filename).name}.page.json`, body)
        report.queued++; report.deviceApplied += status.applied; if (status.pending ?? !status.applied) report.pending++
      } catch (e) { report.failed.push({ filename: image.filename, reason: e instanceof Error ? e.message : String(e) }) }
    }
    return report
  })
}
