#!/usr/bin/env node
/**
 * Starts the local Kokoro TTS (Gradio) app alongside `npm run dev`.
 *
 * Kokoro lives in its own folder with its own Python venv, so this launcher
 * runs it in place rather than vendoring it into this repo.
 *
 * It is deliberately forgiving - Kokoro is an optional provider, so any
 * problem here logs a hint and exits 0 instead of taking down `npm run dev`:
 *   - already running (e.g. started from an IDE)  -> attach, do nothing
 *   - app folder or venv not found                -> skip with instructions
 *
 * Configure with (in server/.env or the environment):
 *   KOKORO_APP_DIR   path to the Kokoro app folder
 *   KOKORO_URL       base URL to probe (default http://127.0.0.1:7860)
 *   KOKORO_AUTOSTART set to "false" to disable autostart entirely
 */

import { spawn } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

/**
 * Minimal .env reader - the repo root has no dependencies of its own, and
 * this only needs the handful of KOKORO_* keys. Existing environment
 * variables win, matching dotenv's behaviour.
 */
function loadEnv(envPath) {
  if (!existsSync(envPath)) return

  for (const rawLine of readFileSync(envPath, 'utf8').split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const eq = line.indexOf('=')
    if (eq === -1) continue

    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()

    // strip matching surrounding quotes
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
      value = value.slice(1, -1)
    }

    if (key && process.env[key] === undefined) process.env[key] = value
  }
}

// Reuse the server's .env so KOKORO_* lives in one place
loadEnv(path.join(repoRoot, 'server', '.env'))

const KOKORO_URL = process.env.KOKORO_URL || 'http://127.0.0.1:7860'
const AUTOSTART = (process.env.KOKORO_AUTOSTART || 'true').toLowerCase() !== 'false'

/** Default to the sibling "Kokoro" folder next to this project. */
const DEFAULT_APP_DIR = path.resolve(repoRoot, '..', 'Kokoro')
const APP_DIR = process.env.KOKORO_APP_DIR || DEFAULT_APP_DIR

const log = (msg) => console.log(`[kokoro] ${msg}`)

async function isRunning() {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2000)
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
function resolvePython(appDir) {
  const isWindows = os.platform() === 'win32'
  const candidates = isWindows
    ? [path.join(appDir, '.venv', 'Scripts', 'python.exe'), path.join(appDir, 'venv', 'Scripts', 'python.exe')]
    : [path.join(appDir, '.venv', 'bin', 'python'), path.join(appDir, 'venv', 'bin', 'python')]

  return candidates.find(existsSync) || null
}

async function main() {
  if (!AUTOSTART) {
    log('autostart disabled (KOKORO_AUTOSTART=false) - skipping')
    return
  }

  if (await isRunning()) {
    log(`already running at ${KOKORO_URL} - reusing it`)
    return
  }

  if (!existsSync(APP_DIR)) {
    log(`app folder not found at ${APP_DIR}`)
    log('set KOKORO_APP_DIR in server/.env to enable autostart, or start Kokoro yourself')
    return
  }

  const entry = path.join(APP_DIR, 'app.py')
  if (!existsSync(entry)) {
    log(`no app.py in ${APP_DIR} - skipping autostart`)
    return
  }

  const python = resolvePython(APP_DIR)
  if (!python) {
    log(`no Python venv found in ${APP_DIR} (looked for .venv/ and venv/)`)
    log('create one there, or start Kokoro yourself - the app works without it')
    return
  }

  const { hostname, port } = new URL(KOKORO_URL)

  log(`starting from ${APP_DIR}`)

  // app.py ends in `demo.launch(server_port=7860, inbrowser=True)`, which
  // hardcodes the port and pops a browser tab. Rather than edit that file,
  // import its `demo` and launch it ourselves with the settings we want:
  // honours KOKORO_URL's port, and no browser tab on every `npm run dev`.
  const bootstrap = [
    'import runpy, sys',
    'ns = runpy.run_path(sys.argv[1], run_name="__kokoro_autostart__")',
    'demo = ns.get("demo")',
    'if demo is None:',
    '    sys.exit("app.py exposes no `demo` Blocks object")',
    'demo.launch(server_name=sys.argv[2], server_port=int(sys.argv[3]), inbrowser=False, quiet=True)'
  ].join('\n')

  const child = spawn(python, ['-c', bootstrap, entry, hostname, port || '7860'], {
    cwd: APP_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GRADIO_ANALYTICS_ENABLED: 'False',
      PYTHONUNBUFFERED: '1'
    }
  })

  child.stdout.on('data', (d) => {
    const line = d.toString().trim()
    // Gradio is chatty on boot; surface only the useful lines
    if (line && /Running on|error|Error|Traceback/.test(line)) log(line)
  })
  child.stderr.on('data', (d) => {
    const line = d.toString().trim()
    if (line && /error|Error|Traceback/.test(line)) log(line)
  })

  child.on('error', (err) => {
    log(`failed to start: ${err.message}`)
  })

  child.on('exit', (code) => {
    if (code && code !== 0) log(`exited with code ${code}`)
  })

  // Tie Kokoro's lifetime to this launcher so Ctrl-C on `npm run dev`
  // doesn't leave an orphan holding port 7860.
  const shutdown = () => {
    if (!child.killed) child.kill('SIGTERM')
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('exit', () => { if (!child.killed) child.kill('SIGTERM') })

  // Report readiness so the dev log shows when TTS is actually usable
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 1000))
    if (await isRunning()) {
      log(`ready at ${KOKORO_URL}`)
      break
    }
    if (child.exitCode !== null) return
  }

  // Keep this process alive so the child keeps running under concurrently
  await new Promise(() => {})
}

main().catch((err) => {
  log(`autostart skipped: ${err?.message || err}`)
})
