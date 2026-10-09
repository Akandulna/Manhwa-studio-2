import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { stitchApi, StitchChapterRow, LARGE_CHAPTER_PAGES } from '@/lib/api'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import { ArrowLeft, CheckCircle, Layers, Loader2, Search, Sparkles } from 'lucide-react'

export default function StitchLibrary() {
  const navigate = useNavigate()
  const { toast } = useToast()
  const [rows, setRows] = useState<StitchChapterRow[]>([])
  const [loading, setLoading] = useState(true)
  const [onlyLarge, setOnlyLarge] = useState(false)
  const [query, setQuery] = useState('')

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

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = rows.filter(
      r =>
        (!onlyLarge || r.pageCount > LARGE_CHAPTER_PAGES || r.stitched) &&
        (!q || r.seriesTitle.toLowerCase().includes(q))
    )
    // Biggest first when hunting for oversized chapters; reading order otherwise.
    return onlyLarge ? [...list].sort((a, b) => b.pageCount - a.pageCount) : list
  }, [rows, onlyLarge, query])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  return (
    <div className="p-6">
      <div className="flex items-start gap-4 mb-6">
        <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-3">
            <Layers className="h-7 w-7 text-primary" />
            Page Stitcher
          </h1>
          <p className="text-muted-foreground">
            Join a chapter's many short pages into a few tall ones, or Auto stitch any chapter: re-cut it into ~12k px
            pages only across blank rows, so no panel is split between two pages.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4 mb-4">
        <div className="relative w-72">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-8 h-9"
            placeholder="Filter by series"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <Switch checked={onlyLarge} onCheckedChange={setOnlyLarge} />
          Only chapters with more than {LARGE_CHAPTER_PAGES} pages
        </label>
      </div>

      {visible.length === 0 ? (
        <Card className="p-12 text-center">
          <CheckCircle className="h-12 w-12 mx-auto text-emerald-500 mb-3" />
          <p className="font-medium">
            {onlyLarge ? `No downloaded chapter has more than ${LARGE_CHAPTER_PAGES} pages` : 'No downloaded chapters'}
          </p>
          {onlyLarge && (
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
                  <div className="font-medium truncate">{r.seriesTitle}</div>
                  <div className="text-sm text-muted-foreground truncate">
                    Chapter {r.number}
                    {r.title ? ` — ${r.title}` : ''}
                  </div>
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
