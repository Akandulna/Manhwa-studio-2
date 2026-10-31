/**
 * PhoneFetchDialog — choose what "Fetch from phone" brings onto this Mac.
 *
 * The Sleeper-Cell phones upload two things per series and language to R2:
 * one script zip (every chapter's script, summary and closing paragraph) and
 * one voiceover zip per fully voiced chapter. The preview (one click, the only
 * R2 read) lists both side by side per chapter, and the user ticks what to
 * take: new scripts and new or re-uploaded voiceovers start ticked; a script
 * that would replace a different one here starts unticked, since it may be the
 * one the voiceover was made from. Confirming starts the fetch on the server;
 * attached voiceovers are aligned by themselves.
 */

import { useMemo, useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import type {
  NarrationPhonePreview,
  PhoneImportChapter,
  PhoneImportPreview,
  PhoneVoiceoverPreviewChapter
} from '@/lib/api'
import { LANGUAGE_LABEL, type NarrationLanguage } from '@/lib/narrationLanguage'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'

function formatWhen(iso: string | null | undefined): string | null {
  if (!iso) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

const ABOUT_NOTES: Record<PhoneImportPreview['about'], string | null> = {
  set: 'The series has no "about" text yet; the phone\'s will be used.',
  replace: 'The phone rewrote chapter 1, so its "about" text replaces this series\' one.',
  keep: 'The phone\'s "about" text is ignored: it didn\'t start from chapter 1, so the series\' own is kept.',
  same: null,
  none: null
}

const scriptTicked = (c: PhoneImportChapter) => c.action === 'new' && !c.published
const voiceoverTicked = (c: PhoneVoiceoverPreviewChapter) => c.state !== 'same'

interface Row {
  chapterId: string
  number: number
  script: PhoneImportChapter | null
  voiceover: PhoneVoiceoverPreviewChapter | null
}

export interface PhoneFetchSelection {
  scriptsEtag?: string
  scriptChapterIds: string[]
  voiceoverChapterIds: string[]
}

interface Props {
  language: NarrationLanguage
  /** The preview to choose from; the dialog is open while it's set. */
  preview: NarrationPhonePreview | null
  starting: boolean
  onCancel: () => void
  onConfirm: (selection: PhoneFetchSelection) => void
}

export function PhoneFetchDialog(props: Props) {
  // The body mounts with each preview, so every one starts from its own default ticks.
  return (
    <Dialog open={!!props.preview} onOpenChange={open => !open && !props.starting && props.onCancel()}>
      {props.preview && <DialogBody {...props} preview={props.preview} />}
    </Dialog>
  )
}

function DialogBody({ language, preview, starting, onCancel, onConfirm }: Props & { preview: NarrationPhonePreview }) {
  const scripts = preview.scripts
  const voiceovers = preview.voiceovers

  const rows = useMemo(() => {
    const byId = new Map<string, Row>()
    const row = (chapterId: string, number: number) => {
      let r = byId.get(chapterId)
      if (!r) byId.set(chapterId, (r = { chapterId, number, script: null, voiceover: null }))
      return r
    }
    for (const c of scripts?.chapters ?? []) row(c.chapterId, c.number).script = c
    for (const c of voiceovers?.chapters ?? []) row(c.chapterId, c.number).voiceover = c
    return [...byId.values()].sort((a, b) => a.number - b.number)
  }, [scripts, voiceovers])

  const [scriptIds, setScriptIds] = useState(
    () => new Set((scripts?.chapters ?? []).filter(scriptTicked).map(c => c.chapterId))
  )
  const [voiceoverIds, setVoiceoverIds] = useState(
    () => new Set((voiceovers?.chapters ?? []).filter(voiceoverTicked).map(c => c.chapterId))
  )

  const toggle = (set: (fn: (prev: Set<string>) => Set<string>) => void, id: string, on: boolean) =>
    set(prev => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  const hinglish = language === 'hi'
  const unmatched = [...new Set([...(scripts?.unmatched ?? []), ...(voiceovers?.unmatched ?? [])])]
  const voiceoverBytes = (voiceovers?.chapters ?? [])
    .filter(c => voiceoverIds.has(c.chapterId))
    .reduce((sum, c) => sum + c.bytes, 0)
  const nothing = scriptIds.size === 0 && voiceoverIds.size === 0

  const confirm = () =>
    onConfirm({
      scriptsEtag: scripts?.zip.etag,
      scriptChapterIds: [...scriptIds],
      voiceoverChapterIds: [...voiceoverIds]
    })

  return (
    <DialogContent className="max-w-3xl">
      <DialogHeader>
        <DialogTitle>Fetch {LANGUAGE_LABEL[language]} narration from the phone</DialogTitle>
        <DialogDescription>
          Ticked scripts are saved to their chapter with the summary and closing paragraph; ticked voiceovers
          replace the chapter's sections and audio, then align by themselves.
          {scripts && <> Scripts uploaded {formatWhen(scripts.zip.uploadedAt) ?? 'recently'}.</>}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-3">
        {!scripts && (
          <p className="text-sm text-muted-foreground flex items-center gap-1">
            {preview.scriptsError ? (
              <span className="text-destructive flex items-center gap-1">
                <AlertTriangle className="h-4 w-4" />
                {preview.scriptsError}
              </span>
            ) : (
              `No ${hinglish ? 'Hinglish ' : ''}script zip from the phone yet — it uploads one once every chapter is done there.`
            )}
          </p>
        )}

        <div className="max-h-[50vh] overflow-y-auto rounded-md border divide-y">
          <div className="grid grid-cols-[7rem_1fr_1fr] gap-3 px-3 py-2 text-xs font-medium text-muted-foreground bg-muted/50">
            <span>Chapter</span>
            <span>Script</span>
            <span>Voiceover</span>
          </div>
          {rows.length === 0 && (
            <p className="p-3 text-sm text-muted-foreground">Nothing from the phone matches a chapter here yet.</p>
          )}
          {rows.map(r => (
            <div key={r.chapterId} className="grid grid-cols-[7rem_1fr_1fr] items-center gap-3 px-3 py-2 text-sm">
              <span className="font-medium">Chapter {r.number}</span>

              {r.script ? (
                <label className="flex flex-wrap items-center gap-1.5 cursor-pointer">
                  <Checkbox
                    checked={scriptIds.has(r.chapterId)}
                    onCheckedChange={v => toggle(setScriptIds, r.chapterId, v === true)}
                    disabled={starting || r.script.action === 'same'}
                  />
                  {r.script.action === 'new' && <Badge variant="success">New</Badge>}
                  {r.script.action === 'replace' && (
                    <Badge variant="outline" className="border-amber-500 text-amber-600">
                      Replaces {r.script.desktopStatus ?? 'existing'}
                    </Badge>
                  )}
                  {r.script.action === 'same' && <Badge variant="outline">Already here</Badge>}
                  {r.script.published && <Badge variant="secondary">Published</Badge>}
                  {r.script.review && (
                    <Badge variant="outline" className="border-amber-500 text-amber-600" title={r.script.review.join('\n')}>
                      Needs review
                    </Badge>
                  )}
                  {r.script.sourceMatches === false && (
                    <Badge
                      variant="outline"
                      className="border-yellow-500 text-yellow-600"
                      title="The phone converted a different English script than the one here"
                    >
                      Other English
                    </Badge>
                  )}
                </label>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}

              {r.voiceover ? (
                <label className="flex flex-wrap items-center gap-1.5 cursor-pointer">
                  <Checkbox
                    checked={voiceoverIds.has(r.chapterId)}
                    onCheckedChange={v => toggle(setVoiceoverIds, r.chapterId, v === true)}
                    disabled={starting || r.voiceover.state === 'same'}
                  />
                  {r.voiceover.state === 'new' && <Badge variant="success">New</Badge>}
                  {r.voiceover.state === 'changed' && (
                    <Badge variant="outline" className="border-amber-500 text-amber-600" title="Re-voiced on the phone since it was fetched">
                      Re-uploaded
                    </Badge>
                  )}
                  {r.voiceover.state === 'same' && <Badge variant="outline">Already here</Badge>}
                  <span className="text-xs text-muted-foreground" title={formatWhen(r.voiceover.uploadedAt) ?? undefined}>
                    {formatMb(r.voiceover.bytes)}
                  </span>
                </label>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </div>
          ))}
        </div>

        {unmatched.length > 0 && (
          <p className="text-xs text-muted-foreground">Not matched to a chapter here (skipped): {unmatched.join(', ')}</p>
        )}
        {scripts && ABOUT_NOTES[scripts.about] && (
          <p className="text-xs text-muted-foreground">{ABOUT_NOTES[scripts.about]}</p>
        )}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={starting}>
          Cancel
        </Button>
        <Button onClick={confirm} disabled={starting || nothing}>
          {starting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          Fetch {scriptIds.size} script{scriptIds.size === 1 ? '' : 's'}, {voiceoverIds.size} voiceover
          {voiceoverIds.size === 1 ? '' : 's'}
          {voiceoverBytes > 0 && <span className="ml-1 opacity-70">({formatMb(voiceoverBytes)})</span>}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
