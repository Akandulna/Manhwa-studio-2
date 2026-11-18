import { useEffect, useRef, useState } from 'react'
import { Clapperboard, Download, FolderOpen, Loader2, Play, RefreshCw, Volume2, VolumeX, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { shortsApi, type ShortProject, type ShortPreviewJob } from '@/lib/shortsApi'

const storageKey = 'shorts:last-folder'
const time = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`

export default function Shorts() {
  const [folder, setFolder] = useState(() => localStorage.getItem(storageKey) || '')
  const [folders, setFolders] = useState<{ name: string; folder: string }[]>([])
  const [project, setProject] = useState<ShortProject | null>(null)
  const [job, setJob] = useState<ShortPreviewJob | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState(0)
  const video = useRef<HTMLVideoElement>(null)
  const mounted = useRef(true)
  const loading = useRef(0)

  async function load(target: string) {
    const request = ++loading.current
    setBusy(true); setError(''); setJob(null)
    try {
      const result = await shortsApi.load(target)
      if (!mounted.current || request !== loading.current) return
      setProject(result); setSelected(0); setFolder(result.folder)
      localStorage.setItem(storageKey, result.folder)
      const previous = await shortsApi.latest(result.id)
      if (mounted.current && request === loading.current) setJob(previous)
    } catch (e) { if (mounted.current && request === loading.current) setError((e as Error).message) }
    finally { if (mounted.current && request === loading.current) setBusy(false) }
  }

  useEffect(() => {
    mounted.current = true
    void shortsApi.folders().then(list => {
      if (!mounted.current) return
      setFolders(list)
      const initial = localStorage.getItem(storageKey) || list.find(f => f.name === 'grand-duke-shorts-40s')?.folder || list[0]?.folder
      if (initial) void load(initial)
    }).catch(e => { if (mounted.current) setError(e.message) })
    return () => { mounted.current = false; loading.current++ }
  }, [])

  useEffect(() => {
    if (!job || job.state !== 'rendering') return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await shortsApi.job(job.id)
        if (cancelled) return
        setJob(next)
        if (next.state === 'failed') setError(next.message)
      } catch (e) { if (!cancelled) setError((e as Error).message) }
      if (!cancelled) timer = setTimeout(poll, 1000)
    }
    timer = setTimeout(poll, 500)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [job?.id, job?.state])

  async function generate() {
    if (!project) return
    setBusy(true); setError('')
    try { setJob(await shortsApi.start(project)) }
    catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }

  const shot = project?.shots[selected]
  const rendering = job?.state === 'rendering'
  const ready = job?.state === 'complete' && job.videoUrl && job.revision === project?.revision
  const chooseShot = (index: number) => { setSelected(index); if (video.current && project) video.current.currentTime = project.shots[index].start }

  return <div className="mx-auto max-w-7xl p-6 space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-3"><Clapperboard className="h-7 w-7 text-primary" />Shorts</h1>
        <p className="mt-2 text-muted-foreground">Turn a timeline folder into a vertical video preview.</p>
      </div>
      {project && <div className="flex gap-2"><Badge variant="secondary">9:16</Badge><Badge variant="secondary">{project.duration.toFixed(0)} seconds</Badge><Badge variant="secondary">{project.shots.length} shots</Badge></div>}
    </div>

    <Card className="p-5 space-y-4">
      <div className="flex items-center gap-2 font-medium"><FolderOpen className="h-5 w-5 text-primary" />Short folder</div>
      <form className="flex flex-wrap gap-3" onSubmit={e => { e.preventDefault(); void load(folder) }}>
        <Input aria-label="Short folder path" value={folder} onChange={e => setFolder(e.target.value)} placeholder="Paste the folder path containing your timeline and crops3" className="flex-1 min-w-[220px]" disabled={rendering} />
        <Button type="submit" variant="outline" disabled={busy || rendering || !folder.trim()}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}Load folder</Button>
      </form>
      {!!folders.length && <div className="flex items-center gap-2 flex-wrap"><span className="text-xs text-muted-foreground">Available folders</span>{folders.map(f => <Button key={f.folder} variant={project?.folder === f.folder ? 'secondary' : 'ghost'} size="sm" disabled={busy || rendering} onClick={() => void load(f.folder)}>{f.name}</Button>)}</div>}
      <p className="text-xs text-muted-foreground">Choose an extracted folder on this computer with a .timeline.json file and a crops3 folder.</p>
    </Card>

    {error && <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">{error}</div>}

    {project && shot && <div className="grid gap-6 lg:grid-cols-[minmax(280px,420px)_minmax(0,1fr)]">
      <div className="space-y-4">
        <div className="relative mx-auto aspect-[9/16] w-full max-w-[360px] overflow-hidden rounded-2xl border bg-black shadow-xl">
          {ready ? <video ref={video} key={job.id} src={job.videoUrl} controls playsInline preload="metadata" aria-label="Shorts video preview" className="h-full w-full" onTimeUpdate={e => {
            const current = e.currentTarget.currentTime
            const index = project.shots.findIndex(s => current >= s.start && current < s.end)
            if (index >= 0) setSelected(index)
          }} /> : <>
            <img src={shortsApi.image(project, shot.images[0])} alt="" className="absolute inset-0 h-full w-full object-cover opacity-40 blur-xl" />
            <img src={shortsApi.image(project, shot.images[0])} alt={`Shot ${selected + 1}`} className="absolute inset-0 h-full w-full object-contain" />
            {shot.caption && <div className="absolute bottom-[15%] left-[7%] right-[10%] rounded-lg bg-black/85 px-3 py-3 text-center text-lg font-extrabold leading-tight text-yellow-300">{shot.caption}</div>}
            <Badge className="absolute top-3 left-3">Shot {selected + 1} · {time(shot.start)}</Badge>
          </>}
          {rendering && <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/75 p-6 text-center text-white" role="status"><Loader2 className="h-9 w-9 animate-spin" /><p>{job.message}</p><div className="h-2 w-full rounded bg-white/20"><div className="h-full rounded bg-primary transition-all" style={{ width: `${job.progress}%` }} /></div><p className="text-sm">{job.progress}%</p></div>}
        </div>
        <Button className="w-full" onClick={() => void generate()} disabled={busy || rendering || project.missingImages.length > 0}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}{ready ? 'Regenerate preview' : 'Generate preview'}</Button>
        {rendering && <Button variant="outline" className="w-full" onClick={() => void shortsApi.cancel(job.id).then(setJob).catch(e => setError(e.message))}><X className="mr-2 h-4 w-4" />Cancel render</Button>}
        {ready && <Button variant="outline" className="w-full" asChild><a href={job.videoUrl} download="shorts-preview.mp4"><Download className="mr-2 h-4 w-4" />Download preview MP4</a></Button>}
        <p className="text-center text-xs text-muted-foreground">Preview quality · 540 × 960 · 30 fps</p>
      </div>

      <div className="min-w-0 space-y-5">
        <div><h2 className="text-xl font-semibold">{project.title}</h2>{project.series && <p className="text-sm text-muted-foreground mt-1">{project.series}</p>}</div>
        <Card className="p-4 space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">{project.audioFile ? <Volume2 className="h-4 w-4 text-emerald-500" /> : <VolumeX className="h-4 w-4 text-amber-500" />}{project.audioFile ? `Voiceover: ${project.audioFile}` : 'Silent preview'}</div>
          {project.warnings.map(w => <p key={w} className="text-sm text-muted-foreground">{w}</p>)}
          {!!project.missingImages.length && <div className="text-sm text-destructive"><p>{project.missingImages.length} missing or unreadable images. Restore them, then reload.</p><ul className="mt-2 max-h-28 overflow-auto break-all text-xs">{project.missingImages.map(f => <li key={f}>{f}</li>)}</ul></div>}
        </Card>
        <div className="space-y-3">
          <div className="flex items-center justify-between"><h3 className="font-semibold">Shot sequence</h3><span className="text-xs text-muted-foreground">Select a shot to inspect</span></div>
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-7 lg:grid-cols-5 xl:grid-cols-7">
            {project.shots.map((s, i) => <button key={s.id} onClick={() => chooseShot(i)} aria-label={`Select shot ${i + 1}`} aria-pressed={selected === i} className={`overflow-hidden rounded-lg border-2 text-left transition-colors ${selected === i ? 'border-primary bg-primary/10' : 'border-transparent bg-muted hover:border-muted-foreground/40'}`}>
              <img loading="lazy" src={shortsApi.image(project, s.images[0])} alt="" className="aspect-[3/4] w-full object-cover" /><div className="p-1.5 text-xs"><span className="font-semibold">{String(i + 1).padStart(2, '0')}</span><span className="block text-muted-foreground">{time(s.start)}</span></div>
            </button>)}
          </div>
        </div>
        <Card className="p-5 space-y-4">
          <div className="flex items-center justify-between"><h3 className="font-semibold">Shot {selected + 1}</h3><Badge variant="outline">{time(shot.start)} – {time(shot.end)}</Badge></div>
          <div><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">Narration</p><p>{shot.narration || 'No narration text supplied.'}</p></div>
          {shot.caption && <div><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">On-screen text</p><p className="font-semibold">{shot.caption}</p></div>}
          {shot.note && <p className="text-sm text-muted-foreground">{shot.note}</p>}
        </Card>
        <p className="text-xs text-muted-foreground">The preview includes the selected images, gentle motion, and on-screen text. Music and sound-effect notes remain editing cues.</p>
      </div>
    </div>}
    {!project && !busy && !error && <div className="py-12 text-center text-muted-foreground"><FolderOpen className="mx-auto mb-4 h-12 w-12 opacity-40" /><p>Load a Short folder to see its shots and generate a preview.</p></div>}
  </div>
}
