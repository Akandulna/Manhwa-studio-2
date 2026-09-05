/**
 * The manual pointer loop, as two reusable pieces.
 *
 * Detection can run in-app against Gemini, but the loop that actually works best is
 * manual: paste the guidelines into a chat that already holds the chapter's pages,
 * and bring the JSON back. That loop appears in two places — the Narration Studio's
 * manual tab (Steps 3 and 4, right after the script steps, because the chat there is
 * already holding the pages) and the Image Clipper 2.0 workspace (where the result
 * can be checked against the artwork immediately).
 *
 * Both surfaces need identical behaviour and very different layouts, so what is
 * shared here is the behaviour, not the chrome:
 *
 *   CopyPointerPromptButton — fetches the server-composed prompt and copies it
 *   PointerJsonDrop         — drag/drop, file picker or paste, then imports
 *
 * The prompt is composed server-side (GET /clipper2/prompt) rather than assembled
 * here, so the two surfaces can never drift into copying different bytes.
 */

import { useCallback, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import { Copy, Check, Upload, Loader2, AlertTriangle, FileJson, Wrench } from 'lucide-react'
import {
  clipper2Api,
  type Clipper2Issue,
  type Clipper2PointSet,
  type Clipper2Validation
} from '@/lib/api'

// ============ Copy the prompt ============

interface CopyPointerPromptButtonProps {
  size?: 'default' | 'sm' | 'lg'
  variant?: 'default' | 'outline' | 'secondary' | 'ghost'
  className?: string
  label?: string
  /** Told the guidelines' state so a caller can warn when the document is missing. */
  onLoaded?: (info: { guidelinesPresent: boolean; chars: number }) => void
}

export function CopyPointerPromptButton({
  size = 'default',
  variant = 'default',
  className,
  label = 'Copy pointer prompt',
  onLoaded
}: CopyPointerPromptButtonProps) {
  const { toast } = useToast()
  const [copying, setCopying] = useState(false)
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    setCopying(true)
    try {
      // Fetched per click rather than cached: the guidelines are editable in
      // Settings, and a stale prompt would silently produce pointers judged
      // against rules the user has already replaced.
      const { prompt, guidelinesPresent } = await clipper2Api.getPrompt()
      await navigator.clipboard.writeText(prompt)
      onLoaded?.({ guidelinesPresent, chars: prompt.length })
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
      toast({
        title: 'Prompt copied',
        description: guidelinesPresent
          ? `${prompt.length.toLocaleString()} characters — paste it into the chat holding this chapter's pages.`
          : 'The guidelines document is missing, so only the instruction line was copied. Restore it in Settings → Crop Pointers.'
      })
    } catch (error) {
      toast({
        title: 'Copy failed',
        description: error instanceof Error ? error.message : 'Could not copy the prompt',
        variant: 'destructive'
      })
    } finally {
      setCopying(false)
    }
  }, [onLoaded, toast])

  return (
    <Button size={size} variant={variant} className={className} onClick={handleCopy} disabled={copying}>
      {copying ? (
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
      ) : copied ? (
        <Check className="h-4 w-4 mr-2" />
      ) : (
        <Copy className="h-4 w-4 mr-2" />
      )}
      {copied ? 'Copied' : label}
    </Button>
  )
}

// ============ Bring the JSON back ============

interface PointerJsonDropProps {
  chapterId: string
  /** Fired with the freshly imported set so the host can re-render its viewer. */
  onImported?: (set: Clipper2PointSet, repairs: Clipper2Issue[]) => void
  /** Warn before replacing an existing artifact. */
  hasExistingPoints?: boolean
  /** Drops the paste-a-blob textarea, for space-constrained hosts. */
  compact?: boolean
}

export function PointerJsonDrop({
  chapterId,
  onImported,
  hasExistingPoints = false,
  compact = false
}: PointerJsonDropProps) {
  const { toast } = useToast()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [dragging, setDragging] = useState(false)
  const [importing, setImporting] = useState(false)
  const [pasted, setPasted] = useState('')
  const [repairs, setRepairs] = useState<Clipper2Issue[]>([])
  const [failure, setFailure] = useState<{ message: string; validation: Clipper2Validation | null } | null>(null)

  const runImport = useCallback(
    async (content: string, origin: string) => {
      if (!content.trim()) {
        toast({ title: 'Nothing to import', description: 'The file or paste was empty', variant: 'destructive' })
        return
      }
      if (
        hasExistingPoints &&
        !window.confirm('This replaces the pointer file this chapter already has. Continue?')
      ) {
        return
      }

      setImporting(true)
      setFailure(null)
      setRepairs([])
      try {
        const result = await clipper2Api.importPoints(chapterId, content)
        if (!result.ok) {
          setFailure({ message: result.message, validation: result.validation })
          toast({ title: 'Import rejected', description: result.message, variant: 'destructive' })
          return
        }

        setRepairs(result.repairs)
        setPasted('')
        onImported?.(result.set, result.repairs)

        const cropCount = result.set.file?.crops.length ?? 0
        toast({
          title: `Imported ${cropCount} crop${cropCount === 1 ? '' : 's'}`,
          description: result.repairs.length
            ? `From ${origin} — ${result.repairs.length} adjustment${result.repairs.length === 1 ? '' : 's'} applied, listed below.`
            : `From ${origin} — no adjustments needed.`
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Import failed'
        setFailure({ message, validation: null })
        toast({ title: 'Import failed', description: message, variant: 'destructive' })
      } finally {
        setImporting(false)
      }
    },
    [chapterId, hasExistingPoints, onImported, toast]
  )

  const readFile = useCallback(
    async (file: File) => {
      try {
        await runImport(await file.text(), file.name)
      } catch {
        toast({ title: 'Could not read file', description: file.name, variant: 'destructive' })
      }
    },
    [runImport, toast]
  )

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      setDragging(false)
      const file = event.dataTransfer.files?.[0]
      if (file) {
        void readFile(file)
        return
      }
      // A drag straight out of a chat window carries text, not a file.
      const text = event.dataTransfer.getData('text')
      if (text) void runImport(text, 'the dropped text')
    },
    [readFile, runImport]
  )

  return (
    <div className="space-y-3">
      <div
        onDragOver={e => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`rounded-lg border-2 border-dashed transition-colors cursor-pointer ${
          compact ? 'p-4' : 'p-8'
        } ${
          dragging
            ? 'border-primary bg-primary/10'
            : 'border-muted-foreground/25 hover:border-muted-foreground/50 bg-muted/20'
        }`}
      >
        <div className="flex flex-col items-center justify-center gap-2 text-center pointer-events-none">
          {importing ? (
            <Loader2 className={`${compact ? 'h-5 w-5' : 'h-8 w-8'} animate-spin text-muted-foreground`} />
          ) : (
            <Upload className={`${compact ? 'h-5 w-5' : 'h-8 w-8'} text-muted-foreground`} />
          )}
          <p className={`${compact ? 'text-xs' : 'text-sm'} font-medium`}>
            {importing ? 'Importing…' : 'Drop crop_points.json here'}
          </p>
          {!compact && (
            <p className="text-xs text-muted-foreground">
              or click to browse — the AI's raw reply works too, fences and all
            </p>
          )}
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json,.txt"
        className="hidden"
        onChange={e => {
          const file = e.target.files?.[0]
          if (file) void readFile(file)
          // Reset so re-picking the same filename fires onChange again.
          e.target.value = ''
        }}
      />

      {!compact && (
        <div className="space-y-2">
          <Textarea
            value={pasted}
            onChange={e => setPasted(e.target.value)}
            placeholder="…or paste the AI's reply here"
            className="font-mono text-xs min-h-[100px]"
            spellCheck={false}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={!pasted.trim() || importing}
            onClick={() => void runImport(pasted, 'the pasted reply')}
          >
            {importing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <FileJson className="h-4 w-4 mr-2" />}
            Import pasted JSON
          </Button>
        </div>
      )}

      <ImportFeedback repairs={repairs} failure={failure} />
    </div>
  )
}

// ============ What the import did, or why it refused ============

function IssueLine({ issue }: { issue: Clipper2Issue }) {
  return (
    <div className="flex gap-2 text-xs">
      {issue.rule && (
        <Badge variant="outline" className="shrink-0 font-mono text-[10px] px-1 py-0">
          {issue.rule}
        </Badge>
      )}
      <span className="text-muted-foreground">{issue.message}</span>
    </div>
  )
}

function ImportFeedback({
  repairs,
  failure
}: {
  repairs: Clipper2Issue[]
  failure: { message: string; validation: Clipper2Validation | null } | null
}) {
  if (failure) {
    const issues = failure.validation?.errors ?? []
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 space-y-2">
        <div className="flex items-center gap-2 text-sm font-medium text-destructive">
          <AlertTriangle className="h-4 w-4" />
          {failure.message}
        </div>
        {issues.length > 0 && (
          <div className="space-y-1">
            {issues.map((issue, i) => (
              <IssueLine key={i} issue={issue} />
            ))}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Nothing was written — the chapter still has whatever pointers it had before.
        </p>
      </div>
    )
  }

  if (repairs.length === 0) return null

  return (
    <div className="rounded-md border bg-muted/40 p-3 space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Wrench className="h-4 w-4 text-muted-foreground" />
        {repairs.length} adjustment{repairs.length === 1 ? '' : 's'} applied on import
      </div>
      <div className="space-y-1">
        {repairs.map((issue, i) => (
          <IssueLine key={i} issue={issue} />
        ))}
      </div>
    </div>
  )
}
