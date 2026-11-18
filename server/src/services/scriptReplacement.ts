import { parseManualNarration } from './narrationManual.js'
import { requireSeriesRestartReady } from './seriesRestartGuard.js'
import fs from 'fs/promises'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { prisma } from '../index.js'
import { alignmentFileName, audioFolderName, scriptFileName, type NarrationLanguage } from './narrationLanguage.js'
import { createClient, getR2Config, isNotFound, phoneFolders, requestPhoneUpdate, getPhoneScripts } from './r2Service.js'
import { pendingAlignments } from './alignment/alignmentService.js'
import { notifySeriesProcessChanged } from './seriesProcess.js'

const active = new Set<string>()
export const scriptReplacementBusy = (chapterId: string) => active.has(chapterId)
/** Holds chapters as "being replaced" (fetches, voiceovers and other replacements wait) until the returned release. */
export function claimScriptChapters(chapterIds: string[]): () => void {
  const busy = chapterIds.filter(id => active.has(id))
  if (busy.length > 0) throw new ScriptReplacementError('A chapter is already being replaced', 409)
  chapterIds.forEach(id => active.add(id))
  return () => chapterIds.forEach(id => active.delete(id))
}
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
  input: { text: string; expectedSha256: string | null; sendToPhones?: boolean; manualBlockId?: string
    /** A complete reply from the copyable manual prompts, without requiring a blocked-content receipt. */
    manualOutput?: boolean; sourceSha256?: string | null
    /** A script Studio wrote itself (AntiGravity Narration): its own summary, and the series overview for a first chapter. */
    generated?: { summary: string; about?: string | null } }) {
  if (active.has(chapterId)) throw new ScriptReplacementError('This chapter is already being replaced', 409)
  active.add(chapterId)
  try {
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.includes('\0') || Buffer.byteLength(input.text) > 2 * 1024 * 1024) {
      throw new ScriptReplacementError('Choose a nonempty UTF-8 script smaller than 2 MB')
    }
    if (input.manualOutput !== undefined && typeof input.manualOutput !== 'boolean') throw new ScriptReplacementError('Invalid manual-output request')
    if (pendingAlignments(chapterId, 'en') || pendingAlignments(chapterId, 'hi')) throw new ScriptReplacementError('Wait for this chapter’s alignment to finish', 409)
    const { chapter, dir } = await chapterInfo(chapterId)
    const restartRevision = await requireSeriesRestartReady(path.basename(chapter.series.rootFolder))
    const scriptPath = path.join(dir, scriptFileName(language))
    const current = await readText(scriptPath)
    if ((current === null ? null : sha(current)) !== input.expectedSha256) throw new ScriptReplacementError('The local script changed. Reopen Replace to load the latest text.', 409)
    const english = language === 'hi' ? await readText(path.join(dir, 'script.md')) : input.text
    const previousScript = chapter.scripts.find(s => s.language === language)
    const markerPath = path.join(dir, markerName(language))
    const previousMarker = JSON.parse(await readText(markerPath) ?? 'null') as {
      sha256: string; savedAt: string; backupPath: string; manualBlockId?: string; responseSha256?: string; sourceSha256?: string | null
    } | null
    let manual: ReturnType<typeof parseManualNarration> | null = null
    const responseSha256 = sha(input.text)
    if (input.manualBlockId !== undefined) {
      if (typeof input.manualBlockId !== 'string') throw new ScriptReplacementError('Invalid manual-completion request')
      const replay = previousMarker?.manualBlockId === input.manualBlockId && previousMarker.responseSha256 === responseSha256
      const block = replay ? null : (await getPhoneScripts(chapter.seriesId)).blocked?.find(b => b.id === input.manualBlockId && b.chapterId === chapterId && b.language === language)
      if (!replay && !block) throw new ScriptReplacementError('This manual-completion request changed or was resolved. Refresh Narration.', 409)
      const sourceSha = replay ? previousMarker!.sourceSha256 : block?.sourceSha256
      if (language === 'hi' && (!sourceSha || !english || sha(english.trim()) !== sourceSha)) {
        throw new ScriptReplacementError('Fetch the matching English source from the phone before completing this Hinglish script.', 409)
      }
    } else if (input.manualOutput && language === 'hi' && (!english?.trim() || input.sourceSha256 !== sha(english.trim()))) {
      throw new ScriptReplacementError('The English source changed or is missing. Reopen Replace and create fresh Hinglish prompts from the current English script.', 409)
    }
    if (input.manualBlockId !== undefined || input.manualOutput) {
      try { manual = parseManualNarration(input.text, language, language === 'hi' ? english : null) }
      catch (error) { throw new ScriptReplacementError(error instanceof Error ? error.message : 'Invalid narration output') }
      if (language === 'en' && Number(chapter.number) <= 1 && !chapter.series.aboutSummary?.trim() && !manual.about) {
        throw new ScriptReplacementError('Include the ===ABOUT=== section when completing the first English script for this series.')
      }
      input = { ...input, text: manual.script }
    } else if (input.generated) {
      if (!input.generated.summary?.trim()) throw new ScriptReplacementError('A generated script needs its story summary')
      manual = { script: input.text, summary: input.generated.summary.trim(), about: input.generated.about?.trim() || null }
    }
    const unchanged = previousMarker?.sha256 === sha(input.text) && current === input.text &&
      (!manual || previousMarker?.manualBlockId === input.manualBlockId && previousMarker.responseSha256 === responseSha256)
    const savedAt = unchanged ? previousMarker.savedAt : new Date().toISOString()
    const bundle = replacementBundle(path.basename(chapter.series.rootFolder), path.basename(chapter.folderPath), language,
      input.text, english, manual?.summary ?? previousScript?.rollingSummary ?? null, savedAt)
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
      const aboutPath = path.join(path.dirname(dir), 'about.md')
      const paths = [scriptPath, audioDir, alignmentPath, markerPath, ...(manual?.about ? [aboutPath] : [])]
      const exists = await Promise.all(paths.map(file => fs.stat(file).then(() => true).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return false; throw e })))
      for (const [i, file] of paths.entries()) if (exists[i]) await fs.cp(file, path.join(backupPath, path.basename(file)), { recursive: true })
      const updatedAt = new Date(Math.max(Date.now(), (timeline?.updatedAt.getTime() ?? 0) + 1))
      const metadata = JSON.parse(bundle.files[language === 'hi' ? 'continuity.hi.json' : 'continuity.json'])
      try {
        await prisma.$transaction(async tx => {
          await tx.audioFile.deleteMany({ where: { chapterId, language } })
          await tx.audioSection.deleteMany({ where: { chapterId, language } })
          const data = { scriptPath, status: 'edited', mode: 'manual', closingParagraph: metadata.closing, error: null,
            ...(manual ? { rollingSummary: manual.summary } : {}),
            ...(language === 'hi' ? { sourceSha256: metadata.sourceSha256, review: null } : {}) }
          await tx.chapterScript.upsert({ where: { chapterId_language: { chapterId, language } }, create: { chapterId, language, ...data }, update: data })
          await tx.editor2Timeline.upsert({ where: timelineWhere,
            create: { chapterId, language, json: '', processedJson: null, updatedAt }, update: { json: '', processedJson: null, updatedAt } })
          if (manual?.about) {
            await tx.series.update({ where: { id: chapter.seriesId }, data: { aboutSummary: manual.about } })
            await fs.writeFile(aboutPath, manual.about + '\n')
          }
          const temp = path.join(dir, `.${randomUUID()}.script.tmp`)
          try { await fs.writeFile(temp, input.text); await fs.rename(temp, scriptPath) } finally { await fs.rm(temp, { force: true }) }
          await fs.rm(audioDir, { recursive: true, force: true })
          await fs.rm(alignmentPath, { force: true })
          await fs.writeFile(markerPath, JSON.stringify({ sha256: sha(input.text), savedAt, backupPath, ...(manual ? { manualBlockId: input.manualBlockId, responseSha256, sourceSha256: language === 'hi' ? sha(english!.trim()) : null } : {}) }))
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
            Body: JSON.stringify({ ...bundle, ...(restartRevision ? { restartRevision } : {}), files: { ...remote?.files, ...bundle.files } }), ContentType: 'application/json',
            ...(previous?.ETag ? { IfMatch: previous.ETag } : previous ? {} : { IfNoneMatch: '*' }) }))
          if (manual?.about) {
            await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: `${folder}shared/scripts/${bundle.series}/_series.json`,
              Body: JSON.stringify({ schema: 'sleeper-cell-shared-series/1', series: bundle.series, device: 'Manhwa Studio', deviceId: 'manhwa-studio', sharedAt: savedAt,
                ...(restartRevision ? { restartRevision } : {}), about: manual.about }), ContentType: 'application/json' }))
          }
        }
        phoneSent = true
        try { await requestPhoneUpdate('sync'); phoneNotified = true } catch { /* Ready for the next manual sync. */ }
      } catch (error) { phoneError = error instanceof Error ? error.message : String(error) }
    }
    return { chapterId, language, sha256: sha(input.text), unchanged, backupPath, phoneSent, phoneNotified, phoneError }
  } finally { active.delete(chapterId) }
}
