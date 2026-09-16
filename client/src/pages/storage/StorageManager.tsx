/**
 * Storage Manager — what the local disk is holding, and what is safe to drop.
 *
 * The page is built around one question: a chapter that has already been
 * rendered and published no longer needs the material it was built from, so
 * which chapters are those and how much would they give back? Everything is
 * therefore keyed off the export status — the "safe to delete" figure counts
 * only exported chapters, and a chapter with no rendered MP4 needs a separate,
 * explicit acknowledgement before it can be cleaned.
 *
 * Rendered videos are shown but never included in a cleanup: they are the
 * finished product, and they have their own per-file delete under the series.
 */

import { useState, useEffect, useMemo, useCallback } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Progress } from '@/components/ui/progress'
import { useToast } from '@/components/ui/use-toast'
import {
  HardDrive,
  Loader2,
  RefreshCw,
  Trash2,
  ChevronRight,
  CheckCircle2,
  AlertTriangle,
  Film,
  FolderOpen,
  ShieldAlert
} from 'lucide-react'
import {
  storageApi,
  type StorageOverview,
  type SeriesStorage,
  type ChapterStorage,
  type StorageCategoryKey,
  type StorageCategoryMeta,
  type StorageVideoFile
} from '@/lib/api'

// ============ Formatting ============

/**
 * Bytes as the user's disk utility would show them (GB = 1000 MB, matching
 * Finder), with enough precision to see a delete land.
 */
function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log10(bytes) / 3), units.length - 1)
  const value = bytes / Math.pow(1000, i)
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`
}

/** Colour per category, so the same material reads the same in every bar. */
const CATEGORY_COLOR: Record<StorageCategoryKey, string> = {
  pages: 'bg-sky-500',
  crops: 'bg-violet-500',
  cropJson: 'bg-teal-500',
  audio: 'bg-amber-500',
  script: 'bg-lime-500',
  video: 'bg-rose-500',
  other: 'bg-zinc-500'
}

/** Which categories a cleanup offers, in the order they matter by size. */
const CLEANUP_ORDER: StorageCategoryKey[] = ['crops', 'audio', 'pages']

// ============ Pieces ============

/** A single stacked bar showing how one folder's bytes break down. */
function UsageBar({
  sizes,
  total,
  categories
}: {
  sizes: Record<StorageCategoryKey, number>
  total: number
  categories: StorageCategoryMeta[]
}) {
  if (total <= 0) {
    return <div className="h-2 rounded-full bg-muted" />
  }
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
      {categories.map(cat => {
        const bytes = sizes[cat.key] || 0
        if (bytes <= 0) return null
        return (
          <div
            key={cat.key}
            className={CATEGORY_COLOR[cat.key]}
            style={{ width: `${(bytes / total) * 100}%` }}
            title={`${cat.label}: ${formatBytes(bytes)}`}
          />
        )
      })}
    </div>
  )
}

/** The legend, doubling as a per-category total for the whole library. */
function Legend({
  categories,
  sizes
}: {
  categories: StorageCategoryMeta[]
  sizes: Record<StorageCategoryKey, number>
}) {
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-2">
      {categories.map(cat => (
        <span key={cat.key} className="flex items-center gap-2 text-xs" title={cat.description}>
          <span className={`h-2.5 w-2.5 rounded-sm ${CATEGORY_COLOR[cat.key]}`} />
          <span className="text-muted-foreground">{cat.label}</span>
          <span className="font-medium tabular-nums">{formatBytes(sizes[cat.key] || 0)}</span>
        </span>
      ))}
    </div>
  )
}

function ExportBadge({ chapter }: { chapter: ChapterStorage }) {
  if (chapter.exported) {
    return (
      <Badge
        variant="success"
        className="flex items-center gap-1"
        title={
          chapter.exportedVia === 'editor2'
            ? 'An MP4 for this chapter is in the series _video2 folder'
            : 'A finished Editor 1.0 export includes this chapter'
        }
      >
        <CheckCircle2 className="h-3 w-3" />
        Exported
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="flex items-center gap-1 text-muted-foreground">
      <AlertTriangle className="h-3 w-3" />
      Not exported
    </Badge>
  )
}

// ============ Page ============

export default function StorageManager() {
  const { toast } = useToast()

  const [overview, setOverview] = useState<StorageOverview | null>(null)
  const [categories, setCategories] = useState<StorageCategoryMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [expanded, setExpanded] = useState<string | null>(null)
  const [videos, setVideos] = useState<Record<string, StorageVideoFile[]>>({})
  const [busy, setBusy] = useState<string | null>(null)

  // What a cleanup removes. Crops and audio are on by default because they are
  // the bulk of the reclaimable space and are both regenerable; source pages
  // are opt-in since re-downloading them depends on the source site still
  // being up and still hosting the chapter.
  const [selected, setSelected] = useState<Set<StorageCategoryKey>>(
    () => new Set<StorageCategoryKey>(['crops', 'audio'])
  )

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setScanning(true)
    setError(null)
    try {
      const [ov, cats] = await Promise.all([
        storageApi.getOverview(),
        storageApi.getCategories()
      ])
      setOverview(ov)
      setCategories(cats)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to scan storage')
    } finally {
      setLoading(false)
      setScanning(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const toggleCategory = (key: StorageCategoryKey) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const selectedList = useMemo(() => Array.from(selected), [selected])

  /** Bytes the current selection would free from one chapter. */
  const selectedBytesOf = useCallback(
    (sizes: Record<StorageCategoryKey, number>) =>
      selectedList.reduce((sum, key) => sum + (sizes[key] || 0), 0),
    [selectedList]
  )

  const cleanChapter = async (chapter: ChapterStorage) => {
    if (selectedList.length === 0) {
      toast({ title: 'Nothing selected', description: 'Pick at least one kind of data to delete.', variant: 'destructive' })
      return
    }

    const freeing = formatBytes(selectedBytesOf(chapter.sizes))
    const labels = selectedList
      .map(k => categories.find(c => c.key === k)?.label ?? k)
      .join(', ')

    // An un-exported chapter is the dangerous case, so it gets its own warning
    // rather than being folded into the normal confirmation.
    const message = chapter.exported
      ? `Delete ${labels} from Chapter ${chapter.number}?\n\nThis frees about ${freeing}. The chapter has already been exported to video.`
      : `⚠️ Chapter ${chapter.number} has NOT been exported to video.\n\nDeleting ${labels} (about ${freeing}) means this chapter would have to be re-downloaded and re-cut before it could be rendered.\n\nDelete anyway?`

    if (!window.confirm(message)) return

    setBusy(chapter.id)
    try {
      const result = await storageApi.deleteChapterData(chapter.id, selectedList, !chapter.exported)
      if (result.skipped) {
        toast({ title: `Chapter ${chapter.number} skipped`, description: result.skipped })
      } else {
        toast({
          title: `Freed ${formatBytes(result.freedBytes)}`,
          description: `Chapter ${chapter.number} cleaned up.`
        })
      }
      await load(true)
    } catch (e) {
      toast({
        title: 'Delete failed',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'destructive'
      })
    } finally {
      setBusy(null)
    }
  }

  /** Clean every EXPORTED chapter of a series; un-exported ones are skipped. */
  const cleanSeries = async (series: SeriesStorage) => {
    if (selectedList.length === 0) {
      toast({ title: 'Nothing selected', description: 'Pick at least one kind of data to delete.', variant: 'destructive' })
      return
    }

    const exported = series.chapters.filter(c => c.exported)
    if (exported.length === 0) {
      toast({
        title: 'No exported chapters',
        description: `Nothing in "${series.title}" has been exported to video yet, so there is nothing safe to clean.`,
        variant: 'destructive'
      })
      return
    }

    const freeing = formatBytes(exported.reduce((sum, c) => sum + selectedBytesOf(c.sizes), 0))
    const labels = selectedList.map(k => categories.find(c => c.key === k)?.label ?? k).join(', ')
    const skipping = series.chapterCount - exported.length

    const confirmText =
      `Clean "${series.title}"?\n\n` +
      `Deletes ${labels} from ${exported.length} exported chapter${exported.length === 1 ? '' : 's'}, freeing about ${freeing}.` +
      (skipping > 0
        ? `\n\n${skipping} chapter${skipping === 1 ? '' : 's'} will be left alone because they have not been exported.`
        : '') +
      `\n\nRendered videos are never touched.`

    if (!window.confirm(confirmText)) return

    setBusy(series.id)
    try {
      const result = await storageApi.deleteSeriesData(series.id, selectedList, false)
      const skipped = result.results.filter(r => r.skipped).length
      toast({
        title: `Freed ${formatBytes(result.freedBytes)}`,
        description: skipped > 0
          ? `${result.results.length - skipped} chapters cleaned, ${skipped} skipped (not exported).`
          : `${result.results.length} chapters cleaned.`
      })
      await load(true)
    } catch (e) {
      toast({
        title: 'Cleanup failed',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'destructive'
      })
    } finally {
      setBusy(null)
    }
  }

  const toggleSeries = async (series: SeriesStorage) => {
    const next = expanded === series.id ? null : series.id
    setExpanded(next)
    if (next && !videos[series.id]) {
      try {
        const list = await storageApi.getSeriesVideos(series.id)
        setVideos(prev => ({ ...prev, [series.id]: list }))
      } catch {
        // A failed video listing must not collapse the chapter table, which is
        // the part of the panel the user came for.
        setVideos(prev => ({ ...prev, [series.id]: [] }))
      }
    }
  }

  const deleteVideo = async (series: SeriesStorage, video: StorageVideoFile) => {
    if (!window.confirm(
      `Delete the rendered video "${video.fileName}"?\n\n` +
      `This frees ${formatBytes(video.bytes)} and cannot be undone — make sure it is already uploaded.`
    )) return

    setBusy(video.fileName)
    try {
      const result = await storageApi.deleteVideo(series.id, video.dir, video.fileName)
      toast({ title: `Freed ${formatBytes(result.freedBytes)}`, description: video.fileName })
      const list = await storageApi.getSeriesVideos(series.id)
      setVideos(prev => ({ ...prev, [series.id]: list }))
      await load(true)
    } catch (e) {
      toast({
        title: 'Delete failed',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'destructive'
      })
    } finally {
      setBusy(null)
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  const cleanupCategories = categories.filter(c => CLEANUP_ORDER.includes(c.key))
  const totalSelectedBytes = overview
    ? overview.series.reduce(
        (sum, s) => sum + s.chapters.filter(c => c.exported).reduce((n, c) => n + selectedBytesOf(c.sizes), 0),
        0
      )
    : 0

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <HardDrive className="h-7 w-7 text-primary" />
            <h1 className="text-3xl font-bold">Storage</h1>
          </div>
          <p className="mt-1 text-muted-foreground">
            What each manhwa is consuming on this machine, and which chapters have already been
            exported to video — so the material behind them can be safely deleted.
          </p>
        </div>
        <Button variant="outline" onClick={() => load(true)} disabled={scanning}>
          {scanning
            ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            : <RefreshCw className="mr-2 h-4 w-4" />}
          Rescan
        </Button>
      </div>

      {error && (
        <div className="mb-6 flex items-start gap-2 rounded bg-destructive/10 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {overview && (
        <>
          {/* Totals */}
          <Card className="mb-6">
            <CardContent className="space-y-4 p-5">
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Total on disk</p>
                  <p className="text-2xl font-bold tabular-nums">{formatBytes(overview.totalBytes)}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Safe to delete</p>
                  <p className="text-2xl font-bold tabular-nums text-green-500">
                    {formatBytes(overview.safeToDeleteBytes)}
                  </p>
                  <p className="text-xs text-muted-foreground">from exported chapters</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Reclaimable</p>
                  <p className="text-2xl font-bold tabular-nums">{formatBytes(overview.reclaimableBytes)}</p>
                  <p className="text-xs text-muted-foreground">incl. un-exported chapters</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Rendered video</p>
                  <p className="text-2xl font-bold tabular-nums">{formatBytes(overview.videoBytes)}</p>
                  <p className="text-xs text-muted-foreground">never auto-deleted</p>
                </div>
              </div>

              <UsageBar
                sizes={overview.series.reduce(
                  (acc, s) => {
                    for (const c of categories) acc[c.key] = (acc[c.key] || 0) + s.sizes[c.key]
                    return acc
                  },
                  {} as Record<StorageCategoryKey, number>
                )}
                total={overview.series.reduce((sum, s) => sum + s.totalBytes, 0)}
                categories={categories}
              />

              <Legend
                categories={categories}
                sizes={overview.series.reduce(
                  (acc, s) => {
                    for (const c of categories) acc[c.key] = (acc[c.key] || 0) + s.sizes[c.key]
                    return acc
                  },
                  {} as Record<StorageCategoryKey, number>
                )}
              />

              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <FolderOpen className="h-3.5 w-3.5" />
                <code className="rounded bg-muted px-1.5 py-0.5">{overview.downloadRoot}</code>
                {overview.sharedBytes > 0 && (
                  <span>· plus {formatBytes(overview.sharedBytes)} in shared folders (music, watermarks, reference)</span>
                )}
              </p>
            </CardContent>
          </Card>

          {/* What a cleanup deletes */}
          <Card className="mb-6">
            <CardContent className="p-5">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="font-semibold">What to delete</h2>
                  <p className="text-sm text-muted-foreground">
                    Applies to every Clean button below. Crop pointers, scripts and rendered
                    videos are never included.
                  </p>
                </div>
                <p className="text-sm text-muted-foreground">
                  Selection frees <span className="font-semibold text-foreground">{formatBytes(totalSelectedBytes)}</span> across
                  all exported chapters
                </p>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                {CLEANUP_ORDER.map(key => {
                  const cat = cleanupCategories.find(c => c.key === key)
                  if (!cat) return null
                  const bytes = overview.series.reduce((sum, s) => sum + s.sizes[key], 0)
                  return (
                    <label
                      key={key}
                      className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 hover:border-primary"
                    >
                      <Checkbox
                        checked={selected.has(key)}
                        onCheckedChange={() => toggleCategory(key)}
                        className="mt-0.5"
                      />
                      <span className="min-w-0">
                        <span className="flex items-center gap-2">
                          <span className={`h-2.5 w-2.5 rounded-sm ${CATEGORY_COLOR[key]}`} />
                          <span className="font-medium">{cat.label}</span>
                          <span className="text-sm text-muted-foreground tabular-nums">
                            {formatBytes(bytes)}
                          </span>
                        </span>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {cat.description}
                        </span>
                      </span>
                    </label>
                  )
                })}
              </div>
            </CardContent>
          </Card>

          {/* Per-series */}
          <div className="space-y-4">
            {overview.series.map(series => {
              const isOpen = expanded === series.id
              const exportProgress = series.chapterCount > 0
                ? Math.round((series.exportedChapterCount / series.chapterCount) * 100)
                : 0
              const seriesVideos = videos[series.id] ?? []

              return (
                <Card key={series.id}>
                  <CardContent className="p-5">
                    {/* Series summary row */}
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <button
                        type="button"
                        onClick={() => toggleSeries(series)}
                        className="flex min-w-0 flex-1 items-start gap-3 text-left"
                      >
                        <ChevronRight
                          className={`mt-1 h-5 w-5 flex-shrink-0 text-muted-foreground transition-transform ${isOpen ? 'rotate-90' : ''}`}
                        />
                        <span className="min-w-0">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-lg font-semibold">{series.title}</span>
                            {!series.exists && (
                              <Badge variant="destructive" className="flex items-center gap-1">
                                <AlertTriangle className="h-3 w-3" />
                                Folder missing
                              </Badge>
                            )}
                          </span>
                          <span className="mt-1 block text-sm text-muted-foreground">
                            {formatBytes(series.totalBytes)} · {series.chapterCount} chapters ·{' '}
                            {series.fileCount.toLocaleString()} files
                          </span>
                        </span>
                      </button>

                      <div className="flex items-center gap-4">
                        <div className="text-right">
                          <p className="text-xs uppercase tracking-wide text-muted-foreground">Safe to delete</p>
                          <p className="text-xl font-bold tabular-nums text-green-500">
                            {formatBytes(series.safeToDeleteBytes)}
                          </p>
                        </div>
                        <Button
                          variant="destructive"
                          onClick={() => cleanSeries(series)}
                          disabled={busy === series.id || series.exportedChapterCount === 0}
                          title={
                            series.exportedChapterCount === 0
                              ? 'No chapter of this series has been exported to video yet'
                              : 'Delete the selected data from every exported chapter'
                          }
                        >
                          {busy === series.id
                            ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            : <Trash2 className="mr-2 h-4 w-4" />}
                          Clean exported
                        </Button>
                      </div>
                    </div>

                    {/* Breakdown + export progress */}
                    <div className="mt-4 space-y-3">
                      <UsageBar sizes={series.sizes} total={series.totalBytes} categories={categories} />
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <Legend categories={categories} sizes={series.sizes} />
                        <span className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Film className="h-3.5 w-3.5" />
                          {series.exportedChapterCount}/{series.chapterCount} exported
                          <Progress value={exportProgress} className="h-1.5 w-24" />
                        </span>
                      </div>
                    </div>

                    {/* Chapters */}
                    {isOpen && (
                      <div className="mt-5 border-t pt-5">
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                                <th className="pb-2 pr-4 font-medium">Chapter</th>
                                <th className="pb-2 pr-4 font-medium">Video</th>
                                <th className="pb-2 pr-4 text-right font-medium">Pages</th>
                                <th className="pb-2 pr-4 text-right font-medium">Crops</th>
                                <th className="pb-2 pr-4 text-right font-medium">Audio</th>
                                <th className="pb-2 pr-4 text-right font-medium">Total</th>
                                <th className="pb-2 pr-4 text-right font-medium">Frees</th>
                                <th className="pb-2 font-medium" />
                              </tr>
                            </thead>
                            <tbody>
                              {series.chapters.map(chapter => {
                                const frees = selectedBytesOf(chapter.sizes)
                                return (
                                  <tr key={chapter.id} className="border-b last:border-0 hover:bg-accent/40">
                                    <td className="py-2 pr-4">
                                      <span className="font-medium">Ch {chapter.number}</span>
                                      {chapter.title && (
                                        <span className="ml-2 text-muted-foreground">{chapter.title}</span>
                                      )}
                                      {!chapter.exists && (
                                        <span className="ml-2 text-xs text-muted-foreground">(no folder)</span>
                                      )}
                                    </td>
                                    <td className="py-2 pr-4"><ExportBadge chapter={chapter} /></td>
                                    <td className="py-2 pr-4 text-right tabular-nums text-muted-foreground">
                                      {formatBytes(chapter.sizes.pages)}
                                    </td>
                                    <td className="py-2 pr-4 text-right tabular-nums text-muted-foreground">
                                      {formatBytes(chapter.sizes.crops)}
                                    </td>
                                    <td className="py-2 pr-4 text-right tabular-nums text-muted-foreground">
                                      {formatBytes(chapter.sizes.audio)}
                                    </td>
                                    <td className="py-2 pr-4 text-right font-medium tabular-nums">
                                      {formatBytes(chapter.totalBytes)}
                                    </td>
                                    <td className="py-2 pr-4 text-right tabular-nums text-green-500">
                                      {frees > 0 ? formatBytes(frees) : '—'}
                                    </td>
                                    <td className="py-2 text-right">
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => cleanChapter(chapter)}
                                        disabled={busy === chapter.id || frees <= 0}
                                        title={
                                          chapter.exported
                                            ? 'Delete the selected data from this chapter'
                                            : 'This chapter has not been exported — you will be asked to confirm'
                                        }
                                      >
                                        {busy === chapter.id
                                          ? <Loader2 className="h-4 w-4 animate-spin" />
                                          : <Trash2 className="h-4 w-4" />}
                                      </Button>
                                    </td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        </div>

                        {/* Rendered videos — the product, deleted one at a time */}
                        <div className="mt-6">
                          <h3 className="flex items-center gap-2 font-semibold">
                            <Film className="h-4 w-4" />
                            Rendered videos
                            <span className="text-sm font-normal text-muted-foreground">
                              {formatBytes(series.videoBytes)} · {series.videoFileCount} file
                              {series.videoFileCount === 1 ? '' : 's'}
                            </span>
                          </h3>
                          <p className="mt-1 flex items-start gap-2 rounded bg-amber-500/10 p-2 text-xs text-amber-600">
                            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                            <span>
                              These are the finished exports and are never removed by a cleanup.
                              Delete one only once you are sure it has been uploaded.
                            </span>
                          </p>

                          {seriesVideos.length === 0 ? (
                            <p className="mt-3 text-sm text-muted-foreground">No rendered videos.</p>
                          ) : (
                            <ul className="mt-3 space-y-1">
                              {seriesVideos.map(video => (
                                <li
                                  key={`${video.dir}/${video.fileName}`}
                                  className="flex items-center justify-between gap-3 rounded px-2 py-1.5 text-sm hover:bg-accent/40"
                                >
                                  <span className="flex min-w-0 items-center gap-2">
                                    <code className="truncate text-xs">{video.fileName}</code>
                                    {video.chapterNumber !== null && (
                                      <Badge variant="outline" className="flex-shrink-0">
                                        Ch {video.chapterNumber}
                                      </Badge>
                                    )}
                                  </span>
                                  <span className="flex flex-shrink-0 items-center gap-3">
                                    <span className="tabular-nums text-muted-foreground">
                                      {formatBytes(video.bytes)}
                                    </span>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => deleteVideo(series, video)}
                                      disabled={busy === video.fileName}
                                    >
                                      {busy === video.fileName
                                        ? <Loader2 className="h-4 w-4 animate-spin" />
                                        : <Trash2 className="h-4 w-4" />}
                                    </Button>
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )
            })}
          </div>

          {overview.series.length === 0 && (
            <div className="py-12 text-center">
              <HardDrive className="mx-auto mb-4 h-16 w-16 text-muted-foreground opacity-30" />
              <h2 className="mb-2 text-xl font-semibold">Nothing in the library yet</h2>
              <p className="text-muted-foreground">
                Add and download a series first — this page measures what is on disk.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  )
}
