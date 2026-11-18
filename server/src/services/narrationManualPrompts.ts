import fs from 'fs/promises'
import path from 'path'
import { createHash } from 'crypto'
import { prisma } from '../index.js'
import type { NarrationLanguage } from './narrationLanguage.js'
import { PACING_RULES, QUALITY_RULES, SCRIPT_STYLE, lengthCutRule } from './narrationRules.js'
import { HINGLISH_LANGUAGE, HINGLISH_PACING_RULES, HINGLISH_QUALITY_RULES, englishParagraphs } from './hinglishRules.js'
import { MANUAL_SLICE_MAX_SIDE, manualSlicesDir, readManualSlices, sliceManualPages, type ManualPiece } from './narrationManualSlices.js'

/**
 * Step-by-step prompts for creating a replacement script or finishing a chapter after "Prohibited content".
 *
 * They follow the phone's own layered run (Sleeper-cell-main: narration/NarrationSequence.kt, NarrationPrompt.kt,
 * HinglishConvert.kt, NarrationQuality.kt, NarrationPacing.kt and the fixed "Script"/"Hinglish" prompts in
 * data/BrowserDatabase.kt), adapted for copy-paste: intermediate replies stay in the chat, and the last step
 * always asks for the ===SCRIPT=== / ===SUMMARY=== format that parseManualNarration accepts. Keep the rule text
 * in sync with the phone when its prompts change.
 */




const ORDER_RULES = `The current chapter's images are the authority for events and their order.
Follow original page order, then panel reading order within each image.
Preserve flashbacks and scene changes where they appear in the source; do not sort events into historical chronology.
Start with the first story event in this chapter and end with its last event. Do not start from a later page as a hook.
Previous-chapter summaries, the previous closing and the series overview are background only. Never invent a bridge, replay earlier events, skip this chapter's opening or force a seamless transition when the artwork changes scene.
Keep all story events in order. Do not invent actions, dialogue, objects, character identities or explanations unsupported by the images.
If a name is unknown, use a consistent visual description. Report unreadable or unresolved story evidence instead of guessing.
These source-order and accuracy requirements take priority over stylistic requests.`







/** Images per message, as on the phone (autorun/NarrationImageBatches.kt); 10 is the Gemini app's per-prompt upload limit. */
export const MANUAL_BATCH_SIZE = 10

export interface ManualPromptStep {
  title: string
  /** What to do around the prompt: attach files, where the reply goes. */
  note: string
  prompt: string
  /** File names to attach with this prompt, in order. */
  attach?: string[]
  /** This step's reply is what gets pasted into the dialog. */
  final?: boolean
  /** Copying this step first cuts the pages into pieces; the real batch steps replace it. */
  slice?: boolean
}

export interface ManualPromptInput {
  language: NarrationLanguage
  seriesTitle: string
  chapterNumber: string
  pages: string[]
  /** English: the pages cut into ≤2,000 px pieces, or null until they are cut (on the first copy). */
  pieces?: ManualPiece[] | null
  requireAbout: boolean
  about: string | null
  previous: { summary: string; closing: string } | null
  englishScript: string | null
  englishSummary: string | null
}

/** Same word counting as parseManualNarration's Hinglish length check. */
export const countWords = (text: string) => text.split(/\s+/u).filter(w => /[\p{L}\p{N}]/u.test(w)).length
export { englishParagraphs } from './hinglishRules.js'

const outputFormat = (requireAbout: boolean) => `===SCRIPT===
[The complete narration: one paragraph per line, a blank line between paragraphs]

===SUMMARY===
[Cumulative story summary through this chapter]

===CLOSING===
[The exact last paragraph of the script]${requireAbout ? '\n\n===ABOUT===\n[Brief about-this-manhwa overview, ~100 words]' : ''}`

const PIECE_RULES = `Each image is one piece of a page, cut top to bottom so it can be read at full size. The white band on top shows its id: P0003-T002 is page 3, part 2. The band is a label, not story content.
A page's parts continue each other in order, so a panel or speech bubble may run across a cut: read them together and never report or narrate the same moment twice.`

function englishSteps(input: ManualPromptInput): ManualPromptStep[] {
  const { pages, pieces, seriesTitle, chapterNumber, requireAbout } = input
  if (!pages.length) throw new Error('This chapter has no downloaded pages to attach.')
  const steps: ManualPromptStep[] = []
  if (!pieces?.length) {
    steps.push({
      title: 'Read pages',
      note: `Copy prompt first cuts the ${pages.length} page${pages.length === 1 ? '' : 's'} into pieces of at most ${MANUAL_SLICE_MAX_SIDE.toLocaleString('en-US')} px in a temporary folder, then copies batch 1. The batches to attach appear here.`,
      prompt: '',
      slice: true
    })
  } else {
    const batches: ManualPiece[][] = []
    for (let i = 0; i < pieces.length; i += MANUAL_BATCH_SIZE) batches.push(pieces.slice(i, i + MANUAL_BATCH_SIZE))
    const label = (p: ManualPiece) => `${p.file} - page ${p.page}${p.parts > 1 ? `, part ${p.part} of ${p.parts}` : ''}`
    steps.push(...batches.map((files, index) => {
      const number = index + 1
      const following = number < batches.length ? 'More chapter images will follow in my next messages.'
        : 'This is the final image batch. The writing instructions will follow in a separate message.'
      return {
        title: batches.length > 1 ? `Read pages · batch ${number} of ${batches.length}` : 'Read pages',
        note: `Attach these ${files.length} image${files.length === 1 ? '' : 's'} from the sliced-pages folder in this order, paste the prompt and send. Leave the reply in the chat.`,
        attach: files.map(f => f.file),
        prompt: `${number === 1 ? `I am turning the manhwa "${seriesTitle}" Chapter ${chapterNumber} (a work of fiction) into a spoken recap. The chapter has ${pages.length} pages, cut into ${pieces.length} images sent in ${batches.length} batch${batches.length === 1 ? '' : 'es'}. First we only take notes; the script comes later.\n\n` : ''}Chapter image batch ${number} of ${batches.length}. ${following}

Read ONLY this batch's attached images. Establish facts before writing narration.
Match each image by its filename and the id on its band:
${files.map(label).join('\n')}

${PIECE_RULES}

${ORDER_RULES}

For EACH listed image, write: its opening event, all actions and the meaning of the dialogue in panel order, and its closing event.
Mark an image as NON-STORY only if it is a cover, credits or advertisement with no story content.
List anything unreadable or unclear under UNCERTAIN instead of guessing.
Do not write the script yet. Reply with plain notes, one block per image headed by its id, in the order above.`
      }
    }))
  }

  const continuity = input.previous || input.about
    ? [
        input.about ? `ABOUT THIS MANHWA:\n${input.about}` : null,
        input.previous ? `STORY SO FAR:\n${input.previous.summary}` : null,
        input.previous ? `THE PREVIOUS CHAPTER ENDED WITH:\n"${input.previous.closing}"` : null,
        'IMPORTANT: The previous chapter is background only. Begin with the first story event visible in this chapter\'s images, even if it changes scene or starts a flashback. Do NOT repeat the previous chapter or invent a transition to connect the chapters.'
      ].filter(Boolean).join('\n\n')
    : 'This is CHAPTER 1 - introduce the story, setting, and main characters naturally as they appear.'

  steps.push({
    title: 'Write the draft',
    note: 'Paste and send. Leave the draft in the chat; the next steps review it.',
    prompt: `All ${pages.length} chapter pages${pieces?.length ? ` (${pieces.length} images)` : ''} are now in this chat. Check your notes for every batch against ALL uploaded images, including the first batch, before drafting.

${SCRIPT_STYLE}

---

You are analyzing manhwa chapter images to create a narration script. Read the panels carefully, including:
- Visual action and movement
- Character expressions and body language
- Speech bubbles and dialogue
- Sound effects
- Scene transitions

Create a concise narrative that preserves the chapter's story meaning, combining routine actions and repeated reactions into concise story beats.

${ORDER_RULES}

${QUALITY_RULES}

${PACING_RULES}

Narrate "${seriesTitle}" Chapter ${chapterNumber} from the attached images and your notes.

${continuity}

After the script, provide:
1. A cumulative summary of the story through this chapter (${input.previous ? 'incorporating the previous summary + this chapter\'s events, ' : ''}~200 words total)
2. The exact closing paragraph that ends this chapter's narration${requireAbout ? '\n3. A brief "about this manhwa" overview (~100 words)' : ''}

Format your response EXACTLY like this:
${outputFormat(requireAbout)}`
  })

  steps.push({
    title: 'Review against the images',
    note: 'Paste and send. The model corrects its own draft; leave the reply in the chat.',
    prompt: `REVIEW BEFORE SAVING. Re-read the actual uploaded images from ALL batches in this chat, then compare them with your draft and notes.
Do not rely on the draft or notes alone: correct the narration where the artwork contradicts them.

${ORDER_RULES}

Check the first and last events, who acts on whom, dialogue meaning, scene changes, missing story meaning, unsupported additions, repeated scenes and backward jumps. Concise combined actions and condensed repetitive dialogue are valid when their story meaning is intact; do not expand them back into a panel-by-panel account.
Account for every story page in order; do not silently drop artwork.

${QUALITY_RULES}

${PACING_RULES}

${lengthCutRule()}

First list each correction you made under CORRECTIONS (or "none"). Then return the COMPLETE corrected narration, with the summary and closing updated to match, in exactly this format:
${outputFormat(requireAbout)}`
  })

  steps.push({
    title: 'Final spoken-narration check',
    note: 'Paste and send. Copy this reply — from ===SCRIPT=== to the end — into the box below.',
    final: true,
    prompt: `FINAL SPOKEN-NARRATION CHECK. Inspect EVERY paragraph of your reviewed script, including its opening and closing, specifically for publication material and page-presentation commentary.

${QUALITY_RULES}

${PACING_RULES}

Correct all offending wording. Preserve story meaning, dialogue meanings, names, sequence and paragraph order. Retain concise phrasing and combined routine actions; do not restore redundant description, add events or rewrite clean paragraphs for style. This check must not re-expand the reviewed script.
Remove only non-story clauses; express caption meanings directly. Recheck every corrected paragraph before answering.
The closing must exactly equal the final script paragraph. Write no notes, headings, source labels or page numbers inside the script.

Return ONLY the complete final output, nothing before or after it, in exactly this format:
${outputFormat(requireAbout)}`
  })
  return steps
}

function hinglishSteps(input: ManualPromptInput): ManualPromptStep[] {
  const english = input.englishScript?.trim()
  if (!english) throw new Error('This chapter needs its English script before the Hinglish can be written. Fetch it from the phone first.')
  const paragraphs = englishParagraphs(english)
  const n = paragraphs.length
  const words = countWords(english)
  const ceiling = Math.max(Math.ceil(words * 1.3), words + 24)
  const floor = Math.ceil(words * 0.85)
  const summary = input.englishSummary?.trim() || null
  const scriptFormat = `===SCRIPT===
[SCENE 1: P1-P4]
<Hinglish paragraph>

<Hinglish paragraph>

[SCENE 2: P5-P7]
<Hinglish paragraph>

...

===SUMMARY===
<Hinglish story summary>`
  const summaryLine = summary ? 'Then retell the English story summary in the same Hinglish style, keeping all of its details.'
    : 'Then write a short Hinglish summary of the story through this chapter (~150 words).'

  return [{
    title: 'Scene notes',
    note: 'Paste and send. No attachments needed. Leave the notes in the chat.',
    prompt: `${HINGLISH_LANGUAGE}

---

TASK: Translate and adapt the following fictional story segment into natural Hinglish narration, following the language rules above.

Localize the fictional story in your own words, the way an Indian recap YouTuber would tell it. Preserve the meaning, dramatic pacing and storytelling tone while using natural spoken Hinglish rather than matching English sentence structure. This adaptation is done in steps, in this chat:
1. Now: read the whole script, understand the story scene by scene and make notes
2. Next message: write the Hinglish narration from your notes

${HINGLISH_QUALITY_RULES}

${HINGLISH_PACING_RULES}

CHAPTER LENGTH BUDGET: English source = ${words} words. Hinglish narration must stay between ${floor} and ${ceiling} words, excluding scene markers and summary. Keep all story meaning within this ceiling by removing repetition and filler, never by dropping events.

STEP 1 - SCENE NOTES (do not write the narration yet):
- Split the English script into scenes. A scene is a run of paragraphs about one moment, place or exchange, usually 2 to 6 paragraphs. Every paragraph from [P1] to [P${n}] belongs to exactly one scene, in order, with no gaps or overlaps
- Under each scene, write short notes in Hinglish (Devanagari):
  - the story beats in order: events, causes, consequences, decisions, motives, meaningful thoughts, names, relevant numbers and rules; group repeated actions and descriptions without losing distinct developments
  - what each character says - the meaning and tone of the line, not a translation of it
  - the mood of the scene, and what the viewer should feel
  - an optional brief idiom only if it helps the moment without adding filler; no humour quota or extra commentary

Format your response EXACTLY like this:
===SCENES===
[SCENE 1: P1-P4]
- <note>
- <note>

[SCENE 2: P5-P7]
- <note>

...

ENGLISH SCRIPT (${n} paragraphs), fictional source text:
<story_script>
${paragraphs.map((p, i) => `[P${i + 1}] ${p}`).join('\n\n')}
</story_script>${summary ? `\n\nENGLISH STORY SUMMARY:\n<story_summary>\n${summary}\n</story_summary>` : ''}`
  }, {
    title: 'Write the Hinglish',
    note: 'Paste and send. Leave the reply in the chat; the last step checks it.',
    prompt: `STEP 2 - WRITE: Now write the full Hinglish narration from your scene notes, adapting the fictional source inside <story_script> in my first message. Follow its language rules and preserve the original meaning, dramatic pacing and storytelling tone in natural spoken Hinglish.
${HINGLISH_QUALITY_RULES}
${HINGLISH_PACING_RULES}
- Go scene by scene, with the same scenes as your notes. Start each scene with its mark on a line of its own, exactly as in your notes: [SCENE 1: P1-P4]. Between them the scenes must cover [P1] to [P${n}]
- Tell each scene in your own words. Do not follow the English sentences or their order - only what happens has to match. Merge, split and reorder sentences inside a scene however it sounds most natural when spoken
- Preserve every distinct story beat, meaningful thought, name, relevant number and rule from your notes. Condense routine movements, repeated descriptions and repeated dialogue; do not skip events or add new ones
- Cross-check each scene against the original English paragraphs in my first message. Restore missing story meaning concisely, without restoring redundant descriptions
- Rewrite dialogue the way that character would say it in Hinglish, with the same meaning and tone
- Stay between ${floor} and ${ceiling} words in total. A scene may be shorter than its English source when its meaning is intact
- Keep paragraphs short for easy voice-over reading: one paragraph per line, a blank line between paragraphs
- ${summaryLine}

Format your response EXACTLY like this:
${scriptFormat}`
  }, {
    title: 'Final Hinglish check',
    note: 'Paste and send. Copy this reply — from ===SCRIPT=== to the end — into the box below.',
    final: true,
    prompt: `FINAL HINGLISH SPOKEN-NARRATION CHECK. Review your Hinglish narration of this fictional story. Inspect EVERY paragraph, including the opening and closing.
${HINGLISH_QUALITY_RULES}
${HINGLISH_PACING_RULES}
Cross-check against the numbered English story in my first message. Preserve story meaning, names, dialogue meanings, order and emotional emphasis. Correct only offending narration; do not add events or rewrite clean paragraphs for style. Keep the total between ${floor} and ${ceiling} words.
Keep every scene marker and its paragraph range exactly as you wrote them; together they must cover [P1] to [P${n}] once, in order, and every scene must contain narration.
Every word of the narration and the summary must be in Devanagari - no Roman/Latin letters anywhere except the ===SCRIPT===, ===SUMMARY=== and [SCENE n: Px-Py] markers.

Return ONLY the complete corrected final output, nothing before or after it, in exactly this format:
${scriptFormat}`
  }]
}

export function buildManualPrompts(input: ManualPromptInput): ManualPromptStep[] {
  return input.language === 'hi' ? hinglishSteps(input) : englishSteps(input)
}

/** Sent in the same chat when the dialog rejects a pasted reply. */
export function manualCorrectionPrompt(error: string, language: NarrationLanguage): string {
  return `Your final output could not be saved: ${error}

Fix only that problem${language === 'hi' ? ', keeping every [SCENE n: Px-Py] marker and Devanagari-only prose' : ''}. Do not shorten, summarize or otherwise change the rest of the narration.
Return ONLY the complete corrected final output in the same ===SCRIPT=== / ===SUMMARY===${language === 'hi' ? '' : ' / ===CLOSING==='} format as before, nothing before or after it.`
}

const IMAGE = /\.(?:jpe?g|png|webp|gif|avif)$/i

/**
 * Reads the chapter's pages, continuity and (for Hinglish) English source to build its prompts. English pages already
 * cut for this chapter are listed by piece; with [slice], uncut pages are cut first (the first prompt copy).
 */
export async function chapterManualPrompts(chapterId: string, language: NarrationLanguage, { slice = false } = {}) {
  const chapter = await prisma.chapter.findUnique({
    where: { id: chapterId },
    include: { series: true, scripts: true, pages: { where: { status: 'done' }, orderBy: { index: 'asc' }, select: { localPath: true } } }
  })
  if (!chapter) throw Object.assign(new Error('Chapter not found'), { status: 404 })
  const root = path.resolve(process.env.DOWNLOAD_ROOT || './downloads')
  const dir = path.resolve(root, chapter.folderPath)
  if (!dir.startsWith(root + path.sep)) throw new Error('Invalid chapter folder')
  const readText = (file: string) => fs.readFile(file, 'utf-8').catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e })

  let pages = chapter.pages.map(p => p.localPath && path.basename(p.localPath)).filter((p): p is string => !!p && IMAGE.test(p))
  if (!pages.length) {
    const files = await fs.readdir(dir).catch(() => [] as string[])
    pages = files.filter(f => IMAGE.test(f) && !f.startsWith('.')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  }

  let pieces: ManualPiece[] | null = null
  if (language === 'en' && pages.length) {
    pieces = await readManualSlices(chapterId, pages)
    if (!pieces && slice) pieces = await sliceManualPages(chapterId, pages.map(source => ({ file: path.join(dir, source), source })))
  }

  const previousChapter = await prisma.chapter.findFirst({
    where: { seriesId: chapter.seriesId, number: { lt: chapter.number } },
    orderBy: { number: 'desc' }, include: { scripts: { where: { language: 'en' } } }
  })
  const previousScript = previousChapter?.scripts[0]
  const previous = previousScript?.rollingSummary?.trim() && previousScript.closingParagraph?.trim()
    ? { summary: previousScript.rollingSummary.trim(), closing: previousScript.closingParagraph.trim() } : null
  const about = chapter.series.aboutSummary?.trim() || null
  const englishScript = language === 'hi' ? await readText(path.join(dir, 'script.md')) : null

  const steps = buildManualPrompts({
    language,
    seriesTitle: chapter.series.title,
    chapterNumber: String(chapter.number),
    pages,
    pieces,
    requireAbout: language === 'en' && chapter.number <= 1 && !about,
    about,
    previous,
    englishScript,
    englishSummary: chapter.scripts.find(s => s.language === 'en')?.rollingSummary ?? null
  })
  return { folderPath: chapter.folderPath, slicesFolder: pieces ? manualSlicesDir(chapterId) : null, steps, sourceSha256: englishScript ? createHash('sha256').update(englishScript.trim()).digest('hex') : null }
}
