import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Bot, Check, Loader2, MessageSquarePlus, Pencil, RotateCcw, Send, Settings as SettingsIcon, Square, Trash2, X } from 'lucide-react'
import { agentApi, type AgentChatMessage, type AgentChatSummary } from '@/lib/api'
import { useAgentStatus } from '@/hooks/useAgentStatus'
import { useSocket } from '@/lib/socket'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import { cn } from '@/lib/utils'

const SUGGESTIONS = [
  'Which series are ongoing and which are finished?',
  'Are any downloads failing?',
  'Add a new series from this link: '
]

const LAST_CHAT_KEY = 'agentLastChat'

export default function Agent() {
  const { toast } = useToast()
  const { status, setEnabled } = useAgentStatus()
  const { socket } = useSocket()
  const name = status?.settings.name ?? 'Agent'
  const [chats, setChats] = useState<AgentChatSummary[]>([])
  const [chatId, setChatId] = useState<string | null>(null)
  const [messages, setMessages] = useState<AgentChatMessage[]>([])
  const [busyChat, setBusyChat] = useState<string | null>(null)
  const [text, setText] = useState('')
  const bottom = useRef<HTMLDivElement>(null)
  const busy = !!chatId && busyChat === chatId
  const err = (title: string) => (error: unknown) => toast({ title, description: error instanceof Error ? error.message : String(error), variant: 'destructive' })

  const loadList = useCallback(async () => {
    try { const r = await agentApi.chats(); setChats(r.chats); setBusyChat(r.busyChatId); return r.chats } catch { return null }
  }, [])
  const loadChat = useCallback(async (id: string) => {
    try {
      const r = await agentApi.getChat(id)
      setMessages(r.chat.messages)
      setBusyChat(prev => r.busy ? id : prev === id ? null : prev)
    } catch { /* deleted elsewhere; the list reload handles it */ }
  }, [])

  // First load: reopen the last chat, else the newest, else start one.
  useEffect(() => {
    void (async () => {
      const list = await loadList()
      if (!list) return
      const last = localStorage.getItem(LAST_CHAT_KEY)
      const pick = list.find(c => c.id === last)?.id ?? list[0]?.id ?? (await agentApi.newChat().catch(() => null))?.id ?? null
      if (pick) setChatId(pick)
    })()
  }, [loadList])
  useEffect(() => { if (chatId) { localStorage.setItem(LAST_CHAT_KEY, chatId); void loadChat(chatId) } }, [chatId, loadChat])
  // Poll only while the agent is working on an answer.
  useEffect(() => {
    if (!busyChat) return
    const timer = setInterval(() => { void loadList(); if (chatId) void loadChat(chatId) }, 1200)
    return () => clearInterval(timer)
  }, [busyChat, chatId, loadChat, loadList])
  // The agent can speak up by itself (a script run it started ended or hit a problem): show it at once.
  useEffect(() => {
    if (!socket) return
    const onMessage = (event: { chatId?: string }) => { void loadList(); if (event.chatId && event.chatId === chatId) void loadChat(event.chatId) }
    socket.on('agent:message', onMessage)
    return () => { socket.off('agent:message', onMessage) }
  }, [socket, chatId, loadChat, loadList])
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }) }, [messages.length, busy, messages[messages.length - 1]?.text])

  const enabled = status?.settings.enabled ?? false
  const newChat = async () => {
    try { const c = await agentApi.newChat(); setChatId(c.id); setMessages(c.messages); setText(''); void loadList() } catch (e) { err('Could not start a chat')(e) }
  }
  const removeChat = async (c: AgentChatSummary) => {
    if (!window.confirm(`Delete the chat "${c.title}"?`)) return
    try {
      await agentApi.deleteChat(c.id)
      const list = (await loadList()) ?? []
      if (c.id === chatId) { const next = list[0]; if (next) setChatId(next.id); else await newChat() }
    } catch (e) { err('Could not delete')(e) }
  }
  const renameChat = async (c: AgentChatSummary) => {
    const title = window.prompt('Chat title', c.title)
    if (!title?.trim()) return
    try { await agentApi.renameChat(c.id, title); void loadList() } catch (e) { err('Could not rename')(e) }
  }
  const send = async (value = text) => {
    const message = value.trim()
    if (!message || !chatId || busyChat) return
    try {
      const r = await agentApi.send(chatId, message)
      setMessages(r.messages); setBusyChat(chatId); setText(''); void loadList()
    } catch (e) { err('Could not send')(e) }
  }
  const decide = async (id: string, approve: boolean) => {
    try { setMessages((await agentApi.decide(id, approve)).messages) }
    catch (e) { err('Could not do that')(e); if (chatId) void loadChat(chatId) }
  }

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <aside className="flex min-h-0 w-64 shrink-0 flex-col border-r">
        <div className="p-3">
          <Button className="w-full" variant="outline" onClick={() => void newChat()} disabled={!enabled}>
            <MessageSquarePlus className="mr-2 h-4 w-4" />New chat
          </Button>
        </div>
        <div className="flex-1 space-y-0.5 overflow-auto px-2 pb-3">
          {chats.map(c => (
            <div key={c.id} className={cn('group flex items-center gap-1 rounded-lg pr-1 text-sm', c.id === chatId ? 'bg-accent' : 'hover:bg-accent/60')}>
              <button className="min-w-0 flex-1 px-3 py-2 text-left" onClick={() => setChatId(c.id)} title={c.title}>
                <span className="flex items-center gap-1.5">
                  {busyChat === c.id && <Loader2 className="h-3 w-3 shrink-0 animate-spin" />}
                  <span className="block truncate">{c.title}</span>
                </span>
                <span className="block text-[10px] text-muted-foreground">{new Date(c.updatedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>
              </button>
              <button className="hidden rounded p-1 text-muted-foreground hover:text-foreground group-hover:block" title="Rename" onClick={() => void renameChat(c)}><Pencil className="h-3.5 w-3.5" /></button>
              <button className="hidden rounded p-1 text-muted-foreground hover:text-destructive group-hover:block disabled:opacity-40" title="Delete" disabled={busyChat === c.id} onClick={() => void removeChat(c)}><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          ))}
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-primary/10 p-2 text-primary"><Bot className="h-6 w-6" /></div>
          <div>
            <h1 className="text-2xl font-bold">{name}</h1>
            <p className="text-sm text-muted-foreground">
              {!status ? 'Checking…'
                : status.activeEngine ? `Using ${status.engines.find(e => e.id === status.activeEngine)?.label}`
                : 'No AI engine is ready — install and sign in to Claude Code, Codex or Antigravity'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={enabled} onCheckedChange={v => void setEnabled(v).catch(err('Could not change'))} aria-label="Agent on or off" />
            {enabled ? 'On' : 'Off'}
          </label>
          <Button variant="outline" size="sm" asChild><Link to="/settings?tab=agent"><SettingsIcon className="mr-2 h-4 w-4" />Settings</Link></Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
        <div className="mx-auto max-w-3xl space-y-4">
          {!enabled && (
            <div className="rounded-lg border bg-muted/40 p-4 text-sm">
              {name} is switched off. Turn it on with the switch above to chat and let it manage your library.
            </div>
          )}
          {enabled && !messages.length && (
            <div className="space-y-3 pt-8 text-center">
              <Bot className="mx-auto h-10 w-10 text-muted-foreground" />
              <p className="text-muted-foreground">Ask {name} about your library, give it a link to add a series, or just chat.</p>
              <div className="flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map(s => (
                  <Button key={s} variant="outline" size="sm" onClick={() => s.endsWith(' ') ? setText(s) : void send(s)}>{s.trim()}</Button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <Message key={m.id} message={m} onDecide={decide}
              onRetry={i === messages.length - 1 && enabled && !busyChat ? () => void send('continue') : undefined} />
          ))}
          <div ref={bottom} />
        </div>
      </div>

      <footer className="shrink-0 border-t px-6 py-4">
        <form className="mx-auto flex max-w-3xl items-end gap-2" onSubmit={e => { e.preventDefault(); void send() }}>
          <Textarea
            value={text} onChange={e => setText(e.target.value)} rows={2} disabled={!enabled || !chatId}
            placeholder={enabled ? `Message ${name}… (Enter to send, Shift+Enter for a new line)` : `Switch ${name} on to chat`}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
            className="min-h-[3rem] resize-none"
          />
          {busy
            ? <Button type="button" variant="outline" onClick={() => void agentApi.stop()}><Square className="mr-2 h-4 w-4" />Stop</Button>
            : <Button type="submit" disabled={!enabled || !text.trim()}><Send className="mr-2 h-4 w-4" />Send</Button>}
        </form>
      </footer>
      </div>
    </div>
  )
}

function Message({ message: m, onDecide, onRetry }: { message: AgentChatMessage; onDecide: (id: string, approve: boolean) => void; onRetry?: () => void }) {
  if (m.role === 'system') return <p className={cn('text-center text-xs', m.error ? 'text-destructive' : 'text-muted-foreground')}>{m.text}</p>
  const mine = m.role === 'user'
  const failed = !mine && !!m.error
  const doneSteps = m.steps?.filter(s => s.startsWith('✓')).length ?? 0
  return (
    <div className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
      <div className={cn('max-w-[85%] space-y-2 rounded-2xl px-4 py-2.5 text-sm', mine ? 'bg-primary text-primary-foreground' : m.error ? 'border border-destructive/50 bg-destructive/10' : 'bg-muted')}>
        {!!m.steps?.length && (
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {m.steps.map((s, i) => <li key={i} className="break-words">{s}</li>)}
          </ul>
        )}
        {failed ? (
          <div className="space-y-1.5">
            <p className="flex items-center gap-1.5 font-medium text-destructive"><AlertTriangle className="h-4 w-4 shrink-0" />Stopped — this answer did not finish</p>
            <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{m.text}</p>
            <p className="text-xs">{doneSteps ? `The ${doneSteps === 1 ? 'step' : `${doneSteps} steps`} marked ✓ above ${doneSteps === 1 ? 'was' : 'were'} done. ` : 'Nothing was changed. '}Nothing is running now — send a message or try again to carry on.</p>
            {onRetry && <Button size="sm" variant="outline" onClick={onRetry}><RotateCcw className="mr-1 h-4 w-4" />Try again</Button>}
          </div>
        ) : m.text === '…' ? <Loader2 className="h-4 w-4 animate-spin" /> : <p className="whitespace-pre-wrap break-words">{m.text}</p>}
        {m.actions?.map(a => (
          <div key={a.id} className="space-y-2 rounded-lg border bg-background p-3 text-foreground">
            <p className="font-medium">{a.summary}</p>
            {a.status === 'pending'
              ? <div className="flex gap-2">
                  <Button size="sm" variant="destructive" onClick={() => onDecide(a.id, true)}><Check className="mr-1 h-4 w-4" />Approve</Button>
                  <Button size="sm" variant="outline" onClick={() => onDecide(a.id, false)}><X className="mr-1 h-4 w-4" />Cancel</Button>
                </div>
              : <p className="text-xs text-muted-foreground">{a.status === 'approved' ? 'Approved' : a.status === 'rejected' ? 'Cancelled' : `Failed: ${a.result ?? ''}`}</p>}
          </div>
        ))}
        {!mine && !failed && m.engine && m.text !== '…' && <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{m.engine}</p>}
      </div>
    </div>
  )
}
