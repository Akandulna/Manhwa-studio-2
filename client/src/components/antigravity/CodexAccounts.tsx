/**
 * ChatGPT (Codex) → Accounts: several ChatGPT accounts for the Codex engine.
 *
 * Studio uses them top to bottom. Each page's conversation stays on the
 * account that started it; when an account reaches its Codex limit, it is kept
 * off until its window resets and new pages continue on the next account
 * (automatic switching), or the run pauses so the operator can switch.
 * Each account signs in once with `codex login` into its own Codex folder.
 */

import { useState } from 'react'
import { ArrowDown, ArrowUp, Loader2, LogIn, Plus, RotateCcw, Trash2, Users } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/use-toast'
import { codexApi, type CodexAccountView, type CodexConnection } from '@/lib/api'
import { cn } from '@/lib/utils'

const pct = (w: { usedPercent: number } | null | undefined) => (w ? `${Math.round(w.usedPercent)}%` : '—')
const when = (iso: string) => new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })

export default function CodexAccounts({ data, onChange }: { data: CodexConnection['accounts']; onChange: () => void }) {
  const { toast } = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const { accounts, autoSwitch } = data
  const nextUp = accounts.find(a => a.enabled && !a.limited)

  const act = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key)
    try {
      await fn()
      if (done) toast({ title: done })
    } catch (error) {
      toast({ title: 'Accounts', description: (error as Error).message, variant: 'destructive' })
    } finally {
      setBusy(null)
      onChange()
    }
  }

  const signIn = (a: CodexAccountView) => act(`signin-${a.id}`, async () => {
    const result = await codexApi.signInAccount(a.id)
    toast({ title: result.opened ? 'Terminal opened' : `Sign in "${a.label}"`, description: result.instructions })
  })

  const move = (index: number, delta: number) => {
    const ids = accounts.map(a => a.id)
    const [id] = ids.splice(index, 1)
    ids.splice(index + delta, 0, id)
    void act('order', () => codexApi.reorderAccounts(ids))
  }

  const add = () => act('add', async () => {
    const created = await codexApi.addAccount(label)
    setLabel('')
    const result = await codexApi.signInAccount(created.id)
    toast({ title: 'Account added — sign it in', description: result.instructions })
  })

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold"><Users className="h-4 w-4" /> ChatGPT accounts</h3>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={autoSwitch} disabled={!!busy} onChange={e => void act('auto', () => codexApi.setAutoSwitch(e.target.checked))} />
          Switch automatically when an account runs out
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        Studio uses the accounts from top to bottom. A page stays on the account it started on; when that account reaches its Codex limit, it is kept off until its window resets and {autoSwitch ? 'the remaining pages continue on the next account' : 'the run pauses so you can switch (move another account to the top, or turn this one off) and resume'}. Each account needs Plus or above.
      </p>

      <ul className="divide-y rounded-md border">
        {accounts.map((a, i) => {
          const signedIn = a.login?.signedIn ?? null
          const limits = a.lastLimits
          return (
            <li key={a.id} className={cn('flex flex-wrap items-center gap-3 p-3', !a.enabled && 'opacity-60')}>
              <div className="flex flex-col">
                <Button variant="ghost" size="icon" className="h-5 w-5" aria-label="Move up" disabled={i === 0 || !!busy} onClick={() => move(i, -1)}><ArrowUp className="h-3.5 w-3.5" /></Button>
                <Button variant="ghost" size="icon" className="h-5 w-5" aria-label="Move down" disabled={i === accounts.length - 1 || !!busy} onClick={() => move(i, 1)}><ArrowDown className="h-3.5 w-3.5" /></Button>
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {a.label}
                  {a.builtIn && <Badge variant="outline" className="px-1.5 py-0 text-[10px]">ChatGPT app's sign-in</Badge>}
                  {nextUp?.id === a.id && <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">Next pages use this</Badge>}
                  {signedIn === false && <Badge variant="warning" className="px-1.5 py-0 text-[10px]">Sign-in required</Badge>}
                  {a.login?.mode === 'api_key' && <Badge variant="warning" className="px-1.5 py-0 text-[10px]">API key (billed to API)</Badge>}
                  {a.limited && a.limitedUntil && <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">Out until {when(a.limitedUntil)}</Badge>}
                  {limits?.planType && <span className="text-xs font-normal text-muted-foreground">{limits.planType}</span>}
                </div>
                <div className="text-xs text-muted-foreground">
                  {limits ? <>5 h {pct(limits.primary)} used · weekly {pct(limits.secondary)} used{limits.secondary?.resetsAt ? ` (resets ${when(limits.secondary.resetsAt)})` : ''} · as of {when(limits.at)}</> : 'No usage recorded yet — it appears after the first Codex turn on this account.'}
                </div>
                {a.limited && a.limitReason && <div className="text-xs text-destructive">{a.limitReason}</div>}
                {a.duplicateOf && <div className="text-xs text-yellow-600 dark:text-yellow-400">Same ChatGPT account as "{a.duplicateOf}" — it shares that account's limits. Sign this one in with a different account.</div>}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {signedIn === false && <Button size="sm" disabled={!!busy} onClick={() => void signIn(a)}><LogIn className="mr-1 h-3.5 w-3.5" /> Sign in</Button>}
                {signedIn !== false && !a.builtIn && <Button size="sm" variant="ghost" disabled={!!busy} title="Sign this account in again (for example with a different ChatGPT account)" onClick={() => void signIn(a)}><LogIn className="h-3.5 w-3.5" /></Button>}
                {a.limited && <Button size="sm" variant="outline" disabled={!!busy} title="Use it again now (for example after you upgraded or the limit reset early)" onClick={() => void act(`clear-${a.id}`, () => codexApi.updateAccount(a.id, { clearLimit: true }), `"${a.label}" can be used again`)}><RotateCcw className="mr-1 h-3.5 w-3.5" /> Use again</Button>}
                <label className="flex items-center gap-1 text-xs">
                  <input type="checkbox" checked={a.enabled} disabled={!!busy} onChange={e => void act(`en-${a.id}`, () => codexApi.updateAccount(a.id, { enabled: e.target.checked }))} /> Use
                </label>
                {!a.builtIn && (
                  <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={`Remove ${a.label}`} disabled={!!busy}
                    onClick={() => { if (window.confirm(`Remove "${a.label}"? Its Codex sign-in on this Mac is deleted (the ChatGPT account itself is not affected).`)) void act(`rm-${a.id}`, () => codexApi.removeAccount(a.id), `Removed "${a.label}"`) }}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </li>
          )
        })}
      </ul>

      <form className="flex gap-2" onSubmit={e => { e.preventDefault(); if (label.trim()) void add() }}>
        <Input value={label} onChange={e => setLabel(e.target.value)} placeholder="Name for another ChatGPT account (e.g. Saran)" maxLength={60} className="max-w-xs" />
        <Button type="submit" size="sm" variant="outline" disabled={!label.trim() || !!busy}>
          {busy === 'add' ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Plus className="mr-1 h-3.5 w-3.5" />} Add account
        </Button>
      </form>
    </section>
  )
}
