import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import sharp from 'sharp'

const workspace = fileURLToPath(new URL('../../../', import.meta.url))
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const effects = ['zoom-in', 'zoom-out', 'pan-up', 'pan-down', 'pan-left', 'pan-right']
export interface ShortShot {
  id: string; start: number; end: number; narration: string; caption: string
  note: string; motion: string; images: string[]
}
export interface ShortProject {
  id: string; revision: string; folder: string; timelineFile: string; title: string
  series: string; language: string; duration: number; shots: ShortShot[]
  audioFile: string | null; missingImages: string[]; warnings: string[]
}
export interface ShortPreviewJob {
  id: string; projectId: string; revision: string
  state: 'rendering' | 'complete' | 'failed' | 'cancelled'
  progress: number; message: string; videoUrl?: string
}
interface LoadedProject { view: ShortProject; images: Map<string, string>; audio: string | null }
interface Job { view: ShortPreviewJob; controller: AbortController; output: string }

function range(value: unknown): [number, number] {
  if (typeof value !== 'string') throw new Error('Each shot needs a timeline range.')
  const parts = value.split(/\s*[-–]\s*/)
  if (parts.length !== 2) throw new Error(`Invalid timeline: ${value}`)
  const numbers = parts.map(stamp => {
    if (!/^\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?$/.test(stamp.trim())) throw new Error(`Invalid timestamp: ${stamp}`)
    const fields = stamp.trim().split(':').map(Number)
    if (fields.slice(1).some(n => n >= 60)) throw new Error(`Invalid timestamp: ${stamp}`)
    return fields.reduce((total, field) => total * 60 + field, 0)
  })
  return [numbers[0], numbers[1]]
}

/** Reject both lexical traversal and symlinks escaping the explicitly loaded folder. */
async function inside(folder: string, relative: string): Promise<string> {
  if (!relative || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(p => p === '..' || p.startsWith('.'))) {
    throw new Error(`Unsafe package path: ${relative}`)
  }
  const target = await fs.realpath(path.join(folder, relative))
  if (!target.startsWith(folder + path.sep)) throw new Error(`Package asset leaves its folder: ${relative}`)
  if (!(await fs.stat(target)).isFile()) throw new Error(`Not a file: ${relative}`)
  return target
}

export class ShortsService {
  private projects = new Map<string, LoadedProject>()
  private jobs = new Map<string, Job>()
  constructor(readonly exportsRoot = path.join(workspace, 'exports'), readonly cacheRoot = path.join(workspace, 'server/private/shorts-previews')) {}

  async discover() {
    const entries = await fs.readdir(this.exportsRoot, { withFileTypes: true }).catch(() => [])
    const packages: { folder: string; name: string }[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const folder = path.join(this.exportsRoot, entry.name)
      if ((await fs.readdir(folder)).some(f => f.endsWith('.timeline.json') || f.endsWith('.editor2.json'))) packages.push({ folder, name: entry.name })
    }
    return packages.sort((a, b) => a.name.localeCompare(b.name))
  }

  async load(input: unknown): Promise<ShortProject> {
    if (typeof input !== 'string' || !input.trim()) throw new Error('Enter the folder containing your timeline JSON and crops3 images.')
    const folder = await fs.realpath(path.resolve(workspace, input.trim())).catch(() => { throw new Error('Folder not found. Enter a folder on the computer running Studio.') })
    if (!(await fs.stat(folder)).isDirectory()) throw new Error('Choose a folder, rather than a JSON or ZIP file.')
    const names = (await fs.readdir(folder)).sort()
    const candidates = names.filter(f => f.endsWith('.timeline.json'))
    const minimal = names.filter(f => f.endsWith('.editor2.json'))
    if (candidates.length > 1 || (!candidates.length && minimal.length > 1)) throw new Error('This folder has multiple timelines. Put each Short in its own folder.')
    const timelineFile = candidates[0] || minimal[0]
    if (!timelineFile) throw new Error('No .timeline.json or .editor2.json file found in this folder.')
    const timelinePath = await inside(folder, timelineFile)
    if ((await fs.stat(timelinePath)).size > 5_000_000) throw new Error('Timeline JSON is too large (maximum 5 MB).')
    const raw = await fs.readFile(timelinePath, 'utf8')
    let doc: any
    try { doc = JSON.parse(raw) } catch { throw new Error('The timeline file contains invalid JSON.') }
    if (!Array.isArray(doc?.sections) || doc.sections.length !== 1 || !Array.isArray(doc.sections[0]?.timelines)) throw new Error('A Short needs one section with a timelines array.')
    const slots = doc.sections[0].timelines
    if (!slots.length || slots.length > 200) throw new Error('A Short must contain between 1 and 200 shots.')
    let cursor = 0
    const shots: ShortShot[] = slots.map((slot: any, index: number) => {
      const [start, end] = range(slot?.timeline)
      if (Math.abs(start - cursor) > 0.011 || end <= start || end - start < 1 / 30) throw new Error(`Shot ${index + 1}: timings must be continuous, start at 00:00, and last at least one frame.`)
      cursor = end
      const images = slot.selectedImages
      if (!Array.isArray(images) || !images.length || images.length > 10 || images.some((x: unknown) => typeof x !== 'string' || !/\.(png|jpe?g|webp)$/i.test(x as string) || path.basename(x as string) !== x)) throw new Error(`Shot ${index + 1}: select 1–10 image filenames from crops3.`)
      const text = (value: unknown) => typeof value === 'string' ? value.slice(0, 2000) : ''
      return { id: `shot-${index + 1}`, start, end, images, narration: text(slot.narration), caption: text(slot.on_screen_text), note: text(slot.edit_note), motion: effects.includes(slot.motion?.effect) ? slot.motion.effect : 'zoom-in' }
    })
    if (cursor > 180) throw new Error('Shorts previews support up to 180 seconds.')
    if (doc.duration_seconds !== undefined && (!Number.isFinite(doc.duration_seconds) || Math.abs(doc.duration_seconds - cursor) > 0.02)) throw new Error('The declared duration does not match the end of the timeline.')
    const digest = createHash('sha256').update(raw).update('shorts-preview-v1')
    const images = new Map<string, string>()
    const missingImages: string[] = []
    for (const filename of new Set(shots.flatMap(s => s.images))) {
      try {
        const imagePath = await inside(folder, `crops3/${filename}`)
        const bytes = await fs.readFile(imagePath)
        const meta = await sharp(bytes, { limitInputPixels: 80_000_000 }).metadata()
        if (!meta.width || !meta.height) throw new Error('Invalid image')
        digest.update(filename).update(hash(bytes))
        images.set(filename, imagePath)
      } catch (error) {
        if ((error as Error).message.includes('leaves its folder')) throw error
        missingImages.push(filename)
      }
    }
    const audioFiles = names.filter(name => /^(voiceover|narration)(?:\.[a-z]{2})?\.(wav|mp3|m4a|aac|ogg)$/i.test(name))
    const preferred = audioFiles.find(f => f.startsWith(`voiceover.${doc.language || 'en'}.`)) || audioFiles[0]
    const audio = preferred ? await inside(folder, preferred) : null
    if (audio) digest.update(hash(await fs.readFile(audio)))
    const warnings: string[] = []
    if (!audio) warnings.push('Silent preview: add voiceover.en.wav, voiceover.mp3, or narration.wav to this folder, then reload to include narration.')
    if (audioFiles.length > 1) warnings.push(`Using ${preferred}. Other recordings in the folder are ignored.`)
    if (!shots.some(s => s.caption)) warnings.push('This timeline has no on-screen captions.')
    const id = hash(folder).slice(0, 24)
    const view: ShortProject = { id, revision: digest.digest('hex'), folder, timelineFile, title: typeof doc.title === 'string' ? doc.title : path.basename(folder), series: typeof doc.series === 'string' ? doc.series : '', language: typeof doc.language === 'string' ? doc.language : 'en', duration: cursor, shots, audioFile: preferred || null, missingImages, warnings }
    this.projects.set(id, { view, images, audio })
    return view
  }

  project(id: string) { const p = this.projects.get(id); if (!p) throw new Error('Load the Short folder first.'); return p }
  async image(id: string, filename: string) {
    const project = this.project(id)
    if (!project.images.has(filename)) throw new Error('Image is not in this Short.')
    return inside(project.view.folder, `crops3/${filename}`)
  }
  getJob(id: string) { const job = this.jobs.get(id); if (!job) throw new Error('Preview job not found.'); return job }
  async latest(id: string): Promise<ShortPreviewJob | null> {
    const project = this.project(id)
    const latest = [...this.jobs.values()].reverse().find(j => j.view.projectId === id && j.view.revision === project.view.revision)
    if (latest) return latest.view
    const output = path.join(this.cacheRoot, `${project.view.revision}.mp4`)
    if (!await fs.stat(output).then(s => s.isFile() && s.size > 0).catch(() => false)) return null
    // Reconnect a completed preview after a server restart without re-rendering.
    const jobId = randomUUID()
    const view: ShortPreviewJob = { id: jobId, projectId: id, revision: project.view.revision, state: 'complete', progress: 100, message: 'Preview ready.', videoUrl: `/api/shorts/previews/${jobId}/video` }
    this.jobs.set(jobId, { view, controller: new AbortController(), output })
    return view
  }
  cancel(id: string) {
    const job = this.getJob(id)
    if (job.view.state === 'rendering') { job.controller.abort(); job.view.state = 'cancelled'; job.view.message = 'Preview cancelled.' }
    return job.view
  }
  async start(id: string, revision: unknown): Promise<ShortPreviewJob> {
    const current = this.project(id)
    if (revision !== current.view.revision) throw new Error('The folder changed. Reload before generating a preview.')
    const fresh = await this.load(current.view.folder)
    if (fresh.revision !== revision) throw new Error('The folder changed. Reload before generating a preview.')
    if (fresh.missingImages.length) throw new Error('Restore the missing images before generating a preview.')
    const active = [...this.jobs.values()].find(j => j.view.state === 'rendering')
    if (active) {
      if (active.view.projectId === id && active.view.revision === revision) return active.view
      throw new Error('Another Shorts preview is rendering. Wait for it to finish or cancel it first.')
    }
    await fs.mkdir(this.cacheRoot, { recursive: true })
    const output = path.join(this.cacheRoot, `${fresh.revision}.mp4`)
    const cached = await fs.stat(output).then(s => s.isFile() && s.size > 0).catch(() => false)
    const jobId = randomUUID()
    const view: ShortPreviewJob = { id: jobId, projectId: id, revision: fresh.revision, state: cached ? 'complete' : 'rendering', progress: cached ? 100 : 0, message: cached ? 'Preview ready.' : 'Preparing vertical preview…', ...(cached ? { videoUrl: `/api/shorts/previews/${jobId}/video` } : {}) }
    const job = { view, controller: new AbortController(), output }
    // Bound retained job metadata; cached MP4s remain reusable after reloads.
    for (const [key, old] of this.jobs) if (this.jobs.size >= 50 && old.view.state !== 'rendering') this.jobs.delete(key)
    this.jobs.set(jobId, job)
    if (!cached) void this.render(this.project(id), job)
    return view
  }

  private async render(project: LoadedProject, job: Job) {
    let temp: string | undefined
    try {
      temp = await fs.mkdtemp(path.join(this.cacheRoot, 'render-'))
      const segments: string[] = []
      const uses = project.view.shots.reduce((sum, s) => sum + s.images.length, 0)
      let done = 0
      for (const shot of project.view.shots) {
        const shotStart = Math.round(shot.start * 30), shotEnd = Math.round(shot.end * 30)
        for (let index = 0; index < shot.images.length; index++) {
          job.controller.signal.throwIfAborted()
          const frames = Math.round((index + 1) * (shotEnd - shotStart) / shot.images.length) - Math.round(index * (shotEnd - shotStart) / shot.images.length)
          if (frames < 1) throw new Error('Too many selected images for the shot duration.')
          const image = await inside(project.view.folder, `crops3/${shot.images[index]}`)
          const still = path.join(temp, `${done}-image.png`), caption = path.join(temp, `${done}-caption.png`)
          await composeShortFrame(image, still, caption, shot.caption)
          const segment = path.join(temp, `${done}.mp4`)
          job.view.message = `Rendering shot ${project.view.shots.indexOf(shot) + 1} of ${project.view.shots.length}…`
          const graph = `[0:v]${shortMotion(shot.motion, frames)}[motion];[motion][1:v]overlay=0:0:format=auto,format=yuv420p[v]`
          await runFfmpeg(['-i', still, '-i', caption, '-filter_complex', graph, '-map', '[v]', '-frames:v', String(frames), '-r', '30', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-threads', '2', segment], job.controller.signal)
          segments.push(segment)
          done++
          job.view.progress = Math.round(done / uses * 92)
        }
      }
      const concat = path.join(temp, 'segments.txt')
      await fs.writeFile(concat, segments.map(f => `file '${path.basename(f)}'`).join('\n'))
      const assembled = path.join(temp, 'preview.mp4')
      const audio = project.audio ? await inside(project.view.folder, project.view.audioFile!) : null
      job.view.message = 'Finishing preview…'
      await runFfmpeg(['-f', 'concat', '-safe', '1', '-i', concat,
        ...(audio ? ['-i', audio] : []), '-map', '0:v:0', '-c:v', 'copy',
        ...(audio ? ['-map', '1:a:0', '-af', 'apad', '-c:a', 'aac', '-b:a', '128k'] : ['-an']),
        '-t', String(Math.round(project.view.duration * 30) / 30), '-movflags', '+faststart', assembled], job.controller.signal)
      job.controller.signal.throwIfAborted()
      await fs.rename(assembled, job.output)
      Object.assign(job.view, { state: 'complete', progress: 100, message: 'Preview ready.', videoUrl: `/api/shorts/previews/${job.view.id}/video` })
    } catch (error) {
      job.view.state = job.controller.signal.aborted ? 'cancelled' : 'failed'
      job.view.message = job.controller.signal.aborted ? 'Preview cancelled.' : (error as Error).message
    } finally { if (temp) await fs.rm(temp, { recursive: true, force: true }).catch(() => {}) }
  }
}

const escapeXml = (s: string) => s.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]!))
export function captionLines(text: string): string[] {
  const words = text.trim().split(/\s+/)
  const lines: string[] = []; let line = ''
  for (const word of words) {
    if (line && (line + ' ' + word).length > 25) { lines.push(line); line = '' }
    line += (line ? ' ' : '') + word
  }
  if (line) lines.push(line)
  return lines
}

/** Sharp handles text so preview rendering works with FFmpeg builds without drawtext. */
async function composeShortFrame(image: string, target: string, caption: string, text: string) {
  const bg = await sharp(image).rotate().resize(540, 960, { fit: 'cover' }).blur(20).modulate({ brightness: 0.45 }).png().toBuffer()
  const fg = await sharp(image).rotate().resize(540, 880, { fit: 'inside', withoutEnlargement: false }).png().toBuffer({ resolveWithObject: true })
  await sharp(bg).composite([{ input: fg.data, left: Math.floor((540 - fg.info.width) / 2), top: Math.floor((960 - fg.info.height) / 2) }]).png().toFile(target)
  const lines = captionLines(text)
  const fontSize = Math.min(30, 450 / Math.max(1, ...lines.map(l => l.length)) / 0.65, 110 / Math.max(1, lines.length))
  const height = lines.length * fontSize * 1.3 + 30
  const svg = `<svg width="540" height="960" xmlns="http://www.w3.org/2000/svg">${text ? `<rect x="35" y="${770 - height / 2}" width="440" height="${height}" rx="14" fill="#090d18" fill-opacity=".9"/>${lines.map((line, i) => `<text x="255" y="${770 - (lines.length - 1) * fontSize * 0.65 + i * fontSize * 1.3}" text-anchor="middle" dominant-baseline="central" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="bold" fill="${i === 0 ? '#facc15' : '#ffffff'}">${escapeXml(line)}</text>`).join('')}` : ''}</svg>`
  await sharp(Buffer.from(svg)).png().toFile(caption)
}

export function shortMotion(effect: string, frames: number) {
  const progress = `on/${Math.max(1, frames - 1)}`
  const centerX = 'iw/2-iw/zoom/2', centerY = 'ih/2-ih/zoom/2'
  let z = `1+0.06*${progress}`, x = centerX, y = centerY
  if (effect === 'zoom-out') z = `1.06-0.06*${progress}`
  if (effect.startsWith('pan-')) {
    z = '1.06'
    if (effect === 'pan-up' || effect === 'pan-down') y = `(ih-ih/zoom)*${effect === 'pan-up' ? `(1-${progress})` : progress}`
    else x = `(iw-iw/zoom)*${effect === 'pan-left' ? `(1-${progress})` : progress}`
  }
  return `scale=810:1440,zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=540x960:fps=30,setsar=1`
}

async function runFfmpeg(args: string[], signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-filter_complex_threads', '1', ...args], { signal })
    let stderr = ''
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000) })
    child.once('error', error => reject(new Error(error.message.includes('ENOENT') ? 'FFmpeg was not found. Install FFmpeg or set FFMPEG_PATH, then try again.' : error.message)))
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`Preview render failed: ${stderr || `FFmpeg exited ${code}`}`)))
  })
}

export const shortsService = new ShortsService()
