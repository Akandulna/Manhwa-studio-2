import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyStreamLine, buildCodexArgs, newStreamSummary, parseLoginStatus, parseModelsCache, toEnvelope } from '../codexCli.js'
import { describeSession, findSessionFile, summarizeSession } from '../codexSession.js'
import { classifyProviderFailure } from '../jobs.js'
import { DEFAULT_CODEX_SETTINGS, codexProofStatus, sanitizeCodexSettings, sanitizeSettings, DEFAULT_SETTINGS } from '../settingsModel.js'

const mcp = { command: '/usr/local/bin/node', args: ['/x/job-mcp.mjs'], env: { STUDIO_BRIDGE_URL: 'http://127.0.0.1:3002/api/antigravity/bridge', STUDIO_ATTEMPT_TOKEN_FILE: '/a/capability.token' } }

describe('Codex arguments', () => {
  it('locks every turn down and passes Studio\'s MCP server, never the token', () => {
    const args = buildCodexArgs({ prompt: '-p looks like a flag', model: 'gpt-6-sol', effort: 'high', mcp })
    expect(args.slice(0, 5)).toEqual(['exec', '--json', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check'])
    const joined = args.join('\n')
    for (const needle of ['sandbox_mode="read-only"', 'approval_policy="never"', 'web_search="disabled"', 'features.shell_tool=false', 'features.computer_use=false', 'features.multi_agent=false', 'features.plugins=false', 'model_reasoning_effort="high"', 'mcp_servers.studio.default_tools_approval_mode="approve"']) {
      expect(joined).toContain(needle)
    }
    expect(joined).toContain('mcp_servers.studio.env={ STUDIO_BRIDGE_URL = "http://127.0.0.1:3002/api/antigravity/bridge", STUDIO_ATTEMPT_TOKEN_FILE = "/a/capability.token" }')
    // The prompt follows "--", so a leading dash is never read as a flag.
    expect(args.slice(-2)).toEqual(['--', '-p looks like a flag'])
  })

  it('resumes exactly the stored thread', () => {
    const args = buildCodexArgs({ prompt: 'review', model: 'gpt-6-sol', conversationId: '01a1b788-b8da-7350-a5e8-b57323c23603', mcp })
    expect(args.slice(0, 2)).toEqual(['exec', 'resume'])
    expect(args.slice(-3)).toEqual(['--', '01a1b788-b8da-7350-a5e8-b57323c23603', 'review'])
    expect(args).not.toContain('--last')
    expect(args).not.toContain('-s')
  })

  it('refuses unsafe models, efforts and ids', () => {
    expect(() => buildCodexArgs({ prompt: 'x', model: 'a b', mcp })).toThrow()
    expect(() => buildCodexArgs({ prompt: 'x', model: 'gpt-6-sol', effort: 'ultra', mcp })).toThrow()
    expect(() => buildCodexArgs({ prompt: 'x', model: 'gpt-6-sol', conversationId: '../x y', mcp })).toThrow()
  })
})

describe('Codex JSONL stream', () => {
  const feed = (lines: unknown[]) => {
    const summary = newStreamSummary()
    for (const line of lines) applyStreamLine(summary, typeof line === 'string' ? line : JSON.stringify(line))
    return summary
  }

  it('reads the thread, tool calls, final message and usage (lines observed live)', () => {
    const s = feed([
      { type: 'thread.started', thread_id: '01a1b788-b8da-7350-a5e8-b57323c23603' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'item_1', type: 'mcp_tool_call', server: 'studio', tool: 'fetch_slice', arguments: { sliceId: 's1' }, result: { content: [{ type: 'image', data: 'AAAA' }] }, error: null, status: 'completed' } },
      { type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: 'DONE.' } },
      { type: 'turn.completed', usage: { input_tokens: 58730, output_tokens: 193 } },
      'not json'
    ])
    expect(toEnvelope(s)).toEqual({ conversation_id: '01a1b788-b8da-7350-a5e8-b57323c23603', status: 'SUCCESS', response: 'DONE.', num_turns: 1, usage: { input_tokens: 58730, output_tokens: 193 } })
    expect(s.toolCalls).toEqual({ 'studio/fetch_slice': 1 })
  })

  it('reports a refused MCP call as a denied action (observed before tools were pre-approved)', () => {
    const s = feed([
      { type: 'thread.started', thread_id: 't-1234567890' },
      { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'studio', tool: 'fetch_slice', error: { message: 'MCP tool call requires approval, but approval policy is never' }, status: 'failed' } },
      { type: 'turn.completed', usage: {} }
    ])
    expect(toEnvelope(s)?.denied_actions?.[0].action).toBe('studio/fetch_slice')
  })

  it('turns a failed turn into an ERROR envelope the run can classify', () => {
    const s = feed([{ type: 'thread.started', thread_id: 't-1234567890' }, { type: 'turn.failed', error: { message: "You've hit your usage limit. Upgrade to Pro or try again at 6:12 PM." } }])
    const envelope = toEnvelope(s)!
    expect(envelope.status).toBe('ERROR')
    expect(classifyProviderFailure({ exitCode: 1, signal: null, envelope, stderrTail: '', timedOut: false, cancelled: false, pid: 1, durationMs: 1 })).toBe('quota')
    expect(toEnvelope(newStreamSummary())).toBeNull()
  })
})

describe('Codex account and models', () => {
  it('reads codex login status', () => {
    expect(parseLoginStatus('Logged in using ChatGPT\n')).toMatchObject({ signedIn: true, mode: 'chatgpt' })
    expect(parseLoginStatus('Logged in using an API key - sk-…')).toMatchObject({ signedIn: true, mode: 'api_key' })
    expect(parseLoginStatus('Not logged in')).toMatchObject({ signedIn: false })
  })

  it('lists visible models from Codex\'s cache with their efforts (ultra dropped) and image input', () => {
    const models = parseModelsCache(JSON.stringify({
      models: [
        { slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'ultra' }], visibility: 'list', input_modalities: ['text', 'image'] },
        { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide', input_modalities: ['text', 'image'] },
        { slug: 'text-only', display_name: 'Text', visibility: 'list', input_modalities: ['text'] }
      ]
    }))
    expect(models).toEqual([
      { id: 'gpt-6-sol', label: 'GPT-6-Sol', efforts: ['low', 'medium'], defaultEffort: 'medium', image: true },
      { id: 'text-only', label: 'Text', efforts: [], defaultEffort: null, image: false }
    ])
    expect(parseModelsCache('{')).toEqual([])
  })
})

describe('Codex settings and proof', () => {
  const installation = { path: '/codex', version: '0.166.0', error: null }
  const report = { ok: true, cliVersion: '0.166.0', model: 'gpt-6-sol' } as any

  it('validates settings and the engine switch', () => {
    expect(sanitizeCodexSettings({ model: 'gpt-6-sol', modelLabel: 'GPT-6-Sol', effort: 'high' }, DEFAULT_CODEX_SETTINGS)).toMatchObject({ model: 'gpt-6-sol', effort: 'high' })
    expect(() => sanitizeCodexSettings({ effort: 'ultra' }, DEFAULT_CODEX_SETTINGS)).toThrow()
    expect(() => sanitizeCodexSettings({ executablePath: 'codex' }, DEFAULT_CODEX_SETTINGS)).toThrow()
    expect(sanitizeSettings({ engine: 'codex' }, DEFAULT_SETTINGS).engine).toBe('codex')
    expect(() => sanitizeSettings({ engine: 'claude' }, DEFAULT_SETTINGS)).toThrow()
  })

  it('needs sign-in, a passing test on this codex version and the selected model', () => {
    const settings = { ...DEFAULT_CODEX_SETTINGS, model: 'gpt-6-sol' }
    expect(codexProofStatus(report, installation, settings, { signedIn: true, mode: 'chatgpt', detail: '' }).valid).toBe(true)
    expect(codexProofStatus(report, installation, settings, { signedIn: false, mode: null, detail: '' }).valid).toBe(false)
    expect(codexProofStatus(report, { ...installation, version: '0.167.0' }, settings, null).note).toMatch(/ChatGPT app updates it/)
    expect(codexProofStatus(report, installation, { ...settings, model: 'gpt-6-luna' }, null).valid).toBe(false)
    expect(codexProofStatus(null, installation, settings, null).valid).toBe(false)
  })
})

describe('Codex session evidence', () => {
  const lines = [
    { type: 'session_meta', payload: { id: 't' } },
    { type: 'turn_context', payload: { model: 'gpt-6-sol', effort: 'low' } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'await tools.mcp__studio__fetch_slice({})' } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Reasoning' } } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'McpToolCall', server: 'studio', tool: 'fetch_slice' } } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'McpToolCall', server: 'studio', tool: 'submit_analysis' } } },
    { timestamp: '2026-11-07T19:43:52Z', type: 'event_msg', payload: { type: 'token_count', rate_limits: { plan_type: 'plus', primary: { used_percent: 12.0, window_minutes: 300, resets_at: 1794090489 }, secondary: { used_percent: 79.0, window_minutes: 10080, resets_at: 1794390940 }, rate_limit_reached_type: null } } }
  ].map(l => JSON.stringify(l))

  it('counts Studio tools, the code-mode wrapper, model and usage windows', () => {
    const e = summarizeSession(lines)
    expect(e.toolUse).toEqual({ studio: { fetch_slice: 1, submit_analysis: 1 }, cliReads: 0, unexpected: [] })
    expect(e.wrapperCalls).toBe(1)
    expect([e.model, e.effort]).toEqual(['gpt-6-sol', 'low'])
    expect(e.rateLimits).toMatchObject({ planType: 'plus', primary: { usedPercent: 12, windowMinutes: 300 }, secondary: { usedPercent: 79 }, reached: null })
    expect(describeSession(e)).toMatch(/studio: fetch_slice×1, submit_analysis×1; code-mode wrapper ×1; nothing unexpected; model gpt-6-sol low; Codex plus limits: 5 h 12% used, weekly 79% used/)
  })

  it('flags any other tool as unexpected', () => {
    const e = summarizeSession([
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'shell' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'McpToolCall', server: 'chrome', tool: 'open' } } })
    ])
    expect(e.toolUse.unexpected).toEqual(['shell', 'McpToolCall (chrome:open)'])
  })

  it('finds the thread\'s session file by its id', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-'))
    const dir = path.join(home, 'sessions', '2026', '11', '08')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'rollout-2026-11-08T01-12-33-01a1b788-b8da-7350-a5e8-b57323c23603.jsonl'), lines.join('\n'))
    expect(await findSessionFile('01a1b788-b8da-7350-a5e8-b57323c23603', home)).toMatch(/rollout-.*\.jsonl$/)
    expect(await findSessionFile('01a1b788-0000-0000-0000-000000000000', home)).toBeNull()
    expect(await findSessionFile('../etc', home)).toBeNull()
    await fs.rm(home, { recursive: true, force: true })
  })
})

describe('Codex accounts', async () => {
  const { defaultState, homeFor, limitResetFrom, pickAccount } = await import('../codexAccounts.js')
  const at = Date.parse('2026-11-08T00:00:00Z')
  const acct = (id: string, extra: Record<string, unknown> = {}) => ({ id, label: id, enabled: true, limitedUntil: null, limitReason: null, lastLimits: null, accountId: null, addedAt: '', ...extra })

  it('picks the first enabled account that is not limited, in order', () => {
    const state = { autoSwitch: true, accounts: [acct('default', { limitedUntil: '2026-11-08T02:00:00Z' }), acct('acct-off', { enabled: false }), acct('acct-b'), acct('acct-c')] }
    expect(pickAccount(state, [], at)?.id).toBe('acct-b')
    expect(pickAccount(state, ['acct-b'], at)?.id).toBe('acct-c')
    expect(pickAccount(state, [], Date.parse('2026-11-08T03:00:00Z'))?.id).toBe('default') // its window has reset
    expect(pickAccount({ autoSwitch: true, accounts: [acct('default', { enabled: false })] }, [], at)).toBeNull()
  })

  it('keeps an account off until its exhausted window resets', () => {
    const w = (used: number, resets: string) => ({ usedPercent: used, windowMinutes: 300, resetsAt: resets })
    expect(limitResetFrom({ at: '', planType: 'plus', primary: w(100, '2026-11-08T02:00:00Z'), secondary: w(40, '2026-11-12T00:00:00Z'), reached: 'primary' }, at)).toBe('2026-11-08T02:00:00Z')
    expect(limitResetFrom({ at: '', planType: 'plus', primary: w(100, '2026-11-08T02:00:00Z'), secondary: w(100, '2026-11-12T00:00:00Z'), reached: 'secondary' }, at)).toBe('2026-11-12T00:00:00Z')
    expect(limitResetFrom({ at: '', planType: 'plus', primary: w(30, '2026-11-08T02:00:00Z'), secondary: null, reached: null }, at)).toBeNull()
    expect(limitResetFrom(null, at)).toBeNull()
  })

  it('keeps the Mac\'s own ~/.codex as the default account and gives added accounts their own folder', () => {
    expect(defaultState().accounts.map(a => a.id)).toEqual(['default'])
    expect(homeFor('default', '/r', '/home/.codex')).toBe('/home/.codex')
    expect(homeFor('acct-0123456789', '/r', '/home/.codex')).toBe('/r/acct-0123456789')
    expect(() => homeFor('../etc', '/r')).toThrow()
  })
})
