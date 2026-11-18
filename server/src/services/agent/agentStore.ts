/**
 * The Studio Agent's own files, in server/.config/agent:
 *   knowledge.md — what the agent knows about Manhwa Studio (editable in Settings → Agent)
 *   memory.md    — notes the agent saved itself (its `remember` action); editable and clearable
 *   chats.json   — every conversation (history), so they survive a reload
 *   watches.json — script runs the agent started and will report on (scriptWatcher.ts)
 * Settings (on/off, engine, models) are non-secret and live in the Setting table.
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { PrismaClient } from '@prisma/client'
import type { AgentEngineId } from './agentEngine.js'
import type { Watch } from './scriptWatcher.js'

export const AGENT_FILES = ['knowledge', 'memory'] as const
export type AgentFileKind = typeof AGENT_FILES[number]
export const MAX_FILE_BYTES = 100_000
export const MAX_CHAT_MESSAGES = 200
export const MAX_CHATS = 100

export const AGENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type AgentEffort = typeof AGENT_EFFORTS[number]
export const MAX_NAME = 40

export interface AgentSettings {
  enabled: boolean
  /** What the bot is called in the sidebar, chat and its own replies. */
  name: string
  /** 'auto' = first engine that is installed and signed in. */
  engine: AgentEngineId | 'auto'
  models: Record<AgentEngineId, string | null>
  /** Reasoning effort per engine (null = the engine's default). */
  efforts: Record<AgentEngineId, AgentEffort | null>
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  enabled: false,
  name: 'Agent',
  engine: 'auto',
  models: { claude: null, codex: null, antigravity: null },
  efforts: { claude: null, codex: null, antigravity: null }
}

export interface PendingAction { id: string; tool: string; args: Record<string, unknown>; summary: string; status: 'pending' | 'approved' | 'rejected' | 'failed'; result?: string }
export interface ChatMessage {
  id: string
  role: 'user' | 'agent' | 'system'
  text: string
  at: string
  engine?: AgentEngineId
  /** What the agent did while answering (one line each). */
  steps?: string[]
  actions?: PendingAction[]
  error?: boolean
}

export interface Chat { id: string; title: string; createdAt: string; updatedAt: string; messages: ChatMessage[] }
export interface ChatSummary { id: string; title: string; createdAt: string; updatedAt: string; messageCount: number }

export const DEFAULT_KNOWLEDGE = `# Manhwa Studio — what the agent knows

Manhwa Studio turns downloaded manhwa chapters into narrated YouTube videos. Everything starts in the Library.

## Library
- A *series* is one manhwa. It has *chapters* (numbered); each chapter has downloaded *pages* (images).
- Chapter status: pending, queued, downloading, done, failed, skipped. A series is "ongoing" while it still has chapters that are not done or still has work in later stages; it is "finished" when the user marked it Done (per language: English / Hindi) or archived it.
- Production runs in fixed *parts* of 20 chapters (chapters 1–20 = part 1, 21–40 = part 2 …). A part can be marked complete.
- Stages per chapter: download, cleanup, stitch, English/Hindi script, voiceover, alignment, crop, metadata, timeline, export.

## What the user can do in the Library (and the agent can do for them)
- Add a series from a chapter link (the app finds the numbering pattern and the chapters).
- Add more chapters to a series; rename a series.
- Queue downloads, pause/resume the queue, retry failed chapters, clear the queue.
- Clean pages: delete unwanted pages of a chapter (they go to a restorable bin), restore them, empty the bin.
- Stitch: Auto stitch joins a chapter's short pages and re-cuts them at blank rows into ~12,000 px pages, dropping the repeated intro/outro; originals are backed up so a stitch can be undone. The agent can report which chapters are stitched and start Auto stitch.
- Mark a part complete, mark a series Done (English or Hindi), archive / restore a series.
- Delete a series everywhere (destructive — always needs the user's approval). Emptying a page bin and deleting a stitch backup also need approval.

## Narration scripts (English and Hinglish)
- Each chapter gets an English script written from its pages, then a Hinglish script (Hindi retelling in Devanagari) written from the English one. Saving a script resets that language's voiceover, alignment and Editor timeline.
- Three places write them: **this Mac with AntiGravity** (Narration scripts per part: Start process writes what is missing, ticking a chapter writes or rewrites it; the Antigravity or the ChatGPT (Codex) engine does this, never Claude — e.g. "6.1 Terra High" = engine codex, model gpt-6.1-terra, reasoning level high; a new engine or model needs its compatibility test, which the agent runs itself), **a phone** with Sleeper-Cell (Run automation → Narration scripts: Gemini in AI Studio, one phone at a time, part by part, the phone needs the pages first) and **by hand** in Narration (Replace with pasted text, Fetch from phone to bring the phones' finished scripts in, choose between a phone's differing version and Studio's, Clear scripts).
- Rewriting, Replace, Clear scripts, taking the phone's version over Studio's, Start over and Stop now all need the user's approval in the chat. Starting missing scripts, pause/resume, stopping after the current chapter, retry/continue and fetching new phone scripts do not.
- Studio posts a message in the chat by itself when a script run the agent started ends or hits a problem.

## Image Clipper (AntiGravity on this Mac)
- AntiGravity → Image Clipper works per part (20 chapters): each page is sliced, uploaded to Google Drive and sent to the AI engine, which finds the crop pointers. Results land in Clipper as candidates, are shared with the phones through R2, and still need a human review and Crop Sections.
- The agent can: show the status (per part, chapter or page), Start process (the part's pending pages in order) or start chosen chapters/pages (they join a process already running on that part), Upload to Drive only, pause/resume/stop/stop now, retry a page, review it again, share it with phones, reject a page's result (and optionally process it again), fetch finished pages from R2, mark chapters reviewed or unmark them, and run Crop Sections.
- Pages with saved pointers, managed pages and pages wider than 2000 px are skipped; a page is redone by rejecting it first. Failed pages wait for Retry.
- Needs approval: Stop now, Reject, Mark reviewed (the user confirms they checked the crops; the agent cannot see them) and cutting a chapter again. The agent does not edit crop pointers.

## AI engine limits
- The agent can read the usage limits of Antigravity (Gemini group and Claude/GPT group, each with a 5-hour and a weekly limit, plus the Argon weekly limit), Claude (session, weekly, per-model weekly) and each ChatGPT account (5-hour and weekly). ChatGPT figures are only recorded while a job runs on that account, so they can be old; the agent can refresh one by running a tiny "reply ok" job as that account.

## Settings
- The agent can read and change the plain options in Settings (settings_list, settings_change): Download (folder, concurrent downloads, request delay, user agent, minimum image width / aspect ratio), the agent itself (on/off, name, engine, model and reasoning level per engine) and the AI engine AntiGravity jobs use (engine, model, reasoning level, parallel runs, per-page timeout, sandbox).
- A different download folder, switching the AI engine, turning the Antigravity sandbox off and turning the agent off need the user's approval in the chat. Other changes run at once and the agent reports the old and new value.
- The agent cannot change secrets (R2 keys, relay token, API keys), CLI paths, ChatGPT account sign-in, the theme (saved in the browser) or the YouTube / Editor 2.0 guideline documents; it tells the user which Settings tab to use.

## Style
- Be short and concrete. Say what you did and what happened. Never claim an action worked unless its result said so.
`

const emptyMemory = '# Agent memory\n\n(Nothing saved yet. The agent adds short notes here when you ask it to remember something.)\n'

export class AgentStore {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private prisma: PrismaClient, private root = path.resolve('.config/agent')) {}

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task)
    this.queue = result.catch(() => undefined)
    return result
  }

  private async atomic(filename: string, text: string) {
    await fs.mkdir(this.root, { recursive: true })
    const tmp = `${filename}.${randomUUID()}.tmp`
    try { await fs.writeFile(tmp, text); await fs.rename(tmp, filename) } finally { await fs.rm(tmp, { force: true }) }
  }

  async settings(): Promise<AgentSettings> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'agentSettings' } })
    let saved: Partial<AgentSettings> = {}
    try { saved = row ? JSON.parse(row.value) : {} } catch { saved = {} }
    return { ...DEFAULT_AGENT_SETTINGS, ...saved, models: { ...DEFAULT_AGENT_SETTINGS.models, ...(saved.models ?? {}) }, efforts: { ...DEFAULT_AGENT_SETTINGS.efforts, ...(saved.efforts ?? {}) } }
  }

  async saveSettings(input: unknown): Promise<AgentSettings> {
    const body = (input && typeof input === 'object' ? input : {}) as Record<string, any>
    const next = await this.settings()
    if ('enabled' in body) {
      if (typeof body.enabled !== 'boolean') throw new Error('Choose on or off.')
      next.enabled = body.enabled
    }
    if ('engine' in body) {
      if (body.engine !== 'auto' && !['claude', 'codex', 'antigravity'].includes(body.engine)) throw new Error('Choose an engine from the list.')
      next.engine = body.engine
    }
    if ('name' in body) {
      const name = typeof body.name === 'string' ? body.name.replace(/\s+/g, ' ').trim() : ''
      if (!name || name.length > MAX_NAME) throw new Error(`Give the agent a name of 1–${MAX_NAME} characters.`)
      next.name = name
    }
    if (body.efforts && typeof body.efforts === 'object') {
      for (const id of ['claude', 'codex', 'antigravity'] as const) {
        if (!(id in body.efforts)) continue
        const e = body.efforts[id]
        if (e !== null && !(AGENT_EFFORTS as readonly string[]).includes(e)) throw new Error('Unknown effort level.')
        next.efforts[id] = e
      }
    }
    if (body.models && typeof body.models === 'object') {
      for (const id of ['claude', 'codex', 'antigravity'] as const) {
        if (!(id in body.models)) continue
        const m = body.models[id]
        if (m !== null && (typeof m !== 'string' || !/^[\w.:-]{1,128}$/.test(m))) throw new Error('Choose a model from the list.')
        next.models[id] = m
      }
    }
    await this.prisma.setting.upsert({ where: { key: 'agentSettings' }, create: { key: 'agentSettings', value: JSON.stringify(next) }, update: { value: JSON.stringify(next) } })
    return next
  }

  /** The CLI paths the operator already set for each AntiGravity engine (null = auto-detect). */
  async enginePaths(): Promise<Record<AgentEngineId, string | null>> {
    const read = async (key: string) => {
      const row = await this.prisma.setting.findUnique({ where: { key } })
      try { const p = row ? JSON.parse(row.value)?.executablePath : null; return typeof p === 'string' && p ? p : null } catch { return null }
    }
    const [claude, codex, antigravity] = await Promise.all([read('antigravityClaudeSettings'), read('antigravityCodexSettings'), read('antigravitySettings')])
    return { claude, codex, antigravity }
  }

  private file(kind: AgentFileKind) {
    if (!AGENT_FILES.includes(kind)) throw new Error('Unknown agent file.')
    return path.join(this.root, `${kind}.md`)
  }

  async read(kind: AgentFileKind): Promise<{ text: string; bytes: number; updatedAt: string | null }> {
    const file = this.file(kind)
    try {
      const [text, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)])
      return { text, bytes: Buffer.byteLength(text), updatedAt: stat.mtime.toISOString() }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const text = kind === 'knowledge' ? DEFAULT_KNOWLEDGE : emptyMemory
      return { text, bytes: Buffer.byteLength(text), updatedAt: null }
    }
  }

  write(kind: AgentFileKind, text: unknown): Promise<{ bytes: number }> {
    return this.serial(async () => {
      if (typeof text !== 'string') throw new Error('The file must be text.')
      const bytes = Buffer.byteLength(text)
      if (bytes > MAX_FILE_BYTES) throw new Error('The file is too large (100 KB maximum).')
      await this.atomic(this.file(kind), text)
      return { bytes }
    })
  }

  /** The agent's `remember` action: one dated line appended to memory.md. */
  remember(note: string): Promise<void> {
    return this.serial(async () => {
      const clean = note.replace(/\s+/g, ' ').trim().slice(0, 500)
      if (!clean) throw new Error('Nothing to remember.')
      const current = (await this.read('memory')).text
      const base = /\(Nothing saved yet/.test(current) ? '# Agent memory\n\n' : current.replace(/\s*$/, '\n')
      const next = `${base}- ${new Date().toISOString().slice(0, 10)}: ${clean}\n`
      if (Buffer.byteLength(next) > MAX_FILE_BYTES) throw new Error('Memory is full; clear some notes in Settings → Agent.')
      await this.atomic(this.file('memory'), next)
    })
  }

  // ─── Watches: script runs the agent reports on by itself ───
  async watches(): Promise<Watch[]> {
    try {
      const data = JSON.parse(await fs.readFile(path.join(this.root, 'watches.json'), 'utf8'))
      return Array.isArray(data) ? data : []
    } catch { return [] }
  }
  saveWatches(list: Watch[]) {
    return this.serial(() => this.atomic(path.join(this.root, 'watches.json'), JSON.stringify(list.slice(-50), null, 1)))
  }

  // ─── Chats: chats.json holds every conversation; the old single chat.json is migrated into the first one ───

  private async readChats(): Promise<Chat[]> {
    try {
      const data = JSON.parse(await fs.readFile(path.join(this.root, 'chats.json'), 'utf8'))
      return Array.isArray(data) ? data : []
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return []
    }
    try {
      const old = JSON.parse(await fs.readFile(path.join(this.root, 'chat.json'), 'utf8'))
      if (Array.isArray(old) && old.length) {
        const first = old.find((m: ChatMessage) => m.role === 'user')
        return [{ id: randomUUID(), title: titleFrom(first?.text ?? ''), createdAt: old[0].at, updatedAt: old[old.length - 1].at, messages: old }]
      }
    } catch { /* no old chat */ }
    return []
  }

  /** Newest first, without messages. */
  async listChats(): Promise<ChatSummary[]> {
    return (await this.readChats()).map(({ messages, ...c }) => ({ ...c, messageCount: messages.length }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async getChat(id: string): Promise<Chat | null> {
    return (await this.readChats()).find(c => c.id === id) ?? null
  }

  /** The messages of one chat ([] when it does not exist). */
  async chat(id: string): Promise<ChatMessage[]> {
    return (await this.getChat(id))?.messages ?? []
  }

  private save(chats: Chat[]) {
    return this.atomic(path.join(this.root, 'chats.json'), JSON.stringify(chats.slice(-MAX_CHATS), null, 1))
  }

  newChat(): Promise<Chat> {
    return this.serial(async () => {
      const chats = await this.readChats()
      // An untouched empty chat is reused instead of piling up blanks.
      const blank = chats.find(c => !c.messages.length)
      if (blank) return blank
      const now = new Date().toISOString()
      const chat: Chat = { id: randomUUID(), title: 'New chat', createdAt: now, updatedAt: now, messages: [] }
      await this.save([...chats, chat])
      return chat
    })
  }

  updateChat(id: string, change: (messages: ChatMessage[]) => ChatMessage[] | void): Promise<ChatMessage[]> {
    return this.serial(async () => {
      const chats = await this.readChats()
      const chat = chats.find(c => c.id === id)
      if (!chat) throw new Error('That chat no longer exists.')
      let messages = change(chat.messages) ?? chat.messages
      messages = messages.slice(-MAX_CHAT_MESSAGES)
      chat.messages = messages
      chat.updatedAt = new Date().toISOString()
      if (chat.title === 'New chat') {
        const first = messages.find(m => m.role === 'user')
        if (first) chat.title = titleFrom(first.text)
      }
      await this.save(chats)
      return messages
    })
  }

  renameChat(id: string, title: unknown): Promise<void> {
    return this.serial(async () => {
      const clean = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim().slice(0, 80) : ''
      if (!clean) throw new Error('Give the chat a title.')
      const chats = await this.readChats()
      const chat = chats.find(c => c.id === id)
      if (!chat) throw new Error('That chat no longer exists.')
      chat.title = clean
      await this.save(chats)
    })
  }

  deleteChat(id: string): Promise<void> {
    return this.serial(async () => { await this.save((await this.readChats()).filter(c => c.id !== id)) })
  }

  /** Every chat with a still-waiting action matching this id (approvals can come from any chat). */
  async chatOfAction(actionId: string): Promise<string | null> {
    return (await this.readChats()).find(c => c.messages.some(m => m.actions?.some(a => a.id === actionId)))?.id ?? null
  }
}

const titleFrom = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 48) || 'New chat'
