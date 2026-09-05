/**
 * Default prompts for Narration Studio
 * 
 * These are the default prompts shipped with the app.
 * Users can customize the base style prompt in Settings.
 */

// Default base style prompt (editable in Settings)
export const DEFAULT_BASE_STYLE_PROMPT = `You are writing a manhwa recap narration script for audiobook-style delivery.

STYLE RULES:
- Third-person narration with clear, straightforward prose
- Calm, measured tone - avoid dramatic exclamations or over-the-top language
- No prologue or epilogue - start directly with the story action
- No ending/epilogue lines (unless this is explicitly marked as a Part end)
- Keep dialogue natural but not exaggerated
- Use present tense for action, past tense for backstory
- Keep paragraphs short for easy voice-over reading
- Do NOT include stage directions like [excited], [whisper], *sighs*, etc.
- Avoid excessive punctuation (!!!, ???, ...) - use periods and commas
- Write for a neutral reading pace - no dramatic pauses needed`

// System prompt for script generation
export function getScriptSystemPrompt(baseStylePrompt: string): string {
  return `${baseStylePrompt}

You are analyzing manhwa chapter images to create a narration script. Read the panels carefully, including:
- Visual action and movement
- Character expressions and body language  
- Speech bubbles and dialogue
- Sound effects
- Scene transitions

Create a flowing narrative that captures everything happening in the chapter.`
}

// User prompt for Chapter 1 script generation
export function getChapter1ScriptPrompt(seriesTitle: string): string {
  return `Analyze these manhwa chapter images from "${seriesTitle}" and create a narration script.

This is CHAPTER 1 - introduce the story, setting, and main characters naturally as they appear.

After the script, provide:
1. A cumulative summary of the story so far (aim for ~200 words)
2. The exact closing paragraph that ends this chapter's narration
3. A brief "about this manhwa" overview (~100 words)

Format your response EXACTLY like this:
===SCRIPT===
[Your narration script here]

===SUMMARY===
[Cumulative story summary through this chapter]

===CLOSING===
[The exact last paragraph of the script]

===ABOUT===
[Brief about-this-manhwa overview]`
}

// User prompt for Chapter N (N >= 2) script generation
export function getChapterNScriptPrompt(
  seriesTitle: string,
  chapterNumber: number,
  aboutSummary: string,
  previousSummary: string,
  previousClosingParagraph: string
): string {
  return `Analyze these manhwa chapter images from "${seriesTitle}" Chapter ${chapterNumber} and create a narration script.

ABOUT THIS MANHWA:
${aboutSummary}

STORY SO FAR:
${previousSummary}

THE PREVIOUS CHAPTER ENDED WITH:
"${previousClosingParagraph}"

IMPORTANT: Continue the narration seamlessly from where the previous chapter ended. Do NOT repeat or summarize what came before - pick up the story flow naturally.

After the script, provide:
1. A cumulative summary of the story through this chapter (incorporating the previous summary + this chapter's events, ~200 words total)
2. The exact closing paragraph that ends this chapter's narration

Format your response EXACTLY like this:
===SCRIPT===
[Your narration script here]

===CLOSING===
[The exact last paragraph of the script]

===SUMMARY===
[Cumulative story summary through this chapter]`
}

// System prompt for summary generation (text-only call after editing)
export function getSummarySystemPrompt(): string {
  return `You are summarizing a manhwa narration script. Your task is to:
1. Create a cumulative summary that incorporates the previous summary (if any) with the new chapter's events
2. Extract the exact closing paragraph from the script

Keep summaries concise (~200 words) but comprehensive enough to maintain story continuity.`
}

// User prompt for summary generation (Chapter 1)
export function getChapter1SummaryPrompt(scriptText: string): string {
  return `Here is the narration script for Chapter 1:

===SCRIPT===
${scriptText}
===END SCRIPT===

Provide:
1. A cumulative summary of the story so far (~200 words)
2. The exact closing paragraph from the script
3. A brief "about this manhwa" overview (~100 words)

Format your response EXACTLY like this:
===SUMMARY===
[Cumulative story summary]

===CLOSING===
[The exact last paragraph of the script]

===ABOUT===
[Brief about-this-manhwa overview]`
}

// User prompt for summary generation (Chapter N)
export function getChapterNSummaryPrompt(
  scriptText: string,
  previousSummary: string
): string {
  return `Here is the narration script for this chapter:

===SCRIPT===
${scriptText}
===END SCRIPT===

PREVIOUS CUMULATIVE SUMMARY:
${previousSummary}

Provide:
1. An updated cumulative summary that incorporates the previous summary with this chapter's events (~200 words total)
2. The exact closing paragraph from the script

Format your response EXACTLY like this:
===SUMMARY===
[Updated cumulative story summary]

===CLOSING===
[The exact last paragraph of the script]`
}

// System prompt for beat extraction (map-reduce batching)
export function getBeatExtractionSystemPrompt(): string {
  return `You are extracting narrative beats from manhwa chapter images. For each panel/scene:
- Describe what's happening (action, dialogue, emotion)
- Note any important visual details
- Keep each beat concise but complete

Output beats in reading order, numbered.`
}

// User prompt for beat extraction
export function getBeatExtractionPrompt(batchIndex: number, totalBatches: number): string {
  return `Extract the narrative beats from these manhwa images.
This is batch ${batchIndex + 1} of ${totalBatches}.

Format each beat as:
[Beat X] Description of what happens, including any dialogue.

Keep beats in reading order. Be thorough but concise.`
}

// System prompt for combining beats into script
export function getBeatsToScriptSystemPrompt(baseStylePrompt: string): string {
  return `${baseStylePrompt}

You are creating a narration script from extracted beats. Transform the beats into flowing prose that captures the story.`
}

// User prompt for combining beats (Chapter 1)
export function getBeatsToScriptChapter1Prompt(beats: string[], seriesTitle: string): string {
  return `Create a narration script for "${seriesTitle}" Chapter 1 from these beats:

${beats.map((b, i) => `=== BATCH ${i + 1} ===\n${b}`).join('\n\n')}

This is CHAPTER 1 - introduce the story naturally.

After the script, provide:
1. A cumulative summary (~200 words)
2. The exact closing paragraph
3. A brief "about this manhwa" overview (~100 words)

Format your response EXACTLY like this:
===SCRIPT===
[Your narration script here]

===SUMMARY===
[Cumulative story summary]

===CLOSING===
[The exact last paragraph of the script]

===ABOUT===
[Brief about-this-manhwa overview]`
}

// User prompt for combining beats (Chapter N)
export function getBeatsToScriptChapterNPrompt(
  beats: string[],
  seriesTitle: string,
  chapterNumber: number,
  aboutSummary: string,
  previousSummary: string,
  previousClosingParagraph: string
): string {
  return `Create a narration script for "${seriesTitle}" Chapter ${chapterNumber} from these beats:

${beats.map((b, i) => `=== BATCH ${i + 1} ===\n${b}`).join('\n\n')}

ABOUT THIS MANHWA:
${aboutSummary}

STORY SO FAR:
${previousSummary}

THE PREVIOUS CHAPTER ENDED WITH:
"${previousClosingParagraph}"

Continue seamlessly from where the previous chapter ended.

After the script, provide:
1. A cumulative summary through this chapter (~200 words)
2. The exact closing paragraph

Format your response EXACTLY like this:
===SCRIPT===
[Your narration script here]

===CLOSING===
[The exact last paragraph of the script]

===SUMMARY===
[Cumulative story summary through this chapter]`
}

// System prompt for outro generation
export function getOutroSystemPrompt(): string {
  return `You are writing an outro/epilogue for a manhwa recap video. This closes out a multi-chapter "Part" and should:
- Provide satisfying closure
- Tease what's to come
- Thank viewers
- Keep the warm, energetic tone`
}

// User prompt for outro generation
export function getOutroPrompt(
  seriesTitle: string,
  partNumber: number,
  aboutSummary: string,
  rollingSummary: string
): string {
  return `Write an outro/epilogue for "${seriesTitle}" Part ${partNumber}.

ABOUT THIS MANHWA:
${aboutSummary}

WHAT HAPPENED IN THIS PART:
${rollingSummary}

Create a satisfying outro that:
- Wraps up this part's events
- Teases what's to come
- Thanks viewers for watching
- Encourages likes/comments/subscriptions

Keep it around 100-150 words.

===OUTRO===
[Your outro text here]`
}

// Delimiter patterns for parsing responses
export const DELIMITERS = {
  SCRIPT: '===SCRIPT===',
  SUMMARY: '===SUMMARY===',
  CLOSING: '===CLOSING===',
  ABOUT: '===ABOUT===',
  OUTRO: '===OUTRO==='
} as const

/**
 * Parse delimited response from AI
 */
export function parseDelimitedResponse(text: string): {
  script?: string
  summary?: string
  closing?: string
  about?: string
  outro?: string
} {
  const result: Record<string, string> = {}
  
  const sections = [
    { key: 'script', delimiter: DELIMITERS.SCRIPT },
    { key: 'summary', delimiter: DELIMITERS.SUMMARY },
    { key: 'closing', delimiter: DELIMITERS.CLOSING },
    { key: 'about', delimiter: DELIMITERS.ABOUT },
    { key: 'outro', delimiter: DELIMITERS.OUTRO }
  ]
  
  for (const { key, delimiter } of sections) {
    const startIdx = text.indexOf(delimiter)
    if (startIdx === -1) continue
    
    const contentStart = startIdx + delimiter.length
    
    // Find the next delimiter
    let endIdx = text.length
    for (const { delimiter: nextDelim } of sections) {
      if (nextDelim === delimiter) continue
      const nextIdx = text.indexOf(nextDelim, contentStart)
      if (nextIdx !== -1 && nextIdx < endIdx) {
        endIdx = nextIdx
      }
    }
    
    result[key] = text.slice(contentStart, endIdx).trim()
  }
  
  return result
}

/**
 * Build the manual mode prompt for the user to copy
 */
export function buildManualModePrompt(
  baseStylePrompt: string,
  seriesTitle: string,
  chapterNumber: number,
  aboutSummary?: string,
  previousSummary?: string,
  previousClosingParagraph?: string
): string {
  const isChapter1 = chapterNumber === 1
  
  let prompt = `${baseStylePrompt}

---

Analyze the attached manhwa chapter images from "${seriesTitle}" Chapter ${chapterNumber} and create a narration script.

`

  if (isChapter1) {
    prompt += `This is CHAPTER 1 - introduce the story, setting, and main characters naturally as they appear.

After the script, provide:
1. A cumulative summary of the story so far (aim for ~200 words)
2. The exact closing paragraph that ends this chapter's narration
3. A brief "about this manhwa" overview (~100 words)

Format your response EXACTLY like this:
===SCRIPT===
[Your narration script here]

===SUMMARY===
[Cumulative story summary through this chapter]

===CLOSING===
[The exact last paragraph of the script]

===ABOUT===
[Brief about-this-manhwa overview]`
  } else {
    prompt += `ABOUT THIS MANHWA:
${aboutSummary || '[Not yet generated - generate Chapter 1 first]'}

STORY SO FAR:
${previousSummary || '[Not yet generated - generate previous chapters first]'}

THE PREVIOUS CHAPTER ENDED WITH:
"${previousClosingParagraph || '[Not yet generated - generate previous chapters first]'}"

IMPORTANT: Continue the narration seamlessly from where the previous chapter ended.

After the script, provide:
1. A cumulative summary of the story through this chapter (~200 words total)
2. The exact closing paragraph that ends this chapter's narration

Format your response EXACTLY like this:
===SCRIPT===
[Your narration script here]

===CLOSING===
[The exact last paragraph of the script]

===SUMMARY===
[Cumulative story summary through this chapter]`
  }
  
  return prompt
}
