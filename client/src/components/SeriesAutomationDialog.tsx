import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, CheckCircle2, Loader2, Play, Smartphone, Square } from 'lucide-react'
import { usePhoneOverview } from '@/hooks/usePhoneOverview'
import { usePhoneRelay } from '@/hooks/usePhoneRelay'
import { usePhoneScreens } from '@/hooks/usePhoneScreens'
import { useSocket } from '@/lib/socket'
import { productionApi, type PhoneOverviewPhone, type ProductionConfig, type ProductionJob, type ProductionStep, type Series } from '@/lib/api'
import { ClipperSettings, phoneRuns } from '@/pages/sleeper/RunAutomation'
import { PhoneProfilePicker, NO_CHATGPT_CHOICES, hasChoices } from '@/pages/sleeper/PhoneProfile'
import { onPhone, phoneActivity, phoneList, useNow } from '@/pages/sleeper/sleeperShared'
import { PRODUCTION_STEP_LABELS } from '../../../server/src/services/productionAutomationModel'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import { useToast } from './ui/use-toast'

/** The Library starts the ordered production sequence, resuming from saved work. */
export function SeriesAutomationDialog({ series, onClose }: { series: Series; onClose: () => void }) {
  const { status: overview } = usePhoneOverview()
  const relay = usePhoneRelay()
  const screens = usePhoneScreens()
  const now = useNow(false)
  const { socket } = useSocket()
  const { toast } = useToast()
  const [selected, setSelected] = useState<string | null>(null)
  const [parallel, setParallel] = useState(false)
  const [extraDevices, setExtraDevices] = useState<string[]>([])
  const [pendingProfiles, setPendingProfiles] = useState<Record<string, boolean>>({})
  const [state, setState] = useState<{ job: ProductionJob | null; nextStep: ProductionStep } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [selectingProfile, setSelectingProfile] = useState(false)
  const [clipper, setClipper] = useState<ProductionConfig['clipper']>({ ai: 'chatgpt', flow: 'classic', tabs: 2, chatGpt: NO_CHATGPT_CHOICES })
  const phones = phoneList(overview, relay)
  const several = phones.length > 1
  const phone = phones.find(p => p.id === selected)
  const profiles = overview && phone ? overview.profiles.filter(p => onPhone(p, phone, several)) : []
  const profile = profiles.find(p => p.selected)
  const job = state?.job
  const running = job?.status === 'running'

  const reload = useCallback(() => {
    productionApi.get(series.id).then(next => { setState(next); setError(null) }).catch(e => setError(e instanceof Error ? e.message : String(e)))
  }, [series.id])
  useEffect(reload, [reload])
  useEffect(() => {
    if (!socket) return
    const receive = (next: ProductionJob) => {
      if (next.seriesId === series.id) setState(s => ({ nextStep: s?.nextStep ?? next.step, job: next }))
    }
    socket.on('production:updated', receive)
    socket.on('connect', reload)
    socket.on('series-process:updated', reload)
    return () => { socket.off('production:updated', receive); socket.off('connect', reload); socket.off('series-process:updated', reload) }
  }, [socket, series.id, reload])

  const blocker = (target: PhoneOverviewPhone, primary = true): string | null => {
    if (!relay?.configured) return 'Set up the phone relay in Settings → Cloudflare.'
    if (!relay.connected) return 'Manhwa Studio can’t reach the relay right now.'
    if (!target.id) return 'Update Sleeper-Cell to start this phone individually.'
    if (!target.connected) return 'Open Sleeper-Cell on this phone to start it.'
    if (!target.automation?.remoteStart) return 'Turn on “Start from Manhwa Studio” in the phone’s Automation settings.'
    const kinds = primary ? ['narration', 'voiceover', 'clipper'] as const : ['voiceover', 'clipper'] as const
    if (!kinds.every(kind => phoneRuns(target).includes(kind))) return 'Update Sleeper-Cell to support this automation.'
    if (!kinds.every(kind => target.automation?.chapterRuns?.includes(kind))) return 'Update Sleeper-Cell to skip completed chapters during automation.'
    if (!target.automation.clipper) return 'Update Sleeper-Cell to choose clipping settings.'
    if (phoneActivity(overview, target, several).busy) return 'A run is already in progress. Manage it in Phone Status.'
    return null
  }
  const choosePhone = (target: PhoneOverviewPhone) => {
    setSelected(target.id)
    if (state?.job?.config.device === target.id) {
      const savedDevices = state.job.config.parallelDevices?.map(d => d.device) ?? []
      setParallel(savedDevices.length > 0)
      setExtraDevices(savedDevices)
    } else setExtraDevices(ids => ids.filter(id => id !== target.id))
    setClipper(state?.job?.config.device === target.id ? state.job.config.clipper : {
      ai: target.automation?.clipper?.ai ?? 'chatgpt', flow: target.automation?.clipper?.flow ?? 'classic',
      tabs: target.automation?.clipper?.tabs ?? 2, chatGpt: target.automation?.clipper?.chatGpt ?? NO_CHATGPT_CHOICES
    })
  }
  const additional = parallel ? extraDevices.filter(id => id !== selected) : []
  const parallelTargets = additional.map(id => {
    const target = phones.find(p => p.id === id)
    const targetProfiles = target ? overview?.profiles.filter(p => onPhone(p, target, several)) ?? [] : []
    return { id, target, profiles: targetProfiles, profile: targetProfiles.find(p => p.selected) }
  })
  const parallelReady = !parallel || additional.length > 0 && parallelTargets.every(t => t.target && !blocker(t.target, false) && t.profile && !pendingProfiles[t.id])
  const start = async () => {
    if (!phone || !profile || selectingProfile || blocker(phone) || !parallelReady) return
    setSending(true)
    setError(null)
    try {
      const next = await productionApi.start(series.id, { device: phone.id, profileId: profile.profileId,
        ...(parallel ? { parallelDevices: parallelTargets.map(t => ({ device: t.id, profileId: t.profile!.profileId })) } : {}),
        clipper: { ...clipper, chatGpt: hasChoices(profile) === false ? NO_CHATGPT_CHOICES : clipper.chatGpt } })
      setState(s => ({ job: next, nextStep: s?.nextStep ?? next.step }))
      toast({ title: 'Production automation started', description: `${series.title} · ${additional.length + 1} phone${additional.length ? 's' : ''}. Stops for review before Editor 2.0.` })
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setSending(false) }
  }
  const stop = async () => {
    setSending(true)
    try { const next = await productionApi.stop(series.id); setState(s => ({ job: next, nextStep: s?.nextStep ?? next.step })) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setSending(false) }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Run Sleeper-Cell automation</DialogTitle>
          <DialogDescription>{series.title}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 rounded-lg border bg-muted/30 p-3 text-sm">
          <p className="font-medium">Scripts → Voiceovers → Image Clipping</p>
          <p className="text-xs text-muted-foreground">English and Hinglish. Resumes at the first unfinished step. Voiceovers are fetched and alignment runs automatically on this Mac. Stops for manual review before Editor 2.0.</p>
          {state && !running && <p className="text-xs font-medium">{state.nextStep === 'preparation' ? 'Complete Preparation first.' : state.nextStep === 'complete' ? 'All parts are complete.' : `Resumes at ${PRODUCTION_STEP_LABELS[state.nextStep]}`}</p>}
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {job && <div role="status" className="space-y-2 rounded-lg border p-4">
          <p className="flex items-center gap-2 text-sm font-medium">{running ? <Loader2 className="h-4 w-4 animate-spin" /> : job.status === 'review' ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : null}{PRODUCTION_STEP_LABELS[job.step]}</p>
          <p className="text-sm text-muted-foreground">{job.message}</p>
          {running && <p className="text-xs text-muted-foreground">You can close this dialog. The sequence continues while Manhwa Studio’s server is running.</p>}
          {job.status === 'review' && <Button asChild variant="outline" size="sm"><Link to={`/clipper3/series/${series.id}`}>Review Image Clipping</Link></Button>}
        </div>}
        {!running && state?.nextStep !== 'complete' && state?.nextStep !== 'preparation' && state?.nextStep !== 'review' && (
          !overview || !relay || !state
            ? <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading phones and production progress…</p>
            : phone ? <div className="space-y-5">
              <div className="flex items-center justify-between gap-3"><p className="flex items-center gap-2 text-sm font-medium"><Smartphone className="h-4 w-4" />{phone.name}</p><Button variant="ghost" size="sm" onClick={() => setSelected(null)}><ArrowLeft className="mr-1 h-3.5 w-3.5" />Change device</Button></div>
              <PhoneProfilePicker phone={phone} profiles={profiles} relay={relay} screen={screens.get(phone.id) ?? null} onPending={setSelectingProfile} />
              {!profiles.length && <p className="text-sm text-amber-500">This phone has not reported any profiles. Check its accounts in Sleeper Cells.</p>}
              {blocker(phone) && <p className="text-sm text-amber-500">{blocker(phone)}</p>}
              <div className="space-y-3 border-t pt-4">
                <p className="text-sm font-semibold">Device processing</p>
                <div role="radiogroup" aria-label="Device processing" className="flex flex-wrap gap-2">
                  <Button role="radio" aria-checked={!parallel} variant={!parallel ? 'default' : 'outline'} size="sm" onClick={() => setParallel(false)}>Single device</Button>
                  <Button role="radio" aria-checked={parallel} variant={parallel ? 'default' : 'outline'} size="sm" onClick={() => setParallel(true)}>Parallel devices</Button>
                </div>
                <p className="text-xs text-muted-foreground">Scripts run in chapter order on {phone.name}. Parallel devices share unfinished voiceover and clipping chapters with no overlap. Clipping settings apply to every selected phone.</p>
                {parallel && <div className="space-y-3">
                  {phones.filter(p => p.id !== phone.id).map(target => {
                    const checked = extraDevices.includes(target.id)
                    const targetProfiles = overview?.profiles.filter(p => onPhone(p, target, several)) ?? []
                    const reason = blocker(target, false)
                    return <div key={target.id || target.name} className="space-y-3 rounded-md border p-3">
                      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={checked} disabled={!!reason && !checked} onChange={e => setExtraDevices(ids => e.target.checked ? [...ids, target.id] : ids.filter(id => id !== target.id))} /><span><span className="block font-medium">{target.name}</span>{reason && <span className="text-xs text-amber-500">{reason}</span>}</span></label>
                      {checked && <PhoneProfilePicker phone={target} profiles={targetProfiles} relay={relay} screen={screens.get(target.id) ?? null} onPending={pending => setPendingProfiles(p => p[target.id] === pending ? p : { ...p, [target.id]: pending })} />}
                      {checked && !targetProfiles.length && <p className="text-xs text-amber-500">This phone has not reported any profiles.</p>}
                    </div>
                  })}
                  {!additional.length && <p className="text-xs text-muted-foreground">Select at least one additional connected device and its profile.</p>}
                </div>}
              </div>
              <div className="space-y-4 border-t pt-4"><h3 className="text-sm font-semibold">5. Image Clipping settings</h3><ClipperSettings phone={phone} profiles={profiles} relay={relay} screen={screens.get(phone.id) ?? null} now={now} value={clipper} onChange={setClipper} /></div>
            </div> : <div className="space-y-3">
              <p className="text-sm font-medium">Choose a device</p>
              {!relay.configured && <p className="text-sm text-muted-foreground">Set up the relay in <Link to="/settings?tab=cloudflare" className="underline">Settings → Cloudflare</Link>.</p>}
              {!phones.length && <p className="text-sm text-muted-foreground">Open Sleeper-Cell on a phone with “Start from Manhwa Studio” enabled.</p>}
              {phones.map(target => <Button key={target.id || target.name} variant="outline" className="h-auto w-full justify-start gap-3 whitespace-normal p-4 text-left" disabled={!!blocker(target)} onClick={() => choosePhone(target)}>
                <Smartphone className="h-5 w-5 shrink-0" /><span><span className="block font-medium">{target.name}</span><span className="mt-1 block text-xs font-normal text-muted-foreground">{blocker(target) ?? 'Ready · Choose profile and clipping settings'}</span></span>
              </Button>)}
            </div>
        )}
        {state?.nextStep === 'review' && !running && !job && <p className="text-sm">Image Clipping is ready. Review the results before starting Editor 2.0.</p>}
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" onClick={onClose}>Close</Button>
          {running ? <Button variant="outline" onClick={stop} disabled={sending}><Square className="mr-2 h-4 w-4" />Stop automation</Button>
            : state?.nextStep === 'preparation' ? <Button asChild variant="outline"><Link to={`/series/${series.id}`}>Open Preparation</Link></Button>
            : state?.nextStep === 'review' ? <Button asChild variant="outline"><Link to={`/clipper3/series/${series.id}`}>Review Image Clipping</Link></Button>
            : state?.nextStep !== 'complete' && <Button onClick={start} disabled={sending || !state || !phone || !profile || selectingProfile || !parallelReady || !!(phone && blocker(phone))}>
              {sending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}{job ? 'Resume automation' : 'Start automation'}
            </Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
