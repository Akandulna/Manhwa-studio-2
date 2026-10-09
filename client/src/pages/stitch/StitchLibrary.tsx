import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { stitchApi, StitchChapterRow, LARGE_CHAPTER_PAGES } from '@/lib/api'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import { ArrowLeft, BookOpen, CheckCircle, ChevronRight, Layers, Loader2, Search, Sparkles } from 'lucide-react'

interface SeriesRow {
  id: string
  title: string
  chapters: number
  /** Unstitched chapters with more than LARGE_CHAPTER_PAGES pages. */
  large: number
  stitched: number
}

/**
 * Page Stitcher entry: `/stitch` lists the series with downloaded chapters,
 * `/stitch/series/:seriesId` lists that series' chapters.
 */
export default function StitchLibrary() {
  const { seriesId } = useParams<{ seriesId?: string }>()
  const { toast } = useToast()
  const [rows, setRows] = useState<StitchChapterRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    stitchApi
      .getChapters()
      .then(setRows)
      .catch(error =>
        toast({
          title: 'Could not load chapters',
          description: error instanceof Error ? error.message : 'Unknown error',
          variant: 'destructive'
        })
      )
      .finally(() => setLoading(false))
  }, [toast])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  return seriesId ? <ChapterList rows={rows} seriesId={seriesId} /> : <SeriesList rows={rows} />
}

function Header({ title, subtitle, back }: { title: string; subtitle: string; back: string }) {
  const navigate = useNavigate()
  return (
    <div className="flex items-start gap-4 mb-6">
      <Button variant="ghost" size="icon" onClick={() => navigate(back)}>
        <ArrowLeft className="h-5 w-5" />
      </Button>
      <div className="min-w-0">
        <h1 className="text-3xl font-bold flex items-center gap-3">
          <Layers className="h-7 w-7 text-primary" />
          <span className="truncate">{title}</span>
        </h1>
        <p className="text-muted-foreground">{subtitle}</p>
      </div>
    </div>
  )
}

function SeriesList({ rows }: { rows: StitchChapterRow[] }) {
  const [query, setQuery] = useState('')

  const series = useMemo(() => {
    const byId = new Map<string, SeriesRow>()
    for (const r of rows) {
      const s = byId.get(r.seriesId) ?? { id: r.seriesId, title: r.seriesTitle, chapters: 0, large: 0, stitched: 0 }
      s.chapters++
      if (r.stitched) s.stitched++
      else if (r.pageCount > LARGE_CHAPTER_PAGES) s.large++
      byId.set(r.seriesId, s)
    }
    const q = query.trim().toLowerCase()
    // Rows arrive sorted by series title, so the map keeps that order.
    return [...byId.values()].filter(s => !q || s.title.toLowerCase().includes(q))
  }, [rows, query])

  return (
    <div className="p-6">
      <Header
        title="Page Stitcher"
        subtitle="Pick a manhwa, then a chapter. Join many short pages into a few tall ones, or Auto stitch: re-cut a chapter into ~12k px pages only across blank rows, so no panel is split between two pages."
        back="/"
      />

      <div className="relative w-72 mb-4">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input className="pl-8 h-9" placeholder="Filter by series" value={query} onChange={e => setQuery(e.target.value)} />
      </div>

      {series.length === 0 ? (
        <Card className="p-12 text-center">
          <BookOpen className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
          <p className="font-medium">{rows.length === 0 ? 'No downloaded chapters yet' : 'No series match the filter'}</p>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-2">
            {series.map(s => (
              <Link
                key={s.id}
                to={`/stitch/series/${s.id}`}
                className="flex items-center gap-4 rounded-lg p-3 hover:bg-accent"
              >
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{s.title}</div>
                  <div className="text-sm text-muted-foreground">
                    {s.chapters} downloaded chapter{s.chapters === 1 ? '' : 's'}
                  </div>
                </div>
                {s.large > 0 && (
                  <Badge
                    variant="outline"
                    className="border-amber-500 text-amber-600 dark:text-amber-400"
                    title={`Chapters with more than ${LARGE_CHAPTER_PAGES} pages need stitching`}
                  >
                    {s.large} need stitching
                  </Badge>
                )}
                {s.stitched > 0 && <Badge variant="success">{s.stitched} stitched</Badge>}
                <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
              </Link>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function ChapterList({ rows, seriesId }: { rows: StitchChapterRow[]; seriesId: string }) {
  const navigate = useNavigate()
  const [onlyLarge, setOnlyLarge] = useState(false)

  const chapters = useMemo(() => rows.filter(r => r.seriesId === seriesId), [rows, seriesId])
  const visible = useMemo(
    () => chapters.filter(r => !onlyLarge || r.pageCount > LARGE_CHAPTER_PAGES || r.stitched),
    [chapters, onlyLarge]
  )
  const title = chapters[0]?.seriesTitle ?? 'Series'

  return (
    <div className="p-6">
      <Header
        title={title}
        subtitle={`${chapters.length} downloaded chapter${chapters.length === 1 ? '' : 's'}. Normal chapters have 14–20 pages.`}
        back="/stitch"
      />

      <label className="flex items-center gap-2 text-sm cursor-pointer mb-4 w-fit">
        <Switch checked={onlyLarge} onCheckedChange={setOnlyLarge} />
        Only chapters with more than {LARGE_CHAPTER_PAGES} pages
      </label>

      {visible.length === 0 ? (
        <Card className="p-12 text-center">
          <CheckCircle className="h-12 w-12 mx-auto text-emerald-500 mb-3" />
          <p className="font-medium">
            {chapters.length === 0
              ? 'This series has no downloaded chapters'
              : `No chapter in this series has more than ${LARGE_CHAPTER_PAGES} pages`}
          </p>
          {onlyLarge && chapters.length > 0 && (
            <p className="text-sm text-muted-foreground mt-1">Turn off the filter to stitch any chapter.</p>
          )}
        </Card>
      ) : (
        <Card>
          <CardContent className="p-2">
            {visible.map(r => (
              <Link
                key={r.id}
                to={`/stitch/chapter/${r.id}`}
                className="flex items-center gap-4 rounded-lg p-3 hover:bg-accent"
              >
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">Chapter {r.number}</div>
                  {r.title && <div className="text-sm text-muted-foreground truncate">{r.title}</div>}
                </div>
                {r.stitched ? (
                  <Badge variant="success" title={`Stitched ${new Date(r.stitched.stitchedAt).toLocaleString()}`}>
                    Stitched {r.stitched.originalPages} → {r.pageCount}
                  </Badge>
                ) : (
                  <Badge
                    variant="outline"
                    className={r.pageCount > LARGE_CHAPTER_PAGES ? 'border-amber-500 text-amber-600 dark:text-amber-400' : ''}
                  >
                    {r.pageCount} pages
                  </Badge>
                )}
                {!r.stitched && (
                  <Button
                    size="sm"
                    title="Plan cuts at blank rows for this chapter and preview them"
                    onClick={e => {
                      e.preventDefault()
                      navigate(`/stitch/chapter/${r.id}?auto=1`)
                    }}
                  >
                    <Sparkles className="h-4 w-4 mr-1.5" />
                    Auto stitch
                  </Button>
                )}
                <Button variant="outline" size="sm" tabIndex={-1}>
                  {r.stitched ? 'Review' : 'Stitch'}
                </Button>
              </Link>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
