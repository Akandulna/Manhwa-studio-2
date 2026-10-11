/**
 * Puts Editor 2.0 packages on the phone the moment a chapter is ready for its
 * timeline JSON, so they show in Sleeper-Cell's Editor 2.0 without a Send to
 * phone (publishReadyEditorPackages in phoneEditor.ts does the sending).
 *
 * A chapter gets ready when its last piece lands: its alignment document is
 * written (every section aligned) or it's cut to crops3/ (which needs its
 * review). Those call queueEditorPublish; so does clearing a chapter's paste,
 * which makes it need one again. Calls within a few seconds of each other go
 * out as one check, and checks run one after another. Startup checks every
 * chapter once, for anything that got ready while the server was down.
 *
 * A leaf module, imported by alignment and Clipper 3.0 without pulling in the
 * editor's own imports: phoneEditor.ts is loaded when the first check runs.
 */

/** Long enough for a chapter's sections to finish aligning one after another. */
const DEBOUNCE_MS = 5_000
const STARTUP_DELAY_MS = 30_000

let queuedChapters = new Set<string>()
let queuedAll = false
let timer: ReturnType<typeof setTimeout> | null = null
let chain: Promise<void> = Promise.resolve()

/** Checks `chapterId` (every chapter, with 'all') for a package to send, a few seconds from now. */
export function queueEditorPublish(chapterId: string | 'all'): void {
  if (chapterId === 'all') queuedAll = true
  else queuedChapters.add(chapterId)
  if (timer) clearTimeout(timer)
  timer = setTimeout(flush, DEBOUNCE_MS)
  timer.unref?.()
}

function flush(): void {
  timer = null
  const chapterIds = queuedAll ? null : [...queuedChapters]
  queuedAll = false
  queuedChapters = new Set()
  chain = chain.then(async () => {
    const { publishReadyEditorPackages } = await import('./phoneEditor.js')
    const result = await publishReadyEditorPackages(chapterIds)
    if (result.sent.length > 0) {
      console.log(`[editor2] sent ${result.sent.length} package(s) to the phone: ` +
        result.sent.map(s => `ch ${s.number}${s.language === 'en' ? '' : ` (${s.language})`}`).join(', '))
    }
    for (const failure of result.failed) {
      console.error(`[editor2] sending chapter ${failure.chapterId} (${failure.language}) to the phone failed:`, failure.error)
    }
  }).catch(error => console.error('[editor2] sending packages to the phone failed:', error instanceof Error ? error.message : error))
}

/** For startup: one check of every chapter, once the server has settled. */
export function publishEditorPackagesAtStartup(): void {
  setTimeout(() => queueEditorPublish('all'), STARTUP_DELAY_MS).unref?.()
}
