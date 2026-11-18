import { useEffect, useState } from 'react'
import { Check, Copy, FolderOpen, Loader2 } from 'lucide-react'
import { narrationApi, openFolder, type ManualPrompts, type ManualPromptStep } from '@/lib/api'
import type { NarrationLanguage } from '@/lib/narrationLanguage'
import { Button } from '@/components/ui/button'

/**
 * The phone's layered narration run as copy-paste steps, for replacement or blocked-content recovery. English pages are
 * cut into ≤2,000 px pieces in a temporary folder on the first copy; the server deletes it when the script is saved.
 */
export function ManualPromptSteps({ chapterId, language, recovery = false, onTemplate, onSourceHash }: {
  chapterId: string; language: NarrationLanguage; recovery?: boolean; onTemplate: (template: string) => void; onSourceHash?: (hash: string | null) => void
}) {
  const [steps, setSteps] = useState<ManualPromptStep[] | null>(null)
  const [slicesFolder, setSlicesFolder] = useState<string | null>(null)
  const [slicing, setSlicing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<Set<number>>(new Set())

  const apply = (value: ManualPrompts) => {
    setSteps(value.steps); setSlicesFolder(value.slicesFolder); onTemplate(value.correctionTemplate); onSourceHash?.(value.sourceSha256)
  }
  useEffect(() => {
    let live = true
    setSteps(null); setSlicesFolder(null); setError(null); setCopied(new Set())
    narrationApi.getManualPrompts(chapterId, language)
      .then(value => { if (live) apply(value) })
      .catch(e => { if (live) setError(e instanceof Error ? e.message : 'Could not build the prompts') })
    return () => { live = false }
  }, [chapterId, language, onTemplate, onSourceHash])

  /** Cuts the pages, then copies batch 1. The clipboard write starts inside the click so it survives the wait. */
  const sliceAndCopy = async () => {
    setSlicing(true); setError(null)
    const prepared = narrationApi.sliceManualPages(chapterId)
    const firstPrompt = prepared.then(value => value.steps.find(s => s.attach?.length)?.prompt ?? '')
    firstPrompt.catch(() => {})
    let done = false
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': firstPrompt.then(text => new Blob([text], { type: 'text/plain' })) })])
      done = true
    } catch { /* cutting failed (reported below) or this browser needs a plain write */ }
    try {
      const value = await prepared
      apply(value)
      const first = value.steps.findIndex(s => s.attach?.length)
      if (!done) done = await navigator.clipboard.writeText(value.steps[first]?.prompt ?? '').then(() => true, () => false)
      setCopied(done && first >= 0 ? new Set([first]) : new Set())
      if (!done) setError('Pages are cut. Copy batch 1’s prompt again.')
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not cut the pages') }
    finally { setSlicing(false) }
  }

  const copy = async (index: number) => {
    if (steps![index].slice) return sliceAndCopy()
    try {
      await navigator.clipboard.writeText(steps![index].prompt)
      setCopied(prev => new Set(prev).add(index))
    } catch { setError('Could not copy to the clipboard') }
  }

  if (error) return <p role="alert" className="text-sm text-destructive">{error}</p>
  if (!steps) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Building prompts…</div>

  return <div className="space-y-2">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm font-medium">Step-by-step prompts · send them in order in one chat</p>
      {slicesFolder && <Button variant="outline" size="sm" onClick={() => void openFolder(slicesFolder).catch(() => setError('Could not open the sliced pages folder'))}>
        <FolderOpen className="h-4 w-4 mr-1" />Open sliced pages
      </Button>}
    </div>
    <p className="text-xs text-muted-foreground">{language === 'hi'
      ? `${recovery ? 'Use the retained conversation or a fresh chat.' : 'Use a fresh chat.'} The first prompt includes the saved English script; no image attachments are needed.`
      : `${recovery ? 'Use the retained conversation or a fresh chat' : 'Use a fresh chat'} in an image-capable chatbot. Pages are attached as pieces of at most 2,000 px from a temporary folder, deleted when the script is saved.`} Keep every step in the same chat; only the last reply is pasted here.</p>
    <ol className="space-y-2">
      {steps.map((step, index) => <li key={index} className={`rounded-md border p-2 ${step.final ? 'border-primary/50' : ''}`}>
        <div className="flex items-start gap-2">
          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">{copied.has(index) ? <Check className="h-3 w-3" /> : index + 1}</span>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">{step.title}</p>
              <Button size="sm" variant={copied.has(index) ? 'ghost' : 'secondary'} disabled={slicing} onClick={() => void copy(index)}>
                {step.slice && slicing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : copied.has(index) ? <Check className="h-4 w-4 mr-1" /> : <Copy className="h-4 w-4 mr-1" />}
                {step.slice && slicing ? 'Cutting pages…' : copied.has(index) ? 'Copied' : 'Copy prompt'}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{step.note}</p>
            {step.attach && <p className="text-xs break-all"><span className="text-muted-foreground">Attach: </span>{step.attach.join(', ')}</p>}
            {step.prompt && <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">Show prompt</summary>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-sans">{step.prompt}</pre>
            </details>}
          </div>
        </div>
      </li>)}
    </ol>
  </div>
}
