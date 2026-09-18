/**
 * Kokoro process supervisor.
 *
 * Kokoro is a local Gradio app that holds its TTS model in memory. Keeping it
 * resident for the whole dev session costs RAM even when nothing is being
 * voiced, so this starts it on demand and shuts it down once it has been idle
 * for a while - the same "spawn per job" spirit as the WhisperX aligner, but
 * with a keep-alive window because model load takes ~20s and voiceover runs
 * arrive in bursts (a whole chapter at a time).
 *
 * An externally started Kokoro (from an IDE, or `npm run dev:kokoro`) is
 * detected and reused, and is never killed by us - we only stop what we spawn.
 *
 * Configure with (server/.env):
 *   KOKORO_URL          base URL (default http://127.0.0.1:7860)
 *   KOKORO_APP_DIR      folder holding app.py + its venv
 *   KOKORO_ON_DEMAND    "false" to disable on-demand management entirely
 *   KOKORO_IDLE_TIMEOUT idle seconds before shutdown (default 300)
 */

import { spawn, ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'

const KOKORO_URL = (process.env.KOKORO_URL || 'http://127.0.0.1:7860').replace(/\/+$/, '')
const ON_DEMAND = (process.env.KOKORO_ON_DEMAND || 'true').toLowerCase() !== 'false'
const IDLE_TIMEOUT_MS = Number(process.env.KOKORO_IDLE_TIMEOUT || 300) * 1000

/**
 * Default to the sibling "Kokoro" folder next to this project.
 *
 * The server runs with cwd=server/, so resolve against the repo root (this
 * file's location) rather than cwd - otherwise "../Kokoro" would point inside
 * the project instead of beside it.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const DEFAULT_APP_DIR = path.resolve(REPO_ROOT, '..', 'Kokoro')
const APP_DIR = process.env.KOKORO_APP_DIR || DEFAULT_APP_DIR

const READY_TIMEOUT_MS = 90_000
const PROBE_TIMEOUT_MS = 2000

/** The process we spawned, if any. Never set for an externally started app. */
let child: ChildProcess | null = null
/** In-flight start, so concurrent callers await one boot rather than racing. */
let starting: Promise<void> | null = null
/** Number of jobs currently using Kokoro; the idle timer starts when it hits 0. */
let activeJobs = 0
let idleTimer: NodeJS.Timeout | null = null

const log = (msg: string) => console.log(`[kokoro] ${msg}`)

/** Is something answering on Kokoro's port? */
async function isRunning(): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
    try {
      const res = await fetch(KOKORO_URL, { signal: controller.signal })
      return res.ok
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return false
  }
}

/** Prefer the app's own venv; fall back to whatever python is on PATH. */
function resolvePython(appDir: string): string | null {
  const isWindows = os.platform() === 'win32'
  const candidates = isWindows
    ? [path.join(appDir, '.venv', 'Scripts', 'python.exe'), path.join(appDir, 'venv', 'Scripts', 'python.exe')]
    : [path.join(appDir, '.venv', 'bin', 'python'), path.join(appDir, 'venv', 'bin', 'python')]

  return candidates.find(existsSync) || null
}

function clearIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
}

/** Spawn Kokoro and resolve once it answers on its port. */
async function spawnKokoro(): Promise<void> {
  if (!existsSync(APP_DIR)) {
    throw new Error(
      `Kokoro app folder not found at ${APP_DIR}. Set KOKORO_APP_DIR in server/.env, or start Kokoro yourself.`
    )
  }

  const entry = path.join(APP_DIR, 'app.py')
  if (!existsSync(entry)) {
    throw new Error(`No app.py in ${APP_DIR}`)
  }

  const python = resolvePython(APP_DIR)
  if (!python) {
    throw new Error(`No Python venv found in ${APP_DIR} (looked for .venv/ and venv/)`)
  }

  const { hostname, port } = new URL(KOKORO_URL)

  // app.py hardcodes its port and opens a browser tab on launch. Import its
  // `demo` and launch it ourselves instead of editing that file.
  const bootstrap = [
    'import runpy, sys',
    'ns = runpy.run_path(sys.argv[1], run_name="__kokoro_autostart__")',
    'demo = ns.get("demo")',
    'if demo is None:',
    '    sys.exit("app.py exposes no `demo` Blocks object")',
    'demo.launch(server_name=sys.argv[2], server_port=int(sys.argv[3]), inbrowser=False, quiet=True)'
  ].join('\n')

  log(`starting on demand from ${APP_DIR}`)

  const proc = spawn(python, ['-c', bootstrap, entry, hostname, port || '7860'], {
    cwd: APP_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GRADIO_ANALYTICS_ENABLED: 'False', PYTHONUNBUFFERED: '1' }
  })

  child = proc

  proc.stdout?.on('data', (d: Buffer) => {
    const line = d.toString().trim()
    if (line && /error|Error|Traceback/.test(line)) log(line)
  })
  proc.stderr?.on('data', (d: Buffer) => {
    const line = d.toString().trim()
    if (line && /error|Error|Traceback/.test(line)) log(line)
  })
  proc.on('exit', (code) => {
    if (child === proc) child = null
    if (code && code !== 0) log(`exited with code ${code}`)
  })
  proc.on('error', (err) => {
    if (child === proc) child = null
    log(`failed to start: ${err.message}`)
  })

  // Wait for the port to answer
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1000))
    if (await isRunning()) {
      log('ready')
      return
    }
    if (proc.exitCode !== null) {
      child = null
      throw new Error(`Kokoro exited during startup (code ${proc.exitCode})`)
    }
  }

  stopKokoro()
  throw new Error(`Kokoro did not become ready within ${READY_TIMEOUT_MS / 1000}s`)
}

/** Stop only a Kokoro we started ourselves. */
function stopKokoro(): void {
  clearIdleTimer()
  if (!child) return

  const proc = child
  child = null
  log('idle - shutting down')
  proc.kill('SIGTERM')

  // Escalate if it ignores SIGTERM
  const force = setTimeout(() => {
    if (proc.exitCode === null && !proc.killed) proc.kill('SIGKILL')
  }, 5000)
  force.unref?.()
}

function scheduleIdleShutdown(): void {
  clearIdleTimer()
  if (!child || activeJobs > 0) return

  idleTimer = setTimeout(() => {
    if (activeJobs === 0) stopKokoro()
  }, IDLE_TIMEOUT_MS)
  idleTimer.unref?.()
}

/**
 * Ensure Kokoro is reachable, starting it if necessary, and mark one job as
 * active. ALWAYS pair with `releaseKokoro()` in a finally block - the idle
 * timer only runs once every job has been released.
 */
export async function acquireKokoro(): Promise<void> {
  activeJobs++
  clearIdleTimer()

  try {
    if (await isRunning()) return

    if (!ON_DEMAND) {
      throw new Error(
        `Cannot reach Kokoro at ${KOKORO_URL}. Start it with \`npm run dev:kokoro\`, or set KOKORO_ON_DEMAND=true.`
      )
    }

    // Collapse concurrent starts into one boot
    if (!starting) {
      starting = spawnKokoro().finally(() => { starting = null })
    }
    await starting
  } catch (error) {
    activeJobs = Math.max(0, activeJobs - 1)
    throw error
  }
}

/** Mark one job finished; schedules shutdown when the last one releases. */
export function releaseKokoro(): void {
  activeJobs = Math.max(0, activeJobs - 1)
  if (activeJobs === 0) scheduleIdleShutdown()
}

/** Current supervisor state, for diagnostics. */
export function getKokoroState() {
  return {
    managed: child !== null,
    activeJobs,
    onDemand: ON_DEMAND,
    idleTimeoutSec: IDLE_TIMEOUT_MS / 1000,
    url: KOKORO_URL
  }
}

// Don't leave an orphan holding port 7860 when the server exits.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stopKokoro()
    process.exit(0)
  })
}
process.on('exit', () => {
  if (child) child.kill('SIGTERM')
})
