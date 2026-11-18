import { describe, expect, it } from 'vitest'
import { conversationPrompt, parseReply, systemPrompt } from '../agent.js'
import { claudeChatArgs, codexChatArgs, extractReply, failureReason, pickEngines, stderrReason, type EngineStatus } from '../agentEngine.js'
import { pickNames, secondSeed, summarizeUsage } from '../agentTools.js'

describe('parseReply', () => {
  it('splits text from actions', () => {
    const r = parseReply('Checking.\n<action>{"tool":"library_overview","args":{"filter":"ongoing"}}</action>')
    expect(r.text).toBe('Checking.')
    expect(r.actions).toEqual([{ tool: 'library_overview', args: { filter: 'ongoing' } }])
  })
  it('accepts fenced JSON and missing args', () => {
    const r = parseReply('<action>```json\n{"tool":"pause_downloads"}\n```</action>')
    expect(r.actions).toEqual([{ tool: 'pause_downloads', args: {} }])
  })
  it('reports unreadable actions instead of running them', () => {
    const r = parseReply('<action>{nope}</action>')
    expect(r.actions).toEqual([])
    expect(r.problems).toHaveLength(1)
  })
  it('returns plain answers untouched', () => {
    expect(parseReply('Hello there')).toEqual({ text: 'Hello there', actions: [], problems: [] })
  })
})

describe('secondSeed', () => {
  it('adds one to the last number, keeping padding', () => {
    expect(secondSeed('https://x.com/series-12/chapter-009/')).toBe('https://x.com/series-12/chapter-010/')
    expect(secondSeed('https://x.com/a/ch-1')).toBe('https://x.com/a/ch-2')
  })
  it('gives up when there is no number', () => expect(secondSeed('https://x.com/a')).toBeNull())
})

describe('engines', () => {
  const status = (id: EngineStatus['id'], available: boolean): EngineStatus => ({ id, label: id, available, detail: '', models: [] })
  const all = [status('claude', false), status('codex', true), status('antigravity', true)]
  it('auto picks the first ready engine in order', () => expect(pickEngines('auto', all)).toEqual(['codex', 'antigravity']))
  it('a chosen engine that is not ready yields nothing', () => expect(pickEngines('claude', all)).toEqual([]))
  it('claude runs with no built-in tools', () => {
    const args = claudeChatArgs('claude-sonnet-5-5')
    expect(args).toContain('--tools')
    expect(args[args.indexOf('--tools') + 1]).toBe('')
  })
  it('passes effort to each engine', () => {
    expect(claudeChatArgs(null, 'high')).toEqual(expect.arrayContaining(['--effort', 'high']))
    expect(codexChatArgs(null, 'hi', 'low').join(' ')).toContain('model_reasoning_effort="low"')
    expect(() => claudeChatArgs(null, 'bogus')).toThrow()
  })
  it('codex is read-only', () => expect(codexChatArgs(null, 'hi').join(' ')).toContain('sandbox_mode="read-only"'))
  it('extracts the claude reply and rejects errors', () => {
    expect(extractReply('claude', '{"type":"result","is_error":false,"result":"hi"}')).toBe('hi')
    expect(extractReply('claude', '{"is_error":true,"result":"x"}')).toBeNull()
  })
})

describe('prompts', () => {
  it('lists the actions and includes knowledge and memory', () => {
    const p = systemPrompt('KNOW', 'MEM', 'Kuro')
    expect(p).toContain('add_series_from_link')
    expect(p).toContain('You are Kuro')
    expect(p).toContain('KNOW')
    expect(p).toContain('MEM')
    expect(p).toMatch(/delete_series \[needs the user's approval\]/)
  })
  it('leaves system notes out of the conversation', () => {
    const t = conversationPrompt('SYS', [{ id: '1', role: 'user', text: 'hi', at: '' }, { id: '2', role: 'system', text: 'Done', at: '' }], [])
    expect(t).toContain('USER: hi')
    expect(t).not.toContain('Done')
  })
})

describe('pickNames', () => {
  const names = ['001.webp', '002.webp', '003.webp']
  it('accepts positions and file names, once each', () => {
    expect(pickNames(names, [1, '003.webp', '1'], 'pages')).toEqual(['001.webp', '003.webp'])
  })
  it('refuses unknown pages instead of guessing', () => {
    expect(() => pickNames(names, [4], 'pages')).toThrow(/not one of the 3/)
    expect(() => pickNames(names, ['x.png'], 'pages')).toThrow()
    expect(() => pickNames(names, [], 'pages')).toThrow(/Say which/)
  })
})

describe('summarizeUsage', () => {
  const now = Date.parse('2026-11-16T06:00:00Z')
  const raw = {
    google: { account: 'a@b', checkedAt: '2026-11-16T05:59:00Z', quota: { at: '2026-11-16T05:59:00Z', groups: [{ name: 'Gemini Models', buckets: [{ window: '5h', remainingFraction: 0.75, resetTime: '2026-11-16T08:00:00Z' }] }] } },
    claude: { usage: { at: '2026-11-16T05:59:00Z', windows: [{ label: 'Current session', usedPercent: 29, resetsAt: '2026-11-16T10:00:00Z' }] } },
    codex: { accounts: [
      { label: 'Main', enabled: true, limits: { at: '2026-11-16T05:50:00Z', planType: 'plus', primary: { usedPercent: 76, windowMinutes: 300, resetsAt: '2026-11-16T08:51:00Z' }, secondary: { usedPercent: 39, windowMinutes: 10080, resetsAt: '2026-11-22T09:00:00Z' } } },
      { label: 'Second', enabled: true, limits: null, limitedUntil: '2026-11-16T00:00:00Z' }
    ] }
  }
  const s: any = summarizeUsage(raw, now)
  it('turns remaining into used percent and a countdown', () => {
    expect(s.antigravity.groups[0].limits[0]).toMatchObject({ limit: '5-hour', usedPercent: 25, leftPercent: 75, resetsIn: '2h 0m' })
    expect(s.claude.limits[0]).toMatchObject({ limit: 'Current session (5-hour)', usedPercent: 29 })
    expect(s.chatgpt[0].limits.map((l: any) => l.limit)).toEqual(['5-hour', 'weekly'])
  })
  it('flags missing or old figures and ignores past blocks', () => {
    expect(s.chatgpt[1].stale).toBe(true)
    expect(typeof s.chatgpt[1].limits).toBe('string')
    expect(s.chatgpt[1].blockedUntil).toBeUndefined()
    expect(s.chatgpt[0].stale).toBe(false)
  })
})

describe('failure reasons', () => {
  it('drops the Codex stdin start-up line from stderr', () => {
    expect(stderrReason('Reading additional input from stdin...\n')).toBe('')
    expect(stderrReason('Reading additional input from stdin...\nboom')).toBe('boom')
  })
  it('uses the error Codex wrote in its JSON stream, not the stdin banner', () => {
    const stdout = ['{"type":"thread.started","thread_id":"t1"}', '{"type":"turn.failed","error":{"message":"You have hit your usage limit."}}'].join('\n')
    expect(extractReply('codex', stdout)).toBeNull()
    expect(failureReason('codex', stdout, 'Reading additional input from stdin...\n', 'no answer')).toBe('You have hit your usage limit.')
  })
  it('uses a Codex error event when the turn never completes', () => {
    const stdout = '{"type":"thread.started","thread_id":"t1"}\n{"type":"error","message":"model not supported"}'
    expect(failureReason('codex', stdout, 'Reading additional input from stdin...', 'x')).toBe('model not supported')
  })
  it('falls back to the given text when there is nothing useful', () => {
    expect(failureReason('codex', '', 'Reading additional input from stdin...', 'ChatGPT (Codex) returned no answer.')).toBe('ChatGPT (Codex) returned no answer.')
  })
  it('reads a Claude is_error result', () => {
    expect(failureReason('claude', '{"is_error":true,"result":"Credit balance is too low"}', '', 'x')).toBe('Credit balance is too low')
  })
})
