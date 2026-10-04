/**
 * PhoneScriptImport — "Import from phone" on a series' chapter list.
 *
 * Sleeper-Cell writes narration scripts on the phone. Once every chapter is
 * done there, it uploads the scripts zip to R2 by itself (or with its "Zip and
 * upload to R2" button); this card's button lights up then. Clicking it downloads and parses the zip (nothing is
 * changed yet) and shows what each chapter would get; confirming attaches
 * script.md plus the summary and closing paragraph from continuity.json to
 * each ticked chapter. Voiceover is then started by hand as usual.
 *
 * Only chapters with no script here start ticked: the zip holds every chapter
 * on the phone, and re-importing the ones already scripted (maybe edited,
 * voiced or published since) would overwrite them.
 *
 * Each language tab has its own card: the Hindi tab imports the phone's
 * Hinglish zip (script.hi.md + continuity.hi.json, no about text) into the
 * Hindi scripts, keeping the phone's review issues and the English it was
 * converted from.
 */

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle, Download, Loader2, Smartphone } from 'lucide-react'
import {
  r2Api,
  PhoneImportChapter,
  PhoneImportPreview,
  PhoneScriptsView,
  PhoneScriptsZipStatus
} from '@/lib/api'
import { LANGUAGE_LABEL, type NarrationLanguage } from '@/lib/narrationLanguage'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'

function formatWhen(iso: string | null | undefined): string | null {
  if (!iso) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

const ticksByDefault = (c: PhoneImportChapter) => c.action === 'new' && !c.published

const ABOUT_NOTES: Record<PhoneImportPreview['about'], string | null> = {
  set: 'The series has no "about" text yet; the phone\'s will be used.',
  replace: 'The phone rewrote chapter 1, so its "about" text replaces this series\' one.',
  keep: 'The phone\'s "about" text is ignored: it didn\'t start from chapter 1, so the series\' own is kept.',
  same: null,
  none: null
}

interface Props {
  seriesId: string
  language: NarrationLanguage
  /** From usePhoneScripts(seriesId), for this language (phoneScriptsIn). */
  phoneScripts: PhoneScriptsView | null
  onImported: () => void
}

export function PhoneScriptImport({ seriesId, language, phoneScripts, onImported }: Props) {
  const { toast } = useToast()
  const [zipStatus, setZipStatus] = useState<PhoneScriptsZipStatus | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [preview, setPreview] = useState<PhoneImportPreview | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState(false)

  const phoneSeries = phoneScripts?.series[seriesId]

  // Look for the zip (one R2 HEAD) on open and whenever the phone reports: after
  // an upload the phone sends its scripts receipt, so no timer is needed.
  useEffect(() => {
    let cancelled = false
    setZipStatus(null)
    r2Api
      .getPhoneScriptsZip(seriesId, language)
      .then(next => {
        if (!cancelled) setZipStatus(prev => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
      })
      .catch(() => {
        // Advisory; the next report checks again.
      })
    return () => {
      cancelled = true
    }
  }, [seriesId, language, phoneScripts?.reportedAt])

  const zip = zipStatus?.zip ?? null
  const allDone = !!phoneSeries && phoneSeries.total > 0 && phoneSeries.done === phoneSeries.total
  const ready = allDone && !!zip
  const alreadyImported = !!zip && zipStatus?.lastImport?.etag === zip.etag

  // A chapter saved on the phone after the upload isn't in the zip.
  const zipBehindPhone = useMemo(() => {
    if (!zip?.uploadedAt || !phoneScripts) return false
    const uploaded = new Date(zip.uploadedAt).getTime()
    return Object.values(phoneScripts.chapters).some(c => c.savedAt && new Date(c.savedAt).getTime() > uploaded)
  }, [zip?.uploadedAt, phoneScripts])

  if (!zipStatus?.configured || (!phoneSeries && !zip)) return null

  const handlePreview = async () => {
    setPreviewing(true)
    try {
      const result = await r2Api.previewPhoneScripts(seriesId, language)
      setPreview(result)
      setSelected(new Set(result.chapters.filter(ticksByDefault).map(c => c.chapterId)))
    } catch (error) {
      toast({
        title: 'Could not read the phone scripts',
        description: error instanceof Error ? error.message : 'Download failed',
        variant: 'destructive'
      })
    } finally {
      setPreviewing(false)
    }
  }

  const handleImport = async () => {
    if (!preview) return
    setImporting(true)
    try {
      const result = await r2Api.importPhoneScripts(seriesId, language, preview.zip.etag, [...selected])
      toast({
        title: 'Phone scripts attached',
        description: `${result.imported} chapter script(s) imported${result.aboutUpdated ? ', about text updated' : ''}. Voiceover is ready to run.`
      })
      setPreview(null)
      setZipStatus(await r2Api.getPhoneScriptsZip(seriesId, language).catch(() => zipStatus))
      onImported()
    } catch (error) {
      toast({
        title: 'Import failed',
        description: error instanceof Error ? error.message : 'Could not import the phone scripts',
        variant: 'destructive'
      })
    } finally {
      setImporting(false)
    }
  }

  const toggle = (id: string, on: boolean) =>
    setSelected(prev => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  const hinglish = language === 'hi'
  let note: string
  if (!allDone) {
    note = phoneSeries
      ? hinglish
        ? `${phoneSeries.done}/${phoneSeries.total} chapters converted to Hinglish on the phone — it uploads them once they're all converted`
        : `${phoneSeries.done}/${phoneSeries.total} chapters done on the phone — it uploads them once they're all done`
      : `Waiting for the phone to report its ${hinglish ? 'Hinglish ' : ''}scripts`
  } else if (!zip) {
    note = 'Every chapter is done on the phone — waiting for it to upload them (open the series there if it hasn\'t)'
  } else if (alreadyImported) {
    note = `Imported ${formatWhen(zipStatus.lastImport?.at) ?? ''} (${zipStatus.lastImport?.chapters ?? 0} chapters)`
  } else {
    note = `Uploaded from the phone ${formatWhen(zip.uploadedAt) ?? ''} — ready to import`
  }

  return (
    <>
      <Card className="mb-6">
        <CardContent className="py-4">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <Smartphone className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">Phone {hinglish ? 'Hinglish ' : ''}scripts:</span>
            </div>

            <Button
              size="sm"
              variant={ready && !alreadyImported ? 'default' : 'outline'}
              onClick={handlePreview}
              disabled={!ready || previewing}
              title={ready ? 'Download the phone\'s scripts and choose which chapters to attach them to' : note}
            >
              {previewing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
              {alreadyImported ? 'Import again' : 'Import from phone'}
            </Button>

            <span className="text-sm text-muted-foreground flex items-center gap-1">
              {alreadyImported && <CheckCircle className="h-4 w-4 text-emerald-600" />}
              {note}
            </span>

            {ready && zipBehindPhone && (
              <span className="text-sm text-amber-600 flex items-center gap-1">
                <AlertTriangle className="h-4 w-4" />
                A chapter was saved on the phone after this upload — the phone uploads a new zip by itself (open the
                series there if it doesn't appear)
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!preview} onOpenChange={open => !open && !importing && setPreview(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Import {LANGUAGE_LABEL[language]} scripts from the phone</DialogTitle>
            <DialogDescription>
              Each ticked chapter gets the phone's {hinglish ? 'Hinglish ' : ''}script, summary and closing paragraph.
              Chapters that already have a {LANGUAGE_LABEL[language]} script here start unticked, so they stay as
              they are. Uploaded {formatWhen(preview?.zip.uploadedAt) ?? 'recently'}.
            </DialogDescription>
          </DialogHeader>

          {preview && (
            <div className="space-y-3">
              <div className="max-h-[50vh] overflow-y-auto rounded-md border divide-y">
                {preview.chapters.length === 0 && (
                  <p className="p-3 text-sm text-muted-foreground">No chapter in the zip matches a chapter here.</p>
                )}
                {preview.chapters.map(c => (
                  <label key={c.chapterId} className="flex items-center gap-3 p-2.5 text-sm cursor-pointer hover:bg-accent">
                    <Checkbox
                      checked={selected.has(c.chapterId)}
                      onCheckedChange={v => toggle(c.chapterId, v === true)}
                      disabled={importing}
                    />
                    <span className="font-medium w-28 shrink-0">Chapter {c.number}</span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      {c.action === 'new' && <Badge variant="success">New</Badge>}
                      {c.action === 'replace' && (
                        <Badge variant="outline" className="border-amber-500 text-amber-600">
                          Replaces {c.desktopStatus ?? 'existing'} script
                        </Badge>
                      )}
                      {c.action === 'same' && <Badge variant="outline">Already the same</Badge>}
                      {c.hasVoiceover && c.action !== 'same' && (
                        <Badge variant="outline" className="border-amber-500 text-amber-600">
                          Has voiceover — re-split after import
                        </Badge>
                      )}
                      {c.published && <Badge variant="secondary">Published</Badge>}
                      {c.review && (
                        <Badge
                          variant="outline"
                          className="border-amber-500 text-amber-600"
                          title={c.review.join('\n')}
                        >
                          Needs review
                        </Badge>
                      )}
                      {c.sourceMatches === false && (
                        <Badge
                          variant="outline"
                          className="border-yellow-500 text-yellow-600"
                          title="The phone converted a different English script than this one; it will show as stale"
                        >
                          Other English
                        </Badge>
                      )}
                      {(!c.hasSummary || !c.hasClosing) && (
                        <Badge variant="outline" className="text-muted-foreground">
                          No {!c.hasSummary ? 'summary' : 'closing'}
                        </Badge>
                      )}
                    </span>
                  </label>
                ))}
              </div>

              {preview.unmatched.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Not matched to a chapter here (skipped): {preview.unmatched.join(', ')}
                </p>
              )}
              {ABOUT_NOTES[preview.about] && (
                <p className="text-xs text-muted-foreground">{ABOUT_NOTES[preview.about]}</p>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setPreview(null)} disabled={importing}>
              Cancel
            </Button>
            <Button onClick={handleImport} disabled={importing || selected.size === 0}>
              {importing && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Import {selected.size} chapter{selected.size === 1 ? '' : 's'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
