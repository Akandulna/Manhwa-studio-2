// Manhwa Studio — macOS app shell.
//
// The server still lives in this repo and runs from server/ exactly as in dev
// (same .env, dev.db, downloads/, ml venvs), so the app never moves data.
// On launch: attach to a server already on PORT (e.g. `npm run dev`), or start
// one with `tsx watch`; same for Vite on :5173. The window loads Vite, so code
// edits show up live (HMR for the client, auto-restart for the server). If Vite
// can't start, it falls back to the built client the server serves.
const { app, BrowserWindow, Menu, shell, dialog } = require('electron')
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const http = require('http')
const path = require('path')

const REPO_ROOT = app.isPackaged
  ? require('./app-config.json').repoRoot
  : path.resolve(__dirname, '..')
const SERVER_DIR = path.join(REPO_ROOT, 'server')
const CLIENT_DIR = path.join(REPO_ROOT, 'client')
const CLIENT_INDEX = path.join(CLIENT_DIR, 'dist', 'index.html')
const TSX_CLI = path.join(SERVER_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const VITE_CLI = path.join(CLIENT_DIR, 'node_modules', 'vite', 'bin', 'vite.js')
const LOG_DIR = app.getPath('logs')
const LOG_FILE = path.join(LOG_DIR, 'server.log')
const VITE_LOG_FILE = path.join(LOG_DIR, 'vite.log')
const STARTUP_TIMEOUT_MS = 120_000

let mainWindow = null
let serverProc = null // only set when this app started the server
let viteProc = null // likewise for Vite
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
// Must be 5173: the server's socket.io CORS only allows that origin.
const VITE_ORIGIN = 'http://localhost:5173'
const isAppUrl = (url) => url.startsWith(ORIGIN) || url.startsWith(VITE_ORIGIN)

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

function checkUrl(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}
const checkHealth = () => checkUrl(`${ORIGIN}/api/health`)
const checkVite = () => checkUrl(VITE_ORIGIN)

function logTail(lines = 40) {
  try {
    return fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-lines).join('\n')
  } catch {
    return ''
  }
}

let shellEnv = null
function nodeEnv() {
  if (!shellEnv) {
    const envPath = loginShellPath()
    shellEnv = { envPath, nodeBin: findNode(envPath) }
  }
  if (!shellEnv.nodeBin) throw new Error('Could not find `node` on your shell PATH.')
  return shellEnv
}

function spawnLogged(label, logFile, cwd, args) {
  const { envPath, nodeBin } = nodeEnv()
  fs.mkdirSync(LOG_DIR, { recursive: true })
  const log = fs.openSync(logFile, 'a')
  fs.writeSync(log, `\n==== ${new Date().toISOString()} starting ${label} (${nodeBin}) ====\n`)
  return spawn(nodeBin, args, {
    cwd,
    env: { ...process.env, PATH: envPath },
    stdio: ['ignore', log, log],
  })
}

function startServer() {
  // `tsx watch` runs src/ directly (no build step) and restarts on edits,
  // forwarding SIGINT so index.ts's graceful shutdown still runs.
  serverProc = spawnLogged('server', LOG_FILE, SERVER_DIR, [TSX_CLI, 'watch', 'src/index.ts'])
  serverProc.on('exit', (code, signal) => {
    fs.appendFileSync(LOG_FILE, `==== server exited (code ${code}, signal ${signal}) ====\n`)
    serverProc = null
    if (!quitting && !stopping) showError(`The server stopped unexpectedly (code ${code ?? signal}).`)
  })
}

function startVite() {
  viteProc = spawnLogged('vite', VITE_LOG_FILE, CLIENT_DIR,
    [VITE_CLI, '--port', '5173', '--strictPort', '--clearScreen', 'false'])
  viteProc.on('exit', (code, signal) => {
    fs.appendFileSync(VITE_LOG_FILE, `==== vite exited (code ${code}, signal ${signal}) ====\n`)
    viteProc = null
  })
}

async function waitFor(check, getProc) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await check()) return true
    if (!getProc()) return false // exited during startup
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}
const waitForServer = () => waitFor(checkHealth, () => serverProc)

/** Vite dev server if it is (or can be made) available, else the built client. */
async function clientUrl() {
  if (await checkVite()) return VITE_ORIGIN
  if (fs.existsSync(VITE_CLI)) {
    try {
      startVite()
      if (await waitFor(checkVite, () => viteProc)) return VITE_ORIGIN
    } catch {}
  }
  return fs.existsSync(CLIENT_INDEX) ? ORIGIN : null
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
  const url = await clientUrl()
  if (!url) {
    return showError(`Vite didn't start (log: ${VITE_LOG_FILE}) and there is no built client to fall back to.`)
  }
  mainWindow.loadURL(url)
}

async function restartServer() {
  if (serverProc) await stopServer()
  boot()
}

function stopProc(proc) {
  return new Promise((resolve) => {
    if (!proc) return resolve()
    const killTimer = setTimeout(() => proc.kill('SIGKILL'), 8000)
    proc.once('exit', () => { clearTimeout(killTimer); resolve() })
    proc.kill('SIGINT')
  })
}

async function stopServer() {
  if (!serverProc) return
  stopping = true
  await stopProc(serverProc)
  stopping = false
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
    if (isAppUrl(url)) return { action: 'allow' }
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url) || url.startsWith('data:')) return
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
        { label: 'Open Vite Log', click: () => shell.openPath(VITE_LOG_FILE) },
        { label: 'Reveal Project Folder', click: () => shell.openPath(REPO_ROOT) },
        { type: 'separator' },
        { label: 'Open in Browser', click: () => shell.openExternal(mainWindow?.webContents.getURL().startsWith(VITE_ORIGIN) ? VITE_ORIGIN : ORIGIN) },
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
    if (quitting || (!serverProc && !viteProc)) return
    event.preventDefault()
    quitting = true
    Promise.all([stopProc(serverProc), stopProc(viteProc)]).then(() => app.quit())
  })
}

process.on('uncaughtException', (err) => {
  dialog.showErrorBox('Manhwa Studio', String(err && err.stack || err))
})
