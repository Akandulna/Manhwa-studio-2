/**
 * "Taken by Studio" markers for the phones' Editor 2.0 runs.
 *
 * While a Studio AntiGravity Timeline job is making a chapter's timeline, the phones must not make it too: a phone
 * run would spend its turns on it and its later upload could replace the Studio's timeline. So for every Timeline job
 * that is still in progress, Studio writes `editor/<Series>/<Chapter>[.hi].claim.json` next to the chapter's package,
 * and removes it once the job ends (a saved timeline then reaches the phones the usual way, as a timeline file). The
 * phone's EditorSync brings the markers down and its runs skip claimed chapters.
 *
 * Event-driven only (never on a timer, to keep R2's free tier): rebuilt a few seconds after a Timeline job is created
 * or changes stage, and once at start-up when a Timeline job was active recently. Each marker expires, so a Studio that
 * quit mid-job cannot keep a chapter from the phones for long.
 */
import path from 'path'
import { DeleteObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3'
import { prisma } from '../index.js'
import { createClient, getR2Config, phoneFolders } from './r2Service.js'
import { EDITOR_FOLDER, languageSuffix } from './phoneEditor.js'
import { TERMINAL_STAGES } from './antigravity/jobs.js'
import { languageOfFilename } from './antigravity/editorFlow.js'
import type { NarrationLanguage } from './narrationLanguage.js'

export const CLAIM_SUFFIX = '.claim.json'
export const CLAIM_SCHEMA = 'manhwa-studio-editor-claim/1'
/** A marker the phones honour for this long after it was written; live claims are rewritten before then. */
export const CLAIM_TTL_MS = 3 * 60 * 60 * 1000
const REFRESH_AFTER_MS = CLAIM_TTL_MS / 2
const DEBOUNCE_MS = 3_000

export interface EditorClaim {
  /** `<Series>/<Chapter>[.hi].claim.json`, relative to the editor folder. */
  name: string
  chapterId: string
  language: NarrationLanguage
  series: string
}

/** Chapters (per language) a Timeline job is making right now. */
export async function activeEditorClaims(): Promise<EditorClaim[]> {
  const jobs = await prisma.antigravityPageJob.findMany({
    where: { kind: 'editor', stage: { notIn: [...TERMINAL_STAGES] } },
    select: { chapterId: true, filename: true }
  })
  if (!jobs.length) return []
  const chapters = await prisma.chapter.findMany({
    where: { id: { in: [...new Set(jobs.map(j => j.chapterId))] } },
    select: { id: true, folderPath: true, series: { select: { rootFolder: true } } }
  })
  const byId = new Map(chapters.map(c => [c.id, c]))
  const claims = new Map<string, EditorClaim>()
  for (const job of jobs) {
    const language = languageOfFilename(job.filename)
    const chapter = byId.get(job.chapterId)
    if (!language || !chapter) continue
    const series = path.basename(chapter.series.rootFolder)
    const name = `${series}/${path.basename(chapter.folderPath)}${languageSuffix(language)}${CLAIM_SUFFIX}`
    claims.set(name, { name, chapterId: chapter.id, language, series })
  }
  return [...claims.values()]
}

/** True while a Timeline job is making this chapter's timeline in this language. */
export async function editorChapterClaimed(chapterId: string, language: NarrationLanguage): Promise<boolean> {
  return (await activeEditorClaims()).some(c => c.chapterId === chapterId && c.language === language)
}

export interface ClaimsResult { written: string[]; removed: string[] }

/** Writes a marker for every active claim and removes the rest, in every folder the phones read. */
export async function publishEditorClaims(): Promise<ClaimsResult> {
  const result: ClaimsResult = { written: [], removed: [] }
  const config = getR2Config()
  if (!config) return result
  const client = createClient(config)
  const claims = await activeEditorClaims()
  const now = Date.now()
  const changedSeries = new Set<string>()
  for (const folder of [...new Set(await phoneFolders(client, config))]) {
    const base = `${folder}${EDITOR_FOLDER}`
    const existing = new Map<string, number>()
    let token: string | undefined
    do {
      const page = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: base, ContinuationToken: token }))
      for (const object of page.Contents ?? []) {
        if (object.Key?.endsWith(CLAIM_SUFFIX)) existing.set(object.Key.slice(base.length), object.LastModified?.getTime() ?? 0)
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token)
    for (const claim of claims) {
      const written = existing.get(claim.name)
      if (written !== undefined && now - written < REFRESH_AFTER_MS) continue
      const body = {
        schema: CLAIM_SCHEMA, by: 'antigravity', series: claim.series, chapterId: claim.chapterId, language: claim.language,
        claimedAt: new Date(now).toISOString(), expiresAt: new Date(now + CLAIM_TTL_MS).toISOString()
      }
      await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: `${base}${claim.name}`, Body: JSON.stringify(body), ContentType: 'application/json' }))
      result.written.push(`${base}${claim.name}`)
      changedSeries.add(claim.series)
    }
    const wanted = new Set(claims.map(c => c.name))
    for (const name of existing.keys()) {
      if (wanted.has(name)) continue
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: `${base}${name}` }))
      result.removed.push(`${base}${name}`)
      changedSeries.add(name.split('/')[0])
    }
  }
  if (changedSeries.size) await notifyPhones([...changedSeries])
  return result
}

/** Phones read markers when they sync: ask them to, live through the relay when it's set up. */
async function notifyPhones(series: string[]): Promise<void> {
  try {
    const relay = await import('./phoneRelay.js')
    if (relay.relayConfigured()) {
      for (const name of series) await relay.sendPhoneRequest('sync', { series: name })
    } else {
      await (await import('./r2Service.js')).requestPhoneUpdate('sync')
    }
  } catch (error) {
    console.error('[editor-claims] could not ask the phones to sync:', error instanceof Error ? error.message : error)
  }
}

let timer: NodeJS.Timeout | null = null
let chain: Promise<void> = Promise.resolve()

/** Rebuilds the markers shortly; repeated calls within a few seconds make one pass. */
export function queueEditorClaims(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    chain = chain.then(async () => {
      const { written, removed } = await publishEditorClaims()
      if (written.length || removed.length) console.log(`[editor-claims] ${written.length} chapter(s) marked taken by AntiGravity, ${removed.length} released`)
    }).catch(error => console.error('[editor-claims] publishing failed:', error instanceof Error ? error.message : error))
  }, DEBOUNCE_MS)
  timer.unref?.()
}

/** At start-up: settle markers left by a Studio that quit mid-job, but only when a Timeline job ran recently. */
export async function settleEditorClaimsOnStart(): Promise<void> {
  const recent = await prisma.antigravityPageJob.count({ where: { kind: 'editor', updatedAt: { gt: new Date(Date.now() - CLAIM_TTL_MS) } } })
  if (recent > 0) queueEditorClaims()
}
