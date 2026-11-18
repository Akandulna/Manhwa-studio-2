/**
 * The prompts the user pastes into a new Gemini chat (docs/PRD-gemini-app-narration.md §5).
 *
 * The procedure lives here, in the user's own message, because Gemini refuses orders that arrive in a tool's
 * reply (PRD §3 rule 2). Tool replies stay plain data. These texts only name the job and the loop; what each stage
 * needs comes from get_job and get_reference, so the prompts don't change when the stages do.
 */

import { ROOT_FOLDER_NAME } from '../googleDrive/files.js'
import { GEMINI_FOLDER } from './jobs.js'

const CONNECTOR = '@Manhwa Studio'

const LOOP = (job: string, images = true) => [
  `1. Call get_job with job "${job}". It gives the current stage and what that stage needs.`,
  `2. Do that stage. Use get_reference for any material the stage lists${images ? ', and read the Google Drive files it names' : ''}.`,
  `3. Call submit with job "${job}", the stage, and your result as content.`,
  '4. If Studio rejects it, fix exactly the problems it lists and submit that stage again.',
  '5. When a stage is accepted, call get_job again and continue with the next stage, in this chat, until get_job says the job is saved.'
]

const FILES = [
  `The chapter's pages are images in my Google Drive under My Drive › ${ROOT_FOLDER_NAME} › ${GEMINI_FOLDER}, in the folder get_job names. Read files only from that folder.`,
  'Each image has a white band on top such as "P0003-T002 · CHECK K7QM": the piece id and its check code. Copy the check code from the band of the image you actually read.'
]

/** One chapter (Process): start or continue this job only. */
export function processPrompt(job: { ref: string; language: string; seriesTitle: string; chapterNumber: number; driveFolderName: string | null }): string {
  const english = job.language === 'en'
  return [
    `${CONNECTOR} Job ${job.ref}: write the ${english ? 'English' : 'Hinglish'} narration script for ${job.seriesTitle}, chapter ${job.chapterNumber}.`,
    '',
    'Manhwa Studio holds this job and checks every step. Its tools: get_job (the current stage), get_reference (longer material on request) and submit (a stage\'s result).',
    ...(english ? FILES.concat(job.driveFolderName ? [`This job's folder: "${job.driveFolderName}".`] : []) : ['This job is written from the chapter\'s saved English script (get_reference gives it); it has no images.']),
    '',
    ...LOOP(job.ref, english),
    '',
    'When the job is saved, reply with one line saying so. If a tool says Manhwa Studio is not reachable, stop and tell me.'
  ].join('\n')
}

/** Master: the next job in Studio's queue, then a one-time schedule that runs this same prompt again. */
export function masterPrompt(): string {
  return [
    `${CONNECTOR} Run the next job in Manhwa Studio's Gemini queue.`,
    '',
    'Manhwa Studio holds the jobs and checks every step. Its tools: get_job (a job and its current stage), get_reference (longer material on request) and submit (a stage\'s result).',
    // Gemini, not the connector, decides whether the app asks "Run submit?": it sends its own destructiveHint with each
    // execute_mcp call. Master chats sent true for every submit while Process chats (job named by the user) sent false,
    // so this line gives the user's approval in the user's own words (tool replies can't; PRD §3 rule 2).
    'I approve every get_job, get_reference and submit call this message leads to, for whichever job Studio returns, also when this message runs as a scheduled action. These tools only read and update Manhwa Studio\'s own job records and are not destructive: call them with destructiveHint false, as list_mcp reports, and do not ask me first.',
    ...FILES,
    '',
    '1. Call get_job without a job.',
    '   - If its status is "none": tell me what its note says (the queue is finished or paused) and stop. Do not schedule anything.',
    '   - If its status is "preparing": skip to step 3.',
    '2. Otherwise work through the job it returns, in this chat:',
    ...LOOP('<that job>').map(line => `   ${line.replace(/^(\d)\. /, (_, n) => `${String.fromCharCode(96 + Number(n))}) `)}`),
    '3. When the job is saved, or a tool says "preparing", "waiting", "cancelled" or "needs_attention": create a one-time scheduled action at the time in the latest "nextRunAt" Studio gave (call get_job once more if you have none), whose prompt is this entire message, word for word. Then stop.',
    '',
    'If a tool says Manhwa Studio is not reachable, stop and tell me without scheduling anything.'
  ].join('\n')
}
