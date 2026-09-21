/**
 * Version history browser for the browser-local Settings documents.
 *
 * Shared by all four localStorage-backed editors (Crop 3.0 guideline file,
 * metadata template and prompt; Editor 2.0 prompt) so every one of them
 * presents the same timeline, preview and restore behaviour.
 *
 * Restore is append-only, matching lib/docHistory: the caller archives the text
 * being replaced before writing the restored text, so restoring never discards
 * the version it replaced and a restore can itself be undone.
 */

import { useEffect, useMemo, useState } from 'react'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import { History, RotateCcw, Trash2, Download } from 'lucide-react'
import {
  readHistory, deleteVersion, clearHistory, formatBytes, sha256Hex, MAX_VERSIONS,
  type DocVersion
} from '@/lib/docHistory'

export function DocHistoryDialog({
  open,
  onOpenChange,
  docKey,
  title,
  currentContent,
  onRestore
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The document's own localStorage key; history is derived from it. */
  docKey: string
  /** Document name, for the dialog heading. */
  title: string
  /** The live text, shown alongside the timeline for comparison. */
  currentContent: string
  /** Applies the chosen version as the new current one. */
  onRestore: (version: DocVersion) => void
}) {
  const [versions, setVersions] = useState<DocVersion[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Re-read on every open: another tab, or another card sharing this key, may
  // have archived a version since this dialog last rendered.
  useEffect(() => {
    if (!open) return
    const entries = readHistory(docKey)
    setVersions(entries)
    setSelectedId(entries[0]?.id ?? null)
  }, [open, docKey])

  const selected = versions.find(v => v.id === selectedId) ?? null

  // Hash of the live text, for the "Same as current" badge. Memoised on the
  // text alone so selecting through the timeline does not re-hash the document.
  const currentSha = useMemo(
    () => (currentContent ? sha256Hex(currentContent) : null),
    [currentContent]
  )

  const remove = (id: string) => {
    if (!window.confirm('Delete this version? It cannot be recovered.')) return
    const next = deleteVersion(docKey, id)
    setVersions(next)
    if (selectedId === id) setSelectedId(next[0]?.id ?? null)
  }

  const removeAll = () => {
    if (!window.confirm(`Clear the entire history for ${title}? The current document is kept.`)) return
    clearHistory(docKey)
    setVersions([])
    setSelectedId(null)
  }

  const download = (version: DocVersion) => {
    const blob = new Blob([version.content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const stamp = version.savedAt.replace(/[:.]/g, '-')
    a.download = version.name ? `${stamp}-${version.name}` : `${stamp}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }

  const restore = (version: DocVersion) => {
    if (version.truncated) return
    if (!window.confirm('Restore this version? The current text is kept in history, so this can be undone.')) return
    onRestore(version)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-5 w-5" />
            {title} — version history
          </DialogTitle>
          <DialogDescription>
            Previous versions of this document, newest first. Restoring keeps the current text in
            history too, so nothing is lost. Stored in this browser only — up to {MAX_VERSIONS} versions.
          </DialogDescription>
        </DialogHeader>

        {versions.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            No previous versions yet. The next time you save a change, the version it replaces appears here.
          </p>
        ) : (
          <div className="grid grid-cols-[minmax(0,260px)_minmax(0,1fr)] gap-4">
            <ScrollArea className="h-[380px] pr-3">
              <div className="space-y-2">
                {versions.map((version, index) => (
                  <button
                    key={version.id}
                    type="button"
                    onClick={() => setSelectedId(version.id)}
                    className={`w-full text-left rounded-lg border p-3 transition-colors ${
                      version.id === selectedId ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">
                        {new Date(version.savedAt).toLocaleString()}
                      </span>
                      {index === 0 && <Badge variant="secondary" className="text-xs">Previous</Badge>}
                    </div>
                    {version.name && (
                      <p className="text-xs text-muted-foreground truncate mt-0.5">{version.name}</p>
                    )}
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {formatBytes(version.size)} · {version.sha256.slice(0, 12)}
                    </p>
                    {version.restoredFrom && (
                      <Badge variant="outline" className="text-xs mt-1">Replaced by a restore</Badge>
                    )}
                    {version.truncated && (
                      <Badge variant="outline" className="text-xs mt-1">Too large — metadata only</Badge>
                    )}
                  </button>
                ))}
              </div>
            </ScrollArea>

            <div className="space-y-2 min-w-0">
              {selected ? (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground truncate">
                      Saved {new Date(selected.savedAt).toLocaleString()} · replaced{' '}
                      {new Date(selected.archivedAt).toLocaleString()}
                    </p>
                    {selected.sha256 === currentSha && (
                      <Badge variant="secondary" className="text-xs shrink-0">Same as current</Badge>
                    )}
                  </div>
                  <Textarea
                    value={selected.truncated
                      ? 'This version was too large to keep in full. Its timestamp, size and checksum are recorded, but the text is not available.'
                      : selected.content}
                    readOnly
                    className="font-mono text-xs min-h-[300px] bg-muted/40"
                    spellCheck={false}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => restore(selected)} disabled={selected.truncated}>
                      <RotateCcw className="h-4 w-4 mr-2" />
                      Restore this version
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => download(selected)} disabled={selected.truncated}>
                      <Download className="h-4 w-4 mr-2" />
                      Download
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => remove(selected.id)}>
                      <Trash2 className="h-4 w-4 mr-2" />
                      Delete
                    </Button>
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">Select a version to preview it.</p>
              )}
            </div>
          </div>
        )}

        <DialogFooter className="sm:justify-between">
          {versions.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={removeAll} className="text-destructive">
              Clear history
            </Button>
          ) : <span />}
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The button that opens the dialog, so each card wires up one element. */
export function DocHistoryButton({
  count,
  onClick
}: {
  count: number
  onClick: () => void
}) {
  return (
    <Button variant="outline" onClick={onClick} disabled={count === 0}>
      <History className="h-4 w-4 mr-2" />
      History{count > 0 ? ` (${count})` : ''}
    </Button>
  )
}
