/**
 * Accounts — every browser profile on the phones (one ChatGPT and one Google
 * account each): its plans, ChatGPT's image limit over the rolling 3 hours, and
 * Gemini's daily requests in AI Studio for speech (voiceover) and scripts
 * (narration). Totals on top, then one table per phone.
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
  type PhoneGeminiProfile,
  type PhoneGeminiUsage,
  type PhoneOverview,
  type PhoneOverviewRun,
  type PhoneProfileCheck,
  type PhoneSiteCheck
} from '@/lib/api'
import { UPLOAD_LIMIT, uploadOverview, uploadUsage, type UploadUsage } from '@/lib/uploadUsage'
import { cn } from '@/lib/utils'
import { Bar, clock, InfoTip, MINUTE, phoneList, PhoneHeading, planLabel, plural, SleeperPage, span, useNow } from './sleeperShared'

/** A profile running out sooner than this is flagged. */
const RUNS_OUT_SOON_MS = 30 * MINUTE

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

/** One profile on one phone, across ChatGPT and both Gemini limits (they share the profile id). */
interface Account {
  id: string
  name: string
  phone: string | null
  selected: boolean
  upload: UploadUsage | null
  speech: PhoneGeminiProfile | null
  scripts: PhoneGeminiProfile | null
  /** The phone's last Tools → Profiles → Check of it. */
  check: PhoneProfileCheck | null
}

function accountsOf(overview: PhoneOverview | null, now: number): Account[] {
  const accounts = new Map<string, Account>()
  const add = (p: { id: string; name: string; phone: string | null; selected: boolean }) => {
    const known = accounts.get(p.id)
    if (known) return known
    const account: Account = { id: p.id, name: p.name, phone: p.phone, selected: p.selected, upload: null, speech: null, scripts: null, check: null }
    accounts.set(p.id, account)
    return account
  }
  for (const p of overview?.profiles ?? []) {
    const account = add(p)
    account.upload = uploadUsage(p, now)
    account.check = p.check ?? null
  }
  for (const p of overview?.gemini?.speech?.profiles ?? []) add(p).speech = p
  for (const p of overview?.gemini?.narration?.profiles ?? []) add(p).scripts = p
  return [...accounts.values()]
}

/** Is a Gemini run of this kind on this account now. With one profile the run names none: the selected one is it. */
function geminiInUse(runs: PhoneOverviewRun[], kind: PhoneOverviewRun['kind'], account: Account): boolean {
  return runs.some(r => r.kind === kind && r.phone === account.phone && (r.account === account.name || (!r.account && account.selected)))
}

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

function AccountTable({ accounts, runs, plans, setPlan, now }: {
  accounts: Account[]; runs: PhoneOverviewRun[]; plans: Plans; setPlan: ReturnType<typeof usePlans>['setPlan']; now: number
}) {
  return (
    <div className="overflow-x-auto">
      {/* Fixed columns, so every phone's table lines up. */}
      <table className="w-full min-w-[1000px] table-fixed text-sm">
        <colgroup>
          <col className="w-[18%]" />
          <col className="w-[11%]" />
          <col className="w-[18%]" />
          <col className="w-[6%]" />
          <col className="w-[11%]" />
          <col className="w-[18%]" />
          <col className="w-[18%]" />
        </colgroup>
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
            <Th>Account</Th>
            <Th tip="From Sleeper-Cell’s Tools → Profiles → Check on the phone; set by hand only for a profile never checked there.">ChatGPT plan</Th>
            <Th tip={`ChatGPT takes ${UPLOAD_LIMIT} images per account in any 3 hours, on every plan; each upload counts for 3 hours.`}>Images · 3h</Th>
            <Th className="text-right" tip="Images uploaded in the last 24 hours.">24h</Th>
            <Th tip="From the same check on the phone: Free, Paid, or Google AI’s plan name when the page shows it.">Gemini plan</Th>
            <Th tip="AI Studio Run taps today for voiceover. The limit is what the profile reached before Gemini last stopped it.">Speech today</Th>
            <Th tip="AI Studio Run taps today for narration scripts, limited apart from speech.">Scripts today</Th>
          </tr>
        </thead>
        <tbody>
          {accounts.map(account => {
            const plan = plans[account.name] ?? {}
            const uploading = account.upload?.pace != null
            const voicing = geminiInUse(runs, 'voiceover', account)
            const writing = geminiInUse(runs, 'narration', account)
            return (
              <tr key={account.id} className="border-t align-middle">
                <td className="py-2.5 pr-4">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{account.name}</span>
                    {uploading && <Badge className="bg-sky-600 px-1.5 py-0 text-[10px] hover:bg-sky-600">uploading</Badge>}
                    {voicing && <Badge className="bg-sky-600 px-1.5 py-0 text-[10px] hover:bg-sky-600">voicing</Badge>}
                    {writing && <Badge className="bg-sky-600 px-1.5 py-0 text-[10px] hover:bg-sky-600">writing</Badge>}
                    {!uploading && !voicing && !writing && account.selected && (
                      <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">next up</Badge>
                    )}
                  </div>
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

/** A Gemini limit over every profile: how many can still make requests. */
function GeminiTotal({ label, usage, now }: { label: string; usage: PhoneGeminiUsage | null; now: number }) {
  if (!usage?.profiles.length) return <Total label={label} value="—" sub="Not reported by this build" />
  const ready = usage.profiles.filter(p => !p.limitedUntil && (p.limit === null || p.today < p.limit)).length
  const today = usage.profiles.reduce((sum, p) => sum + p.today, 0)
  const resetsAt = Date.parse(usage.resetsAt)
  return (
    <Total
      label={label}
      warn={ready === 0}
      value={<>{ready}<span className="text-base font-semibold text-muted-foreground"> / {usage.profiles.length} ready</span></>}
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
  const several = phones.length > 1
  const runs = overview?.runs ?? []

  const usages = accounts.map(a => a.upload).filter((u): u is UploadUsage => u !== null)
  const total = uploadOverview(usages, now)
  const limited = usages.filter(u => u.limitedUntil).length

  // One table per phone, in the phones' order; any profile on a phone not listed goes last.
  const groups: [string | null, Account[]][] = several
    ? [
        ...phones.map(p => [p.name, accounts.filter(a => a.phone === p.name)] as [string, Account[]]),
        [null, accounts.filter(a => !phones.some(p => p.name === a.phone))] as [null, Account[]]
      ].filter(([, list]) => list.length > 0)
    : [[null, accounts]]

  return (
    <SleeperPage icon={Users} title="Accounts" receipt={receipt}>
      {overview && (
        <>
          <Card className="mb-6">
            <CardContent className="grid gap-6 p-5 sm:grid-cols-3">
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
              <GeminiTotal label="Gemini · speech" usage={overview.gemini?.speech ?? null} now={now} />
              <GeminiTotal label="Gemini · scripts" usage={overview.gemini?.narration ?? null} now={now} />
            </CardContent>
          </Card>

          {accounts.length === 0
            ? <Card><CardContent className="p-5 text-sm text-muted-foreground">The phone hasn’t reported its accounts yet (older Sleeper-Cell builds don’t).</CardContent></Card>
            : (
              <div className="space-y-6">
                {groups.map(([phone, list]) => (
                  <Card key={phone ?? 'one'}>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base">
                        {phone ? <PhoneHeading name={phone} className="text-sm normal-case tracking-normal text-foreground" /> : several ? 'Other profiles' : `${plural(list.length, 'account')} on the phone`}
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <AccountTable accounts={list} runs={runs} plans={plans} setPlan={setPlan} now={now} />
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
        </>
      )}
    </SleeperPage>
  )
}
