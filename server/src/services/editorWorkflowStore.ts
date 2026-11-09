import {readManagedChapterAssets,assertManagedChapterRevision} from './managedChapterAssets.js'
import fs from 'fs/promises'
import path from 'path'
import { prisma } from '../index.js'
import { getChapterTimelineBundle, getChapterCropMetadataBundle, getChapterBlockers } from './videoEditor2Service.js'
import { getOutputDir, getSourceFolderPath } from './clipper3/perImageStore.js'
import type { NarrationLanguage } from './narrationLanguage.js'
import { acceptWorkflowReply, buildEditorWorkflow, digest, nextWorkflowTask, WorkflowReplyError, type WorkflowState } from './editorWorkflow.js'

const queues = new Map<string, Promise<unknown>>()
async function locked<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  const pending = previous.catch(() => {}).then(work)
  queues.set(key, pending)
  try { return await pending } finally { if (queues.get(key) === pending) queues.delete(key) }
}

/** Read-only preparation is also used by phone packages and the Chapter 4 pilot. */
export async function chapterEditorWorkflow(chapterId: string, language: NarrationLanguage) {
  const chapter = await prisma.chapter.findUnique({ where: { id: chapterId }, select: { folderPath: true } })
  if (!chapter) throw new Error('Chapter not found')
  const blockers = await getChapterBlockers(chapterId, language)
  if (blockers?.length) throw new Error(`Chapter is not ready: ${blockers.join(', ')}`)
  const managed=await readManagedChapterAssets(chapter.folderPath)
  const [timeline, metadata, names, audio] = await Promise.all([
    getChapterTimelineBundle(chapterId, language), getChapterCropMetadataBundle(chapterId), managed ? Promise.resolve(managed.assets.map(file=>file.filename)) : fs.readdir(getOutputDir(chapter.folderPath)),
    prisma.audioSection.findMany({ where: { chapterId, language }, include: { audioFile: true }, orderBy: { index: 'asc' } })
  ])
  const images = names.filter(n => /\.(png|jpe?g|webp)$/i.test(n)).sort()
  const workflow = buildEditorWorkflow(timeline?.text ?? '', metadata?.text ?? '', images, null,
    audio.map(s => ({ number: s.index + 1, durationSec: s.audioFile?.durationMs ? s.audioFile.durationMs / 1000 : null })))
  await assertManagedChapterRevision(chapter.folderPath,managed?.revision??null)
  return { workflow, folder: getSourceFolderPath(chapter.folderPath) }
}

export async function editorWorkflowSession(chapterId: string, language: NarrationLanguage,
  action?: { taskId: string; fingerprint: string; reply: string } | { reset: string }) {
  // Both languages share visual indexing. Serialize their small checkpoint writes together.
  return locked(chapterId, async () => {
    const { workflow, folder } = await chapterEditorWorkflow(chapterId, language)
    const file = path.join(folder, `.editor-stages.${language}.json`)
    const visualFile = path.join(folder, '.editor-stages.visual.json')
    const rejectionFile = path.join(folder, `.editor-stages.${language}.rejection.json`)
    const write = async (name: string, value: unknown) => {
      const temporary = `${name}.tmp`
      await fs.writeFile(temporary, JSON.stringify(value), 'utf-8'); await fs.rename(temporary, name)
    }
    const read = async (name: string): Promise<WorkflowState> => {
      try {
        const value = JSON.parse(await fs.readFile(name, 'utf-8'))
        if (!value || typeof value.replies !== 'object' || Array.isArray(value.replies) || !value.replies) throw new Error('Invalid checkpoint format')
        return value
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { replies: {} }
        throw new Error(`Cannot read staged checkpoint ${path.basename(name)}. Restore or remove the damaged checkpoint before continuing.`)
      }
    }
    const state = await read(file), visual = await read(visualFile)
    let current: WorkflowState = { replies: { ...visual.replies, ...state.replies } }
    const revision = digest(current)
    if (action) {
      if ('reset' in action) {
        if (action.reset !== revision) throw new Error('Checkpoint changed. Reload before resetting.')
        current = { replies: Object.fromEntries(Object.entries(current.replies).filter(([key]) => key.startsWith('V'))) }
      } else {
        try { current = acceptWorkflowReply(workflow, current, action.taskId, action.fingerprint, action.reply) }
        catch (e) {
          if (e instanceof WorkflowReplyError) {
            await write(rejectionFile, { taskId: e.task.id, fingerprint: e.task.fingerprint, reply: action.reply,
              error: e.message, repairPrompt: e.repairPrompt })
          }
          throw e
        }
      }
      // Save before advancing; even an unresolved review retains all completed work.
      await write(file, current)
      await write(visualFile, { replies: Object.fromEntries(Object.entries(current.replies).filter(([key]) => key.startsWith('V'))) })
      await fs.rm(rejectionFile, { force: true })
    }
    const counts = { beats: workflow.beats.length, crops: workflow.crops.length, visualGroups: workflow.scenes.length }
    try {
      const view = nextWorkflowTask(workflow, current)
      let rejection: { fingerprint: string; reply: string; error: string; repairPrompt: string } | null = null
      try { rejection = JSON.parse(await fs.readFile(rejectionFile, 'utf-8')) } catch { /* Diagnostic only; checkpoint parsing above is strict. */ }
      return { ...view, counts, revision: digest(current), sourceHash: workflow.sourceHash, error: null,
        rejection: rejection?.fingerprint === view.task?.fingerprint ? rejection : null }
    }
    catch (e) { return { task: null, completed: Object.keys(current.replies).length, warnings: [], json: null, counts, revision: digest(current), sourceHash: workflow.sourceHash, error: (e as Error).message, rejection: null } }
  })
}
