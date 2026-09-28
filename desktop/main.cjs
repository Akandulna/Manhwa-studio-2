// Manhwa Studio — macOS app shell.
//
// The server still lives in this repo and runs from server/ exactly as in dev
// (same .env, dev.db, downloads/, ml venvs), so the app never moves data.
// On launch: attach to a server already on PORT (e.g. `npm run dev`), or start
// one with the system Node + tsx, then load the built client it serves.
const { app, BrowserWindow, Menu, shell, dialog } = require('electron')
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const http = require('http')
const path = require('path')

const REPO_ROOT = app.isPackaged
  ? require('./app-config.json').repoRoot
  : path.resolve(__dirname, '..')
const SERVER_DIR = path.join(REPO_ROOT, 'server')
const CLIENT_INDEX = path.join(REPO_ROOT, 'client', 'dist', 'index.html')
const LOG_DIR = app.getPath('logs')
const LOG_FILE = path.join(LOG_DIR, 'server.log')
const STARTUP_TIMEOUT_MS = 120_000

let mainWindow = null
let serverProc = null // only set when this app started the server
let quitting = false
let stopping = false // intentional stop (restart/quit): don't show the crash page

/** PORT from server/.env — must match the client's hardcoded localhost:3002. */
function readPort() {
  if (process.env.PORT) return Number(process.env.PORT) // also wins over .env in the spawned server (dotenv doesn't override)
  try {
    const env = fs.readFileSync(path.join(SERVER_DIR, '.env'), 'utf8')
    const m = env.match(/^\s*PORT\s*=\s*"?(\d+)"?/m)
    if (m) return Number(m[1])
  } catch {}
  return 3001 // server/src/index.ts default
}
const PORT = readPort()
const ORIGIN = `http://localhost:${PORT}`

/**
 * Apps opened from Finder get a bare PATH (/usr/bin:/bin...), which would hide
 * Homebrew ffmpeg, nvm node, etc. Borrow the PATH of an interactive login shell.
 */
function loginShellPath() {
  const shellBin = process.env.SHELL || '/bin/zsh'
  try {
    const out = spawnSync(shellBin, ['-ilc', 'printf "__PATH__%s__PATH__" "$PATH"'], {
      encoding: 'utf8',
      timeout: 8000,
    }).stdout || ''
    const m = out.match(/__PATH__(.*)__PATH__/)
    if (m && m[1]) return m[1]
  } catch {}
  return ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':')
}

function findNode(envPath) {
  for (const dir of envPath.split(':')) {
    const candidate = path.join(dir, 'node')
    if (dir && fs.existsSync(candidate)) return candidate
  }
  return null
}

function checkHealth() {
  return new Promise((resolve) => {
    const req = http.get(`${ORIGIN}/api/health`, { timeout: 2000 }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

function logTail(lines = 40) {
  try {
    return fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-lines).join('\n')
  } catch {
    return ''
  }
}

function startServer() {
  const envPath = loginShellPath()
  const nodeBin = findNode(envPath)
  if (!nodeBin) throw new Error('Could not find `node` on your shell PATH.')

  fs.mkdirSync(LOG_DIR, { recursive: true })
  const log = fs.openSync(LOG_FILE, 'a')
  fs.writeSync(log, `\n==== ${new Date().toISOString()} starting server (${nodeBin}) ====\n`)

  // `node --import tsx` runs src/ directly (no build step, always current code)
  // in a single process, so SIGINT reaches index.ts's graceful shutdown.
  serverProc = spawn(nodeBin, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: { ...process.env, PATH: envPath, NODE_ENV: 'production' },
    stdio: ['ignore', log, log],
  })
  serverProc.on('exit', (code, signal) => {
    fs.appendFileSync(LOG_FILE, `==== server exited (code ${code}, signal ${signal}) ====\n`)
    serverProc = null
    if (!quitting && !stopping) showError(`The server stopped unexpectedly (code ${code ?? signal}).`)
  })
}

async function waitForServer() {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await checkHealth()) return true
    if (!serverProc) return false // exited during startup
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

function page(title, body) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
      background:#0b0b10;color:#e4e4e7;font:14px -apple-system,system-ui,sans-serif;-webkit-app-region:drag}
    .box{max-width:760px;padding:32px;text-align:center}
    h1{font-size:18px;font-weight:600;margin:0 0 8px}
    p{color:#a1a1aa;margin:0 0 16px}
    pre{text-align:left;background:#18181b;border:1px solid #27272a;border-radius:8px;padding:12px;
      max-height:50vh;overflow:auto;font-size:11px;color:#d4d4d8;white-space:pre-wrap;-webkit-app-region:no-drag}
    .spin{width:28px;height:28px;margin:0 auto 16px;border:3px solid #27272a;border-top-color:#a78bfa;
      border-radius:50%;animation:s 0.9s linear infinite}@keyframes s{to{transform:rotate(360deg)}}
  </style></head><body><div class="box">${body}</div></body></html>`
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}

const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))

function showError(message) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.loadURL(page('Error', `
    <h1>Manhwa Studio couldn't start</h1>
    <p>${escapeHtml(message)}<br>Log: ${escapeHtml(LOG_FILE)} — use Server → Restart Server to try again.</p>
    <pre>${escapeHtml(logTail())}</pre>`))
}

async function boot() {
  mainWindow.loadURL(page('Starting', '<div class="spin"></div><h1>Starting Manhwa Studio…</h1>'))

  if (!fs.existsSync(CLIENT_INDEX)) {
    return showError(`The client hasn't been built. Run: cd "${REPO_ROOT}/client" && npx vite build`)
  }
  if (!(await checkHealth())) {
    try {
      startServer()
    } catch (err) {
      return showError(err.message)
    }
    if (!(await waitForServer())) {
      if (serverProc) return showError('The server did not respond within 2 minutes.')
      return // exit handler already showed the error
    }
  }
  mainWindow.loadURL(ORIGIN)
}

async function restartServer() {
  if (serverProc) await stopServer()
  boot()
}

function stopServer() {
  return new Promise((resolve) => {
    const proc = serverProc
    if (!proc) return resolve()
    stopping = true
    const killTimer = setTimeout(() => proc.kill('SIGKILL'), 8000)
    proc.once('exit', () => { clearTimeout(killTimer); stopping = false; resolve() })
    proc.kill('SIGINT')
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#0b0b10',
    title: 'Manhwa Studio',
    webPreferences: { contextIsolation: true, sandbox: true },
  })

  // Same-origin popups (e.g. the Murgaa reference window) open in-app;
  // everything else (ChatGPT, AI Studio, …) goes to the default browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(ORIGIN)) return { action: 'allow' }
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(ORIGIN) || url.startsWith('data:')) return
    event.preventDefault()
    if (/^https?:/.test(url)) shell.openExternal(url)
  })
  mainWindow.on('closed', () => { mainWindow = null })

  boot()
}

function buildMenu() {
  const template = [
    { role: 'appMenu' },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      label: 'Server',
      submenu: [
        { label: 'Restart Server', click: () => restartServer() },
        { label: 'Open Server Log', click: () => shell.openPath(LOG_FILE) },
        { label: 'Reveal Project Folder', click: () => shell.openPath(REPO_ROOT) },
        { type: 'separator' },
        { label: 'Open in Browser', click: () => shell.openExternal(ORIGIN) },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return createWindow()
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    buildMenu()
    createWindow()
  })

  // macOS convention: closing the window keeps the app (and any running
  // downloads/exports) alive in the Dock; clicking the Dock icon reopens it.
  app.on('window-all-closed', () => {})
  app.on('activate', () => { if (!mainWindow) createWindow() })

  app.on('before-quit', (event) => {
    if (quitting || !serverProc) return
    event.preventDefault()
    quitting = true
    stopServer().then(() => app.quit())
  })
}

process.on('uncaughtException', (err) => {
  dialog.showErrorBox('Manhwa Studio', String(err && err.stack || err))
})
