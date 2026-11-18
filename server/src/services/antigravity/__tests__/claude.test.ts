import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyClaudeLine, buildClaudeArgs, claudeEnv, claudeMcpConfig, describeClaudeEvidence, findClaudeTranscript, newClaudeSummary,
  parseAuthStatus, projectFolderName, summarizeTranscript, toClaudeEnvelope
} from '../claudeCli.js'
import { classifyProviderFailure } from '../jobs.js'
import { DEFAULT_CLAUDE_SETTINGS, DEFAULT_SETTINGS, claudeProofStatus, sanitizeClaudeSettings, sanitizeSettings } from '../settingsModel.js'
import type { CompatibilityReport } from '../compatibility.js'

const SESSION = 'b165aa02-e8eb-4764-8537-1e53e7a74624'

describe('Claude Code arguments', () => {
  it('locks every turn down to Studio\'s MCP tools and never puts the prompt or token on the command line', () => {
    const args = buildClaudeArgs({ model: 'claude-sonnet-5-5', effort: 'high', mcpConfigPath: '/a/claude-mcp.json' })
    expect(args.slice(0, 4)).toEqual(['-p', '--output-format', 'stream-json', '--verbose'])
    const joined = args.join(' ')
    for (const needle of ['--model claude-sonnet-5-5', '--effort high', '--setting-sources  --tools  --strict-mcp-config --mcp-config /a/claude-mcp.json', '--allowedTools mcp__studio', '--permission-mode dontAsk', '--disable-slash-commands', '--no-chrome']) {
      expect(joined).toContain(needle)
    }
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args).not.toContain('--resume')
  })

  it('resumes exactly the stored session', () => {
    const args = buildClaudeArgs({ model: 'claude-sonnet-5-5', conversationId: SESSION, mcpConfigPath: '/a/m.json' })
    expect(args.slice(-2)).toEqual(['--resume', SESSION])
    expect(args).not.toContain('--continue')
    expect(args).not.toContain('--fork-session')
  })

  it('refuses unsafe models, efforts, ids and relative config paths', () => {
    expect(() => buildClaudeArgs({ model: 'a b', mcpConfigPath: '/m.json' })).toThrow()
    expect(() => buildClaudeArgs({ model: 'claude-sonnet-5-5', effort: 'ultra', mcpConfigPath: '/m.json' })).toThrow()
    expect(() => buildClaudeArgs({ model: 'claude-sonnet-5-5', conversationId: '../x', mcpConfigPath: '/m.json' })).toThrow()
    expect(() => buildClaudeArgs({ model: 'claude-sonnet-5-5', mcpConfigPath: 'm.json' })).toThrow()
  })

  it('writes the MCP config with the token file path only', () => {
    const config = JSON.parse(claudeMcpConfig({ command: '/usr/local/bin/node', args: ['/x/job-mcp.mjs'], env: { STUDIO_BRIDGE_URL: 'http://127.0.0.1:3002/api/antigravity/bridge', STUDIO_ATTEMPT_TOKEN_FILE: '/a/capability.token' } }))
    expect(config.mcpServers.studio).toEqual({ type: 'stdio', command: '/usr/local/bin/node', args: ['/x/job-mcp.mjs'], env: { STUDIO_BRIDGE_URL: 'http://127.0.0.1:3002/api/antigravity/bridge', STUDIO_ATTEMPT_TOKEN_FILE: '/a/capability.token' } })
    expect(() => claudeMcpConfig({ command: 'node', args: [], env: { 'bad name': 'x' } })).toThrow()
  })

  it('drops a parent Claude Code session\'s variables and API keys, keeps the config dir', () => {
    const env = claudeEnv({ PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CODE_ENTRYPOINT: 'sdk', CLAUDE_CONFIG_DIR: '/c', ANTHROPIC_API_KEY: 'sk', HOME: '/h' })
    expect(env.CLAUDECODE).toBeUndefined()
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined()
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.CLAUDE_CONFIG_DIR).toBe('/c')
    expect(env.PATH).toBe('/bin')
    expect(env.DISABLE_AUTOUPDATER).toBe('1')
    // Without this the model can start while Studio's MCP server is still pending and has no tools (observed live).
    expect(env.MCP_CONNECTION_NONBLOCKING).toBe('false')
  })
})

describe('Claude Code stream-json', () => {
  const feed = (lines: unknown[]) => {
    const summary = newClaudeSummary()
    for (const line of lines) applyClaudeLine(summary, typeof line === 'string' ? line : JSON.stringify(line))
    return summary
  }

  it('reads the session, served model, tool calls, limits and result (lines observed live)', () => {
    const s = feed([
      { type: 'system', subtype: 'init', session_id: SESSION, tools: ['mcp__studio__fetch_slice'], mcp_servers: [{ name: 'studio', status: 'connected' }], model: 'claude-haiku-4-5-20251001' },
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1794330600, rateLimitType: 'five_hour', overageStatus: 'rejected' }, session_id: SESSION },
      { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 9, session_id: SESSION },
      { type: 'assistant', message: { model: 'claude-haiku-4-5-20251001', content: [{ type: 'tool_use', name: 'mcp__studio__fetch_slice', input: { sliceId: 's1' } }] }, session_id: SESSION },
      { type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'image', source: { type: 'base64', data: 'iVBOR' } }] }] }, session_id: SESSION },
      { type: 'assistant', message: { model: 'claude-haiku-4-5-20251001', content: [{ type: 'tool_use', name: 'mcp__studio__submit_analysis', input: {} }] }, session_id: SESSION },
      { type: 'assistant', message: { model: 'claude-haiku-4-5-20251001', content: [{ type: 'text', text: 'DONE.' }] }, session_id: SESSION },
      { type: 'result', subtype: 'success', is_error: false, api_error_status: null, num_turns: 3, result: 'DONE.', session_id: SESSION, usage: { input_tokens: 516, output_tokens: 53, server_tool_use: { web_search_requests: 0 } }, permission_denials: [] },
      'not json'
    ])
    expect(toClaudeEnvelope(s)).toEqual({ conversation_id: SESSION, status: 'SUCCESS', response: 'DONE.', num_turns: 3, usage: { input_tokens: 516, output_tokens: 53 } })
    expect(s.model).toBe('claude-haiku-4-5-20251001')
    expect(s.toolCalls).toEqual({ mcp__studio__fetch_slice: 1, mcp__studio__submit_analysis: 1 })
    expect(s.rateLimits).toEqual([{ type: 'five_hour', status: 'allowed', resetsAt: new Date(1794330600 * 1000).toISOString(), utilization: null, at: expect.any(String) }])
  })

  it('an unknown model is an ERROR the run classifies as a model problem (observed live: exit 1, 404)', () => {
    const s = feed([
      { type: 'system', subtype: 'init', session_id: SESSION, mcp_servers: [], model: 'claude-nonexistent-9' },
      { type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: "There's an issue with the selected model (claude-nonexistent-9). It may not exist or you may not have access to it." }] }, session_id: SESSION },
      { type: 'result', subtype: 'success', is_error: true, api_error_status: 404, result: "There's an issue with the selected model (claude-nonexistent-9). It may not exist or you may not have access to it.", session_id: SESSION }
    ])
    const envelope = toClaudeEnvelope(s)!
    expect(envelope.status).toBe('ERROR')
    expect(envelope.error).toMatch(/\(HTTP 404\)/)
    expect(s.model).toBe('claude-nonexistent-9') // the synthetic message does not overwrite it
    expect(classifyProviderFailure({ exitCode: 1, signal: null, envelope, stderrTail: '', timedOut: false, cancelled: false, pid: 1, durationMs: 1 })).toBe('model')
  })

  it('a refused window is a quota failure with its reset; a sign-in error is auth', () => {
    const limited = feed([
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1794330600, rateLimitType: 'five_hour' }, session_id: SESSION },
      { type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: "You've hit your limit · resets 6pm", session_id: SESSION }
    ])
    const envelope = toClaudeEnvelope(limited)!
    expect(envelope.error).toMatch(/Claude usage limit reached \(five hour, resets /)
    const turn = (env: typeof envelope) => ({ exitCode: 1, signal: null, envelope: env, stderrTail: '', timedOut: false, cancelled: false, pid: 1, durationMs: 1 })
    expect(classifyProviderFailure(turn(envelope))).toBe('quota')
    const auth = toClaudeEnvelope(feed([{ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login', session_id: SESSION }]))!
    expect(classifyProviderFailure(turn(auth))).toBe('auth')
  })

  it('reports any non-Studio tool and permission denial as a denied action', () => {
    const s = feed([
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] }, session_id: SESSION },
      { type: 'result', subtype: 'success', is_error: false, result: 'x', session_id: SESSION, permission_denials: [{ tool_name: 'Bash' }] }
    ])
    expect(toClaudeEnvelope(s)!.denied_actions).toEqual([{ action: 'Bash', display_name: 'Bash' }, { action: 'Bash', display_name: 'Bash' }])
  })

  it('an MCP server that failed to start is named in the error', () => {
    const s = feed([
      { type: 'system', subtype: 'init', session_id: SESSION, mcp_servers: [{ name: 'studio', status: 'failed' }] },
      { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: SESSION }
    ])
    expect(toClaudeEnvelope(s)!.error).toMatch(/Studio's MCP server failed/)
  })
})

describe('Claude Code sign-in', () => {
  it('reads claude auth status JSON (observed live)', () => {
    const account = parseAuthStatus(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'me@example.com', subscriptionType: 'pro' }))
    expect(account).toMatchObject({ signedIn: true, method: 'claude.ai', email: 'me@example.com', subscription: 'pro' })
    expect(account.detail).toBe('Signed in with Claude as me@example.com (Pro plan).')
    expect(parseAuthStatus(JSON.stringify({ loggedIn: false })).signedIn).toBe(false)
    expect(parseAuthStatus(JSON.stringify({ loggedIn: true, authMethod: 'api_key' })).detail).toMatch(/billed to the API/)
  })
})

describe('Claude settings and proof', () => {
  const installation = { path: '/u/.local/bin/claude', version: '2.1.180', error: null }
  const report = { ok: true, cliVersion: '2.1.178', model: 'claude-sonnet-5-5', account: 'me@example.com' } as CompatibilityReport
  const account = { signedIn: true, method: 'claude.ai', email: 'me@example.com', subscription: 'pro', detail: '' }
  const settings = { ...DEFAULT_CLAUDE_SETTINGS, model: 'claude-sonnet-5-5' }

  it('validates settings and the engine switch', () => {
    expect(sanitizeSettings({ engine: 'claude' }, DEFAULT_SETTINGS).engine).toBe('claude')
    expect(() => sanitizeSettings({ engine: 'gemini' }, DEFAULT_SETTINGS)).toThrow()
    expect(sanitizeClaudeSettings({ model: 'claude-opus-5-5', modelLabel: 'Claude Opus 5.5', effort: 'max' }, DEFAULT_CLAUDE_SETTINGS)).toMatchObject({ model: 'claude-opus-5-5', effort: 'max' })
    expect(() => sanitizeClaudeSettings({ effort: 'ultra' }, DEFAULT_CLAUDE_SETTINGS)).toThrow()
    expect(() => sanitizeClaudeSettings({ executablePath: 'claude' }, DEFAULT_CLAUDE_SETTINGS)).toThrow()
  })

  it('needs sign-in and a passing test on this minor version, model and account (patch updates keep the proof)', () => {
    expect(claudeProofStatus(report, installation, settings, account)).toEqual({ valid: true, note: null })
    expect(claudeProofStatus(report, installation, settings, { ...account, signedIn: false }).valid).toBe(false)
    expect(claudeProofStatus(null, installation, settings, account).valid).toBe(false)
    expect(claudeProofStatus({ ...report, ok: false }, installation, settings, account).valid).toBe(false)
    expect(claudeProofStatus(report, { ...installation, version: '2.2.0' }, settings, account).note).toMatch(/changed from 2\.1\.178 to 2\.2\.0/)
    expect(claudeProofStatus(report, installation, { ...settings, model: 'claude-opus-5-5' }, account).valid).toBe(false)
    expect(claudeProofStatus(report, installation, settings, { ...account, email: 'other@example.com' }).note).toMatch(/now signed in as other@example\.com/)
  })
})

describe('Claude session evidence', () => {
  it('counts Studio tools, flags anything else and names the model', () => {
    const lines = [
      { type: 'user', message: { content: 'prompt' } },
      { type: 'assistant', message: { model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', name: 'mcp__studio__fetch_slice' }, { type: 'tool_use', name: 'mcp__studio__fetch_slice' }] } },
      { type: 'assistant', message: { model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', name: 'mcp__studio__submit_analysis' }, { type: 'text', text: 'ok' }] } }
    ].map(l => JSON.stringify(l))
    const e = summarizeTranscript(lines)
    expect(e).toEqual({ studio: { fetch_slice: 2, submit_analysis: 1 }, unexpected: [], model: 'claude-sonnet-5-5' })
    expect(describeClaudeEvidence(e, [{ type: 'five_hour', status: 'allowed_warning', resetsAt: null, utilization: 0.82, at: '' }])).toBe('tools used — studio: fetch_slice×2, submit_analysis×1; nothing unexpected; model claude-sonnet-5-5; Claude limits: five hour allowed warning (82% used)')
    expect(summarizeTranscript([JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } })]).unexpected).toEqual(['Bash'])
  })

  it('finds the session transcript by its workspace folder, or by searching', async () => {
    const config = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-cfg-'))
    const workspace = '/Users/me/Library/Application Support/Manhwa Studio/antigravity/attempts/a1/workspace'
    expect(projectFolderName(workspace)).toBe('-Users-me-Library-Application-Support-Manhwa-Studio-antigravity-attempts-a1-workspace')
    await fs.mkdir(path.join(config, 'projects', projectFolderName(workspace)), { recursive: true })
    await fs.writeFile(path.join(config, 'projects', projectFolderName(workspace), `${SESSION}.jsonl`), '')
    expect(await findClaudeTranscript(SESSION, workspace, config)).toBe(path.join(config, 'projects', projectFolderName(workspace), `${SESSION}.jsonl`))
    expect(await findClaudeTranscript(SESSION, '/elsewhere', config)).toBe(path.join(config, 'projects', projectFolderName(workspace), `${SESSION}.jsonl`))
    expect(await findClaudeTranscript('../etc', workspace, config)).toBeNull()
  })
})

describe('Claude Code /usage', async () => {
  const { parseClaudeUsage, parseResetTime } = await import('../claudeCli.js')
  it('reads the windows from /usage (text observed live on Pro)', () => {
    const now = new Date(2026, 10, 10, 19, 0)
    const text = "You are currently using your subscription to power your Claude Code usage\n\nCurrent session: 74% used · resets Nov 10 at 10:40pm (Asia/Calcutta)\nCurrent week (all models): 9% used · resets Nov 11 at 6:30am (Asia/Calcutta)\n\nWhat's contributing to your limits usage?\nLast 24h · 369 requests · 43 sessions\n  44% of your usage was at >150k context\n  Top MCP servers: studio 8%"
    const usage = parseClaudeUsage(text, now)!
    expect(usage.source).toBe('You are currently using your subscription to power your Claude Code usage')
    expect(usage.windows).toEqual([
      { label: 'Current session', usedPercent: 74, resetsAt: new Date(2026, 10, 10, 22, 40).toISOString() },
      { label: 'Current week (all models)', usedPercent: 9, resetsAt: new Date(2026, 10, 11, 6, 30).toISOString() }
    ])
    expect(parseClaudeUsage('nothing here')).toBeNull()
  })

  it('puts resets ahead of now (bare time → tomorrow, past date → next year)', () => {
    const now = new Date(2026, 11, 31, 23, 0)
    expect(parseResetTime('1:15am', now)).toBe(new Date(2027, 0, 1, 1, 15).toISOString())
    expect(parseResetTime('Jan 2 at 12pm (UTC)', now)).toBe(new Date(2027, 0, 2, 12, 0).toISOString())
    expect(parseResetTime('soon', now)).toBeNull()
  })
})
