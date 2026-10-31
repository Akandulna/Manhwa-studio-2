import { useEffect, useState } from 'react'
import { r2Api, type R2Config } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/components/ui/use-toast'
import { CheckCircle, Cloud, ExternalLink, Loader2, Save, XCircle } from 'lucide-react'
import { R2UsageCard } from './R2UsageCard'
import { PhoneRelayCard } from './PhoneRelayCard'

/**
 * Settings → Cloudflare: credentials for the Library's "Send to phone".
 * Saved to the server's .env and applied immediately. The secret is never sent
 * back — the key fields stay blank and a blank field keeps what is saved.
 */
export function CloudflareR2Card({ onSaved }: { onSaved?: () => void } = {}) {
  const { toast } = useToast()
  const [config, setConfig] = useState<R2Config | null>(null)
  const [accountId, setAccountId] = useState('')
  const [bucket, setBucket] = useState('')
  const [prefix, setPrefix] = useState('')
  const [concurrency, setConcurrency] = useState('4')
  const [accessKeyId, setAccessKeyId] = useState('')
  const [secretAccessKey, setSecretAccessKey] = useState('')
  const [analyticsToken, setAnalyticsToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)

  const apply = (next: R2Config) => {
    setConfig(next)
    setAccountId(next.accountId)
    setBucket(next.bucket)
    setPrefix(next.prefix)
    setConcurrency(String(next.concurrency))
  }

  useEffect(() => {
    r2Api.getConfig()
      .then(apply)
      .catch(() => toast({ title: 'Could not load the Cloudflare settings', variant: 'destructive' }))
  }, [])

  const test = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const { bucket: name } = await r2Api.test()
      setTestResult({ success: true, message: `Connected to bucket "${name}"` })
    } catch (err) {
      setTestResult({ success: false, message: err instanceof Error ? err.message : 'Test failed' })
    } finally {
      setTesting(false)
    }
  }

  const save = async () => {
    setSaving(true)
    try {
      const next = await r2Api.saveConfig({
        accountId,
        bucket,
        prefix,
        concurrency: Number(concurrency),
        ...(accessKeyId.trim() ? { accessKeyId: accessKeyId.trim() } : {}),
        ...(secretAccessKey.trim() ? { secretAccessKey: secretAccessKey.trim() } : {}),
        ...(analyticsToken.trim() ? { analyticsToken: analyticsToken.trim() } : {})
      })
      apply(next)
      setAccessKeyId('')
      setSecretAccessKey('')
      setAnalyticsToken('')
      toast({ title: 'Cloudflare settings saved' })
      onSaved?.()
      if (next.configured) void test()
      else setTestResult(null)
    } catch (err) {
      toast({ title: 'Save failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  const removeKeys = async () => {
    try {
      apply(await r2Api.saveConfig({ clearKeys: true }))
      setTestResult(null)
      toast({ title: 'R2 access keys removed' })
      onSaved?.()
    } catch (err) {
      toast({ title: 'Could not remove the keys', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Cloud className="h-5 w-5" />
          Cloudflare R2
          {config && (
            config.configured
              ? <Badge variant="success">Configured</Badge>
              : <Badge variant="secondary">Not connected</Badge>
          )}
        </CardTitle>
        <CardDescription>
          Used by <strong>Send to phone</strong> on the Library page: each chapter's pages are zipped and uploaded to
          your bucket for Sleeper-Cell, one zip per chapter, and the local zip is deleted. The phone deletes a
          chapter's zip when it clears the chapter.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!config ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <Label htmlFor="r2AccountId">Account ID</Label>
              <Input
                id="r2AccountId"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                placeholder="32-character ID, or paste the S3 endpoint URL"
                className="font-mono"
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                Cloudflare dashboard → R2 Object Storage → <em>Account Details</em>.{' '}
                <a
                  href="https://dash.cloudflare.com/?to=/:account/r2/overview"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline inline-flex items-center gap-1"
                >
                  Open R2 <ExternalLink className="h-3 w-3" />
                </a>
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="r2AccessKey">Access Key ID</Label>
                <Input
                  id="r2AccessKey"
                  type="password"
                  autoComplete="off"
                  value={accessKeyId}
                  onChange={(e) => setAccessKeyId(e.target.value)}
                  placeholder={config.hasAccessKey ? `Saved (${config.accessKeyHint}) — paste to replace` : 'Access Key ID'}
                  className="font-mono"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="r2Secret">Secret Access Key</Label>
                <Input
                  id="r2Secret"
                  type="password"
                  autoComplete="off"
                  value={secretAccessKey}
                  onChange={(e) => setSecretAccessKey(e.target.value)}
                  placeholder={config.hasSecret ? 'Saved — paste to replace' : 'Secret Access Key'}
                  className="font-mono"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground -mt-2">
              R2 → <em>Manage API Tokens</em> → <em>Create Account API token</em> with <strong>Object Read &amp; Write</strong> on
              your bucket. The page shown after creating it has the Access Key ID and Secret Access Key (the secret is
              shown only once) — not the "Token value". Its S3 endpoint URL can go in Account ID.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="r2Bucket">Bucket name</Label>
                <Input
                  id="r2Bucket"
                  value={bucket}
                  onChange={(e) => setBucket(e.target.value)}
                  placeholder="manhwa-studio"
                  className="font-mono"
                  autoComplete="off"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="r2Prefix">Folder in bucket (optional)</Label>
                <Input
                  id="r2Prefix"
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value)}
                  placeholder="Manhwa"
                  className="font-mono"
                  autoComplete="off"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="r2Concurrency">Parallel upload parts</Label>
                <Input
                  id="r2Concurrency"
                  type="number"
                  min={1}
                  max={16}
                  value={concurrency}
                  onChange={(e) => setConcurrency(e.target.value)}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground -mt-2">
              Each series is saved as <code>{prefix.trim() ? `${prefix.trim().replace(/^\/+|\/+$/g, '')}/` : ''}&lt;Series name&gt;.zip</code>,
              replacing the previous backup of that series. Parallel upload parts: 16 MB chunks sent at once (default 4).
              Saved to the server's <code>.env</code> and applied immediately — no restart needed.
            </p>

            <div className="space-y-2">
              <Label htmlFor="r2AnalyticsToken">Analytics token (optional)</Label>
              <div className="flex gap-2">
                <Input
                  id="r2AnalyticsToken"
                  type="password"
                  autoComplete="off"
                  value={analyticsToken}
                  onChange={(e) => setAnalyticsToken(e.target.value)}
                  placeholder={config.hasAnalyticsToken ? 'Saved — paste to replace' : 'API token with Account Analytics → Read'}
                  className="font-mono"
                />
                {config.hasAnalyticsToken && (
                  <Button
                    variant="ghost"
                    onClick={async () => {
                      try {
                        apply(await r2Api.saveConfig({ clearAnalyticsToken: true }))
                        onSaved?.()
                      } catch (err) {
                        toast({ title: 'Could not remove the token', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
                      }
                    }}
                  >
                    Remove
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Makes Free plan usage show Cloudflare's own request counts, including Sleeper-Cell's and the dashboard's,
                instead of only Manhwa Studio's. My Profile → API Tokens → Create Custom Token → <em>Account · Account
                Analytics · Read</em>. Reading it costs no R2 operations.
              </p>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <Button onClick={save} disabled={saving}>
                {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
                Save
              </Button>
              <Button variant="outline" onClick={test} disabled={testing || !config.configured}>
                {testing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Cloud className="h-4 w-4 mr-2" />}
                Test connection
              </Button>
              {(config.hasAccessKey || config.hasSecret) && (
                <Button variant="ghost" onClick={removeKeys}>Remove keys</Button>
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
          </>
        )}
      </CardContent>
    </Card>
  )
}

/** The Settings → Cloudflare tab: credentials, the phone relay, then free-plan usage (re-measured after a save). */
export function CloudflareTab() {
  const [version, setVersion] = useState(0)
  return (
    <>
      <CloudflareR2Card onSaved={() => setVersion(v => v + 1)} />
      <PhoneRelayCard />
      <R2UsageCard key={version} />
    </>
  )
}
