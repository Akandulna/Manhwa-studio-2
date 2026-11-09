/**
 * Run automation's checklist: what a phone run needs of a series before it can
 * do any work, and the one-click fixes for what's missing (Phone Status → Run
 * automation, step 2).
 *
 * - Image Clipper and Narration scripts read the chapters' pages on the phone
 *   (Workspace/Manhwa/<Series>/<Chapter>). Fix: send them (phoneSend.ts), which
 *   ends by asking the phones to sync; Sleeper-Cell's sync downloads every
 *   series in R2, a brand-new one too (ManhwaSync.kt).
 * - Editor 2.0 reads the chapters' packages and the prompt from R2: the run
 *   fetches them itself as it starts (EditorSync at runSeries), so having them
 *   up is enough. Fix: put the ready chapters' packages up, and the prompt.
 * - Voiceover voices the scripts the phone wrote, once split on the phone.
 *   Scripts only reach a phone from its own narration run (or another
 *   phone's), so the fix is to run Narration scripts first.
 *
 * Reads the receipts the server already holds and the library on disk; only
 * Editor 2.0's check LISTs R2, so the client asks for it on demand only.
 */

import type { Server } from 'socket.io'
import { libraryControls } from './libraryControls.js'
import { narrationRunScope, type NarrationPartChoice, type NarrationRunScope } from './narrationRunScope.js'
import { voiceoverChapterScope } from './voiceoverChapterScope.js'
import { prisma } from '../index.js'
import { getSendJob, getSeriesSendPlan, startPhoneSend, type PhoneSendChapter } from './phoneSend.js'
import { getEditorReadiness, publishReadyEditorPackages, saveEditorPrompt } from './phoneEditor.js'
import { getPhoneScripts, requestPhoneUpdate, type PhoneRunKind } from './r2Service.js'
import type { NarrationLanguage } from './narrationLanguage.js'

/**
 * ready:   nothing to do
 * waiting: on its way to the phone; nothing to do but wait (or ask again)
 * missing: a fix here gets it there
 * blocked: needs work elsewhere first (on the desktop, or another run)
 * note:    worth knowing, never stops the run
 */
export type ReadinessState = 'ready' | 'waiting' | 'missing' | 'blocked' | 'note'

/**
 * send_pages:   send the chapters (chapterIds) to the phones
 * ask_download: ask the phones to sync what's in R2 already
 * send_editor:  put the ready chapters' Editor 2.0 packages up (chapterIds)
 * send_prompt:  put the Editor 2.0 prompt up (the client sends it: it lives in the browser)
 * run_narration: start Narration scripts on the series instead (done by the client)
 */
export type ReadinessFixAction = 'send_pages' | 'ask_download' | 'send_editor' | 'send_prompt' | 'run_narration'

export interface ReadinessFix {
  action: ReadinessFixAction
  label: string
  chapterIds?: string[]
}

export interface ReadinessItem {
  id: string
  label: string
  state: ReadinessState
  detail: string
  fix?: ReadinessFix
  /** Where to fix it in the app when no button can (a client route). */
  link?: { to: string; label: string }
}

export interface PhoneRunReadiness {
  seriesId: string
  kind: PhoneRunKind
  language: NarrationLanguage
  /** Nothing missing, waiting or blocked: the run has everything it needs. */
  ready: boolean
  /** The run has something to work on now, even if not everything is there. */
  canWork: boolean
  items: ReadinessItem[]
  /** A send to the phones is going (any series): its progress comes as `phone-send:progress`. */
  sending: boolean
  narrationScope?: NarrationRunScope
  /** The voiceover's parts and the picked part's unfinished chapters (default: all of them). */
  voiceoverScope?: NarrationRunScope
  metadataChapters?: {name:string;number:number}[]
  /** Chapters Metadata can't run on yet, with why: Studio scopes them to the part picked. */
  metadataBlocked?: {id:string;name:string;number:number;reason:string}[]
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** "Ch. 2, 5, 7", or for many "Ch. 1–20" (in a row) / "Ch. 1, 2, 3 … 40". */
function chapterLabel(numbers: number[]): string {
  if (numbers.length <= 6) return `Ch. ${numbers.join(', ')}`
  const inARow = numbers.every((n, i) => i === 0 || n === numbers[i - 1] + 1)
  return inARow ? `Ch. ${numbers[0]}–${numbers[numbers.length - 1]}` : `Ch. ${numbers.slice(0, 3).join(', ')} … ${numbers[numbers.length - 1]}`
}

/** Whether the desktop has already done this run's work on a chapter: then the phone needn't get it for this run. */
function doneHere(kind: PhoneRunKind, chapter: PhoneSendChapter): boolean {
  if (chapter.desktop.published) return true
  if (kind === 'clipper') return chapter.desktop.crops
  if (kind === 'narration') return chapter.desktop.script && chapter.desktop.scriptHi
  return false
}

/** Image Clipper's and Narration scripts': the chapters' pages on the phone. */
async function pagesItems(kind: PhoneRunKind, seriesId: string, part?: NarrationPartChoice): Promise<{ items: ReadinessItem[]; onPhone: number; narrationScope?: NarrationRunScope }> {
  const plan = await getSeriesSendPlan(seriesId)
  if (!plan) throw new Error('Series not found')
  const work = kind === 'clipper' ? 'cropping' : 'a script'
  const scope = kind === 'narration' ? narrationRunScope(plan.chapters.map(c => ({
    name: c.folder, number: c.number, complete: c.state === 'cleared' || doneHere(kind, c)
  })), (await libraryControls()).find(c => c.folder === plan.folder), part) : undefined
  const selected = scope ? new Set(scope.chapters) : null
  const chapters = plan.chapters.filter(c => (!selected || selected.has(c.folder)) && c.state !== 'cleared' && !doneHere(kind, c))
  const onPhone = chapters.filter(c => c.state === 'on_phone')
  const onTheWay = chapters.filter(c => c.state === 'sent' || c.state === 'downloading')
  const toSend = chapters.filter(c => (c.state === 'new' || c.state === 'changed') && !c.needsStitch)
  const tooLong = chapters.filter(c => (c.state === 'new' || c.state === 'changed') && c.needsStitch)
  const items: ReadinessItem[] = scope ? [{
    id: 'chapter-scope', label: 'Chapter range', state: scope.chapters.length ? 'note' : 'blocked',
    detail: scope.part === 'all' ? `All chapters (${scope.chapters.length}).`
      : `Part ${scope.part} · Chapters ${(scope.part - 1) * 20 + 1}–${scope.part * 20} only (${scope.chapters.length} chapters).`
  }] : []

  if (chapters.length === 0) {
    const anyPages = (scope?.chapters.length ?? plan.chapters.length) > 0
    items.push({
      id: 'pages',
      label: 'Chapters on the phone',
      state: anyPages ? 'ready' : 'blocked',
      detail: anyPages
        ? `No chapter needs ${work} on the phone: the rest are done here or cleared there.`
        : scope && scope.part !== 'all' ? `No chapters in Part ${scope.part} are available. Download or send this part first.`
        : 'No chapter of this series has pages here yet. Download its chapters in the Library first.',
      ...(anyPages ? {} : { link: { to: `/series/${seriesId}`, label: 'Open the series' } })
    })
    return { items, onPhone: 0, ...(scope ? { narrationScope: scope } : {}) }
  }

  if (toSend.length) {
    items.push({
      id: 'pages',
      label: 'Chapters on the phone',
      state: 'missing',
      detail: `${plural(toSend.length, 'chapter')} needing ${work} ${toSend.length === 1 ? 'isn’t' : 'aren’t'} on the phone (${chapterLabel(toSend.map(c => c.number))})${onPhone.length ? `; ${onPhone.length} ${onPhone.length === 1 ? 'is' : 'are'}` : ''}.`,
      fix: { action: 'send_pages', label: `Send ${plural(toSend.length, 'chapter')} to the phone`, chapterIds: toSend.map(c => c.chapterId) }
    })
  } else if (!onTheWay.length) {
    items.push({ id: 'pages', label: 'Chapters on the phone', state: 'ready', detail: `All ${plural(onPhone.length, 'chapter')} needing ${work} are on the phone.` })
  }

  if (onTheWay.length) {
    const downloading = onTheWay.filter(c => c.state === 'downloading').length
    items.push({
      id: 'download',
      label: 'Phone download',
      state: 'waiting',
      detail: downloading
        ? `The phone is downloading ${plural(onTheWay.length, 'chapter')}. It reports each one as it lands.`
        : `${plural(onTheWay.length, 'chapter')} ${onTheWay.length === 1 ? 'is' : 'are'} in R2, not on the phone yet. Sleeper-Cell has to be open with R2 set up to download.`,
      fix: { action: 'ask_download', label: 'Ask the phone to download' }
    })
  }

  if (tooLong.length) {
    items.push({
      id: 'stitch',
      label: 'Long chapters',
      state: 'blocked',
      detail: `${plural(tooLong.length, 'chapter')} (${chapterLabel(tooLong.map(c => c.number))}) ${tooLong.length === 1 ? 'has' : 'have'} too many pages to send: stitch ${tooLong.length === 1 ? 'it' : 'them'} first.`,
      link: { to: `/stitch/series/${seriesId}`, label: 'Open Page Stitcher' }
    })
  }
  return { items, onPhone: onPhone.length, ...(scope ? { narrationScope: scope } : {}) }
}

async function editorItems(seriesId: string, language: NarrationLanguage): Promise<{ items: ReadinessItem[]; canWork: boolean }> {
  const editor = await getEditorReadiness(seriesId, language)
  const items: ReadinessItem[] = []
  items.push(editor.prompt
    ? { id: 'prompt', label: 'Editor 2.0 prompt', state: 'ready', detail: editor.staged ? 'Small-batch instructions are included in the chapter packages.' : 'Up for the phones.' }
    : {
        id: 'prompt',
        label: 'Editor 2.0 prompt',
        state: 'missing',
        detail: 'The phone pastes it with every chapter, and it isn’t up yet.',
        fix: { action: 'send_prompt', label: 'Send the prompt' }
      })

  if (editor.toSend.length) {
    items.push({
      id: 'packages',
      label: 'Chapter packages',
      state: 'missing',
      detail: `${plural(editor.toSend.length, 'chapter')} ${editor.toSend.length === 1 ? 'is' : 'are'} ready here, package not up yet (${chapterLabel(editor.toSend.map(c => c.number))})${editor.up.length ? `; ${editor.up.length} up already` : ''}.`,
      fix: { action: 'send_editor', label: `Send ${plural(editor.toSend.length, 'package')}`, chapterIds: editor.toSend.map(c => c.chapterId) }
    })
  } else if (editor.up.length) {
    items.push({ id: 'packages', label: 'Chapter packages', state: 'ready', detail: `${plural(editor.up.length, 'chapter')} waiting for their timeline ${editor.up.length === 1 ? 'is' : 'are'} up. The run fetches them as it starts.` })
  } else if (!editor.notReady.length) {
    items.push({
      id: 'packages',
      label: 'Chapter packages',
      state: editor.made ? 'ready' : 'blocked',
      detail: editor.made ? 'Every chapter has its timeline already.' : 'This series has no chapter left for Editor 2.0.'
    })
  }

  if (editor.notReady.length) {
    // What holds them back most often, so the step to take reads first.
    const counts = new Map<string, number>()
    for (const chapter of editor.notReady) for (const m of chapter.missing) counts.set(m, (counts.get(m) ?? 0) + 1)
    const reasons = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m, n]) => `${m} (${n})`).join(', ')
    const nothingElse = !editor.up.length && !editor.toSend.length
    items.push({
      id: 'not-ready',
      label: 'Not ready on the desktop',
      state: nothingElse ? 'blocked' : 'note',
      detail: `${plural(editor.notReady.length, 'chapter')} (${chapterLabel(editor.notReady.map(c => c.number))}) still need${editor.notReady.length === 1 ? 's' : ''}: ${reasons}.`,
      link: { to: `/editor2/${seriesId}`, label: 'Open Editor 2.0' }
    })
  }
  return { items, canWork: editor.up.length + editor.toSend.length > 0 }
}

async function voiceoverItems(seriesId: string, language: NarrationLanguage, part?: NarrationPartChoice): Promise<{ items: ReadinessItem[]; canWork: boolean; scope: NarrationRunScope }> {
  const scripts = await getPhoneScripts(seriesId)
  const scope = await voiceoverChapterScope(seriesId, part)
  const facts = language === 'hi' ? scripts.hi.chapters : scripts.chapters
  const done = scope.chapters.filter(c => ['done', 'needs_summary', 'review'].includes(facts[c.id]?.status)).length
  const total = scope.chapters.length
  const items: ReadinessItem[] = [{
    id: 'chapter-scope', label: 'Chapter range', state: total ? 'note' : 'blocked',
    detail: total ? `${scope.parts.part === 'all' ? '' : `Part ${scope.parts.part} · `}${chapterLabel(scope.chapters.map(c => c.number))}.${scope.excluded.length ? ` ${scope.parts.part === 'all' ? 'Completed parts are' : 'Completed parts and other parts are'} excluded.` : ''}`
      : scope.parts.part === 'all' ? 'No unfinished chapters remain for voiceover.' : `No unfinished chapters remain for voiceover in Part ${scope.parts.part}.`
  }]
  if (!total) return { items, canWork: false, scope: scope.parts }
  const which = language === 'hi' ? 'Hinglish scripts' : 'Scripts'
  if (done === 0) {
    items.push({
      id: 'scripts',
      label: `${which} on the phone`,
      state: 'blocked',
      detail: 'The phone has no script in this chapter range to voice. Run Narration scripts for these chapters first.',
      fix: { action: 'run_narration', label: 'Run Narration scripts first' }
    })
  } else {
    items.push({
      id: 'scripts',
      label: `${which} on the phone`,
      state: done < total ? 'note' : 'ready',
      detail: done < total ? `${done} of ${total} chapters have one; the rest aren’t voiced.` : `All ${plural(total, 'chapter')} have one.`
    })
  }
  items.push({
    id: 'splits',
    label: 'Splits',
    state: 'note',
    detail: 'The run prepares missing splits for this chapter range, then voices splits without audio.'
  })
  return { items, canWork: done > 0, scope: scope.parts }
}

export async function getRunReadiness(kind: PhoneRunKind, seriesId: string, language: NarrationLanguage, part?: NarrationPartChoice): Promise<PhoneRunReadiness> {
  let items: ReadinessItem[]
  let canWork: boolean
  let narrationScope: NarrationRunScope | undefined
  let voiceoverScope: NarrationRunScope | undefined
  const metadataChapters:{name:string;number:number}[]=[]
  const metadataBlocked:NonNullable<PhoneRunReadiness['metadataBlocked']>=[]
  if (kind === 'clipper' || kind === 'narration') {
    const pages = await pagesItems(kind, seriesId, part)
    items = pages.items
    canWork = pages.onPhone > 0
    narrationScope = pages.narrationScope
  } else if (kind === 'metadata') {
    const chapters = await prisma.chapter.findMany({where:{seriesId},include:{series:{select:{title:true}}},orderBy:{number:'asc'}})
    const {currentMetadataJobs,metadataGenerations,requireCurrentSplitMetadata} = await import('./clipper3/metadataSplit.js')
    items = []
    let eligible = 0
    for (const chapter of chapters) {
      try {
        await currentMetadataJobs(chapter, await metadataGenerations(chapter))
        if(await requireCurrentSplitMetadata(chapter).catch(()=>false))continue
        eligible++
        metadataChapters.push({name:chapter.folderPath.split(/[\\/]/).pop()!,number:chapter.number})
      } catch (error) {
        const reason=error instanceof Error?error.message:String(error)
        metadataBlocked.push({id:chapter.id,name:chapter.folderPath.split(/[\\/]/).pop()!,number:chapter.number,reason})
        items.push({id:`metadata-${chapter.id}`,label:`Chapter ${chapter.number}`,state:'blocked',detail:reason,link:{to:`/clipper3`,label:'Review and cut in Image Clipper'}})
      }
    }
    items.unshift({id:'metadata-ready',label:'Reviewed and cut chapters',state:eligible?'ready':'blocked',detail:`${eligible} chapters eligible. Select one phone and explicit chapters; Metadata uses AI Studio. Synchronize original pages and the English script on that phone first.`})
    canWork = eligible > 0
  } else if (kind === 'editor') {
    ({ items, canWork } = await editorItems(seriesId, language))
  } else {
    ({ items, canWork, scope: voiceoverScope } = await voiceoverItems(seriesId, language, part))
  }
  return {
    seriesId,
    kind,
    language,
    ready: items.every(i => i.state === 'ready' || i.state === 'note'),
    canWork,
    items,
    ...(kind==='metadata'?{metadataChapters,metadataBlocked}:{}),
    ...(narrationScope ? { narrationScope } : {}),
    ...(voiceoverScope ? { voiceoverScope } : {}),
    sending: getSendJob()?.state === 'running'
  }
}

export interface ReadinessFixResult {
  /** What was done, in a line for a toast. */
  message: string
}

/** Runs one fix. Sending pages returns once the send has started; its progress comes as `phone-send:progress`. */
export async function fixRunReadiness(
  fix: { action: ReadinessFixAction; seriesId: string; chapterIds?: string[]; prompt?: string },
  io: Server
): Promise<ReadinessFixResult> {
  switch (fix.action) {
    case 'send_pages': {
      if (!fix.chapterIds?.length) throw new Error('No chapters to send')
      const job = await startPhoneSend([{ seriesId: fix.seriesId, chapterIds: fix.chapterIds }], io)
      return { message: `Sending ${plural(fix.chapterIds.length, 'chapter')} to R2 for ${job.series[0]?.title ?? 'the series'}. The phone is asked to download them once they’re up.` }
    }
    case 'ask_download': {
      const request = await requestPhoneUpdate('sync')
      return {
        message: request.via === 'relay' && request.phones === 0
          ? 'No phone is connected. It downloads when Sleeper-Cell next opens.'
          : 'Asked the phone to download what’s in R2.'
      }
    }
    case 'send_editor': {
      if (!fix.chapterIds?.length) throw new Error('No chapters to send')
      const known = await prisma.chapter.count({ where: { id: { in: fix.chapterIds }, seriesId: fix.seriesId } })
      if (known !== fix.chapterIds.length) throw new Error('Those chapters aren’t in this series')
      const result = await publishReadyEditorPackages(fix.chapterIds)
      if (result.sent.length === 0 && result.failed.length) throw new Error(result.failed[0].error)
      const failed = result.failed.length ? ` ${plural(result.failed.length, 'package')} failed: ${result.failed[0].error}` : ''
      return { message: `${plural(result.sent.length, 'package')} sent, and the phone was asked to fetch ${result.sent.length === 1 ? 'it' : 'them'}.${failed}` }
    }
    case 'send_prompt': {
      if (!fix.prompt?.trim()) throw new Error('No Editor 2.0 prompt is saved in this browser: save it in Settings → Editor 2.0 first.')
      await saveEditorPrompt(fix.prompt, true)
      return { message: 'The Editor 2.0 prompt is up for the phones.' }
    }
    case 'run_narration':
      throw new Error('Narration scripts is started from Run automation')
  }
}
