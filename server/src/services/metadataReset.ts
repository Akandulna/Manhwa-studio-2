/**
 * Reset stale Metadata (Metadata page → series → "Reset stale metadata").
 *
 * Metadata binds every crop description to the chapter's approved cut AND to
 * its English script (script links). When the script is rewritten after the
 * jobs went out, everything made from the old jobs goes stale at once: Studio
 * reports "Stale Metadata job result", R2 keeps old results the auto-fetch
 * keeps rejecting, and the phones keep the old job, so their pages still look
 * done. One series-wide action clears all three:
 *
 *   1. R2 first (nothing removed here comes back by itself): every
 *      `metadata/<Series>/<Chapter>/<page>.page.json` result made for another
 *      job revision than the current one is deleted, under our prefix, the
 *      bucket root and every folder the phones write receipts to.
 *   2. Studio: crop_metadata3 files that no longer validate against the current
 *      job are moved to `<Chapter>/.metadata-resets/<ms>/` (not deleted).
 *   3. Current jobs are republished to `shared/metadata-jobs/` (only changed
 *      ones are written) and the phones are asked to sync. A phone that takes
 *      the new job treats its old result as not done — results are kept per
 *      job revision — and, the cut being unchanged, reuses its accepted visual
 *      descriptions verbatim, regenerating only the script links. No APK change.
 *
 * Pages whose metadata is still current are never touched. Chapters whose
 * jobs can't be built right now (no review/cut, no script, managed) are
 * reported and left alone.
 */
import fs from 'fs/promises'
import path from 'path'
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { prisma } from '../index.js'
import { currentMetadataJobs, metadataGenerations, publishMetadataJobs, validateMetadataResult } from './clipper3/metadataSplit.js'
import { getMetadataFilePathFor, getSourceFolderPath, readImageMetadata } from './clipper3/perImageStore.js'
import { managedCropBindingCount } from './managedCropProjection.js'
import { createClient, getR2Config, phoneFolders, requestPhoneUpdate } from './r2Service.js'
import { withSeriesMutation } from './seriesActivity.js'
import { notifySeriesProcessChanged } from './seriesProcess.js'
import { syncMetadataLibrary } from './metadataLibrary.js'
import { LIVE_CONTROLS } from './antigravity/jobs.js'
import type { MetadataResetChapter, MetadataResetResult } from './metadataLibraryModel.js'

export class MetadataResetError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

type ChapterRow = { id: string; number: number; folderPath: string; seriesId: string; series: { title: string } }
type Plan = { chapter: ChapterRow; folder: string; revisions: Map<string, string>; stalePages: string[]; publish: boolean }

async function planChapter(chapter: ChapterRow): Promise<Plan | { chapter: ChapterRow; skipped: string }> {
  if (await managedCropBindingCount(chapter.folderPath)) return { chapter, skipped: 'Managed/mixed chapter' }
  let current: Awaited<ReturnType<typeof currentMetadataJobs>>
  try { current = await currentMetadataJobs(chapter, await metadataGenerations(chapter)) }
  catch (error) { return { chapter, skipped: error instanceof Error ? error.message : String(error) } }
  const dir = getSourceFolderPath(chapter.folderPath)
  const revisions = new Map<string, string>()
  const stalePages: string[] = []
  let publish = false
  for (const job of current.jobs) {
    const page = JSON.parse(job.payloadText).page as string
    revisions.set(page, job.revision)
    const text = await readImageMetadata(chapter.folderPath, page)
    if (text !== null) {
      try { validateMetadataResult(text, job, current.script) } catch { stalePages.push(page) }
    }
    const published = await fs.readFile(path.join(dir, '.metadata-jobs', `${path.parse(page).name}.json`), 'utf8')
      .then(t => JSON.parse(t).revision as string, () => null)
    if (published !== job.revision) publish = true
  }
  return { chapter, folder: path.basename(dir), revisions, stalePages, publish }
}

/** R2 results of these chapters made for another job revision. Lists `metadata/<Series>/` once per folder. */
async function staleR2Results(seriesFolder: string, plans: Plan[]) {
  const config = getR2Config()
  if (!config) return null
  const client = createClient(config)
  try {
    const roots = [...new Set([config.prefix, '', ...await phoneFolders(client, config)])]
    const byFolder = new Map(plans.map(p => [p.folder, p]))
    const stale = new Map<string, string[]>() // chapterId → keys
    for (const root of roots) {
      const base = `${root}metadata/${seriesFolder}/`
      let token: string | undefined
      do {
        const list = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: base, ContinuationToken: token }))
        for (const item of list.Contents ?? []) {
          const key = item.Key
          if (!key?.endsWith('.page.json')) continue
          const [chapterFolder, file, ...rest] = key.slice(base.length).split('/')
          const plan = byFolder.get(chapterFolder)
          if (!plan || !file || rest.length) continue
          let revision: string | null = null, page: string | null = null
          try {
            const body = JSON.parse(await (await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))).Body!.transformToString())
            revision = typeof body.revision === 'string' ? body.revision : null
            page = typeof body.page === 'string' ? body.page : null
          } catch { /* unreadable → stale */ }
          const current = page ? plan.revisions.get(page) : undefined
          if (current && current === revision && path.parse(page!).name === file.slice(0, -'.page.json'.length)) continue
          stale.set(plan.chapter.id, [...(stale.get(plan.chapter.id) ?? []), key])
        }
        token = list.NextContinuationToken
      } while (token)
    }
    return { client, config, stale }
  } catch (error) { client.destroy(); throw error }
}

export async function resetStaleSeriesMetadata(seriesId: string): Promise<MetadataResetResult> {
  const series = await prisma.series.findUnique({
    where: { id: seriesId },
    select: { id: true, title: true, rootFolder: true,
      chapters: { where: { status: 'done', completedAt: null }, orderBy: { number: 'asc' },
        select: { id: true, number: true, folderPath: true, seriesId: true } } }
  })
  if (!series) throw new MetadataResetError('Series not found', 404)
  const live = await prisma.antigravityRun.findFirst({ where: { seriesId, kind: 'metadata', control: { in: [...LIVE_CONTROLS] } } })
  if (live) throw new MetadataResetError('An AntiGravity Metadata process is running for this series; stop it first', 409)
  if (!getR2Config()) throw new MetadataResetError('Configure Cloudflare R2 first: phones and R2 can only be reset through it', 409)

  const seriesFolder = path.basename(series.rootFolder)
  const result = await withSeriesMutation(seriesFolder, async () => {
    const resetAt = new Date()
    const chapters = series.chapters.map(c => ({ ...c, series: { title: series.title } }))
    const planned = await Promise.all(chapters.map(planChapter))
    const plans = planned.filter((p): p is Plan => 'revisions' in p)

    // 1. R2 — throws before anything here changes.
    const r2 = await staleR2Results(seriesFolder, plans)
    const deleted = new Map<string, number>()
    if (r2) {
      try {
        for (const [chapterId, keys] of r2.stale) for (let i = 0; i < keys.length; i += 1000) {
          const batch = keys.slice(i, i + 1000)
          const response = await r2.client.send(new DeleteObjectsCommand({ Bucket: r2.config.bucket, Delete: { Objects: batch.map(Key => ({ Key })), Quiet: true } }))
          const failed = response.Errors?.find(e => e.Code !== 'NoSuchKey')
          if (failed) throw new MetadataResetError(`R2 refused to delete ${failed.Key}: ${failed.Message ?? failed.Code}`, 502)
          deleted.set(chapterId, (deleted.get(chapterId) ?? 0) + batch.length)
        }
      } finally { r2.client.destroy() }
    }

    // 2. Studio — stale files moved aside.
    const report: MetadataResetChapter[] = []
    for (const entry of planned) {
      if (!('revisions' in entry)) {
        report.push({ chapterId: entry.chapter.id, number: entry.chapter.number, studioPages: [], r2Results: 0, republished: false, skipped: entry.skipped })
        continue
      }
      const { chapter, stalePages } = entry
      if (stalePages.length) {
        const backup = path.join(getSourceFolderPath(chapter.folderPath), '.metadata-resets', String(resetAt.getTime()))
        await fs.mkdir(backup, { recursive: true })
        for (const page of stalePages) {
          const file = getMetadataFilePathFor(chapter.folderPath, page)
          await fs.rename(file, path.join(backup, path.basename(file)))
        }
      }
      // 3. Republish current jobs (writes only those whose revision changed).
      let republished = false
      if (entry.publish || stalePages.length || deleted.get(chapter.id)) {
        await publishMetadataJobs(chapter, { notify: false })
        republished = true
      }
      report.push({ chapterId: chapter.id, number: chapter.number, studioPages: stalePages, r2Results: deleted.get(chapter.id) ?? 0, republished })
    }
    return { resetAt: resetAt.toISOString(), chapters: report }
  })

  notifySeriesProcessChanged(true)
  // Refresh the fetch report so the old "Stale Metadata job result" errors go away.
  void syncMetadataLibrary().catch(error => console.warn('[metadata-reset] refresh after reset failed:', error))

  let phonesAsked = false
  if (result.chapters.some(c => c.republished || c.r2Results)) {
    try { await requestPhoneUpdate('sync'); phonesAsked = true }
    catch (error) { console.warn(`[metadata-reset] asking the phones to sync failed (${series.title}):`, error) }
  }
  return {
    seriesId: series.id, title: series.title, resetAt: result.resetAt, chapters: result.chapters,
    studioPages: result.chapters.reduce((n, c) => n + c.studioPages.length, 0),
    r2Results: result.chapters.reduce((n, c) => n + c.r2Results, 0),
    republished: result.chapters.filter(c => c.republished).length,
    phonesAsked
  }
}
