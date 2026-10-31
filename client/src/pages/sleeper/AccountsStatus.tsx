import ManagedAccountsPanel from './ManagedAccountsPanel'
/**
 * Accounts — every browser profile on the phones (one ChatGPT and one Google
 * account each): its plans, ChatGPT's image limit over the rolling 3 hours, and
 * Gemini's daily requests in AI Studio for speech (voiceover) and scripts
 * (narration). Totals on top, then one table of accounts.
 *
 * The phones sign in to the same accounts, and the limits are the account's,
 * not the phone's: a profile on each phone with the same account name (any
 * case) is one row, its uploads and requests added up across the phones.
 *
 * Work limits are ChatGPT's plan limits that Codex and Work mode share (a 5-hour
 * and a weekly window, as chatgpt.com/codex/settings/usage shows them), as the
 * phone last read them: in that check, and in Image Clipper and Editor runs.
 *
 * Plans are what Sleeper-Cell's Tools → Profiles → Check last found on the
 * phone (each profile's `check`). A profile never checked there can have its
 * plan set here instead, kept in the Setting table (`phoneAccountPlans`) by
 * account name, so the same account keeps it on any phone.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Users } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { usePhoneOverview } from '@/hooks/usePhoneOverview'
import { usePhoneRelay } from '@/hooks/usePhoneRelay'
import {
  settingsApi,
  type PhoneChatGptUsage,
  type PhoneGeminiProfile,
  type PhoneGeminiUsage,
  type PhoneOverview,
  type PhoneOverviewRun,
  type PhoneProfileCheck,
  type PhoneSiteCheck,
  type PhoneUploadProfile,
  type PhoneUsageWindow
} from '@/lib/api'
import { UPLOAD_LIMIT, uploadOverview, uploadUsage, type UploadUsage } from '@/lib/uploadUsage'
import { cn } from '@/lib/utils'
import { ago, Bar, clock, HOUR, InfoTip, MINUTE, phoneList, planLabel, plural, SleeperPage, span, useNow } from './sleeperShared'

/** A profile running out sooner than this is flagged. */
const RUNS_OUT_SOON_MS = 30 * MINUTE

/** A Work limit window with less than this left (in percent) is flagged. */
const WORK_LOW_PERCENT = 20

const PLANS_KEY = 'phoneAccountPlans'
const CHATGPT_PLANS = ['Free', 'Go', 'Plus', 'Pro', 'Business'] as const
const GEMINI_PLANS = ['Free', 'AI Pro', 'AI Ultra'] as const
const NO_PLAN = 'none'

type PlanKind = 'chatgpt' | 'gemini'
type Plans = Record<string, Partial<Record<PlanKind, string>>>

/** The plans set here, by account name, saved to the server as they change. */
function usePlans() {
  const { toast } = useToast()
  const [plans, setPlans] = useState<Plans>({})
  const current = useRef(plans)
  useEffect(() => {
    settingsApi.getAll()
      .then(all => {
        const saved = (all as unknown as Record<string, string>)[PLANS_KEY]
        if (!saved) return
        try {
          current.current = JSON.parse(saved) as Plans
          setPlans(current.current)
        } catch { /* a broken value is replaced on the next change */ }
      })
      .catch(() => {})
  }, [])
  const setPlan = (account: string, kind: PlanKind, plan: string | null) => {
    const next: Plans = { ...current.current, [account]: { ...current.current[account], [kind]: plan ?? undefined } }
    current.current = next
    setPlans(next)
    settingsApi.update(PLANS_KEY, JSON.stringify(next)).catch(error => {
      toast({ title: 'Could not save the plan', description: error instanceof Error ? error.message : String(error), variant: 'destructive' })
    })
  }
  return { plans, setPlan }
}

/** One account, across every phone that has a profile for it, ChatGPT and both Gemini limits. */
interface Account {
  key: string
  /** As the first phone names it. */
  name: string
  /** Every name the phones give it (they differ only in case), for the plans saved by name. */
  names: string[]
  /** The phones with a profile for it. */
  phones: (string | null)[]
  /** The phones whose browser is on it: their next run starts in it. */
  selectedOn: (string | null)[]
  upload: UploadUsage | null
  speech: PhoneGeminiProfile | null
  scripts: PhoneGeminiProfile | null
  /** The latest Tools → Profiles → Check of it, on any phone. */
  check: PhoneProfileCheck | null
  /** Its Work limits as last read, on any phone. */
  usage: PhoneChatGptUsage | null
}

const accountKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase()

const latest = (times: (string | null)[]): string | null =>
  times.reduce<string | null>((best, t) => (t && (!best || Date.parse(t) > Date.parse(best)) ? t : best), null)

/** One account's ChatGPT profiles on several phones as one: their upload slots added up, the latest limit. */
function mergeUploads(profiles: PhoneUploadProfile[]): PhoneUploadProfile {
  if (profiles.length === 1) return profiles[0]
  const slots = new Map<string, number>()
  for (const u of profiles.flatMap(p => p.uploads)) slots.set(u.at, (slots.get(u.at) ?? 0) + u.images)
  return {
    ...profiles[0],
    selected: profiles.some(p => p.selected),
    limitedUntil: latest(profiles.map(p => p.limitedUntil)),
    uploads: [...slots].map(([at, images]) => ({ at, images })).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
    limits: profiles.flatMap(p => p.limits).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  }
}

/** One account's Gemini profiles on several phones as one: today's requests added up, the highest limit seen. */
function mergeGemini(profiles: PhoneGeminiProfile[]): PhoneGeminiProfile | null {
  if (profiles.length <= 1) return profiles[0] ?? null
  const limits = profiles.map(p => p.limit).filter((l): l is number => l !== null)
  return {
    ...profiles[0],
    selected: profiles.some(p => p.selected),
    today: profiles.reduce((sum, p) => sum + p.today, 0),
    limit: limits.length ? Math.max(...limits) : null,
    limitedUntil: latest(profiles.map(p => p.limitedUntil))
  }
}

function accountsOf(overview: PhoneOverview | null, now: number): Account[] {
  const found = new Map<string, {
    account: Account; uploads: PhoneUploadProfile[]; speech: PhoneGeminiProfile[]; scripts: PhoneGeminiProfile[]
  }>()
  const add = (p: { name: string; phone: string | null; selected: boolean }) => {
    const key = accountKey(p.name)
    let entry = found.get(key)
    if (!entry) {
      const account: Account = { key, name: p.name, names: [], phones: [], selectedOn: [], upload: null, speech: null, scripts: null, check: null, usage: null }
      entry = { account, uploads: [], speech: [], scripts: [] }
      found.set(key, entry)
    }
    const { account } = entry
    if (!account.names.includes(p.name)) account.names.push(p.name)
    if (!account.phones.includes(p.phone)) account.phones.push(p.phone)
    if (p.selected && !account.selectedOn.includes(p.phone)) account.selectedOn.push(p.phone)
    return entry
  }
  for (const p of overview?.profiles ?? []) add(p).uploads.push(p)
  for (const p of overview?.gemini?.speech?.profiles ?? []) add(p).speech.push(p)
  for (const p of overview?.gemini?.narration?.profiles ?? []) add(p).scripts.push(p)
  return [...found.values()].map(({ account, uploads, speech, scripts }) => {
    const checks = uploads.map(p => p.check).filter((c): c is PhoneProfileCheck => !!c)
    const lastCheck = latest(checks.map(c => c.checkedAt))
    // A failed read counts only when no phone has a real one.
    const usages = uploads.map(p => p.usage).filter((u): u is PhoneChatGptUsage => !!u)
    const read = usages.some(u => !u.error) ? usages.filter(u => !u.error) : usages
    const lastUsage = latest(read.map(u => u.checkedAt))
    return {
      ...account,
      usage: read.find(u => u.checkedAt === lastUsage) ?? null,
      upload: uploads.length ? uploadUsage(mergeUploads(uploads), now) : null,
      speech: mergeGemini(speech),
      scripts: mergeGemini(scripts),
      check: checks.find(c => c.checkedAt === lastCheck) ?? null
    }
  })
}

/** Is a Gemini run of this kind on this account now, on any phone. With one profile the run names none: the selected one is it. */
function geminiInUse(runs: PhoneOverviewRun[], kind: PhoneOverviewRun['kind'], account: Account): boolean {
  return runs.some(r => r.kind === kind && account.phones.includes(r.phone) && (
    (r.account != null && accountKey(r.account) === account.key) || (!r.account && account.selectedOn.includes(r.phone))
  ))
}

/** The plans set here for an account, under any of its names. */
const planOf = (plans: Plans, account: Account) =>
  plans[account.name] ?? account.names.map(n => plans[n]).find(Boolean) ?? {}

function PlanSelect({ value, options, onChange, label }: { value: string | undefined; options: readonly string[]; onChange: (plan: string | null) => void; label: string }) {
  return (
    <Select value={value ?? NO_PLAN} onValueChange={v => onChange(v === NO_PLAN ? null : v)}>
      <SelectTrigger className={cn('h-8 w-28 text-xs', !value && 'text-muted-foreground')} aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_PLAN}>Not set</SelectItem>
        {options.map(o => <SelectItem key={o} value={o}>{o}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}

/**
 * A plan's cell: what the phone's check found (signed out in amber, a failed check as —), with the email and when
 * it was checked on hover; the plan set here when the phone never checked the profile.
 */
function PlanCell({ check, site, manual }: { check: PhoneProfileCheck | null; site: PhoneSiteCheck | null; manual: React.ReactNode }) {
  if (!check || !site) return <>{manual}</>
  const title = [site.email, site.error, `Checked on the phone ${new Date(check.checkedAt).toLocaleString()}`].filter(Boolean).join(' · ')
  if (site.error) return <span className="text-muted-foreground" title={title}>—</span>
  if (!site.signedIn) return <span className="text-xs font-medium text-amber-500" title={title}>Signed out</span>
  return <span className="text-sm font-medium" title={title}>{planLabel(site.plan) ?? 'Signed in'}</span>
}

/** A limit's cell: what's left, when it changes, and a bar of what's left. */
function Meter({ main, side, percent, warn, title }: { main: React.ReactNode; side?: React.ReactNode; percent: number | null; warn: boolean; title?: string }) {
  return (
    <div className="w-44 space-y-1" title={title}>
      <div className="flex items-baseline justify-between gap-2 text-xs tabular-nums">
        <span className={cn('font-medium', warn && 'text-amber-500')}>{main}</span>
        {side && <span className="truncate text-muted-foreground">{side}</span>}
      </div>
      {percent !== null && <Bar percent={percent} tone={warn ? 'warn' : 'primary'} />}
    </div>
  )
}

function ImagesCell({ usage, now }: { usage: UploadUsage | null; now: number }) {
  if (!usage) return <span className="text-muted-foreground">—</span>
  const lastLimit = usage.lastLimit
    ? ` · ChatGPT last stopped it at ${usage.lastLimit.used} images (${clock(usage.lastLimit.at)})`
    : ''
  const title = `${usage.used} of ${usage.limit} used in the last 3 hours${lastLimit}`
  if (usage.limitedUntil) {
    return <Meter main="At the limit" side={`back ~${clock(usage.limitedUntil)}`} percent={0} warn title={title} />
  }
  const soon = usage.exhaustsAt !== null && usage.exhaustsAt - now < RUNS_OUT_SOON_MS
  const side = usage.exhaustsAt !== null
    ? `out in ${span(usage.exhaustsAt - now)}`
    : usage.nextFreeAt !== null && usage.used > 0 ? `+${usage.nextFree} ~${clock(usage.nextFreeAt)}` : null
  return <Meter main={`${usage.left} left`} side={side} percent={(usage.left / usage.limit) * 100} warn={soon} title={title} />
}

/** "5h", "Week": a window by its length. */
function windowName(seconds: number): string {
  if (seconds === 7 * 24 * 3600) return 'Week'
  if (seconds >= 24 * 3600) return `${Math.round(seconds / (24 * 3600))}d`
  return seconds > 0 ? `${Math.round(seconds / 3600)}h` : 'Limit'
}

/** "2h 10m", "5d 3h": how long until a reset, as ChatGPT's own usage page puts it. */
function untilLabel(ms: number): string {
  if (ms < 24 * HOUR) return span(ms)
  const hours = Math.round(ms / HOUR)
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** What's left of a window now: a window whose reset has gone by since the read is back to full. */
function windowLeft(w: PhoneUsageWindow, now: number): { left: number; reset: boolean } {
  const resetAt = w.resetAt ? Date.parse(w.resetAt) : NaN
  if (!Number.isNaN(resetAt) && resetAt <= now) return { left: 100, reset: true }
  return { left: Math.max(0, 100 - w.usedPercent), reset: false }
}

/** Can the account use Work now, by its last read: no window used up, ChatGPT not saying the limit is reached. */
function workReady(usage: PhoneChatGptUsage, now: number): boolean {
  const lefts = usage.windows.map(w => windowLeft(w, now))
  if (usage.limitReached && !lefts.some(l => l.reset)) return false
  return lefts.every(l => l.left > 0)
}

/** The Work limits' cell: each window's percent left, when it resets, and a bar of what's left. */
function WorkCell({ usage, now }: { usage: PhoneChatGptUsage | null; now: number }) {
  if (!usage) return <span className="text-muted-foreground" title="Not read yet: run Tools → Profiles → Check on the phone, or an Image Clipper / Editor run in ChatGPT.">—</span>
  const read = `Read on the phone ${ago(usage.checkedAt, now)} (${new Date(usage.checkedAt).toLocaleString()})`
  if (!usage.windows.length) {
    return <span className="text-xs text-muted-foreground" title={[usage.error, read].filter(Boolean).join(' · ')}>{usage.error ? 'Couldn’t read' : 'No limits shown'}</span>
  }
  return (
    <div className="space-y-1.5">
      {usage.windows.map((w, i) => {
        const { left, reset } = windowLeft(w, now)
        const resetAt = w.resetAt ? Date.parse(w.resetAt) : NaN
        const side = reset
          ? 'reset since'
          : Number.isNaN(resetAt) ? null : `resets in ${untilLabel(resetAt - now)}`
        const title = `${windowName(w.seconds)} limit: ${Math.round(w.usedPercent)}% used when read${reset ? ', reset since' : ''}`
          + `${Number.isNaN(resetAt) ? '' : ` · resets ${clock(resetAt)}`} · ${read}`
        return (
          <Meter
            key={i}
            main={<>{windowName(w.seconds)} · {Math.round(left)}% left</>}
            side={side}
            percent={left}
            warn={left <= WORK_LOW_PERCENT || (usage.limitReached && !reset)}
            title={title}
          />
        )
      })}
    </div>
  )
}

function GeminiCell({ profile }: { profile: PhoneGeminiProfile | null }) {
  if (!profile) return <span className="text-muted-foreground">—</span>
  if (profile.limitedUntil) {
    return <Meter main="At the limit" side={`back ~${clock(profile.limitedUntil)}`} percent={0} warn title={`${profile.today} requests today`} />
  }
  if (profile.limit === null) {
    return <Meter main={`${profile.today} used`} side="limit not seen yet" percent={null} warn={false} />
  }
  const left = Math.max(0, profile.limit - profile.today)
  return (
    <Meter
      main={`${left} left`}
      side={`${profile.today} / ${profile.limit}`}
      percent={(left / profile.limit) * 100}
      warn={left <= profile.limit * 0.2}
      title={`${profile.today} of ${profile.limit} requests today`}
    />
  )
}

function Th({ children, tip, className }: { children: React.ReactNode; tip?: string; className?: string }) {
  return (
    <th className={cn('pb-2 pr-4 font-medium', className)}>
      <span className="inline-flex items-center gap-1">{children}{tip && <InfoTip text={tip} />}</span>
    </th>
  )
}

function AccountTable({ accounts, phones, runs, plans, setPlan, now }: {
  accounts: Account[]; phones: string[]; runs: PhoneOverviewRun[]; plans: Plans; setPlan: ReturnType<typeof usePlans>['setPlan']; now: number
}) {
  return (
    <div className="overflow-x-auto">
      {/* Fixed columns, so every phone's table lines up. */}
      <table className="w-full min-w-[1200px] table-fixed text-sm">
        <colgroup>
          <col className="w-[14%]" />
          <col className="w-[9%]" />
          <col className="w-[15%]" />
          <col className="w-[5%]" />
          <col className="w-[16%]" />
          <col className="w-[9%]" />
          <col className="w-[16%]" />
          <col className="w-[16%]" />
        </colgroup>
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
            <Th>Account</Th>
            <Th tip="From Sleeper-Cell’s Tools → Profiles → Check on the phone; set by hand only for a profile never checked there.">ChatGPT plan</Th>
            <Th tip={`ChatGPT takes ${UPLOAD_LIMIT} images per account in any 3 hours, on every plan; each upload counts for 3 hours.`}>Images · 3h</Th>
            <Th className="text-right" tip="Images uploaded in the last 24 hours.">24h</Th>
            <Th tip="ChatGPT’s plan limits, shared by Codex and Work mode (chats don’t count): % left of the 5-hour and weekly windows. Read on the phone in Tools → Profiles → Check and during Image Clipper / Editor runs; a window whose reset has passed shows as full.">Work limits</Th>
            <Th tip="From the same check on the phone: Free, Paid, or Google AI’s plan name when the page shows it.">Gemini plan</Th>
            <Th tip="AI Studio Run taps today for voiceover. The limit is what the profile reached before Gemini last stopped it.">Speech today</Th>
            <Th tip="AI Studio Run taps today for narration scripts, limited apart from speech.">Scripts today</Th>
          </tr>
        </thead>
        <tbody>
          {accounts.map(account => {
            const plan = planOf(plans, account)
            // With several phones, say which ones an account is missing from, and which phone it's next up on.
            const onlyOn = phones.length > 1 && phones.some(p => !account.phones.includes(p))
              ? account.phones.filter((p): p is string => !!p)
              : []
            const uploading = account.upload?.pace != null
            const voicing = geminiInUse(runs, 'voiceover', account)
            const writing = geminiInUse(runs, 'narration', account)
            return (
              <tr key={account.key} className="border-t align-middle">
                <td className="py-2.5 pr-4">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{account.name}</span>
                    {uploading && <Badge className="bg-sky-600 px-1.5 py-0 text-[10px] hover:bg-sky-600">uploading</Badge>}
                    {voicing && <Badge className="bg-sky-600 px-1.5 py-0 text-[10px] hover:bg-sky-600">voicing</Badge>}
                    {writing && <Badge className="bg-sky-600 px-1.5 py-0 text-[10px] hover:bg-sky-600">writing</Badge>}
                    {!uploading && !voicing && !writing && account.selectedOn.length > 0 && (
                      <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                        next up{phones.length > 1 && account.selectedOn[0] && <> · {account.selectedOn.join(', ')}</>}
                      </Badge>
                    )}
                  </div>
                  {onlyOn.length > 0 && <p className="text-[11px] text-muted-foreground">only on {onlyOn.join(', ')}</p>}
                </td>
                <td className="py-2.5 pr-4">
                  <PlanCell
                    check={account.check}
                    site={account.check?.chatGpt ?? null}
                    manual={<PlanSelect label={`${account.name}’s ChatGPT plan`} value={plan.chatgpt} options={CHATGPT_PLANS} onChange={p => setPlan(account.name, 'chatgpt', p)} />}
                  />
                </td>
                <td className="py-2.5 pr-4"><ImagesCell usage={account.upload} now={now} /></td>
                <td className="py-2.5 pr-4 text-right tabular-nums text-muted-foreground">{account.upload ? account.upload.lastDay : '—'}</td>
                <td className="py-2.5 pr-4"><WorkCell usage={account.usage} now={now} /></td>
                <td className="py-2.5 pr-4">
                  <PlanCell
                    check={account.check}
                    site={account.check?.gemini ?? null}
                    manual={<PlanSelect label={`${account.name}’s Gemini plan`} value={plan.gemini} options={GEMINI_PLANS} onChange={p => setPlan(account.name, 'gemini', p)} />}
                  />
                </td>
                <td className="py-2.5 pr-4"><GeminiCell profile={account.speech} /></td>
                <td className="py-2.5"><GeminiCell profile={account.scripts} /></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function Total({ label, value, sub, warn }: { label: string; value: React.ReactNode; sub: React.ReactNode; warn?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className={cn('text-2xl font-bold tabular-nums', warn && 'text-amber-500')}>{value}</div>
      <div className="text-xs text-muted-foreground">{sub}</div>
    </div>
  )
}

/** A Gemini limit over every account: how many can still make requests. */
function GeminiTotal({ label, usage, profiles, now }: { label: string; usage: PhoneGeminiUsage | null; profiles: PhoneGeminiProfile[]; now: number }) {
  if (!usage || !profiles.length) return <Total label={label} value="—" sub="Not reported by this build" />
  const ready = profiles.filter(p => !p.limitedUntil && (p.limit === null || p.today < p.limit)).length
  const today = profiles.reduce((sum, p) => sum + p.today, 0)
  const resetsAt = Date.parse(usage.resetsAt)
  return (
    <Total
      label={label}
      warn={ready === 0}
      value={<>{ready}<span className="text-base font-semibold text-muted-foreground"> / {profiles.length} ready</span></>}
      sub={<>{plural(today, 'request')} today · resets ~{clock(resetsAt)}{resetsAt > now && <> (in {span(resetsAt - now)})</>}</>}
    />
  )
}

export default function AccountsStatus() {
  const receipt = usePhoneOverview()
  const relay = usePhoneRelay()
  const overview = receipt.status
  const now = useNow(false)
  const { plans, setPlan } = usePlans()
  const accounts = useMemo(() => accountsOf(overview, now), [overview, now])
  const phones = phoneList(overview, relay)
  const phoneNames = phones.map(p => p.name)
  const runs = overview?.runs ?? []

  const usages = accounts.map(a => a.upload).filter((u): u is UploadUsage => u !== null)
  const total = uploadOverview(usages, now)
  const limited = usages.filter(u => u.limitedUntil).length

  const workUsages = accounts.map(a => a.usage).filter((u): u is PhoneChatGptUsage => u !== null && u.windows.length > 0)
  const workReadyCount = workUsages.filter(u => workReady(u, now)).length
  // When the first used-up account gets Work back: its earliest window reset that's still ahead.
  const workBackAt = workUsages
    .filter(u => !workReady(u, now))
    .map(u => Math.max(...u.windows.filter(w => windowLeft(w, now).left <= 0 || u.limitReached).map(w => (w.resetAt ? Date.parse(w.resetAt) : NaN)).filter(t => !Number.isNaN(t))))
    .filter(t => Number.isFinite(t))
    .sort((a, b) => a - b)[0]

  const speech = accounts.map(a => a.speech).filter((p): p is PhoneGeminiProfile => p !== null)
  const scripts = accounts.map(a => a.scripts).filter((p): p is PhoneGeminiProfile => p !== null)

  return (
    <SleeperPage icon={Users} title="Accounts" receipt={receipt}>
      <ManagedAccountsPanel/>
      {overview && (
        <>
          <Card className="mb-6">
            <CardContent className="grid gap-6 p-5 sm:grid-cols-2 lg:grid-cols-4">
              {usages.length
                ? (
                  <Total
                    label="ChatGPT images"
                    warn={total.left === 0}
                    value={<>{total.left}<span className="text-base font-semibold text-muted-foreground"> / {usages.length * UPLOAD_LIMIT} left</span></>}
                    sub={limited
                      ? <>{limited} of {plural(usages.length, 'account')} at the limit{total.nextLiftAt !== null && <> · first back ~{clock(total.nextLiftAt)}</>}</>
                      : total.allUsedAt !== null
                      ? <>At ~{Math.round(total.pace!)}/h, all used ~{clock(total.allUsedAt)}</>
                      : <>Every account can upload</>}
                  />
                )
                : <Total label="ChatGPT images" value="—" sub="Not reported by this build" />}
              {workUsages.length
                ? (
                  <Total
                    label="ChatGPT · Work limits"
                    warn={workReadyCount === 0}
                    value={<>{workReadyCount}<span className="text-base font-semibold text-muted-foreground"> / {workUsages.length} ready</span></>}
                    sub={workReadyCount < workUsages.length && workBackAt !== undefined
                      ? <>First back ~{clock(workBackAt)} (in {untilLabel(workBackAt - now)})</>
                      : <>Every read account has Work left</>}
                  />
                )
                : <Total label="ChatGPT · Work limits" value="—" sub="Not read yet on the phone" />}
              <GeminiTotal label="Gemini · speech" usage={overview.gemini?.speech ?? null} profiles={speech} now={now} />
              <GeminiTotal label="Gemini · scripts" usage={overview.gemini?.narration ?? null} profiles={scripts} now={now} />
            </CardContent>
          </Card>

          {accounts.length === 0
            ? <Card><CardContent className="p-5 text-sm text-muted-foreground">The phone hasn’t reported its accounts yet (older Sleeper-Cell builds don’t).</CardContent></Card>
            : (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">
                    {plural(accounts.length, 'account')}{phoneNames.length > 1 ? <> on {phoneNames.join(' and ')}</> : ' on the phone'}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <AccountTable accounts={accounts} phones={phoneNames} runs={runs} plans={plans} setPlan={setPlan} now={now} />
                </CardContent>
              </Card>
            )}
        </>
      )}
    </SleeperPage>
  )
}
