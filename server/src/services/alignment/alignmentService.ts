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
 */

import { spawn } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'
import PQueue from 'p-queue'
import { Server } from 'socket.io'
import { prisma } from '../../index.js'
import { buildTimelineScript, type AlignedWord } from './beatFormatter.js'

/** Alignment is English-only for now; Hindi is future scope. */
const ALIGN_LANGUAGE = 'en'

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
 * Check whether the alignment sidecar can run. Mirrors the voice-analysis
 * sidecar's --check contract.
 */
export async function checkAlignmentAvailable(): Promise<{
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

/** Spawn the sidecar for one alignment job and parse its JSON result. */
function runAligner(audioPath: string, text: string): Promise<{
  words: AlignedWord[]
  durationSec: number
}> {
  const pythonPath = getPythonPath()
  const scriptPath = getScriptPath()

  return new Promise((resolve, reject) => {
    const proc = spawn(pythonPath, [scriptPath, '--align'])

    let stdout = ''
    let stderr = ''
    let settled = false

    const fail = (err: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      proc.kill()
      reject(err)
    }

    const timer = setTimeout(() => {
      fail(new Error('Alignment timed out'))
    }, ALIGN_TIMEOUT_MS)

    proc.stdout.on('data', (d) => { stdout += d.toString() })
    proc.stderr.on('data', (d) => { stderr += d.toString() })

    proc.on('error', (err) => {
      fail(new Error(`Could not start the aligner: ${err.message}`))
    })

    proc.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)

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

    proc.stdin.write(JSON.stringify({
      audio_path: audioPath,
      text,
      language: ALIGN_LANGUAGE
    }))
    proc.stdin.end()
  })
}

/**
 * Align one section's audio against its script text and save the resulting
 * timeline to the section. Queued: only one alignment runs at a time.
 */
export async function alignSection(
  sectionId: string,
  io?: Server
): Promise<AlignmentResult> {
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

    io?.emit('alignment:progress', {
      chapterId: section.chapterId,
      sectionId,
      index: section.index,
      stage: 'aligning'
    })

    try {
      const { words, durationSec } = await runAligner(audioPath, section.text)

      if (words.length === 0) {
        throw new Error('The aligner produced no word timings for this audio')
      }

      const timelineScript = buildTimelineScript(section.text, words)

      await prisma.audioSection.update({
        where: { id: sectionId },
        data: { timelineScript }
      })

      const beatCount = timelineScript ? timelineScript.split('\n').length : 0

      io?.emit('alignment:progress', {
        chapterId: section.chapterId,
        sectionId,
        index: section.index,
        stage: 'done',
        beatCount
      })

      return { sectionId, timelineScript, beatCount, durationSec }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Alignment failed'

      io?.emit('alignment:progress', {
        chapterId: section.chapterId,
        sectionId,
        index: section.index,
        stage: 'failed',
        error: message
      })

      throw error
    }
  }) as Promise<AlignmentResult>
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

/** Align every section of a chapter that has audio, in reading order. */
export async function alignChapter(
  chapterId: string,
  io?: Server
): Promise<{ aligned: number; failed: number; errors: string[] }> {
  const sections = await prisma.audioSection.findMany({
    where: { chapterId, audioFile: { isNot: null } },
    orderBy: { index: 'asc' },
    include: { audioFile: true }
  })

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

  io?.emit('alignment:chapter-complete', { chapterId, aligned, failed })

  return { aligned, failed, errors }
}
