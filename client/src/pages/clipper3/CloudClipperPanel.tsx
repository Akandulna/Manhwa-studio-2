import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
interface CloudAccount {
    id: string;
    label: string;
    state: string;
    error?: string;
    firstUsedAt?: number;
    retryAt?: number;
    inFlight?: string;
}
interface CloudPage {
    id: string;
    chapter: string;
    filename: string;
    state: string;
    fetched: string[];
    error?: string;
    updatedAt: number;
}
interface CloudRun {
    id: string;
    state: string;
    done: number;
    total: number;
    mode: string;
    accountIds: string[];
}
interface Status {
    accounts: CloudAccount[];
    pages: CloudPage[];
    runs: CloudRun[];
    seriesFolder: string;
    controllerUrl: string;
    updatedAt: number;
    preparation: null | {
        running: boolean;
        done: number;
        total: number;
        page?: string;
        error?: string;
        cancelled?: boolean;
    };
}
async function api(path: string, body?: unknown, method?: string) { const response = await fetch('/api/clipper-cloud' + path, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); const data = await response.json(); if (!response.ok)
    throw Error(data.error ?? 'Cloud request failed'); return data; }
export function CloudClipperPanel({ seriesId, chapters, onImported }: {
    seriesId: string;
    onImported?: () => void;
    chapters: {
        id: string;
        label: string;
    }[];
}) {
    const [open, setOpen] = useState(false), [configured, setConfigured] = useState(false), [url, setUrl] = useState(''), [token, setToken] = useState(''), [status, setStatus] = useState<Status | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
    const [chapterIds, setChapterIds] = useState<string[]>([]), [accountIds, setAccountIds] = useState<string[]>([]), [pageIds, setPageIds] = useState<string[]>([]), [mode, setMode] = useState('parallel'), [autoResume, setAutoResume] = useState(true), [rules, setRules] = useState(''), [label, setLabel] = useState('');
    const refresh = useCallback(async () => { try {
        setStatus(await api('/status?seriesId=' + encodeURIComponent(seriesId)));
    }
    catch (e) {
        setError(String(e instanceof Error ? e.message : e));
    } }, [seriesId]);
    useEffect(() => { if (!open)
        return; let cancelled = false; void api('/settings').then(value => { if (!cancelled) {
        setConfigured(value.configured);
        setUrl(value.url);
    } }).catch(e => setError(String(e))); return () => { cancelled = true; }; }, [open]);
    useEffect(() => { if (!open || !configured)
        return; void refresh(); const timer = setInterval(() => void refresh(), 5000); return () => clearInterval(timer); }, [open, configured, refresh]);
    useEffect(() => { setPageIds([]); setChapterIds([]); setStatus(null); }, [seriesId]);
    async function action(fn: () => Promise<unknown>) { setBusy(true); setError(''); try {
        const result: any = await fn();
        if (result?.errors?.length)
            setError(result.errors.join('\n'));
        await refresh();
    }
    catch (e) {
        setError(e instanceof Error ? e.message : String(e));
    }
    finally {
        setBusy(false);
    } }
    const toggle = (id: string, values: string[], set: (v: string[]) => void) => set(values.includes(id) ? values.filter(v => v !== id) : [...values, id]);
    const prepared = status?.pages.filter(p => ['ready', 'attention'].includes(p.state)) ?? [];
    const selectedReady = pageIds.filter(id => prepared.some(p => p.id === id));
    return <details className="border rounded-md p-3 my-3 text-sm" onToggle={event => setOpen(event.currentTarget.open)}><summary className="cursor-pointer font-medium">R2 Cloud processing</summary>{open && <div className="space-y-3 pt-3">
  <p>Prepare pages, select accounts, then Start. Uploading alone never starts processing. Saved pointers await your normal Studio review.</p>
  <details open={!configured}><summary>Controller settings</summary><div className="space-y-2 py-2"><input className="border rounded p-2 bg-background w-full" aria-label="Controller URL" placeholder="https://your-clipper.workers.dev" value={url} onChange={e => setUrl(e.target.value)}/><input className="border rounded p-2 bg-background w-full" aria-label="Controller key" type="password" autoComplete="off" placeholder="Controller key" value={token} onChange={e => setToken(e.target.value)}/><Button disabled={busy || !token} onClick={() => void action(async () => { await api('/settings', { url, token }, 'PUT'); setToken(''); setConfigured(true); })}>Save connection</Button></div></details>
  {configured && <>
   <fieldset className="space-y-1"><legend className="font-medium">1. Prepare selected chapters</legend>{chapters.map(c => <label key={c.id} className="inline-flex items-center gap-1 mr-3"><input type="checkbox" checked={chapterIds.includes(c.id)} disabled={busy || status?.preparation?.running} onChange={() => toggle(c.id, chapterIds, setChapterIds)}/>{c.label}</label>)}<textarea className="border rounded p-2 bg-background w-full" aria-label="Additional crop rules" placeholder="Additional crop rules (optional; saved with this batch)" value={rules} onChange={e => setRules(e.target.value)}/><Button disabled={busy || !chapterIds.length || status?.preparation?.running} onClick={() => void action(() => api('/prepare', { seriesId, chapterIds, rules }))}>Slice and upload selected chapters</Button></fieldset>
   {status?.preparation && <p role="status">Preparation: {status.preparation.done}/{status.preparation.total} · {status.preparation.running ? 'uploading' : status.preparation.cancelled ? 'cancelled' : 'finished'} {status.preparation.page}{status.preparation.error && <span className="text-destructive"> · {status.preparation.error}</span>}{status.preparation.running && <Button variant="outline" className="ml-2" onClick={() => void action(() => api('/cancel-preparation', { seriesId }))}>Cancel upload</Button>}</p>}
   <fieldset className="space-y-2"><legend className="font-medium">2. Accounts</legend><div className="flex gap-2"><input className="border rounded p-2 bg-background" aria-label="Account label" placeholder="Account label" value={label} onChange={e => setLabel(e.target.value)}/><Button disabled={busy || !label.trim()} onClick={() => void action(async () => { await api('/accounts', { label: label.trim() }); setLabel(''); })}>Add account</Button></div>
    {status?.accounts.map(a => <div key={a.id} className="border rounded p-2"><label className="flex gap-2"><input type="checkbox" checked={accountIds.includes(a.id)} onChange={() => toggle(a.id, accountIds, setAccountIds)}/><strong>{a.label}</strong> · {a.state}{a.retryAt ? ` · retry ${new Date(a.retryAt).toLocaleString()}` : ''}</label>{a.error && <p>{a.error}</p>}<details><summary>Connect this ChatGPT account</summary><p>Add this custom MCP server in that account:</p><code className="break-all">{status.controllerUrl}/mcp/{a.id}</code><p>Then in a Work Cloud chat: “Monitor Clipper work available events. For each assigned page, fetch its prompt and every slice, submit analysis, perform the separate review, and save with submit_review. Stop when no page is assigned.” Authorize the connection with your controller key.</p></details><Button size="sm" variant="outline" disabled={busy || !!a.inFlight} onClick={() => void action(() => api(`/accounts/${a.id}/availability`, { retryAt: null }))}>Mark available</Button></div>)}
   </fieldset>
   <fieldset className="space-y-2"><legend className="font-medium">3. Start selected pages</legend><Button variant="outline" size="sm" onClick={() => setPageIds(prepared.map(p => p.id))}>Select all {prepared.length} ready pages</Button><Button variant="outline" size="sm" className="ml-2" onClick={() => setPageIds([])}>Clear selection</Button><div className="max-h-64 overflow-auto">{prepared.map(p => <label key={p.id} className="flex gap-2"><input type="checkbox" checked={pageIds.includes(p.id)} onChange={() => toggle(p.id, pageIds, setPageIds)}/>{p.chapter} · {p.filename}{p.error ? ` · ${p.error}` : ''}</label>)}</div><label className="flex gap-2">Accounts<select className="border rounded bg-background" value={mode} onChange={e => setMode(e.target.value)}><option value="parallel">Process together</option><option value="sequential">Use one at a time</option></select></label><label className="flex gap-2"><input type="checkbox" checked={autoResume} onChange={e => setAutoResume(e.target.checked)}/>Resume this run after expected account reset</label><Button disabled={busy || !selectedReady.length || !accountIds.length || !status} onClick={() => void action(() => api('/runs', { series: status!.seriesFolder, pageIds: selectedReady, accountIds, mode, autoResume }))}>Start {selectedReady.length} pages</Button></fieldset>
   <div className="space-y-2" aria-live="polite">{status?.runs.slice().reverse().map(r => <div className="border rounded p-2" key={r.id}><strong>{r.done}/{r.total} pages saved · {r.state}</strong><progress className="w-full" value={r.done} max={r.total}/>{['active', 'paused'].includes(r.state) && <div className="flex gap-2"><Button disabled={busy} variant="outline" onClick={() => void action(() => api(`/runs/${r.id}/${r.state === 'paused' ? 'resume' : 'pause'}`, {}))}>{r.state === 'paused' ? 'Resume' : 'Pause'}</Button><Button disabled={busy} variant="outline" onClick={() => void action(() => api(`/runs/${r.id}/stop`, {}))}>Stop</Button></div>}</div>)}</div>
   <p>Stop blocks new work and ignores late results. Already running ChatGPT responses may finish.</p>
   <div className="flex gap-2"><Button disabled={busy} variant="outline" onClick={() => void action(() => api('/import', { seriesId }).then(result => { onImported?.(); return result; }))}>Import saved pointers</Button><Button disabled={busy} variant="outline" onClick={() => void refresh()}>Refresh progress</Button></div>
   <details><summary>Page progress ({status?.pages.length ?? 0})</summary>{status?.pages.map(p => <p key={p.id}>{p.chapter} · {p.filename}: {p.state}{p.state === 'processing' ? ` · ${p.fetched.length} slices fetched` : ''}{p.error ? ` · ${p.error}` : ''}</p>)}</details>
   {status && <p className="text-muted-foreground">Updated {new Date(status.updatedAt).toLocaleTimeString()}. Progress refreshes every 5 seconds while this panel is open. Import saved pointers to update the normal Clipper preview.</p>}
  </>}{error && <p role="alert" className="text-destructive whitespace-pre-wrap">{error}</p>}
 </div>}</details>;
}
