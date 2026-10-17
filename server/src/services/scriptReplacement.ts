import fs from 'fs/promises'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { prisma } from '../index.js'
import { alignmentFileName, audioFolderName, scriptFileName, type NarrationLanguage } from './narrationLanguage.js'
import { createClient, getR2Config, isNotFound, phoneFolders, requestPhoneUpdate } from './r2Service.js'
import { pendingAlignments } from './alignment/alignmentService.js'
import { notifySeriesProcessChanged } from './seriesProcess.js'

const active = new Set<string>()
export const scriptReplacementBusy = (chapterId: string) => active.has(chapterId)
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const markerName = (language: NarrationLanguage) => `.script-replacement${language === 'hi' ? '.hi' : ''}.json`
const readText = (file: string) => fs.readFile(file, 'utf-8').catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e })

export class ScriptReplacementError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}

async function chapterInfo(chapterId: string) {
  const chapter = await prisma.chapter.findUnique({ where: { id: chapterId }, include: { series: true, scripts: true } })
  if (!chapter) throw new ScriptReplacementError('Chapter not found', 404)
  if (chapter.completedAt || chapter.status !== 'done') throw new ScriptReplacementError('Only downloaded, unarchived chapters can have their script replaced', 409)
  const root = path.resolve(process.env.DOWNLOAD_ROOT || './downloads')
  const dir = path.resolve(root, chapter.folderPath)
  if (!dir.startsWith(root + path.sep)) throw new ScriptReplacementError('Invalid chapter folder')
  return { chapter, dir }
}

export async function getReplacementScript(chapterId: string, language: NarrationLanguage) {
  const { chapter, dir } = await chapterInfo(chapterId)
  const text = await readText(path.join(dir, scriptFileName(language)))
  return { chapterId, number: chapter.number, language, text: text ?? '', sha256: text === null ? null : sha(text), phoneConfigured: !!getR2Config() }
}

export function replacementBundle(series: string, chapter: string, language: NarrationLanguage, text: string,
  english: string | null, summary: string | null, savedAt: string) {
  if (language === 'hi' && !english?.trim()) throw new ScriptReplacementError('The chapter needs its English script before sending a Hinglish replacement')
  const suffix = language === 'hi' ? '.hi' : ''
  const continuity = {
    summary: summary ?? '', closing: text.trim().split(/\r?\n\s*\r?\n/).at(-1)!.trim(), savedAt,
    workspaceReplacement: true,
    ...(language === 'hi' ? { sourceSha256: sha(english!.trim()) } : {})
  }
  const files: Record<string, string> = { ...(language === 'hi' ? { 'script.md': english! } : {}),
    [scriptFileName(language)]: text, [`continuity${suffix}.json`]: JSON.stringify(continuity, null, 2) }
  return {
    schema: 'sleeper-cell-shared-script/1', series, chapter, device: 'Manhwa Studio', deviceId: 'manhwa-studio', sharedAt: savedAt,
    files
  }
}

export async function replaceChapterScript(chapterId: string, language: NarrationLanguage,
  input: { text: string; expectedSha256: string | null; sendToPhones?: boolean }) {
  if (active.has(chapterId)) throw new ScriptReplacementError('This chapter is already being replaced', 409)
  active.add(chapterId)
  try {
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.includes('\0') || Buffer.byteLength(input.text) > 2 * 1024 * 1024) {
      throw new ScriptReplacementError('Choose a nonempty UTF-8 script smaller than 2 MB')
    }
    if (pendingAlignments(chapterId, 'en') || pendingAlignments(chapterId, 'hi')) throw new ScriptReplacementError('Wait for this chapter’s alignment to finish', 409)
    const { chapter, dir } = await chapterInfo(chapterId)
    const scriptPath = path.join(dir, scriptFileName(language))
    const current = await readText(scriptPath)
    if ((current === null ? null : sha(current)) !== input.expectedSha256) throw new ScriptReplacementError('The local script changed. Reopen Replace to load the latest text.', 409)
    const english = language === 'hi' ? await readText(path.join(dir, 'script.md')) : input.text
    const previousScript = chapter.scripts.find(s => s.language === language)
    const markerPath = path.join(dir, markerName(language))
    const previousMarker = JSON.parse(await readText(markerPath) ?? 'null') as { sha256: string; savedAt: string; backupPath: string } | null
    const unchanged = previousMarker?.sha256 === sha(input.text) && current === input.text
    const savedAt = unchanged ? previousMarker.savedAt : new Date().toISOString()
    const bundle = replacementBundle(path.basename(chapter.series.rootFolder), path.basename(chapter.folderPath), language,
      input.text, english, previousScript?.rollingSummary ?? null, savedAt)
    let backupPath = previousMarker?.backupPath ?? ''
    if (!unchanged) {
      backupPath = path.join(dir, '.script-replacements', `${Date.now()}-${randomUUID()}`)
      await fs.mkdir(backupPath, { recursive: true })
      const audioDir = path.join(dir, audioFolderName(language))
      const alignmentPath = path.join(dir, alignmentFileName(language))
      const timelineWhere = { chapterId_language: { chapterId, language } }
      const [sections, audioFiles, timeline] = await Promise.all([
        prisma.audioSection.findMany({ where: { chapterId, language } }),
        prisma.audioFile.findMany({ where: { chapterId, language } }),
        prisma.editor2Timeline.findUnique({ where: timelineWhere })
      ])
      await fs.writeFile(path.join(backupPath, 'state.json'), JSON.stringify({ script: previousScript, sections, audioFiles, timeline }, null, 2))
      const paths = [scriptPath, audioDir, alignmentPath, markerPath]
      const exists = await Promise.all(paths.map(file => fs.stat(file).then(() => true).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return false; throw e })))
      for (const [i, file] of paths.entries()) if (exists[i]) await fs.cp(file, path.join(backupPath, path.basename(file)), { recursive: true })
      const updatedAt = new Date(Math.max(Date.now(), (timeline?.updatedAt.getTime() ?? 0) + 1))
      const metadata = JSON.parse(bundle.files[language === 'hi' ? 'continuity.hi.json' : 'continuity.json'])
      try {
        await prisma.$transaction(async tx => {
          await tx.audioFile.deleteMany({ where: { chapterId, language } })
          await tx.audioSection.deleteMany({ where: { chapterId, language } })
          const data = { scriptPath, status: 'edited', mode: 'manual', closingParagraph: metadata.closing, error: null,
            ...(language === 'hi' ? { sourceSha256: metadata.sourceSha256, review: null } : {}) }
          await tx.chapterScript.upsert({ where: { chapterId_language: { chapterId, language } }, create: { chapterId, language, ...data }, update: data })
          await tx.editor2Timeline.upsert({ where: timelineWhere,
            create: { chapterId, language, json: '', processedJson: null, updatedAt }, update: { json: '', processedJson: null, updatedAt } })
          const temp = path.join(dir, `.${randomUUID()}.script.tmp`)
          try { await fs.writeFile(temp, input.text); await fs.rename(temp, scriptPath) } finally { await fs.rm(temp, { force: true }) }
          await fs.rm(audioDir, { recursive: true, force: true })
          await fs.rm(alignmentPath, { force: true })
          await fs.writeFile(markerPath, JSON.stringify({ sha256: sha(input.text), savedAt, backupPath }))
        }, { timeout: 30_000 })
      } catch (error) {
        for (const [i, file] of paths.entries()) {
          await fs.rm(file, { recursive: true, force: true })
          if (exists[i]) await fs.cp(path.join(backupPath, path.basename(file)), file, { recursive: true })
        }
        throw error
      }
      notifySeriesProcessChanged(true)
    }
    let phoneSent = false
    let phoneNotified = false
    let phoneError: string | undefined
    if (input.sendToPhones !== false) {
      try {
        const config = getR2Config()
        if (!config) throw new Error('Set up Settings → Cloudflare, then use Replace again to send the saved script.')
        const client = createClient(config)
        for (const folder of await phoneFolders(client, config)) {
          const key = `${folder}shared/scripts/${bundle.series}/${bundle.chapter}.script.json`
          const previous = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
            .catch(error => { if (isNotFound(error)) return null; throw error })
          const remote = previous ? JSON.parse(await previous.Body!.transformToString('utf-8')) : null
          if (remote && (remote.schema !== bundle.schema || remote.series !== bundle.series || remote.chapter !== bundle.chapter)) {
            throw new Error('The phone’s shared script does not match this chapter. Refresh from the phone before retrying.')
          }
          if (language === 'hi' && typeof remote?.files?.['script.md'] === 'string' && remote.files['script.md'].trim() !== english!.trim()) {
            throw new Error('The phone has a different English source. Fetch its English script before sending this Hinglish replacement.')
          }
          await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: key,
            Body: JSON.stringify({ ...bundle, files: { ...remote?.files, ...bundle.files } }), ContentType: 'application/json',
            ...(previous?.ETag ? { IfMatch: previous.ETag } : previous ? {} : { IfNoneMatch: '*' }) }))
        }
        phoneSent = true
        try { await requestPhoneUpdate('sync'); phoneNotified = true } catch { /* Ready for the next manual sync. */ }
      } catch (error) { phoneError = error instanceof Error ? error.message : String(error) }
    }
    return { chapterId, language, sha256: sha(input.text), unchanged, backupPath, phoneSent, phoneNotified, phoneError }
  } finally { active.delete(chapterId) }
}
