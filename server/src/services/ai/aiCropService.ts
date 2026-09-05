/**
 * AI Auto-Crop Service — Module 3 AI
 *
 * Node ↔ Python sidecar bridge. Mirrors voiceAnalysisService's spawn pattern
 * (PYTHON_PATH env, JSON over stdin, exit codes, a --check mode) but adds
 * line-delimited JSON progress envelopes on stdout so long-running jobs stream
 * progress over Socket.io without blocking the Express event loop.
 *
 * Stage A (rule-based panel detection) works with zero training data; when an
 * active trained model exists it is layered on as Stage B.
 */

import { spawn, ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs/promises'
import { Server } from 'socket.io'
import { prisma } from '../../index.js'
import { getChapterManifest, type ImageManifest } from '../clipperService.js'
import {
  getDatasetSampleCount,
  getFinalizedCropCount,
  getDatasetDir,
  exportDataset,
  exportSuggestionFeedback
} from './cropDatasetService.js'
import {
  suggestWithGuidelines,
  isGeminiAvailable,
  getGuidelinesMeta,
  ensureLocked
} from './guidelineCropService.js'
import type { AiCropStatus, SuggestResult, CropEngine } from './aiCropTypes.js'

// ============ Config & paths ============

const ACTIVE_MODEL_SETTING_KEY = 'aiCrop.activeModelVersion'
const ENGINE_SETTING_KEY = 'aiCrop.engine'

/** Synthetic version number for the built-in guideline (Gemini) model. */
export const GUIDELINES_MODEL_VERSION = 0

export function getMinSamples(): number {
  const v = parseInt(process.env.AI_CROP_MIN_SAMPLES || '', 10)
  return Number.isFinite(v) && v > 0 ? v : 30
}

function getPythonPath(): string {
  return process.env.PYTHON_PATH || path.join(process.cwd(), 'ml', 'venv', 'bin', 'python3')
}

function getScriptPath(name: string): string {
  return path.join(process.cwd(), 'ml', name)
}

export function getModelsDir(): string {
  return path.join(process.cwd(), 'ml', 'models')
}

export function getModelDir(version: number): string {
  return path.join(getModelsDir(), `v${version}`)
}

function getFullFolderPath(relativePath: string): string {
  const downloadRoot = process.env.DOWNLOAD_ROOT || './downloads'
  return path.join(downloadRoot, relativePath)
}

// ============ Job registry (cancellation) ============

interface RunningJob {
  proc: ChildProcess
  type: 'suggest' | 'train' | 'evaluate'
  sessionId?: string
}

const runningJobs = new Map<string, RunningJob>()

/** Cancel any running jobs for a session (or a specific job key). */
export function cancelJobs(filter: { sessionId?: string; key?: string }): number {
  let killed = 0
  for (const [key, job] of runningJobs) {
    if ((filter.key && key === filter.key) || (filter.sessionId && job.sessionId === filter.sessionId)) {
      job.proc.kill('SIGTERM')
      runningJobs.delete(key)
      killed++
    }
  }
  return killed
}

// ============ Generic sidecar runner ============

interface SidecarEnvelope {
  event: 'progress' | 'result' | 'error'
  message?: string
  [k: string]: unknown
}

interface RunOptions {
  jobKey: string
  type: RunningJob['type']
  sessionId?: string
  onProgress?: (env: SidecarEnvelope) => void
  timeoutMs?: number
}

/**
 * Spawn a sidecar script in a streaming mode. Reads stdout line by line; each
 * line is a JSON envelope. Resolves with the `result` envelope, rejects on an
 * `error` envelope, a non-zero exit, or cancellation.
 */
function runSidecar(
  scriptName: string,
  args: string[],
  input: unknown,
  opts: RunOptions
): Promise<SidecarEnvelope> {
  const python = getPythonPath()
  const scriptPath = getScriptPath(scriptName)

  return new Promise((resolve, reject) => {
    const proc = spawn(python, [scriptPath, ...args])
    runningJobs.set(opts.jobKey, { proc, type: opts.type, sessionId: opts.sessionId })

    let stdoutBuf = ''
    let stderr = ''
    let result: SidecarEnvelope | null = null
    let errorEnv: SidecarEnvelope | null = null

    const timeout = setTimeout(() => {
      proc.kill('SIGTERM')
      reject(new Error('Sidecar timed out'))
    }, opts.timeoutMs ?? 10 * 60 * 1000)

    proc.stdin.write(JSON.stringify(input))
    proc.stdin.end()

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString()
      let nl: number
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim()
        stdoutBuf = stdoutBuf.slice(nl + 1)
        if (!line) continue
        let env: SidecarEnvelope
        try {
          env = JSON.parse(line)
        } catch {
          continue // ignore non-JSON noise
        }
        if (env.event === 'progress') opts.onProgress?.(env)
        else if (env.event === 'result') result = env
        else if (env.event === 'error') errorEnv = env
      }
    })

    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    proc.on('error', (err) => {
      clearTimeout(timeout)
      runningJobs.delete(opts.jobKey)
      reject(new Error(`Failed to start sidecar: ${err.message}`))
    })

    proc.on('close', (code, signal) => {
      clearTimeout(timeout)
      runningJobs.delete(opts.jobKey)
      if (signal === 'SIGTERM') return reject(new Error('cancelled'))
      if (errorEnv) return reject(new Error(errorEnv.message || 'Sidecar error'))
      if (code !== 0) return reject(new Error(stderr.trim() || `Sidecar exited with code ${code}`))
      if (!result) return reject(new Error('Sidecar produced no result'))
      resolve(result)
    })
  })
}

// ============ Availability ============

export async function checkSidecarAvailable(): Promise<{ available: boolean; error?: string }> {
  const python = getPythonPath()
  const scriptPath = getScriptPath('suggest.py')

  return new Promise((resolve) => {
    const proc = spawn(python, [scriptPath, '--check'])
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d) => { stdout += d.toString() })
    proc.stderr.on('data', (d) => { stderr += d.toString() })
    proc.on('close', (code) => {
      if (code === 0 && stdout.includes('ok')) resolve({ available: true })
      else resolve({ available: false, error: stderr.trim() || 'AI crop sidecar unavailable. Run `npm run ml:setup`.' })
    })
    proc.on('error', () => resolve({
      available: false,
      error: 'Python not found. Install Python 3.10+ and run `npm run ml:setup`.'
    }))
    setTimeout(() => { proc.kill(); resolve({ available: false, error: 'Sidecar check timed out' }) }, 15000)
  })
}

// ============ Active model resolution ============

export async function getActiveModelVersion(): Promise<number | null> {
  const setting = await prisma.setting.findUnique({ where: { key: ACTIVE_MODEL_SETTING_KEY } })
  if (!setting) return null
  const v = parseInt(setting.value, 10)
  return Number.isFinite(v) ? v : null
}

export async function setActiveModelVersion(version: number): Promise<void> {
  await prisma.setting.upsert({
    where: { key: ACTIVE_MODEL_SETTING_KEY },
    create: { key: ACTIVE_MODEL_SETTING_KEY, value: String(version) },
    update: { value: String(version) }
  })
}

/**
 * Which engine generates suggestions. Defaults to the guideline (Gemini) cropper
 * so a fresh install follows the user's written guidelines with no training.
 */
export async function getEngine(): Promise<CropEngine> {
  const setting = await prisma.setting.findUnique({ where: { key: ENGINE_SETTING_KEY } })
  return setting?.value === 'trained' ? 'trained' : 'guidelines'
}

export async function setEngine(engine: CropEngine): Promise<void> {
  await prisma.setting.upsert({
    where: { key: ENGINE_SETTING_KEY },
    create: { key: ENGINE_SETTING_KEY, value: engine },
    update: { value: engine }
  })
}

/** Resolve the on-disk model dir for inference, or null to use Stage A only. */
async function resolveActiveModelDir(): Promise<string | null> {
  const version = await getActiveModelVersion()
  if (version == null) return null
  const model = await prisma.aIModel.findUnique({ where: { version } })
  if (!model || model.status !== 'ready') return null
  const dir = getModelDir(version)
  try {
    await fs.access(path.join(dir, 'model.joblib'))
    return dir
  } catch {
    return null
  }
}

// ============ Status ============

export async function getStatus(): Promise<AiCropStatus> {
  // Idempotent: keep the guidelines file locked read-only on every status poll.
  ensureLocked().catch(() => {})

  const [sidecar, sampleCount, activeModelVersion, modelCount, backboneAvailable, engine, guidelinesMeta] =
    await Promise.all([
      checkSidecarAvailable(),
      // Live finalized-crop count, not the manifest (which only refreshes during
      // training) — otherwise canTrain stays false forever and training never starts.
      getFinalizedCropCount().catch(() => 0),
      getActiveModelVersion(),
      prisma.aIModel.count(),
      fs.access(path.join(getModelsDir(), 'backbone.onnx')).then(() => true).catch(() => false),
      getEngine(),
      getGuidelinesMeta()
    ])
  const minSamples = getMinSamples()
  return {
    sidecarAvailable: sidecar.available,
    sidecarError: sidecar.error,
    sampleCount,
    minSamples,
    canTrain: sampleCount >= minSamples,
    activeModelVersion,
    modelCount,
    backboneAvailable,
    engine,
    geminiAvailable: isGeminiAvailable(),
    guidelinesPresent: guidelinesMeta.present,
    guidelinesUpdatedAt: guidelinesMeta.updatedAt
  }
}

// ============ Suggest ============

/**
 * Run Stage A (+ Stage B if a model is active) for a session, persist the
 * suggestions as AISuggestion rows, and stream progress over Socket.io.
 * Returns the persisted suggestions.
 */
export async function suggestForSession(
  cropSessionId: string,
  io: Server
): Promise<void> {
  const emitComplete = (payload: Record<string, unknown>) =>
    io.emit('ai-crop:suggest-complete', { cropSessionId, ...payload })

  try {
    const session = await prisma.cropSession.findUnique({
      where: { id: cropSessionId },
      include: { chapter: { select: { id: true, folderPath: true } } }
    })
    if (!session) {
      emitComplete({ error: 'Session not found' })
      return
    }

    const manifest: ImageManifest = await getChapterManifest(session.chapter.folderPath)
    const imageDir = getFullFolderPath(session.chapter.folderPath)
    const engine = await getEngine()

    let result: SuggestResult
    if (engine === 'guidelines') {
      // Default engine: the Gemini guideline cropper (no Python sidecar).
      io.emit('ai-crop:suggest-progress', { cropSessionId, phase: 'guidelines', percent: 15 })
      const suggestions = await suggestWithGuidelines(imageDir, manifest)
      io.emit('ai-crop:suggest-progress', { cropSessionId, phase: 'guidelines', percent: 100 })
      result = { mode: 'guidelines', modelVersion: null, suggestions }
    } else {
      const modelDir = await resolveActiveModelDir()
      const env = await runSidecar(
        'suggest.py',
        ['--suggest'],
        { imageDir, manifest, modelDir },
        {
          jobKey: `suggest:${cropSessionId}`,
          type: 'suggest',
          sessionId: cropSessionId,
          onProgress: (e) => io.emit('ai-crop:suggest-progress', {
            cropSessionId, phase: e.phase, percent: e.percent
          })
        }
      )
      result = env as unknown as SuggestResult
    }
    const modelId = result.modelVersion != null
      ? (await prisma.aIModel.findUnique({ where: { version: result.modelVersion } }))?.id ?? null
      : null

    // Replace any prior pending suggestions for this session.
    await prisma.aISuggestion.deleteMany({ where: { cropSessionId, status: 'pending' } })

    const created = await Promise.all(result.suggestions.map(s =>
      prisma.aISuggestion.create({
        data: {
          modelId,
          cropSessionId,
          chapterId: session.chapter.id,
          rectJson: JSON.stringify({
            canvasX: s.canvasX, canvasY: s.canvasY, canvasW: s.canvasW, canvasH: s.canvasH
          }),
          aspectPreset: s.aspectPreset,
          confidence: s.confidence,
          status: 'pending'
        }
      })
    ))

    emitComplete({
      mode: result.mode,
      modelVersion: result.modelVersion,
      suggestions: created.map(c => ({
        id: c.id,
        ...JSON.parse(c.rectJson),
        aspectPreset: c.aspectPreset,
        confidence: c.confidence,
        status: c.status
      }))
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Suggestion failed'
    if (message !== 'cancelled') console.error('[ai-crop] suggest failed:', err)
    emitComplete({ error: message })
  }
}

// ============ Train ============

const TRAIN_JOB_KEY = 'train:global'
const HOLDOUT_RATIO = 0.15

interface TrainResult {
  status: string
  trainingSampleCount: number
  metrics: Record<string, unknown>
  hyperparams: Record<string, unknown>
  validationChapters: string[]
  usesEmbeddings?: boolean
  hasCutModel?: boolean
  cutMetrics?: Record<string, unknown> | null
}

/**
 * Export the dataset, train a new versioned model, and stream progress.
 * Refuses (with a clear message) when there are too few crops to learn from.
 */
export async function trainModel(io: Server): Promise<void> {
  const emitProgress = (phase: string, percent: number) =>
    io.emit('ai-crop:training-progress', { phase, percent })
  const emitComplete = (payload: Record<string, unknown>) =>
    io.emit('ai-crop:training-complete', payload)

  let modelId: string | null = null
  let version = 0

  try {
    const sidecar = await checkSidecarAvailable()
    if (!sidecar.available) {
      emitComplete({ error: sidecar.error || 'AI sidecar unavailable. Run `npm run ml:setup`.' })
      return
    }

    // 1. Refresh the dataset (crops + suggestion feedback).
    emitProgress('exporting', 5)
    await exportDataset()
    await exportSuggestionFeedback()

    const sampleCount = await getDatasetSampleCount()
    const minSamples = getMinSamples()
    if (sampleCount < minSamples) {
      emitComplete({
        error: `Not enough training data: ${sampleCount} finalized crops. ` +
          `Crop and finalize ${minSamples - sampleCount} more before training.`,
        sampleCount,
        minSamples
      })
      return
    }

    // 2. Allocate the next version + a training row.
    const latest = await prisma.aIModel.findFirst({ orderBy: { version: 'desc' } })
    version = (latest?.version ?? 0) + 1
    const model = await prisma.aIModel.create({
      data: { version, status: 'training', trainingSampleCount: sampleCount }
    })
    modelId = model.id

    // 3. Train.
    const env = await runSidecar(
      'train.py',
      ['--train'],
      {
        datasetDir: getDatasetDir(),
        modelDir: getModelDir(version),
        version,
        minSamples,
        holdoutRatio: HOLDOUT_RATIO,
        createdAt: new Date().toISOString()
      },
      {
        jobKey: TRAIN_JOB_KEY,
        type: 'train',
        onProgress: (e) => emitProgress(String(e.phase), Number(e.percent) || 0),
        timeoutMs: 30 * 60 * 1000
      }
    )

    const result = env as unknown as TrainResult

    // 4. Mark ready, store metrics, activate.
    await prisma.aIModel.update({
      where: { id: model.id },
      data: {
        status: 'ready',
        trainingSampleCount: result.trainingSampleCount,
        metricsJson: JSON.stringify(result.metrics),
        hyperparamsJson: JSON.stringify(result.hyperparams),
        notes: `Holdout chapters: ${result.validationChapters.length}`
      }
    })
    await setActiveModelVersion(version)

    emitProgress('saving', 100)
    emitComplete({
      version,
      status: 'ready',
      metrics: result.metrics,
      usesEmbeddings: result.usesEmbeddings,
      hasCutModel: result.hasCutModel,
      cutMetrics: result.cutMetrics ?? null
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Training failed'
    if (message !== 'cancelled') console.error('[ai-crop] train failed:', err)
    if (modelId) {
      await prisma.aIModel.update({
        where: { id: modelId },
        data: { status: 'failed', notes: message }
      }).catch(() => {})
    }
    emitComplete({ error: message, version })
  }
}

/** Cancel a running training job. */
export function cancelTraining(): number {
  return cancelJobs({ key: TRAIN_JOB_KEY })
}

// ============ Evaluate ============

const EVAL_JOB_KEY = 'evaluate:global'

/** AIModel rows with parsed metrics, newest first (for the version history UI). */
export async function listModels() {
  const [models, active, engine, guidelinesMeta] = await Promise.all([
    prisma.aIModel.findMany({ orderBy: { version: 'desc' } }),
    getActiveModelVersion(),
    getEngine(),
    getGuidelinesMeta()
  ])

  // Built-in default: the guideline (Gemini) cropper. Not a DB row — synthesized
  // as version 0 and active whenever the engine is set to 'guidelines'.
  const guidelinesEntry = {
    id: 'guidelines',
    version: GUIDELINES_MODEL_VERSION,
    kind: 'guidelines' as const,
    label: 'Guidelines (Gemini)',
    status: 'ready' as const,
    trainingSampleCount: 0,
    metrics: null,
    hyperparams: null,
    notes: guidelinesMeta.present ? 'Follows your written cropping guidelines.' : 'Guidelines file missing.',
    createdAt: (guidelinesMeta.updatedAt ?? new Date(0).toISOString()),
    active: engine === 'guidelines'
  }

  const trained = models.map(m => ({
    id: m.id,
    version: m.version,
    kind: 'trained' as const,
    label: `v${m.version}`,
    status: m.status,
    trainingSampleCount: m.trainingSampleCount,
    metrics: m.metricsJson ? JSON.parse(m.metricsJson) : null,
    hyperparams: m.hyperparamsJson ? JSON.parse(m.hyperparamsJson) : null,
    notes: m.notes,
    createdAt: m.createdAt.toISOString(),
    active: engine === 'trained' && m.version === active
  }))

  return [guidelinesEntry, ...trained]
}

/** Recorded evaluation runs, newest first. */
export async function listEvaluations() {
  const runs = await prisma.evaluationRun.findMany({ orderBy: { createdAt: 'desc' }, take: 50 })
  return runs.map(r => ({
    id: r.id,
    modelId: r.modelId,
    mode: r.mode,
    chapterIds: JSON.parse(r.chapterIds),
    metrics: JSON.parse(r.metricsJson),
    createdAt: r.createdAt.toISOString()
  }))
}

/** Chapters split into hold-out candidates (have finalized crops) and blind candidates. */
export async function getEvaluatableChapters() {
  const chapters = await prisma.chapter.findMany({
    where: { status: 'done' },
    include: {
      series: { select: { title: true } },
      cropSession: { select: { status: true, cropCount: true } }
    },
    orderBy: [{ seriesId: 'asc' }, { number: 'asc' }]
  })

  const holdout: unknown[] = []
  const blind: unknown[] = []
  for (const ch of chapters) {
    const base = {
      id: ch.id,
      number: ch.number,
      title: ch.title,
      seriesTitle: ch.series.title,
      cropCount: ch.cropSession?.cropCount ?? 0
    }
    if (ch.cropSession?.status === 'finalized' && (ch.cropSession.cropCount ?? 0) > 0) holdout.push(base)
    else blind.push(base)
  }
  return { holdout, blind }
}

/**
 * Run held-out evaluation: the AI crops chapters from scratch and is scored
 * against the user's finalized crops. Persists an EvaluationRun.
 */
export async function evaluateModel(io: Server, chapterIds: string[]): Promise<void> {
  const emitProgress = (payload: Record<string, unknown>) => io.emit('ai-crop:evaluate-progress', payload)
  const emitComplete = (payload: Record<string, unknown>) => io.emit('ai-crop:evaluate-complete', payload)

  try {
    const sidecar = await checkSidecarAvailable()
    if (!sidecar.available) {
      emitComplete({ error: sidecar.error || 'AI sidecar unavailable. Run `npm run ml:setup`.' })
      return
    }

    // Gather finalized chapters + their user crops.
    const sessions = await prisma.cropSession.findMany({
      where: { status: 'finalized', chapter: { id: { in: chapterIds } } },
      include: {
        crops: { orderBy: { sequence: 'asc' } },
        chapter: { select: { id: true, folderPath: true } }
      }
    })
    if (sessions.length === 0) {
      emitComplete({ error: 'No finalized chapters to evaluate' })
      return
    }

    const chapters = []
    for (const s of sessions) {
      const manifest = await getChapterManifest(s.chapter.folderPath)
      chapters.push({
        chapterId: s.chapter.id,
        imageDir: getFullFolderPath(s.chapter.folderPath),
        manifest,
        userCrops: s.crops.map(c => ({
          canvasX: c.canvasX, canvasY: c.canvasY, canvasW: c.canvasW, canvasH: c.canvasH,
          aspectPreset: c.aspectRatio || 'free'
        }))
      })
    }

    const activeVersion = await getActiveModelVersion()
    const modelDir = await resolveActiveModelDir()

    const env = await runSidecar(
      'evaluate.py',
      ['--evaluate'],
      { modelDir, chapters },
      {
        jobKey: EVAL_JOB_KEY,
        type: 'evaluate',
        onProgress: (e) => emitProgress({ phase: e.phase, percent: e.percent, chapterId: e.chapterId }),
        timeoutMs: 30 * 60 * 1000
      }
    )

    const result = env as unknown as { aggregate: unknown; perChapter: unknown }
    const modelId = activeVersion != null
      ? (await prisma.aIModel.findUnique({ where: { version: activeVersion } }))?.id ?? null
      : null

    const run = await prisma.evaluationRun.create({
      data: {
        modelId,
        mode: 'holdout',
        chapterIds: JSON.stringify(chapters.map(c => c.chapterId)),
        metricsJson: JSON.stringify({ aggregate: result.aggregate, perChapter: result.perChapter })
      }
    })

    emitComplete({
      runId: run.id,
      mode: 'holdout',
      aggregate: result.aggregate,
      perChapter: result.perChapter
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Evaluation failed'
    if (message !== 'cancelled') console.error('[ai-crop] evaluate failed:', err)
    emitComplete({ error: message })
  }
}

export function cancelEvaluation(): number {
  return cancelJobs({ key: EVAL_JOB_KEY })
}
