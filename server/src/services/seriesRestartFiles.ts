import { createHash } from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import { stripCropStory } from './seriesRestartModel.js'

const exists = async (file: string) => fs.lstat(file).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e })
export async function atomicRestartWrite(file: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = file + '.restart-tmp'
  await fs.writeFile(temp, body)
  await fs.rename(temp, file)
}
/** Same-volume renames, an immutable DB snapshot and phase markers make retries non-destructive. */
export async function archiveRestartFiles(root: string, folder: string, revision: string, chapters: string[], snapshot: unknown): Promise<string> {
  if (!folder || folder.startsWith('.') || /[/\\\0]/.test(folder) || !/^[1-9]\d*-[A-Za-z0-9_-]{1,64}$/.test(revision)) throw new Error('Invalid restart path')
  root = path.resolve(root)
  const backup = path.join(root, '.restarts', revision, folder)
  if (await exists(path.join(backup, 'files-complete.json'))) return backup
  const scoped = (relative: string) => {
    const file = path.resolve(root, relative)
    if (!file.startsWith(path.join(root, folder) + path.sep)) throw new Error('Restart path is outside this series')
    return file
  }
  for (const chapter of chapters) scoped(chapter + path.sep)
  const savedState = path.join(backup, 'state.json')
  if (!await exists(savedState)) await atomicRestartWrite(savedState, JSON.stringify(snapshot, null, 2))
  const move = async (relative: string) => {
    const source = scoped(relative)
    const stat = await exists(source)
    if (!stat) return
    if (stat.isSymbolicLink()) throw new Error('Restart cannot archive symbolic links')
    const target = path.join(backup, 'files', relative)
    if (await exists(target)) throw new Error(`Both restart backup and original exist: ${relative}`)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.rename(source, target)
  }
  const clean = async (relative: string) => {
    const dir = scoped(relative)
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return []; throw e })) {
      if (entry.isSymbolicLink()) throw new Error('Restart cannot traverse symbolic links')
      const rel = path.join(relative, entry.name)
      if (entry.isDirectory()) await clean(rel)
      else if (entry.isFile() && (entry.name.startsWith('crop-metadata-') && entry.name.endsWith('.json') || relative.endsWith('crop_metadata3') && entry.name.endsWith('.txt'))) {
        const file = scoped(rel), old = await fs.readFile(file, 'utf8'), next = stripCropStory(old)
        if (old === next) continue
        const copy = path.join(backup, 'metadata', rel)
        if (!await exists(copy)) await atomicRestartWrite(copy, old)
        await atomicRestartWrite(file, next)
      }
    }
  }
  for (const name of ['about.md', '_video2', '_video2_hi']) await move(path.join(folder, name))
  for (const name of await fs.readdir(path.join(root, folder)).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return []; throw e })) {
    if (/^Part \d+ - .*script(?:\.hi)?\.md$/i.test(name)) await move(path.join(folder, name))
  }
  for (const chapter of chapters) {
    for (const name of ['script.md', 'script.hi.md', 'continuity.json', 'continuity.hi.json', 'audio', 'audio_hi', 'script-timeline.md', 'script-timeline.hi.md', '.editor2-phone.json', '.script-replacement.json', '.script-replacement.hi.json']) await move(path.join(chapter, name))
    await clean(path.join(chapter, 'crop_metadata3'))
    await clean(path.join(chapter, 'Processed'))
  }
  await clean(path.join(folder, 'Processed'))
  await atomicRestartWrite(path.join(backup, 'files-complete.json'), JSON.stringify({ revision, folder }))
  return backup
}

/** Restarted series must link every stored crop to the current English script before Editor publication. */
export async function chapterStoryLinksCurrent(root: string, folderPath: string): Promise<boolean> {
  const dir = path.resolve(root, folderPath)
  try {
    const script = (await fs.readFile(path.join(dir, 'script.md'), 'utf8')).replace(/\r\n/g, '\n').trim()
    if (!script) return false
    const hash = createHash('sha256').update(script).digest('hex')
    const metadata = (await fs.readdir(path.join(dir, 'crop_metadata3'))).filter(n => n.endsWith('.txt'))
    if (!metadata.length) return false
    let supported = false
    for (const name of metadata) {
      const value = JSON.parse(await fs.readFile(path.join(dir, 'crop_metadata3', name), 'utf8'))
      if (value?.storyLinking?.scriptSha256 !== hash || !Array.isArray(value.crops) || !value.crops.every((c: any) => c.matchType === 'unmatched' ? Array.isArray(c.scriptRefs) && c.scriptRefs.length === 0 && !c.storyContext && !!c.reviewReason?.trim() : ['direct', 'context'].includes(c.matchType) && Array.isArray(c.scriptRefs) && c.scriptRefs.length > 0 && !!c.storyContext?.trim() && !!c.evidence?.trim() && !c.reviewReason)) return false
      if (value.crops.some((c: any) => c.matchType !== 'unmatched')) supported = true
    }
    return supported
  } catch { return false }
}
