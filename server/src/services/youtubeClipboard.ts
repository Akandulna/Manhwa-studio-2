import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Request } from 'express'
import { YouTubeError, type YouTubeStore } from './youtubeStore.js'
const execute = promisify(execFile)
// Fixed program; paths are argv data, never interpolated into AppleScript or a shell.
const COPY_FILES = `ObjC.import('AppKit');
function run(paths) {
  var urls = $.NSMutableArray.alloc.init;
  paths.forEach(function(p) { urls.addObject($.NSURL.fileURLWithPath(p)); });
  var board = $.NSPasteboard.generalPasteboard;
  board.clearContents;
  if (!board.writeObjects(urls)) throw new Error('Could not write image files to the clipboard.');
  if (!board.setPropertyListForType($(paths), 'NSFilenamesPboardType')) throw new Error('Could not copy the full image file list.');
  var copied = ObjC.deepUnwrap(board.propertyListForType('NSFilenamesPboardType'));
  if (!copied || copied.length !== paths.length) throw new Error('Not all image files reached the clipboard.');
  return String(copied.length);
}`
export function assertLocalClipboardRequest(req: Request) {
  const remote = req.socket.remoteAddress
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote ?? '') || req.get('X-Studio-Clipboard') !== 'references') throw new YouTubeError('Copy reference images from Studio on this Mac.', 403)
  const origin = req.get('Origin')
  if (origin) {
    let allowed = false
    try {
      const url = new URL(origin)
      const server = new URL(`http://${req.get('Host')}`)
      const loopback = (hostname: string) => ['localhost', '127.0.0.1', '[::1]'].includes(hostname)
      // Vite (:5173) proxies /api with changeOrigin, so Host becomes :3002
      // while the browser's Origin correctly remains :5173.
      const developmentUi = url.protocol === 'http:' && url.port === '5173' && loopback(server.hostname)
      allowed = ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && loopback(url.hostname) && (url.host === server.host || developmentUi)
    } catch { /* Invalid Origin or Host. */ }
    if (!allowed) throw new YouTubeError('Open Studio directly on this Mac to copy reference images.', 403)
  }
  if (req.get('Sec-Fetch-Site') === 'cross-site') throw new YouTubeError('Copy images from the Studio window.', 403)
}
let previousDirectory: string | null = null
let clipboardQueue: Promise<unknown> = Promise.resolve()
interface ClipboardDependencies { platform: NodeJS.Platform; write: (files: string[]) => Promise<unknown> }
export function copyReferenceFiles(store: YouTubeStore, seriesId: string, requestId: string, dependencies: ClipboardDependencies = { platform: process.platform, write: (files: string[]) => execute('/usr/bin/osascript', ['-l', 'JavaScript', '-e', COPY_FILES, ...files], { timeout: 15_000, maxBuffer: 16_384 }) }) {
  const result = clipboardQueue.then(() => copyFiles(store, seriesId, requestId, dependencies))
  clipboardQueue = result.catch(() => undefined)
  return result
}
async function copyFiles(store: YouTubeStore, seriesId: string, requestId: string, dependencies: ClipboardDependencies) {
  if (dependencies.platform !== 'darwin') throw new YouTubeError('Copying several reference images is available in local Studio on macOS. Use the reference pack on this device.', 501)
  const workspace = await store.openWorkspace(seriesId)
  const request = workspace.thumbnails.requests.find(item => item.id === requestId)
  if (!request) throw new YouTubeError('Thumbnail request not found for this series.', 404)
  if (!request.references.length || request.references.length > 10) throw new YouTubeError('This request needs between one and ten saved references.')
  // Read/verify every snapshot before touching the clipboard. Include the base for edits.
  const files = await Promise.all(request.references.map(async (ref, i) => ({ name: `reference-${i + 1}.png`, bytes: await store.thumbnailMedia(seriesId, ref.id) })))
  if (request.parentId) files.push({ name: 'base-thumbnail.png', bytes: await store.thumbnailMedia(seriesId, request.parentId) })
  // Finder-style file clipboard needs durable files until the user pastes them.
  // A private OS temp folder outlives this HTTP call and doesn't expose source paths.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-youtube-clipboard-'))
  const paths = files.map(file => path.join(directory, file.name))
  try {
    for (let i = 0; i < files.length; i++) await fs.writeFile(paths[i], files[i].bytes, { mode: 0o600, flag: 'wx' })
    await dependencies.write(paths)
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true })
    if (error instanceof YouTubeError) throw error
    throw new YouTubeError('macOS could not copy these images. Try again, or download the reference pack.', 503)
  }
  const previous = previousDirectory; previousDirectory = directory
  if (previous) await fs.rm(previous, { recursive: true, force: true }).catch(() => undefined)
  return { count: files.length, includesBase: Boolean(request.parentId) }
}
