/**
 * Editor 2.0 — batch MP4 export.
 *
 * Turns processed timeline plans into finished videos, one MP4 per chapter,
 * rendered back to back in a single job so the whole series can be exported
 * from one press of a button.
 *
 * The composition is deliberately Editor 1.0's: `buildImageFilterChunk` from
 * videoEditorService draws every frame, so a chapter exported here looks the
 * same as the same chapter exported there — blurred cover backdrop, image fit
 * to frame height, the same gentle Ken Burns drift. What differs is where the
 * material comes from. Editor 1.0 renders a VideoProject it owns in the
 * database; Editor 2.0 has no project rows at all — its source of truth is the
 * pasted timeline JSON, which the client re-sends here and which is processed
 * into a plan exactly as the preview processes it. That keeps "what I exported"
 * identical to "what I previewed" without a schema change.
 *
 * Jobs live in memory. A render that is interrupted by a server restart is
 * simply re-run: nothing is written until FFmpeg finishes a chapter, and the
 * inputs (the JSON) are still sitting in the browser.
 */

import { ChildProcess, spawn } from 'child_process'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { Server } from 'socket.io'
import {
  buildImageFilterChunk,
  getVideoCapabilities,
  RESOLUTIONS,
  type VideoCapabilities
} from './videoEditorService.js'
import { ensureFfmpegAvailable, normalizePartDurations } from './videoMath.js'
import { processTimelineJson, type PlanSection, type TimelinePlan } from './editor2Timeline.js'
import { prisma } from '../index.js'

const DEFAULT_FPS = 30
const DEFAULT_CRF = 18
const AUDIO_BITRATE = '192k'
const AUDIO_SAMPLE_RATE = 44100

/** Map the editor's quality preset to an x264 preset — same table as 1.0. */
const X264_PRESET: Record<string, string> = {
  fast: 'veryfast',
  medium: 'medium',
  slow: 'slow'
}

function getFfmpegPath(): string {
  return process.env.FFMPEG_PATH || 'ffmpeg'
}

/** Resolve a stored (possibly relative) download path against DOWNLOAD_ROOT. */
function getFullFolderPath(relativePath: string): string {
  const downloadRoot = process.env.DOWNLOAD_ROOT || './downloads'
  return path.join(downloadRoot, relativePath)
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'video'
}

// ============ What has already been exported ============
//
// Editor 2.0 owns no database rows, so the `_video2` folder is the record of
// what has been rendered: every finished chapter leaves exactly one MP4 there
// whose name carries the chapter number. Scanning it is therefore the honest
// answer to "has this chapter been exported?" — it survives a server restart,
// a cleared browser, and a job swept out of the in-memory map, and a file the
// user deletes by hand correctly reads as not exported again.

/** Where one series' Editor 2.0 renders live. */
function exportDirFor(rootFolder: string): string {
  return path.join(getFullFolderPath(rootFolder), '_video2')
}

/**
 * The chapter number encoded in an export filename, or null if the name did
 * not come from this exporter.
 *
 * Matches the `_ch007_` segment written by `startBatchExport`. Anything else
 * in the folder — a hand-dropped file, a render from another tool — is ignored
 * rather than guessed at.
 */
function chapterNumberFromFilename(name: string): number | null {
  const m = /_ch(\d{3,})_/.exec(name)
  if (!m) return null
  const n = parseInt(m[1], 10)
  return Number.isFinite(n) ? n : null
}

/** One chapter's finished export on disk. */
export interface Export2Existing {
  chapterNumber: number
  fileName: string
  filePath: string
  /** Bytes, so the UI can tell a real render from a truncated leftover. */
  size: number
  /** Epoch ms of the last write, for "exported <when>". */
  modifiedAt: number
}

/**
 * Every chapter of this series that already has an MP4 in `_video2`, keyed by
 * chapter number.
 *
 * When several renders of the same chapter are present — older runs made
 * before exports were deduplicated — the newest wins, since that is the one
 * the user would consider current.
 */
export async function listExistingExports(
  rootFolder: string
): Promise<Map<number, Export2Existing>> {
  const dir = exportDirFor(rootFolder)
  const found = new Map<number, Export2Existing>()

  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    // No folder yet simply means nothing has been exported.
    return found
  }

  for (const fileName of entries) {
    if (!fileName.toLowerCase().endsWith('.mp4')) continue
    const chapterNumber = chapterNumberFromFilename(fileName)
    if (chapterNumber === null) continue

    const filePath = path.join(dir, fileName)
    let stat
    try {
      stat = await fs.stat(filePath)
    } catch {
      // Vanished between readdir and stat — treat it as absent.
      continue
    }
    // A zero-byte file is a failed or interrupted render, not an export.
    if (!stat.isFile() || stat.size === 0) continue

    const prior = found.get(chapterNumber)
    if (prior && prior.modifiedAt >= stat.mtimeMs) continue
    found.set(chapterNumber, {
      chapterNumber,
      fileName,
      filePath,
      size: stat.size,
      modifiedAt: stat.mtimeMs
    })
  }

  return found
}

/**
 * Which of a series' chapters are already exported, as chapter ids.
 *
 * The scan works in chapter numbers because that is what the filename carries;
 * this maps them back to ids, which is what every caller upstream speaks.
 */
export async function getExportedChapterIds(seriesId: string): Promise<
  { chapterId: string; chapterNumber: number; fileName: string; size: number; modifiedAt: number }[]
> {
  const series = await prisma.series.findUnique({
    where: { id: seriesId },
    select: { rootFolder: true }
  })
  if (!series) return []

  const existing = await listExistingExports(series.rootFolder)
  if (existing.size === 0) return []

  const chapters = await prisma.chapter.findMany({
    where: { seriesId, number: { in: [...existing.keys()] } },
    select: { id: true, number: true }
  })

  return chapters.flatMap(ch => {
    const hit = existing.get(ch.number)
    if (!hit) return []
    return [{
      chapterId: ch.id,
      chapterNumber: ch.number,
      fileName: hit.fileName,
      size: hit.size,
      modifiedAt: hit.modifiedAt
    }]
  })
}

// ============ Job state ============

/**
 * 'skipped' is a chapter that already had an MP4 in `_video2` and was left
 * alone — the reason pressing Export twice no longer re-renders the series.
 */
export type Export2ChapterStatus =
  | 'pending'
  | 'rendering'
  | 'done'
  | 'skipped'
  | 'failed'
  | 'cancelled'

export interface Export2ChapterState {
  chapterId: string
  chapterNumber: number
  chapterTitle: string | null
  status: Export2ChapterStatus
  /** 0-100 within this chapter. */
  percent: number
  outputPath: string | null
  error: string | null
}

export type Export2JobStatus = 'running' | 'done' | 'failed' | 'cancelled'

export interface Export2Job {
  id: string
  seriesId: string
  status: Export2JobStatus
  /** 0-100 across every chapter in the job, weighted by runtime. */
  percent: number
  chapters: Export2ChapterState[]
  startedAt: number
  finishedAt: number | null
  error: string | null
}

/** One chapter's input: the chapter and the exact JSON that was previewed. */
export interface Export2Input {
  chapterId: string
  json: string
}

export interface Export2Options {
  resolution: string
  preset: string
  fps?: number
  /**
   * Re-render chapters that already have an MP4 in `_video2`. Off by default:
   * the common press of Export All is "finish the rest of the series", and
   * silently re-encoding hours of finished video is never what was meant.
   */
  force?: boolean
}

interface JobRuntime {
  job: Export2Job
  cancelled: boolean
  proc: ChildProcess | null
}

/**
 * Live jobs, keyed by id. Kept in memory deliberately: an export is a
 * foreground action the user watches, not a record worth persisting, and
 * Editor 2.0 has no tables of its own to persist it into.
 */
const jobs = new Map<string, JobRuntime>()

/** Finished jobs are swept an hour after they end so the map cannot grow forever. */
const JOB_TTL_MS = 60 * 60 * 1000

function sweepOldJobs(): void {
  const now = Date.now()
  for (const [id, rt] of jobs) {
    if (rt.job.finishedAt && now - rt.job.finishedAt > JOB_TTL_MS) jobs.delete(id)
  }
}

export function getExport2Job(jobId: string): Export2Job | null {
  return jobs.get(jobId)?.job ?? null
}

/** Ask a running job to stop; the active FFmpeg child is killed. */
export function cancelExport2Job(jobId: string): boolean {
  const rt = jobs.get(jobId)
  if (!rt || rt.job.status !== 'running') return false
  rt.cancelled = true
  rt.proc?.kill('SIGKILL')
  return true
}

// ============ FFmpeg plumbing ============

/** Run one FFmpeg child, streaming -progress, honoring cooperative cancel. */
function runFfmpeg(
  rt: JobRuntime,
  args: string[],
  onOutTime?: (sec: number) => void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (rt.cancelled) return reject(new Error('cancelled'))

    const proc = spawn(getFfmpegPath(), args)
    rt.proc = proc

    let stderr = ''
    proc.stderr.on('data', d => { stderr += d.toString() })

    if (onOutTime) {
      let buf = ''
      proc.stdout.on('data', d => {
        buf += d.toString()
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const line of lines) {
          const m = line.match(/^out_time_us=(\d+)/)
          if (m) onOutTime(parseInt(m[1], 10) / 1_000_000)
        }
      })
    }

    proc.on('error', reject)
    proc.on('close', code => {
      rt.proc = null
      if (rt.cancelled) return reject(new Error('cancelled'))
      if (code === 0) resolve()
      else reject(new Error(`FFmpeg exited ${code}: ${stderr.slice(-2000)}`))
    })
  })
}

/** Pixel dimensions of an image, via sharp (already a hard dependency). */
async function getImageDimensions(filePath: string): Promise<{ width: number; height: number }> {
  const sharp = (await import('sharp')).default
  const meta = await sharp(filePath).metadata()
  return { width: meta.width || 1920, height: meta.height || 1080 }
}

interface RenderOpts {
  res: { w: number; h: number }
  fps: number
  x264Preset: string
  crf: number
}

/**
 * Render one plan section to its own MP4: its images composited in order,
 * carried by that section's voiceover.
 *
 * A section is the natural render unit because it is the unit the timeline was
 * authored in — every timestamp in the JSON is relative to this section's own
 * audio file, which is therefore the master clock for exactly these images.
 */
async function renderSection(
  rt: JobRuntime,
  section: PlanSection,
  outFile: string,
  opts: RenderOpts,
  caps: VideoCapabilities,
  onOutTime: (sec: number) => void
): Promise<void> {
  const { res, fps } = opts

  const images = section.slots.flatMap(slot => slot.images)
  if (images.length === 0) {
    throw new Error(`${section.label} has no images to show`)
  }

  // Stretch/squeeze the image durations so they sum to the audio exactly —
  // rounding across many slots otherwise drifts against the voiceover.
  const normalized = normalizePartDurations(images, section.audioDuration)

  const inputArgs: string[] = []
  const chunks: string[] = []
  const labels: string[] = []

  for (let idx = 0; idx < normalized.length; idx++) {
    const img = normalized[idx]
    // An unresolved ref renders as black rather than aborting the export: the
    // preview already flagged it, and losing a whole chapter to one missing
    // crop would be worse than a short gap the user can see and fix.
    const isFiller = !img.imagePath
    const frames = Math.max(1, Math.round(img.duration * fps))

    let imgW: number | undefined
    let imgH: number | undefined
    if (!isFiller && img.imagePath) {
      try {
        const dim = await getImageDimensions(img.imagePath)
        imgW = dim.width
        imgH = dim.height
      } catch {
        // Unreadable on disk — fall through as filler.
      }
    }

    const useFiller = isFiller || imgW === undefined
    if (useFiller) {
      inputArgs.push('-f', 'lavfi', '-i', `color=c=black:s=${res.w}x${res.h}:r=${fps}:d=${img.duration.toFixed(3)}`)
    } else {
      inputArgs.push('-i', img.imagePath!)
    }

    const { filter, outLabel } = buildImageFilterChunk({
      inputIndex: idx,
      frameW: res.w,
      frameH: res.h,
      fps,
      durationFrames: frames,
      isFiller: useFiller,
      imgW,
      imgH,
      // Editor 2.0 has no focus/anchor editing, so every image drifts.
      motionMode: 'drift',
      motionEffect: img.motionEffect,
      motionIntensity: img.motionIntensity,
      anchorX: null,
      anchorY: null,
      scale: null,
      offsetX: null,
      offsetY: null,
      blurFilter: caps.blurFilter,
      hasZoompan: caps.hasZoompan
    })
    chunks.push(filter)
    labels.push(outLabel)
  }

  const filterComplex = `${chunks.join('')}${labels.join('')}concat=n=${labels.length}:v=1:a=0[vout]`

  const args = ['-hide_banner', '-nostats', '-progress', 'pipe:1', ...inputArgs]

  if (section.audioPath) {
    args.push('-i', section.audioPath)
  } else {
    // A silent section still has to occupy its slot in the finished video.
    args.push('-f', 'lavfi', '-t', section.audioDuration.toFixed(3), '-i', `anullsrc=r=${AUDIO_SAMPLE_RATE}:cl=stereo`)
  }
  const audioInputIndex = normalized.length

  args.push(
    '-filter_complex', filterComplex,
    '-map', '[vout]',
    '-map', `${audioInputIndex}:a`,
    '-r', String(fps),
    '-c:v', 'libx264', '-preset', opts.x264Preset, '-crf', String(opts.crf), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', AUDIO_BITRATE, '-ar', String(AUDIO_SAMPLE_RATE),
    '-shortest',
    '-y', outFile
  )

  await runFfmpeg(rt, args, onOutTime)
}

/**
 * Render one chapter's plan to a finished MP4: every section rendered, then
 * concatenated without re-encoding.
 */
async function renderChapter(
  rt: JobRuntime,
  plan: TimelinePlan,
  outputPath: string,
  opts: RenderOpts,
  onPercent: (percent: number) => void
): Promise<void> {
  const caps = getVideoCapabilities()
  const total = plan.sections.reduce((s, sec) => s + sec.audioDuration, 0)
  if (total <= 0) throw new Error('This chapter has no runtime to render')

  const tmpDir = path.join(os.tmpdir(), `mhs_editor2_${plan.chapterId}_${Date.now()}`)
  await fs.mkdir(tmpDir, { recursive: true })

  try {
    const partFiles: string[] = []
    let priorDuration = 0

    for (let i = 0; i < plan.sections.length; i++) {
      if (rt.cancelled) throw new Error('cancelled')
      const section = plan.sections[i]
      const partFile = path.join(tmpDir, `part_${String(i).padStart(4, '0')}.mp4`)

      await renderSection(rt, section, partFile, opts, caps, sec => {
        onPercent(Math.min(99, ((priorDuration + sec) / total) * 100))
      })

      partFiles.push(partFile)
      priorDuration += section.audioDuration
      onPercent(Math.min(99, (priorDuration / total) * 100))
    }

    const listPath = path.join(tmpDir, 'concat.txt')
    await fs.writeFile(listPath, partFiles.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'))

    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await runFfmpeg(rt, [
      '-hide_banner', '-nostats',
      '-f', 'concat', '-safe', '0', '-i', listPath,
      '-c', 'copy', '-movflags', '+faststart',
      '-y', outputPath
    ])

    onPercent(100)
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

// ============ Job orchestration ============

/**
 * Start a batch export and return its job id immediately — rendering runs in
 * the background and is followed through the job status endpoint.
 *
 * Chapters render one at a time rather than in parallel: FFmpeg already
 * saturates the machine on a single chapter, so running several would only
 * trade a readable progress bar for contention.
 */
export async function startBatchExport(
  seriesId: string,
  inputs: Export2Input[],
  options: Export2Options,
  io?: Server
): Promise<string> {
  ensureFfmpegAvailable(getVideoCapabilities())
  sweepOldJobs()

  const res = RESOLUTIONS[options.resolution]
  if (!res) throw new Error(`Unsupported resolution: ${options.resolution}`)
  if (inputs.length === 0) throw new Error('No chapters to export')

  const fps = [24, 30, 60].includes(options.fps ?? 0) ? options.fps! : DEFAULT_FPS
  const x264Preset = X264_PRESET[options.preset] || 'medium'

  const series = await prisma.series.findUnique({
    where: { id: seriesId },
    select: { title: true, rootFolder: true }
  })
  if (!series) throw new Error('Series not found')

  const chapters = await prisma.chapter.findMany({
    where: { id: { in: inputs.map(i => i.chapterId) } },
    select: { id: true, number: true, title: true }
  })
  const byId = new Map(chapters.map(c => [c.id, c]))

  // What is already on disk. Resolved once, up front, so the decision to skip
  // is made before any FFmpeg starts rather than per chapter mid-run.
  const already = options.force ? new Map() : await listExistingExports(series.rootFolder)

  const jobId = randomUUID()
  const job: Export2Job = {
    id: jobId,
    seriesId,
    status: 'running',
    percent: 0,
    chapters: inputs.map(input => {
      const ch = byId.get(input.chapterId)
      const hit = ch ? already.get(ch.number) : undefined
      // An already-exported chapter enters the job finished rather than
      // pending, so the list shows "Exported" immediately and the progress
      // bar is not padded with work that will never run.
      return {
        chapterId: input.chapterId,
        chapterNumber: ch?.number ?? 0,
        chapterTitle: ch?.title ?? null,
        status: (hit ? 'skipped' : 'pending') as Export2ChapterStatus,
        percent: hit ? 100 : 0,
        outputPath: hit?.filePath ?? null,
        error: null
      }
    }),
    startedAt: Date.now(),
    finishedAt: null,
    error: null
  }
  const rt: JobRuntime = { job, cancelled: false, proc: null }
  jobs.set(jobId, rt)

  // Only what is left to render actually goes through the loop below.
  const pending = inputs.filter(
    input => job.chapters.find(c => c.chapterId === input.chapterId)?.status === 'pending'
  )

  const outputDir = path.join(getFullFolderPath(series.rootFolder), '_video2')
  const opts: RenderOpts = { res, fps, x264Preset, crf: DEFAULT_CRF }

  // Chapters are equal slices of the bar. Weighting by runtime was considered,
  // but that needs every plan processed up front — which would stall the UI
  // before the first frame is rendered.
  const emit = () => {
    const done = job.chapters.reduce((sum, c) => sum + c.percent, 0)
    job.percent = Math.round(done / job.chapters.length)
    io?.emit('editor2:export-progress', {
      jobId,
      percent: job.percent,
      status: job.status,
      chapters: job.chapters
    })
  }

  // Fire and forget: the caller gets the job id and polls (or listens) for the
  // rest. Errors are recorded on the job, never thrown into an empty stack.
  void (async () => {
    try {
      for (const input of pending) {
        if (rt.cancelled) break
        const state = job.chapters.find(c => c.chapterId === input.chapterId)!
        state.status = 'rendering'
        emit()

        try {
          // Re-process here rather than trusting a plan from the client: the
          // JSON is the authored artifact, and processing it server-side is
          // what guarantees the export matches the preview.
          const plan = await processTimelineJson(input.chapterId, input.json)
          state.chapterNumber = plan.chapterNumber
          state.chapterTitle = plan.chapterTitle

          const stamp = new Date().toISOString().replace(/[:.]/g, '-')
          const name = `${slugify(series.title)}_ch${String(plan.chapterNumber).padStart(3, '0')}_${options.resolution}_${stamp}.mp4`
          const outputPath = path.join(outputDir, name)

          await renderChapter(rt, plan, outputPath, opts, percent => {
            state.percent = percent
            emit()
          })

          state.status = 'done'
          state.percent = 100
          state.outputPath = outputPath
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Render failed'
          if (message === 'cancelled' || rt.cancelled) {
            state.status = 'cancelled'
            state.error = null
          } else {
            // One bad chapter must not cost the user the rest of the batch.
            state.status = 'failed'
            state.error = message
            console.error(`[editor2Export] chapter ${input.chapterId} failed:`, message)
          }
        }
        emit()
      }

      if (rt.cancelled) {
        job.status = 'cancelled'
        for (const c of job.chapters) {
          if (c.status === 'pending' || c.status === 'rendering') c.status = 'cancelled'
        }
      } else {
        const failed = job.chapters.filter(c => c.status === 'failed')
        // Only chapters this job actually attempted can make it a failure —
        // a run that was entirely skips is a success with nothing to do.
        job.status = pending.length > 0 && failed.length === pending.length ? 'failed' : 'done'
        if (failed.length > 0) {
          job.error = `${failed.length} of ${pending.length} chapters failed`
        }
      }
    } catch (error) {
      job.status = 'failed'
      job.error = error instanceof Error ? error.message : 'Export failed'
      console.error('[editor2Export] batch export failed:', job.error)
    } finally {
      job.finishedAt = Date.now()
      emit()
    }
  })()

  return jobId
}
