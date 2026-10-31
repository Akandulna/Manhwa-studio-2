import { useEffect, useState } from 'react'
import { r2Api } from '@/lib/api'
import { usePhoneRelay } from '@/hooks/usePhoneRelay'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/components/ui/use-toast'
import { CheckCircle, Copy, KeyRound, Loader2, Radio, Save, XCircle } from 'lucide-react'

function randomToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Settings → Cloudflare: the phone relay, a Cloudflare Worker (relay/ in the
 * repo) that carries Sleeper-Cell's status to Manhwa Studio live, without
 * spending R2 operations. Like the R2 secret, the token is never sent back:
 * a blank field keeps the saved one.
 */
export function PhoneRelayCard() {
  const { toast } = useToast()
  const status = usePhoneRelay()
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (status && !loaded) {
      setUrl(status.url)
      setLoaded(true)
    }
  }, [status, loaded])

  const test = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await r2Api.testRelay()
      const kinds = result.receipts.map(r => r.kind).join(', ')
      setTestResult({
        success: true,
        message: `Relay answered${kinds ? ` · holds ${kinds}` : ' · no receipts from the phone yet'}`
      })
    } catch (err) {
      setTestResult({ success: false, message: err instanceof Error ? err.message : 'Test failed' })
    } finally {
      setTesting(false)
    }
  }

  const save = async () => {
    setSaving(true)
    try {
      const next = await r2Api.saveRelay({ url, ...(token.trim() ? { token: token.trim() } : {}) })
      setUrl(next.url)
      setToken('')
      setShowToken(false)
      toast({ title: 'Phone relay saved' })
      if (next.configured) void test()
      else setTestResult(null)
    } catch (err) {
      toast({ title: 'Save failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  const generate = () => {
    setToken(randomToken())
    setShowToken(true)
  }

  const copyForPhone = async () => {
    const lines = [`RELAY_URL=${url.trim()}`, `RELAY_TOKEN=${token.trim()}`].join('\n')
    try {
      await navigator.clipboard.writeText(lines)
      toast({ title: 'Copied', description: 'On the phone: Settings → Manhwa → Paste R2 settings.' })
    } catch {
      toast({ title: 'Could not copy', variant: 'destructive' })
    }
  }

  const clearToken = async () => {
    try {
      await r2Api.saveRelay({ clearToken: true })
      setTestResult(null)
      toast({ title: 'Relay token removed', description: 'Phone status goes back to R2 (on demand).' })
    } catch (err) {
      toast({ title: 'Could not remove the token', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Radio className="h-5 w-5" />
          Phone relay
          {status && (
            !status.configured
              ? <Badge variant="secondary">Not set up</Badge>
              : status.connected
                ? <Badge variant="success">{status.phones > 1 ? `Live · ${status.phones} phones open` : status.phones > 0 ? 'Live · phone open' : 'Live · phone closed'}</Badge>
                : <Badge variant="destructive">Not connected</Badge>
          )}
        </CardTitle>
        <CardDescription>
          Carries Sleeper-Cell's progress (downloads, scripts, crop pages) here the moment it changes, and
          "Refresh from phone" to the phone, through a free Cloudflare Worker instead of R2. It keeps the phone's last
          report, so this app catches up when it opens even if the phone reported while the Mac was off.
          Without it, phone status goes through R2, on demand only.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!status ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <Label htmlFor="relayUrl">Worker URL</Label>
              <Input
                id="relayUrl"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://sleeper-cell-relay.<your-subdomain>.workers.dev"
                className="font-mono"
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                Printed by <code>npm run deploy</code> in the repo's <code>relay/</code> folder.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="relayToken">Token</Label>
              <div className="flex gap-2">
                <Input
                  id="relayToken"
                  type={showToken ? 'text' : 'password'}
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={status.hasToken ? 'Saved — paste or generate to replace' : 'Shared secret'}
                  className="font-mono"
                />
                <Button variant="outline" onClick={generate} title="Make a new random token">
                  <KeyRound className="h-4 w-4 mr-2" /> Generate
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                The same token goes three places: here, the Worker (<code>npx wrangler secret put RELAY_TOKEN</code> in{' '}
                <code>relay/</code>), and Sleeper-Cell. After generating one, copy it for the phone before saving: it is
                not shown again.
              </p>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <Button onClick={save} disabled={saving}>
                {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
                Save
              </Button>
              <Button variant="outline" onClick={copyForPhone} disabled={!url.trim() || !token.trim()}
                title={token.trim() ? 'Copy RELAY_URL / RELAY_TOKEN lines for the phone' : 'Paste or generate the token first'}>
                <Copy className="h-4 w-4 mr-2" /> Copy for phone
              </Button>
              <Button variant="outline" onClick={test} disabled={testing || !status.configured}>
                {testing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Radio className="h-4 w-4 mr-2" />}
                Test relay
              </Button>
              {status.hasToken && (
                <Button variant="ghost" onClick={clearToken}>Remove token</Button>
              )}
              {testResult && (
                testResult.success ? (
                  <span className="text-sm text-green-600 flex items-center gap-1">
                    <CheckCircle className="h-4 w-4" /> {testResult.message}
                  </span>
                ) : (
                  <span className="text-sm text-destructive flex items-center gap-1">
                    <XCircle className="h-4 w-4" /> {testResult.message}
                  </span>
                )
              )}
            </div>

            {status.configured && !status.connected && status.lastError && (
              <p className="text-xs text-destructive">Last connection error: {status.lastError}. Retrying by itself.</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
