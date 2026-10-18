/**
 * PartsPanel — a series' narration Parts on the Storage page, and "Complete
 * Part": the one irreversible delete in the app.
 *
 * A Part can be completed once it is closed (its last chapter is marked
 * "Part end" in Narration) and every chapter has both its English and Hindi
 * video exported. Completing deletes everything the Part's chapters left on
 * this disk and in R2 — pages, crops, JSON, scripts, voiceover, the app's
 * chNNN_ exports — keeping only each chapter's rolling summary and closing
 * paragraph (backed up to R2), which the next Part continues from. The user's
 * own final render in the video folders is left alone.
 *
 * Confirmation is typing the series title, in a dialog (window.prompt does not
 * exist in the Electron shell).
 */

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { useToast } from '@/components/ui/use-toast'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { CompletedBadge } from '@/components/PublishedBadge'
import { AlertTriangle, Archive, Loader2, Lock } from 'lucide-react'
import { storageApi, type SeriesPart, type SeriesParts } from '@/lib/api'

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log10(bytes) / 3), units.length - 1)
  const value = bytes / Math.pow(1000, i)
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`
}

function ExportCount({ label, done, total }: { label: string; done: number; total: number }) {
  const complete = total > 0 && done === total
  return (
    <span className="flex items-center gap-1.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-medium tabular-nums ${complete ? 'text-green-500' : ''}`}>
        {done}/{total}
      </span>
      <Progress value={total > 0 ? (done / total) * 100 : 0} className="h-1.5 w-16" />
    </span>
  )
}

export function PartsPanel({ seriesId, onChanged }: { seriesId: string; onChanged: () => void }) {
  const { toast } = useToast()
  const [data, setData] = useState<SeriesParts | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<SeriesPart | null>(null)
  const [workingOnly, setWorkingOnly] = useState(false)
  const [typed, setTyped] = useState('')
  const [running, setRunning] = useState<number | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      setData(await storageApi.getParts(seriesId))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load parts')
    }
  }, [seriesId])

  useEffect(() => { load() }, [load])

  const open = (part: SeriesPart, working = false) => {
    setWorkingOnly(working)
    setTyped('')
    setConfirming(part)
  }

  const complete = async () => {
    if (!confirming || !data) return
    const part = confirming
    setConfirming(null)
    setRunning(part.number)
    try {
      if (workingOnly) {
        const result = await storageApi.cleanPartWorkingFiles(seriesId, part.number, typed)
        toast({ title: `Part ${part.number} working files deleted`, description: `Freed ${formatBytes(result.freedBytes)}. Scripts and videos kept.` })
        await load()
        onChanged()
        return
      }
      const result = await storageApi.completePart(seriesId, part.number, typed)
      toast({
        title: `Part ${part.number} completed`,
        description:
          `Freed ${formatBytes(result.localFreedBytes)} on disk and ${formatBytes(result.r2FreedBytes)} in R2 ` +
          `(${result.r2Deleted.length} object${result.r2Deleted.length === 1 ? '' : 's'}).` +
          (result.warnings.length > 0 ? ` ${result.warnings.join(' · ')}` : '')
      })
      await load()
      onChanged()
    } catch (e) {
      toast({
        title: `Part ${part.number} not completed`,
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'destructive'
      })
      await load()
    } finally {
      setRunning(null)
    }
  }

  if (error) {
    return (
      <p className="flex items-center gap-2 text-sm text-destructive">
        <AlertTriangle className="h-4 w-4" />
        {error}
      </p>
    )
  }
  if (!data) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Reading parts…
      </p>
    )
  }

  return (
    <div>
      <h3 className="flex items-center gap-2 font-semibold">
        <Archive className="h-4 w-4" />
        Parts
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        After saving a compressed video, choose its Part and delete working files to free space.
        Source pages, audio, crops and JSON are removed locally. Scripts, timelines and all videos are kept.
        Confirm that the saved video covers the chapter range shown; its filename does not determine the Part.
        This works without R2. The separate Complete &amp; delete action also removes scripts and cloud files.
      </p>
      <p className="mt-2 break-words text-xs text-muted-foreground">
        {data.compressedVideos.length ? `Compressed videos found: ${data.compressedVideos.join(', ')}` : 'No compressed video found. Add a nonempty video to compressed, Compressed or Compress inside a video folder, then Rescan.'}
      </p>
      {!data.r2Configured && (
        <p className="mt-2 flex items-center gap-2 rounded bg-amber-500/10 p-2 text-xs text-amber-600">
          <AlertTriangle className="h-3.5 w-3.5" />
          R2 isn't set up. Local working-file cleanup is available; Complete & delete requires R2.
        </p>
      )}

      {data.parts.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No downloaded chapters yet.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {data.parts.map(part => (
            <li
              key={part.number}
              className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 ${part.completed ? 'opacity-80' : ''}`}
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">Part {part.number}</span>
                  <span className="text-sm text-muted-foreground">
                    Ch {part.firstChapter}–{part.lastChapter} · {part.chapters.length} chapters
                  </span>
                  {part.completed && <CompletedBadge part={part.number} />}
                  {!part.closed && !part.completed && (
                    <span className="text-xs text-muted-foreground">(in progress)</span>
                  )}
                  {part.closed && !part.endMarked && !part.completed && (
                    <span
                      className="text-xs text-muted-foreground"
                      title="No Part end is marked in Narration, so this Part runs to the last chapter with an exported video. Mark a Part end to split it differently."
                    >
                      (up to the last exported chapter)
                    </span>
                  )}
                </div>
                {part.completed ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Completed {part.completedAt ? new Date(part.completedAt).toLocaleDateString() : ''}
                    {part.localBytes > 0 && ` · ${formatBytes(part.localBytes)} left on disk`}
                  </p>
                ) : (
                  <div className="mt-1.5 flex flex-wrap items-center gap-4">
                    <ExportCount label="English" done={part.exportedEn} total={part.chapters.length} />
                    <ExportCount label="Hindi" done={part.exportedHi} total={part.chapters.length} />
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {formatBytes(part.localBytes)} on disk
                    </span>
                  </div>
                )}
                {part.blocker && (
                  <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Lock className="h-3 w-3" />
                    {part.blocker}
                  </p>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                <Button variant="destructive" size="sm" onClick={() => open(part, true)}
                  disabled={!data.compressedVideos.length || running !== null || part.workingBytes <= 0}>
                  {running === part.number ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Delete working files · {formatBytes(part.workingBytes)}
                </Button>
              {part.closed && (!part.completed || part.localBytes > 0) && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => open(part)}
                  disabled={!data.r2Configured || running !== null || (!part.ready && !part.completed)}
                  title={part.blocker ?? undefined}
                >
                  {running === part.number
                    ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    : <Archive className="mr-2 h-4 w-4" />}
                  {part.completed ? 'Delete leftovers' : 'Complete & delete'}
                </Button>
              )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={confirming !== null} onOpenChange={o => { if (!o) setConfirming(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {workingOnly ? 'Delete working files for' : confirming?.completed ? 'Delete leftovers of' : 'Complete'} Part {confirming?.number}?
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2 text-sm">
                {workingOnly ? <>
                  <p>Part {confirming?.number}: chapters {confirming?.firstChapter}–{confirming?.lastChapter} of <b>{data.title}</b>.</p>
                  <p>Confirm your compressed video covers this entire range. Delete source pages, both languages’ audio, crops, JSON and other working files from these chapters.</p>
                  <p>Keep scripts, timelines, saved script records and all videos, including compressed videos. R2 files remain available.</p>
                  <p>This cannot be undone locally. Frees about {formatBytes(confirming?.workingBytes ?? 0)}.</p>
                </> : <>

                <p>
                  Chapters {confirming?.firstChapter}–{confirming?.lastChapter} of <b>{data.title}</b>.
                  This can't be undone. These are permanently deleted:
                </p>
                <ul className="list-disc space-y-0.5 pl-5">
                  <li>source pages, crops, crop JSON, slices and scripts</li>
                  <li>English and Hindi voiceover</li>
                  <li>the app's chNNN_ video exports (your final render stays)</li>
                  <li>the chapters' phone zips, crops, voiceover and editor files in R2</li>
                </ul>
                <p>
                  Kept: each chapter's rolling summary and closing paragraph, backed up to R2, so Part{' '}
                  {(confirming?.number ?? 0) + 1} continues the story. The chapters show as Completed everywhere.
                </p>
                {confirming && <p>About {formatBytes(confirming.localBytes)} on this disk.</p>}
                </>}
              </div>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <label className="text-sm">
              Type <b>{data.title}</b> to confirm
            </label>
            <Input value={typed} onChange={e => setTyped(e.target.value)} autoFocus />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={complete}
              disabled={typed.trim() !== data.title.trim()}
            >
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
