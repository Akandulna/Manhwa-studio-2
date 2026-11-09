import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildTurnArgs, findExecutable, parseEnvelope, parseModelList, parseUsage, processAlive, runTurn, signedInEmail } from '../cli.js'
import { jobSettings, makeProbeImage } from '../compatibility.js'
import { DEFAULT_SETTINGS, proofStatus, sanitizeSettings } from '../settingsModel.js'
import type { CompatibilityReport } from '../compatibility.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cli-test-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

/** A fake agy: prints a JSON envelope echoing its args, or sleeps when asked. */
function fakeAgy(body: string) {
  const file = path.join(dir, `agy-${Math.random().toString(36).slice(2)}`)
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return file
}

describe('agy output parsing', () => {
  it('parses the tab-separated model list and ignores banner lines', () => {
    const models = parseModelList('Fetching available models...\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nclaude-opus-5-5-high\tClaude Opus 5.5 (High)\n')
    expect(models).toEqual([
      { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
      { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)' }
    ])
  })

  it('reads the JSON envelope, including after log lines', () => {
    const env = parseEnvelope('some log\n{"conversation_id":"abc","status":"SUCCESS","response":"DONE\\n","denied_actions":[{"action":"command"}]}\n')
    expect(env).toMatchObject({ conversation_id: 'abc', status: 'SUCCESS', denied_actions: [{ action: 'command' }] })
    expect(parseEnvelope('not json')).toBeNull()
  })

  it('builds argument arrays with an explicit conversation, never --continue', () => {
    const args = buildTurnArgs({ prompt: 'hi; rm -rf /', model: 'gemini-3.8-flash-low', conversationId: 'conv-1', settings: jobSettings(), sandbox: true, effort: 'high' })
    expect(args).toContain('--conversation')
    expect(args).not.toContain('--continue')
    expect(args).not.toContain('-c')
    expect(args).not.toContain('--remote-agent')
    expect(args[args.indexOf('--print') + 1]).toBe('hi; rm -rf /')
    expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({ permissions: { allow: ['mcp(studio/*)'] } })
    expect(() => buildTurnArgs({ prompt: 'x', model: 'bad model; ls' })).toThrow()
    expect(() => buildTurnArgs({ prompt: 'x', model: 'ok', conversationId: '../../etc' })).toThrow()
  })

  it('accepts only absolute executable overrides', () => {
    const agy = fakeAgy('echo 1.5.2')
    expect(findExecutable(agy)).toBe(agy)
    expect(findExecutable('relative/agy')).toBeNull()
    expect(findExecutable(path.join(dir, 'missing'))).toBeNull()
  })
})

describe('runTurn process control', () => {
  it('passes arguments without a shell and returns the envelope', async () => {
    const agy = fakeAgy(`printf '{"conversation_id":"c-1","status":"SUCCESS","response":"%s"}' "$2"`)
    const result = await runTurn({ executable: agy, cwd: dir, prompt: '$(whoami) && echo hacked', model: 'm', timeoutMs: 10_000 })
    expect(result.exitCode).toBe(0)
    expect(result.envelope?.response).toBe('$(whoami) && echo hacked')
  })

  it('kills its own process group on timeout', async () => {
    const pidFile = path.join(dir, 'child.pid')
    const agy = fakeAgy(`sleep 30 & echo $! > "${pidFile}"; wait`)
    const result = await runTurn({ executable: agy, cwd: dir, prompt: 'x', model: 'm', timeoutMs: 1500 })
    expect(result.timedOut).toBe(true)
    expect(result.envelope).toBeNull()
    const child = Number(fs.readFileSync(pidFile, 'utf8'))
    await new Promise(r => setTimeout(r, 200))
    expect(processAlive(child)).toBe(false)
  })

  it('stops on cancellation', async () => {
    const agy = fakeAgy('sleep 30')
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const result = await runTurn({ executable: agy, cwd: dir, prompt: 'x', model: 'm', timeoutMs: 10_000, signal: controller.signal })
    expect(result.cancelled).toBe(true)
    expect(result.durationMs).toBeLessThan(5000)
  })
})

describe('settings and proof validity', () => {
  it('validates settings input', () => {
    expect(sanitizeSettings({ concurrency: 3, model: 'gemini-4-argon-high', effort: 'high' }, DEFAULT_SETTINGS)).toMatchObject({ concurrency: 3, model: 'gemini-4-argon-high', effort: 'high' })
    expect(() => sanitizeSettings({ concurrency: 9 }, DEFAULT_SETTINGS)).toThrow()
    expect(() => sanitizeSettings({ model: 'x; ls' }, DEFAULT_SETTINGS)).toThrow()
    expect(() => sanitizeSettings({ executablePath: 'agy' }, DEFAULT_SETTINGS)).toThrow()
    expect(() => sanitizeSettings({ effort: 'ultra' }, DEFAULT_SETTINGS)).toThrow()
  })

  it('invalidates the proof when the CLI version, model or sandbox changes', () => {
    const report = { ok: true, cliVersion: '1.5.2', model: 'm1', sandbox: true } as CompatibilityReport
    const install = { path: '/x', version: '1.5.2', error: null }
    const settings = { ...DEFAULT_SETTINGS, model: 'm1' }
    expect(proofStatus(report, install, settings).valid).toBe(true)
    expect(proofStatus(report, { ...install, version: '1.6.0' }, settings).note).toMatch(/changed/)
    expect(proofStatus(report, install, { ...settings, model: 'm2' }).valid).toBe(false)
    expect(proofStatus(report, install, { ...settings, sandbox: false }).valid).toBe(false)
    expect(proofStatus({ ...report, ok: false }, install, settings).valid).toBe(false)
    expect(proofStatus(null, install, settings).valid).toBe(false)
    // Model access is per signed-in account: a model this login lacks, or a proof from another login, is stale.
    expect(proofStatus(report, install, settings, { models: [{ id: 'other', label: 'Other' }], account: 'b@x.com' }).note).toMatch(/does not offer/)
    expect(proofStatus(report, install, settings, { models: [{ id: settings.model!, label: 'M' }] }).valid).toBe(true)
    expect(proofStatus({ ...report, account: 'a@x.com' }, install, settings, { account: 'b@x.com' }).note).toMatch(/now signed in as b@x.com/)
    expect(proofStatus({ ...report, account: 'a@x.com' }, install, settings, { account: 'A@x.com' }).valid).toBe(true)
  })
})

describe('probe image', () => {
  it('draws a fresh random code each time', async () => {
    const a = await makeProbeImage()
    const b = await makeProbeImage()
    expect(a.key.code).toMatch(/^[A-Z2-9]{5}$/)
    expect(a.png.subarray(1, 4).toString()).toBe('PNG')
    expect(a.png.equals(b.png)).toBe(false)
  })
})

describe('agy /usage', () => {
  // Shape observed live from `agy -p "/usage" --output-format json` (agy 1.5.x, 2026-11-08).
  const live = JSON.stringify({
    conversation_id: '', status: 'SUCCESS', response: 'Gemini Models\tWeekly Limit Remaining\t100%\t2026-11-14T20:48:56Z\n',
    command: { name: 'usage', data: { description: 'Within each group, models share a weekly limit.', groups: [
      { name: 'Gemini Models', description: 'Models within this group: Gemini Flash, Gemini Pro', buckets: [{ id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.42, reset_time: '2026-11-14T20:48:56Z' }] },
      { name: 'Claude and GPT models', description: null, buckets: [{ id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 1.5, reset_time: '2026-11-14T20:48:56Z' }] }
    ] } }
  })

  it('reads the structured groups and clamps fractions', () => {
    const usage = parseUsage(live, 'T')!
    expect(usage.at).toBe('T')
    expect(usage.groups.map(g => g.name)).toEqual(['Gemini Models', 'Claude and GPT models'])
    expect(usage.groups[0].buckets[0]).toEqual({ id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.42, resetTime: '2026-11-14T20:48:56Z' })
    expect(usage.groups[1].buckets[0].remainingFraction).toBe(1)
  })

  it('falls back to the tab-separated records', () => {
    const usage = parseUsage('Gemini Models\tWeekly Limit Remaining\t83%\t2026-11-14T20:48:56Z\nClaude and GPT models\tWeekly Limit Remaining\t100%\t2026-11-14T20:48:56Z\n')!
    expect(usage.groups).toHaveLength(2)
    expect(usage.groups[0].buckets[0]).toMatchObject({ remainingFraction: 0.83, window: 'weekly', resetTime: '2026-11-14T20:48:56Z' })
  })

  it('returns null when there is no usage', () => {
    expect(parseUsage('Not signed in')).toBeNull()
  })

  it('reads the last signed-in account from agy\'s log', () => {
    const home = fs.mkdtempSync(path.join(dir, 'home-'))
    fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true })
    fs.writeFileSync(path.join(home, '.gemini', 'antigravity-cli', 'cli.log'), 'applyAuthResult: email=a@x.com, authMethod=consumer\n...\napplyAuthResult: email=b@y.com, authMethod=consumer\n')
    expect(signedInEmail(home)).toBe('b@y.com')
    expect(signedInEmail(path.join(dir, 'nowhere'))).toBeNull()
  })
})
