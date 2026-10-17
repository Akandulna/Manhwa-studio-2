import { useEffect, useRef, useState } from 'react'
import { FileUp, Loader2, RefreshCw } from 'lucide-react'
import { narrationApi, type NarrationChapter } from '@/lib/api'
import { LANGUAGE_LABEL, type NarrationLanguage } from '@/lib/narrationLanguage'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'

export function ReplaceScriptDialog({ chapter, language, onClose, onSaved }: {
  chapter: NarrationChapter; language: NarrationLanguage; onClose: () => void; onSaved: () => void
}) {
  const { toast } = useToast()
  const [text, setText] = useState('')
  const [expectedSha256, setExpectedSha256] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [phoneConfigured, setPhoneConfigured] = useState(false)
  const [sendToPhones, setSendToPhones] = useState(true)
  const [source, setSource] = useState('Saved chapter script')
  const fileInput = useRef<HTMLInputElement>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const value = await narrationApi.getScript(chapter.id, language)
      setText(value.text)
      setExpectedSha256(value.sha256)
      setPhoneConfigured(value.phoneConfigured)
      setSendToPhones(value.phoneConfigured)
      setSource('Saved chapter script')
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load script') }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [chapter.id, language])

  const chooseFile = async (file: File | undefined) => {
    if (!file) return
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('Choose a script smaller than 2 MB.')
      const value = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
      if (!value.trim() || value.includes('\0')) throw new Error('Choose a nonempty UTF-8 script.')
      setText(value)
      setSource(file.name)
      setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not read file') }
    finally { if (fileInput.current) fileInput.current.value = '' }
  }
  const replace = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await narrationApi.replaceScript(chapter.id, language, { text, expectedSha256, sendToPhones })
      setExpectedSha256(result.sha256)
      onSaved()
      if (sendToPhones && !result.phoneSent) {
        setError(`Saved locally. ${result.phoneError ?? 'The phone upload failed.'} Use Replace & send again to retry.`)
        return
      }
      toast({ title: result.unchanged ? 'Replacement sent' : 'Script replaced', description: result.phoneSent
        ? 'The phones will prepare fresh splits when they sync while idle. Generate the voiceover, then fetch it here for alignment and a new Editor timeline.'
        : 'Previous results are backed up. Send this script to Sleeper-Cell to generate its new voiceover.' })
      onClose()
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not replace script') }
    finally { setBusy(false) }
  }

  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Replace script · Chapter {chapter.number}</DialogTitle>
        <DialogDescription>{LANGUAGE_LABEL[language]}. Use the saved local script, choose a file, or paste your revision. Replacing backs up and resets this language’s audio, alignment, and Editor timeline.</DialogDescription>
      </DialogHeader>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={busy || loading} onClick={() => fileInput.current?.click()}><FileUp className="h-4 w-4 mr-1" />Choose file</Button>
        <input ref={fileInput} type="file" accept=".md,.txt,text/plain,text/markdown" className="hidden" aria-label="Choose replacement script" onChange={e => void chooseFile(e.target.files?.[0])} />
        <Button variant="ghost" size="sm" disabled={busy || loading} onClick={() => void load()}><RefreshCw className="h-4 w-4 mr-1" />Reload saved file</Button>
        <span className="text-xs text-muted-foreground truncate">{source}</span>
      </div>
      {loading ? <div className="flex items-center gap-2 py-8 text-sm"><Loader2 className="h-4 w-4 animate-spin" />Loading local script…</div>
        : <Textarea aria-label="Replacement script" className="min-h-72 max-h-[45vh]" value={text} disabled={busy} onChange={e => setText(e.target.value)} />}
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sendToPhones} disabled={busy || loading || !phoneConfigured} onChange={e => setSendToPhones(e.target.checked)} />Send the revised script to Sleeper-Cell</label>
      {!phoneConfigured && <p className="text-xs text-muted-foreground">Set up Settings → Cloudflare to send the revision to your phones.</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button disabled={busy || loading || !text.trim()} onClick={() => void replace()}>{busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}{sendToPhones ? 'Replace & send' : 'Replace script'}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
