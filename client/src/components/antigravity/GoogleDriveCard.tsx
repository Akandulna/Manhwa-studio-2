/**
 * AntiGravity → Settings → Google Drive (docs/PRD-antigravity-studio.md §4).
 *
 * Import the Desktop app OAuth client JSON, connect an account in the system
 * browser, show the verified account, storage and the "Manhwa Studio" root,
 * run the upload/download test, reconnect, switch account and disconnect.
 * Nothing secret ever reaches this page: the server returns sanitized status.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, ChevronDown, ExternalLink, FolderOpen, HardDrive, Loader2, RefreshCw, ShieldCheck, Upload, XCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useToast } from '@/components/ui/use-toast'
import { googleDriveApi, type ConnectRequestView, type DriveStatus } from '@/lib/api'
import { cn, formatBytes } from '@/lib/utils'

const STATE_LABEL: Record<DriveStatus['state'], { label: string; variant: 'success' | 'warning' | 'destructive' | 'secondary' | 'outline' }> = {
  not_configured: { label: 'Not configured', variant: 'outline' },
  disconnected: { label: 'Disconnected', variant: 'secondary' },
  connecting: { label: 'Waiting for browser', variant: 'warning' },
  connected: { label: 'Connected', variant: 'success' },
  reconnect_required: { label: 'Reconnect required', variant: 'warning' },
  error: { label: 'Error', variant: 'destructive' }
}

const SETUP_STEPS: { title: string; detail: string; href?: string }[] = [
  { title: 'Create or select a Google Cloud project', detail: 'Any name, e.g. "Manhwa Studio".', href: 'https://console.cloud.google.com/projectcreate' },
  { title: 'Enable the Google Drive API', detail: 'APIs & Services → Library → Google Drive API → Enable.', href: 'https://console.cloud.google.com/apis/library/drive.googleapis.com' },
  { title: 'Branding', detail: 'Google Auth Platform → Branding: app name "Manhwa Studio" and your support email.', href: 'https://console.cloud.google.com/auth/branding' },
  { title: 'Audience', detail: 'External. While the app is in Testing, add the Google account you will connect as a Test user.', href: 'https://console.cloud.google.com/auth/audience' },
  { title: 'Data access (scopes)', detail: 'Add …/auth/drive.file, openid and …/auth/userinfo.email. Studio never asks for full Drive access.', href: 'https://console.cloud.google.com/auth/scopes' },
  { title: 'Create a "Desktop app" OAuth client', detail: 'Google Auth Platform → Clients → Create client → Application type: Desktop app.', href: 'https://console.cloud.google.com/auth/clients' },
  { title: 'Download its JSON and import it below', detail: 'The client secret goes into the macOS Keychain, not the Studio database.' }
]

const shortHash = (hash: string | null | undefined) => (hash ? `${hash.slice(0, 12)}…` : '—')
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—')

export default function GoogleDriveCard() {
  const { toast } = useToast()
  const [status, setStatus] = useState<DriveStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [request, setRequest] = useState<{ requestId: string; authUrl: string; view: ConnectRequestView | null } | null>(null)
  const [showSetup, setShowSetup] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const load = useCallback(async (check: boolean) => {
    try {
      const next = await googleDriveApi.status(check)
      setStatus(next)
      if (next.state === 'not_configured') setShowSetup(true)
    } catch (error) {
      toast({ title: 'Could not read Google Drive status', description: (error as Error).message, variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { void load(true) }, [load])

  // While the operator is in the browser, follow the local connect request.
  useEffect(() => {
    if (!request || (request.view && request.view.status !== 'pending')) return
    const timer = setInterval(async () => {
      try {
        const view = await googleDriveApi.connectStatus(request.requestId)
        setRequest(current => (current && current.requestId === request.requestId ? { ...current, view } : current))
        if (view.status !== 'pending') {
          clearInterval(timer)
          if (view.status === 'completed') toast({ title: 'Google Drive connected', description: view.email ?? undefined })
          else if (view.status !== 'cancelled') toast({ title: 'Google Drive not connected', description: view.message ?? undefined, variant: 'destructive' })
          void load(true)
        }
      } catch {
        clearInterval(timer)
      }
    }, 1500)
    return () => clearInterval(timer)
  }, [request, load, toast])

  const run = async <T,>(key: string, task: () => Promise<T>, done?: (value: T) => void) => {
    setBusy(key)
    try {
      const value = await task()
      done?.(value)
    } catch (error) {
      toast({ title: 'Google Drive', description: (error as Error).message, variant: 'destructive' })
    } finally {
      setBusy(null)
      void load(false)
    }
  }

  const importFile = async (file: File | undefined) => {
    if (!file) return
    const text = await file.text()
    await run('import', () => googleDriveApi.importClient(text), () => toast({ title: 'OAuth client imported', description: 'Secret saved to the macOS Keychain.' }))
    if (fileInput.current) fileInput.current.value = ''
  }

  const connect = () =>
    run('connect', () => googleDriveApi.connect(), value => {
      setRequest({ requestId: value.requestId, authUrl: value.authUrl, view: null })
      if (!value.opened) window.open(value.authUrl, '_blank', 'noopener')
    })

  const cancel = () => request && run('cancel', () => googleDriveApi.cancelConnect(request.requestId), view => setRequest({ ...request, view }))

  const test = () =>
    run('test', () => googleDriveApi.test(), result =>
      toast(result.ok
        ? { title: 'Drive test passed', description: `Uploaded and downloaded ${formatBytes(result.bytes)}; SHA-256 matched.` }
        : { title: 'Drive test failed', description: result.error ?? 'Verification failed', variant: 'destructive' })
    )

  const repairRoot = () => run('repair', () => googleDriveApi.ensureRoot(true), () => toast({ title: 'Manhwa Studio folder ready' }))

  const disconnect = () => {
    if (!status?.account || !window.confirm(`Disconnect ${status.account.email}? Files already in Drive are kept.`)) return
    void run('disconnect', () => googleDriveApi.disconnect(), result => toast({ title: 'Google Drive disconnected', description: result.message }))
  }

  if (loading && !status) {
    return (
      <Card><CardContent className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Reading Google Drive status…</CardContent></Card>
    )
  }
  if (!status) return null

  const state = STATE_LABEL[status.state]
  const pending = request && (!request.view || request.view.status === 'pending')
  const connected = status.state === 'connected' || status.state === 'error'
  const canConnect = !!status.client && !pending

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-lg"><HardDrive className="h-5 w-5" /> Google Drive</CardTitle>
          <p className="text-sm text-muted-foreground">
            Studio uploads page slices to <span className="font-medium text-foreground">My Drive / Manhwa Studio / &lt;Series&gt; / Chapters / &lt;Chapter&gt;</span>. It asks only for files it creates (<code>drive.file</code>).
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant={state.variant}>{state.label}</Badge>
          <Button variant="ghost" size="icon" aria-label="Recheck Google Drive" disabled={!!busy} onClick={() => { setLoading(true); void load(true) }}>
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* 1. Google Cloud setup */}
        <section className="rounded-lg border">
          <button type="button" className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium" onClick={() => setShowSetup(v => !v)} aria-expanded={showSetup}>
            <span>One-time Google Cloud setup (done by the Cloud project owner)</span>
            <ChevronDown className={cn('h-4 w-4 transition-transform', showSetup && 'rotate-180')} />
          </button>
          {showSetup && (
            <ol className="space-y-3 border-t px-4 py-3 text-sm">
              {SETUP_STEPS.map((step, i) => (
                <li key={step.title} className="flex gap-3">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs">{i + 1}</span>
                  <div>
                    <div className="font-medium">
                      {step.href ? (
                        <a className="inline-flex items-center gap-1 hover:underline" href={step.href} target="_blank" rel="noreferrer">{step.title} <ExternalLink className="h-3 w-3" /></a>
                      ) : step.title}
                    </div>
                    <div className="text-muted-foreground">{step.detail}</div>
                  </div>
                </li>
              ))}
              <li className="text-xs text-muted-foreground">
                While the app's publishing status is <em>Testing</em>, Google expires the authorization after 7 days — Studio will show <em>Reconnect required</em>. Full guide: docs/antigravity-google-drive-setup.md.
              </li>
            </ol>
          )}
        </section>

        {/* 2. OAuth client */}
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">OAuth client</h3>
          <div className="flex flex-wrap items-center gap-3">
            {status.client ? (
              <div className="text-sm">
                <div className="font-mono text-xs break-all">{status.client.clientId}</div>
                <div className="text-muted-foreground">Project {status.client.projectId ?? 'unknown'} · imported {when(status.client.importedAt)} · secret in Keychain</div>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">No OAuth client yet. Import the Desktop app client JSON from step 7.</div>
            )}
            <input ref={fileInput} type="file" accept="application/json,.json" className="hidden" onChange={e => void importFile(e.target.files?.[0])} />
            <Button variant={status.client ? 'outline' : 'default'} size="sm" disabled={!!busy || !!pending} onClick={() => fileInput.current?.click()}>
              {busy === 'import' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
              {status.client ? 'Replace client JSON' : 'Import OAuth client JSON'}
            </Button>
          </div>
        </section>

        {/* 3. Account */}
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Account</h3>

          {pending && (
            <div className="flex flex-wrap items-center gap-3 rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Choose the Google account in your browser and allow access. This request expires in 10 minutes.</span>
              <a className="inline-flex items-center gap-1 underline" href={request!.authUrl} target="_blank" rel="noreferrer">Open sign-in page again <ExternalLink className="h-3 w-3" /></a>
              <Button variant="ghost" size="sm" onClick={cancel} disabled={busy === 'cancel'}>Cancel</Button>
            </div>
          )}
          {request?.view && request.view.status !== 'pending' && request.view.status !== 'completed' && request.view.message && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">{request.view.message}</div>
          )}

          {status.account && status.state !== 'disconnected' ? (
            <div className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <div className="text-muted-foreground">Connected account</div>
                <div className="flex items-center gap-1.5 font-medium"><ShieldCheck className="h-4 w-4 text-green-500" /> {status.account.email}</div>
                <div className="text-xs text-muted-foreground">Verified by Google · since {when(status.account.connectedAt)}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Storage</div>
                {status.storage ? (
                  <div>{formatBytes(status.storage.usage ?? 0)} used{status.storage.limit !== null ? ` of ${formatBytes(status.storage.limit)}` : ''}</div>
                ) : (
                  <div className="text-muted-foreground">Not read yet</div>
                )}
                {status.storageNote && <div className="text-xs text-muted-foreground">{status.storageNote}</div>}
              </div>
              <div className="sm:col-span-2">
                <div className="text-muted-foreground">Root folder</div>
                {status.root?.folderId && status.root.state !== 'missing' ? (
                  <a className="inline-flex items-center gap-1.5 font-medium hover:underline" href={status.root.url ?? undefined} target="_blank" rel="noreferrer">
                    <FolderOpen className="h-4 w-4" /> {status.root.name} <ExternalLink className="h-3 w-3" />
                    <span className="text-xs font-normal text-muted-foreground">{status.root.state === 'ok' ? `verified ${when(status.root.verifiedAt)}` : 'not verified yet'}</span>
                  </a>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-yellow-600 dark:text-yellow-400">
                      {status.root?.state === 'missing' ? 'Studio’s Manhwa Studio folder was deleted or trashed in Drive.' : 'Not created yet.'}
                    </span>
                    <Button variant="outline" size="sm" disabled={!!busy || !connected} onClick={repairRoot}>
                      {busy === 'repair' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      {status.root?.state === 'missing' ? 'Repair: create a new folder' : 'Create folder'}
                    </Button>
                  </div>
                )}
              </div>
            </div>
          ) : (
            !pending && <p className="text-sm text-muted-foreground">No Google account connected. Antigravity sign-in and model choice are not needed for this step.</p>
          )}

          {status.lastError && status.state !== 'disconnected' && (
            <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-sm">{status.lastError}</div>
          )}

          <div className="flex flex-wrap gap-2">
            {(status.state === 'disconnected' || status.state === 'not_configured' || status.state === 'connecting') && (
              <Button disabled={!canConnect || !!busy} onClick={connect}>
                {busy === 'connect' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Connect Google Drive
              </Button>
            )}
            {status.state === 'reconnect_required' && (
              <Button disabled={!canConnect || !!busy} onClick={connect}>Reconnect</Button>
            )}
            {connected && (
              <Button disabled={!!busy || !!pending} onClick={test}>
                {busy === 'test' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Test connection
              </Button>
            )}
            {status.account && status.state !== 'disconnected' && (
              <>
                <Button variant="outline" disabled={!canConnect || !!busy} onClick={connect}>Switch account</Button>
                <Button variant="ghost" className="text-destructive" disabled={!!busy || !!pending} onClick={disconnect}>Disconnect</Button>
              </>
            )}
          </div>
          {status.otherAccounts.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Earlier accounts (their folders and history are kept): {status.otherAccounts.map(a => a.email).join(', ')}. Switch account and choose one to use it again.
            </p>
          )}
        </section>

        {/* 4. Last test */}
        {status.lastTest && (
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Last connection test</h3>
            <div className="flex items-start gap-2 text-sm">
              {status.lastTest.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-green-500" /> : <XCircle className="mt-0.5 h-4 w-4 text-destructive" />}
              <div className="space-y-0.5">
                <div>{status.lastTest.ok ? 'Upload → download verified' : status.lastTest.error ?? 'Failed'} · {when(status.lastTest.at)}{status.lastTest.durationMs ? ` · ${(status.lastTest.durationMs / 1000).toFixed(1)} s` : ''}</div>
                {status.lastTest.bytes > 0 && (
                  <div className="font-mono text-xs text-muted-foreground">
                    {formatBytes(status.lastTest.bytes)} · local {shortHash(status.lastTest.localSha256)} · downloaded {shortHash(status.lastTest.downloadedSha256)} · Drive {shortHash(status.lastTest.remoteSha256)} · fixture {status.lastTest.cleanedUp ? 'deleted' : 'left in the root (delete it by hand)'}
                  </div>
                )}
              </div>
            </div>
          </section>
        )}

        <p className="text-xs text-muted-foreground">
          Drive API calls are currently free within Google's published quotas; files count against this account's storage. Disconnecting keeps every uploaded file.
        </p>
      </CardContent>
    </Card>
  )
}
