import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, CheckCircle2, FileText, Image, Loader2, Settings, Type, Youtube } from 'lucide-react'
import YouTubeTitles from './YouTubeTitles'
import YouTubeDescription from './YouTubeDescription'
import YouTubeThumbnails from './YouTubeThumbnails'
import { seriesApi, type Series } from '@/lib/api'
import { youtubeApi, type YouTubeWorkspace as Workspace } from '@/lib/youtube'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

export default function YouTubeWorkspace() {
  const { seriesId } = useParams<{ seriesId: string }>()
  const [data, setData] = useState<{ series: Series; workspace: Workspace } | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [tab, setTab] = useState('title')
  useEffect(() => {
    let cancelled = false
    setData(null); setError(''); setTab('title')
    if (!seriesId) { setError('Choose a series from the YouTube library.'); return }
    void Promise.all([seriesApi.getById(seriesId), youtubeApi.openWorkspace(seriesId)])
      .then(([series, workspace]) => { if (!cancelled) setData({ series, workspace }) })
      .catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not open workspace.') })
    return () => { cancelled = true }
  }, [seriesId, retry])
  return <div className="mx-auto min-w-0 max-w-7xl space-y-6 p-5 sm:p-8">
    <div className="flex items-center gap-2 text-xs text-muted-foreground"><Link to="/youtube" className="flex items-center gap-1.5 rounded py-1 hover:text-foreground"><ArrowLeft className="h-3.5 w-3.5" />YouTube</Link><span>/</span><span className="truncate">Series workspace</span></div>
    {error ? <div role="alert" className="rounded-xl border border-destructive/20 bg-destructive/5 p-6"><p className="font-medium">Could not open this workspace</p><p className="mt-2 text-sm text-muted-foreground">{error}</p><Button className="mt-4" variant="outline" onClick={() => setRetry(value => value + 1)}>Try again</Button></div>
      : !data ? <div role="status" className="flex items-center justify-center gap-3 rounded-xl border bg-card py-24 text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" />Opening your workspace…</div>
      : <>
        <header className="flex flex-col justify-between gap-5 sm:flex-row sm:items-start">
          <div className="flex min-w-0 items-start gap-4"><div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-red-500/15 bg-red-500/5"><Youtube className="h-6 w-6 text-red-500" /></div><div className="min-w-0"><h1 className="break-words text-2xl font-semibold tracking-tight sm:text-3xl">{data.series.title}</h1><div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground"><Badge variant="secondary" className="font-normal">English</Badge><span>Shared across all parts</span><span className="flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />Saved workspace</span></div></div></div>
          <Button variant="outline" size="sm" asChild><Link to="/settings?tab=youtube"><Settings className="mr-2 h-4 w-4" />Guidelines</Link></Button>
        </header>
        <Tabs value={tab} onValueChange={setTab} className="space-y-6">
          <TabsList className="h-auto w-full justify-start gap-2 overflow-x-auto rounded-none border-b bg-transparent p-0" aria-label="YouTube workspace sections">
            <TabsTrigger value="title" className="gap-2 rounded-none border-b-2 border-transparent px-3 py-3 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"><Type className="h-4 w-4" />Titles{data.workspace.titles.suggestions.length > 0 && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{data.workspace.titles.suggestions.length}</span>}</TabsTrigger>
            <TabsTrigger value="description" className="gap-2 rounded-none border-b-2 border-transparent px-3 py-3 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"><FileText className="h-4 w-4" />Description{data.workspace.description && <CheckCircle2 className="h-3 w-3 text-emerald-500" />}</TabsTrigger>
            <TabsTrigger value="thumbnail" className="gap-2 rounded-none border-b-2 border-transparent px-3 py-3 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"><Image className="h-4 w-4" />Thumbnail{data.workspace.selectedThumbnail && <CheckCircle2 className="h-3 w-3 text-emerald-500" />}</TabsTrigger>
          </TabsList>
          <TabsContent value="title" forceMount className="mt-0 data-[state=inactive]:hidden"><YouTubeTitles key={data.series.id} workspace={data.workspace} onDescription={() => setTab('description')} onSaved={workspace => setData(current => current && ({ ...current, workspace }))} /></TabsContent>
          <TabsContent value="description" forceMount className="mt-0 data-[state=inactive]:hidden"><YouTubeDescription key={data.series.id} workspace={data.workspace} onSaved={workspace => setData(current => current && ({ ...current, workspace }))} onTitles={() => setTab('title')} /></TabsContent>
          <TabsContent value="thumbnail" forceMount className="mt-0 data-[state=inactive]:hidden"><YouTubeThumbnails key={data.series.id} workspace={data.workspace} onSaved={workspace => setData(current => current && ({ ...current, workspace }))} onTitles={() => setTab('title')} /></TabsContent>
        </Tabs>
      </>}
  </div>
}
