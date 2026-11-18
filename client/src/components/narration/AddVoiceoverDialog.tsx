/**
 * Add voiceover · one chapter — attach an audio file you made yourself (any
 * TTS, or your own recording) as the chapter's whole voiceover in this
 * language. It becomes one section voicing the full script, as the phone's
 * full-script mode makes, and is aligned like a fetched voiceover.
 */

import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, FileAudio, Loader2 } from 'lucide-react'
import { narrationApi, type NarrationChapter } from '@/lib/api'
import { LANGUAGE_LABEL, type NarrationLanguage } from '@/lib/narrationLanguage'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'

const ACCEPT = '.wav,.mp3,.ogg,.flac,.aac,.m4a,.opus,.weba,audio/*'
const MAX_BYTES = 512 * 1024 * 1024

export function AddVoiceoverDialog({ chapter, language, onClose, onAdded }: {
  chapter: NarrationChapter
  language: NarrationLanguage
  onClose: () => void
  onAdded: () => void
}) {
  const { toast } = useToast()
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl) }, [previewUrl])

  const choose = (next: File | undefined) => {
    if (input.current) input.current.value = ''
    if (!next) return
    if (next.size > MAX_BYTES) { setError('Choose an audio file smaller than 512 MB.'); return }
    setError(null)
    setFile(next)
    setPreviewUrl(URL.createObjectURL(next))
  }

  const add = async () => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      await narrationApi.addManualVoiceover(chapter.id, language, file)
      toast({ title: `Voiceover added to chapter ${chapter.number}`, description: 'Aligning it now; the alignment document follows when it finishes.' })
      onAdded()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add the voiceover')
    } finally {
      setBusy(false)
    }
  }

  const replacing = chapter.withAudio > 0

  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>Add voiceover · Chapter {chapter.number}</DialogTitle>
        <DialogDescription>
          {LANGUAGE_LABEL[language]}. Choose one audio file that reads this chapter’s whole script. It is aligned to the
          script like a voiceover fetched from the phone.
        </DialogDescription>
      </DialogHeader>

      {!chapter.hasScript ? (
        <p className="flex items-start gap-2 text-sm text-amber-600">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          This chapter has no {LANGUAGE_LABEL[language]} script yet. Add it with Replace first, then its voiceover.
        </p>
      ) : (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() => input.current?.click()}
            onDragOver={e => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={e => { e.preventDefault(); setDragging(false); choose(e.dataTransfer.files[0]) }}
            className={`flex w-full flex-col items-center gap-2 rounded-lg border-2 border-dashed p-6 text-sm transition-colors ${dragging ? 'border-primary bg-primary/5' : 'border-muted-foreground/30 hover:border-primary/60'}`}
          >
            <FileAudio className="h-6 w-6 text-muted-foreground" />
            {file
              ? <span className="font-medium break-all">{file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB</span>
              : <span>Drop an audio file here, or click to choose</span>}
            <span className="text-xs text-muted-foreground">WAV, MP3, M4A, OGG, FLAC, AAC, Opus</span>
          </button>
          <input ref={input} type="file" accept={ACCEPT} className="hidden" aria-label="Choose voiceover audio" onChange={e => choose(e.target.files?.[0])} />
          {previewUrl && <audio controls src={previewUrl} className="w-full" />}

          {replacing && (
            <p className="flex items-start gap-2 text-sm text-amber-600">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              This replaces the chapter’s current voiceover ({chapter.withAudio}/{chapter.sections} sections) and clears its
              alignment and Editor timeline. The old audio and timeline are backed up in the audio folder.
            </p>
          )}
        </>
      )}

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button disabled={busy || !file || !chapter.hasScript} onClick={() => void add()}>
          {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          {replacing ? 'Replace voiceover' : 'Add voiceover'}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
