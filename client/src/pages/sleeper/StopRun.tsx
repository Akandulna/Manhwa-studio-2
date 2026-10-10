/**
 * Stop, as Sleeper-Cell asks it on the phone: stop right now, or let the run
 * finish the pages, chapter or splits it's on and then stop ("run_finish" on
 * the relay). Once a run is stopping, only stopping right now is left. Builds
 * that can't finish first (no `automation.stopAfter`) only stop now.
 */

import { Loader2, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { PhoneOverviewRun } from '@/lib/api'

/** What stopping means for what's going: the phone's own wording (confirmStop in MainActivity). */
export interface StopChoice {
  /** It already stops once what it's on is done. */
  stopping: boolean
  /** The finish-first button. */
  after: string
  message: string
  stoppingMessage: string
  /** Shown on the card while it's stopping. */
  stoppingLabel: string
}

/** For one phone: its clipper pages (`pages`, with `clipperStopping`), else its first run. Null when nothing runs. */
export function stopChoice(pages: number, runs: PhoneOverviewRun[], clipperStopping: boolean): StopChoice | null {
  if (pages > 0) {
    const one = pages === 1
    return {
      stopping: clipperStopping,
      after: one ? 'Finish this page, then stop' : 'Finish these pages, then stop',
      message: 'Stop right now, or let the run finish the pages it’s on first? No new page is started.',
      stoppingMessage: `Image Clipper stops once the ${one ? 'page' : 'pages'} it’s on ${one ? 'is' : 'are'} finished. Stop right now instead?`,
      stoppingLabel: one ? 'Stops after this page' : 'Stops after these pages'
    }
  }
  const run = runs[0]
  if (!run) return null
  if (run.kind === 'voiceover') {
    return {
      stopping: run.stopping,
      after: 'Finish these splits, then stop',
      message: 'Stop right now, or let the splits it’s voicing finish and be saved first?',
      stoppingMessage: 'The run stops once the splits it’s voicing are saved. Stop right now instead?',
      stoppingLabel: 'Stops after these splits'
    }
  }
  const chapter = run.kind === 'editor' ? 'the chapter it’s on' : 'the chapter it’s writing'
  return {
    stopping: run.stopping,
    after: 'Finish this chapter, then stop',
    message: `Stop right now, or let ${chapter} finish and be saved first?`,
    stoppingMessage: `The run stops once ${chapter} is saved. Stop right now instead?`,
    stoppingLabel: 'Stops after this chapter'
  }
}

/** For every phone at once: finish first only says "what they're on". */
export function stopAllChoice(choices: StopChoice[]): StopChoice | null {
  if (!choices.length) return null
  if (choices.length === 1) return choices[0]
  return {
    stopping: choices.every(c => c.stopping),
    after: 'Finish what they’re on, then stop',
    message: 'Stop every phone right now, or let each finish the pages, chapter or splits it’s on first?',
    stoppingMessage: 'Every phone stops once what it’s on is done. Stop them right now instead?',
    stoppingLabel: 'Stopping after what they’re on'
  }
}

export function StopRunDialog({ open, onOpenChange, where, choice, canFinish, sending, onStop }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** "Nord", "every phone". */
  where: string
  choice: StopChoice
  canFinish: boolean
  /** Which stop is on its way, if one is. */
  sending: 'now' | 'after' | null
  onStop: (after: boolean) => Promise<boolean>
}) {
  const stop = async (after: boolean) => {
    if (await onStop(after)) onOpenChange(false)
  }
  const message = !canFinish
    ? 'This Sleeper-Cell build can only stop the run right now. Update it to let the run finish what it’s on first.'
    : choice.stopping ? choice.stoppingMessage : choice.message
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Stop the run on {where}?</DialogTitle>
          <DialogDescription>{message}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-wrap gap-2 sm:space-x-0">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant={canFinish && !choice.stopping ? 'outline' : 'default'} disabled={sending !== null} onClick={() => stop(false)}>
            {sending === 'now' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Square className="mr-2 h-4 w-4" />}
            Stop now
          </Button>
          {canFinish && !choice.stopping && (
            <Button disabled={sending !== null} onClick={() => stop(true)}>
              {sending === 'after' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {choice.after}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
