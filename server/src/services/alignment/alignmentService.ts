/**
 * Alignment Service
 *
 * Produces the "Script with Timeline" text for a section by force-aligning the
 * section's KNOWN script text against its audio. Nothing is transcribed - the
 * text is already authoritative, so the aligner only decides *when* each word
 * is spoken and the script wording is preserved exactly.
 *
 * Runs WhisperX's wav2vec2 aligner through a Python sidecar (scripts/align.py),
 * spawned per job and exiting when done, so no model stays resident between
 * jobs. Jobs are serialized (concurrency 1) to keep peak memory predictable on
 * small machines.
 *
 * Every finished section also refreshes the chapter's alignment document on
 * disk (see alignmentDocument.ts), which is written once all its sections are
 * aligned.
 */

import { spawn } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'
import PQueue from 'p-queue'
import { Server } from 'socket.io'
import { prisma } from '../../index.js'
import { buildTimelineScript, type AlignedWord } from './beatFormatter.js'
import { cachedProbe, isAvailable } from '../../utils/cachedProbe.js'
import { writeAlignmentDocument } from './alignmentDocument.js'
import { NarrationLanguage, parseLanguage } from '../narrationLanguage.js'
import { notifySeriesProcessChanged } from '../seriesProcess.js'

/** Serialized: one alignment at a time, so peak memory stays predictable. */
const alignQueue = new PQueue({ concurrency: 1 })

/** A single job may legitimately take minutes on CPU for a long section. */
const ALIGN_TIMEOUT_MS = 10 * 60 * 1000
const CHECK_TIMEOUT_MS = 30 * 1000

export interface AlignmentResult {
  sectionId: string
  timelineScript: string
  beatCount: number
  durationSec: number
}

function getPythonPath(): string {
  // Prefer an explicit override, then the dedicated alignment venv if it
  // exists, then the project-wide PYTHON_PATH, then python3 on PATH.
  if (process.env.WHISPERX_PYTHON_PATH) {
    return process.env.WHISPERX_PYTHON_PATH
  }

  const venvPython = path.join(process.cwd(), '.venv-whisperx', 'bin', 'python')
  if (existsSync(venvPython)) {
    return venvPython
  }

  return process.env.PYTHON_PATH || 'python3'
}

function getScriptPath(): string {
  return path.join(process.cwd(), 'scripts', 'align.py')
}

/**
 * Check whether the alignment sidecar can run (`align.py --check` prints "ok").
 */
async function probeAlignmentAvailable(): Promise<{
  available: boolean
  error?: string
}> {
  const pythonPath = getPythonPath()
  const scriptPath = getScriptPath()

  return new Promise((resolve) => {
    const proc = spawn(pythonPath, [scriptPath, '--check'])

    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (result: { available: boolean; error?: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const timer = setTimeout(() => {
      proc.kill()
      finish({ available: false, error: 'Alignment check timed out' })
    }, CHECK_TIMEOUT_MS)

    proc.stdout.on('data', (d) => { stdout += d.toString() })
    proc.stderr.on('data', (d) => { stderr += d.toString() })

    proc.on('close', (code) => {
      if (code === 0 && stdout.includes('ok')) {
        finish({ available: true })
      } else {
        finish({
          available: false,
          error: stderr.trim() || 'WhisperX is not installed. Run: pip install whisperx'
        })
      }
    })

    proc.on('error', () => {
      finish({
        available: false,
        error: `Python not found at ${pythonPath}, or scripts/align.py is missing.`
      })
    })
  })
}
export const checkAlignmentAvailable = cachedProbe(probeAlignmentAvailable, { isOk: isAvailable })

/**
 * Spawn the sidecar for one alignment job and parse its JSON result.
 *
 * `language` picks WhisperX's wav2vec2 alignment model: its default English
 * model, or its Hindi one for a Hindi section (downloaded on first use).
 */
function runAligner(audioPath: string, text: string, language: NarrationLanguage, durationMs?: number | null,
  onProgress?: (percent: number, phase: AlignmentProgress['phase']) => void
): Promise<{
  words: AlignedWord[]
  durationSec: number
}> {
  const pythonPath = getPythonPath()
  const scriptPath = getScriptPath()

  return new Promise((resolve, reject) => {
    const proc = spawn(pythonPath, [scriptPath, '--align'])

    let stdout = ''
    let stderr = ''
    let progressBuffer = ''
    let settled = false

    let failure: Error | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined

    const fail = (err: Error) => {
      if (settled || failure) return
      failure = err
      clearTimeout(timer)
      // Keep the queue occupied until close confirms the sidecar has exited.
      // A process that ignores SIGTERM must still stop before the next job.
      proc.kill()
      killTimer = setTimeout(() => { proc.kill('SIGKILL') }, 5_000)
    }

    // Long recordings need proportionally more CPU time, especially with the
    // Hindi model. Keep the existing minimum for startup and model loading.
    const timeoutMs = typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0
      ? Math.max(ALIGN_TIMEOUT_MS, durationMs * 4 + 2 * 60 * 1000)
      : ALIGN_TIMEOUT_MS
    const timer = setTimeout(() => {
      fail(new Error('Alignment timed out'))
    }, timeoutMs)

    proc.stdout.on('data', (d) => { stdout += d.toString() })
    proc.stderr.on('data', (d) => {
      const chunk = d.toString()
      stderr = (stderr + chunk).slice(-64 * 1024)
      progressBuffer += chunk
      const lines = progressBuffer.split('\n')
      progressBuffer = lines.pop()!.slice(-8192)
      for (const line of lines) {
        if (!line.startsWith('ALIGNMENT_PROGRESS ')) continue
        try {
          const progress = JSON.parse(line.slice('ALIGNMENT_PROGRESS '.length))
          if (typeof progress.percent !== 'number' || !Number.isFinite(progress.percent)) continue
          if (!['loading', 'audio', 'matching', 'saving'].includes(progress.phase)) continue
          onProgress?.(Math.max(0, Math.min(99, Math.floor(progress.percent))), progress.phase)
        } catch { /* Non-protocol library diagnostics are kept for errors. */ }
      }
    })

    proc.on('error', (err) => {
      fail(new Error(`Could not start the aligner: ${err.message}`))
    })

    proc.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)

      clearTimeout(killTimer)
      if (failure) {
        reject(failure)
        return
      }

      if (code !== 0) {
        reject(new Error(stderr.trim() || `Aligner exited with code ${code}`))
        return
      }

      try {
        const parsed = JSON.parse(stdout)
        resolve({
          words: parsed.words ?? [],
          durationSec: parsed.durationSec ?? 0
        })
      } catch {
        reject(new Error('Aligner returned invalid JSON'))
      }
    })

    proc.stdin.on('error', (err) => { fail(new Error(`Could not send script to the aligner: ${err.message}`)) })
    proc.stdin.write(JSON.stringify({
      audio_path: audioPath,
      text,
      language
    }))
    proc.stdin.end()
  })
}

/** Sections queued or aligning, per `chapterId:language`, so a page opened mid-run shows it. */
const pending = new Map<string, number>()

export interface AlignmentProgress {
  sectionId: string
  sectionNumber: number
  percent: number
  phase: 'loading' | 'audio' | 'matching' | 'saving'
}
const activeProgress = new Map<string, AlignmentProgress>()

/** Snapshot for pages opened or refreshed while a section is running. */
export function alignmentProgress(chapterId: string, language: NarrationLanguage): AlignmentProgress | null {
  return activeProgress.get(`${chapterId}:${language}`) ?? null
}

/** How many of this chapter's sections are queued or aligning right now. */
export function pendingAlignments(chapterId: string, language: NarrationLanguage): number {
  return pending.get(`${chapterId}:${language}`) ?? 0
}

/**
 * Align one section's audio against its script text and save the resulting
 * timeline to the section. Queued: only one alignment runs at a time.
 */
// Register synchronously so simultaneous manual/automatic requests share one job.
const sectionJobs = new Map<string, Promise<AlignmentResult>>()

export function alignSection(
  sectionId: string,
  io?: Server
): Promise<AlignmentResult> {
  const existing = sectionJobs.get(sectionId)
  if (existing) return existing
  const job = trackSection(sectionId, io).finally(() => { sectionJobs.delete(sectionId) })
  sectionJobs.set(sectionId, job)
  return job
}

async function trackSection(
  sectionId: string,
  io?: Server
): Promise<AlignmentResult> {
  const owner = await prisma.audioSection.findUnique({
    where: { id: sectionId },
    select: { chapterId: true, language: true }
  })
  const key = owner ? `${owner.chapterId}:${parseLanguage(owner.language)}` : null
  if (key) pending.set(key, (pending.get(key) ?? 0) + 1)
  try {
    return await alignQueued(sectionId, io)
  } finally {
    if (key) {
      const left = (pending.get(key) ?? 1) - 1
      if (left > 0) pending.set(key, left)
      else pending.delete(key)
    }
  }
}

function alignQueued(sectionId: string, io?: Server): Promise<AlignmentResult> {
  return alignQueue.add(async () => {
    const section = await prisma.audioSection.findUnique({
      where: { id: sectionId },
      include: { audioFile: true }
    })

    if (!section) {
      throw new Error('Section not found')
    }
    if (!section.audioFile) {
      throw new Error('This section has no audio yet')
    }
    if (!section.text?.trim()) {
      throw new Error('This section has no script text to align')
    }

    const audioPath = section.audioFile.filePath

    const progressKey = `${section.chapterId}:${parseLanguage(section.language)}`
    const reportProgress = (percent: number, phase: AlignmentProgress['phase']) => {
      const previous = activeProgress.get(progressKey)
      percent = Math.max(previous?.percent ?? 0, percent)
      if (previous?.percent === percent && previous.phase === phase) return
      const progress = { sectionId, sectionNumber: section.index + 1, percent, phase }
      activeProgress.set(progressKey, progress)
      io?.emit('alignment:progress', {
        chapterId: section.chapterId, language: section.language,
        sectionId, index: section.index, stage: 'aligning', progress
      })
    }
    reportProgress(0, 'loading')

    try {
      const { words, durationSec } = await runAligner(audioPath, section.text, parseLanguage(section.language), section.audioFile.durationMs, reportProgress)

      if (words.length === 0) {
        throw new Error('The aligner produced no word timings for this audio')
      }

      const timelineScript = buildTimelineScript(section.text, words)
      reportProgress(99, 'saving')

      await prisma.audioSection.update({
        where: { id: sectionId },
        data: { timelineScript }
      })

      const beatCount = timelineScript ? timelineScript.split('\n').length : 0
      const documentWritten = await refreshDocument(section.chapterId, parseLanguage(section.language))

      io?.emit('alignment:progress', {
        chapterId: section.chapterId,
        language: section.language,
        sectionId,
        index: section.index,
        stage: 'done',
        percent: 100,
        beatCount,
        documentWritten
      })
      notifySeriesProcessChanged()

      return { sectionId, timelineScript, beatCount, durationSec }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Alignment failed'

      io?.emit('alignment:progress', {
        chapterId: section.chapterId,
        language: section.language,
        sectionId,
        index: section.index,
        stage: 'failed',
        error: message
      })

      throw error
    } finally {
      activeProgress.delete(progressKey)
    }
  }) as Promise<AlignmentResult>
}

/**
 * Rewrites the chapter's alignment document after a section is aligned. A disk
 * error is logged, never thrown: the timeline itself is already saved.
 */
async function refreshDocument(chapterId: string, language: NarrationLanguage): Promise<boolean> {
  try {
    return await writeAlignmentDocument(chapterId, language)
  } catch (error) {
    console.error(`[alignment] writing the document for chapter ${chapterId} failed:`, error instanceof Error ? error.message : error)
    return false
  }
}

/**
 * Fire-and-forget alignment used by the auto-trigger after generation/upload.
 *
 * Deliberately never throws: a failed alignment must not fail the audio
 * generation that produced the file. The socket event carries the error, and
 * the section's timeline simply stays empty for the user to retry by hand.
 */
export function alignSectionInBackground(sectionId: string, io?: Server | null): void {
  alignSection(sectionId, io ?? undefined).catch((error) => {
    const message = error instanceof Error ? error.message : 'Alignment failed'
    console.error(`[alignment] section ${sectionId}: ${message}`)
  })
}

/**
 * Align every section of a chapter that has audio, in reading order.
 * `onlyMissing` skips sections that already have a timeline.
 */
export async function alignChapter(
  chapterId: string,
  io?: Server,
  language: NarrationLanguage = 'en',
  { onlyMissing = false }: { onlyMissing?: boolean } = {}
): Promise<{ aligned: number; failed: number; errors: string[] }> {
  const sections = (await prisma.audioSection.findMany({
    where: { chapterId, language, audioFile: { isNot: null } },
    orderBy: { index: 'asc' },
    select: { id: true, index: true, timelineScript: true }
  })).filter(section => !onlyMissing || !section.timelineScript?.trim())

  let aligned = 0
  let failed = 0
  const errors: string[] = []

  for (const section of sections) {
    try {
      await alignSection(section.id, io)
      aligned++
    } catch (error) {
      failed++
      const message = error instanceof Error ? error.message : 'Alignment failed'
      errors.push(`Section ${section.index + 1}: ${message}`)
    }
  }

  const documentWritten = await refreshDocument(chapterId, language)
  io?.emit('alignment:chapter-complete', { chapterId, language, aligned, failed, documentWritten })

  return { aligned, failed, errors }
}
