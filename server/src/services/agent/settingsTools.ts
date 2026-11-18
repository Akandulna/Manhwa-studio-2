/**
 * The agent's Settings powers: the plain (non-secret) options the user can change in Settings —
 *   • Download      → Settings → Download (folder, speed, request delay, user agent, image filters)
 *   • Agent         → Settings → Agent (on/off, name, engine, model and reasoning level per engine)
 *   • AI engine     → Settings → AntiGravity (which engine runs jobs, model, reasoning level, parallel runs, page timeout, sandbox)
 * Every change goes through Studio's own HTTP API, exactly like Save on those pages, so the same checks apply.
 * Changes that move files, switch the engine behind every job, weaken a safety setting or switch the agent itself off
 * are parked for the user's approval in the chat.
 *
 * Not here (by design): passwords, API keys, tokens and R2 credentials (Cloudflare tab, relay, API keys), CLI paths,
 * the theme (it is saved in the user's browser, so only the user can change it), the YouTube / Editor 2.0 guideline
 * documents and Storage clean-up. The agent tells the user where to do those.
 */

import type { AgentTool, ToolContext } from './agentTools.js'
import type { ToolKit } from './scriptTools.js'

type Parsed = string | number | boolean | null

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const ENGINES = ['claude', 'codex', 'antigravity'] as const
type Area = 'downloads' | 'agent' | 'antigravity' | 'codex' | 'claude'

export interface SettingDef {
  id: string
  group: 'Download' | 'Agent' | 'AI engine'
  label: string
  /** What is allowed, for the agent and the user. */
  allowed: string
  area: Area
  /** Turns what the agent sent into the stored value, or throws a message the agent can act on. */
  parse: (value: unknown) => Parsed
  /** Reads the stored value out of the area's current settings object. */
  pick: (current: Record<string, any>) => unknown
  /** Builds the request body for the area's settings route. */
  body: (value: Parsed) => Record<string, unknown>
  /** A line for the approval card when this particular change must be approved, else null. */
  risk?: (value: Parsed, current: unknown) => string | null
}

export class SettingError extends Error {}

const fail = (m: string): never => { throw new SettingError(m) }

export const whole = (name: string, min: number, max: number) => (value: unknown): Parsed => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) return fail(`${name} must be a whole number from ${min} to ${max}.`)
  return n
}
export const decimal = (name: string, min: number, max: number) => (value: unknown): Parsed => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) return fail(`${name} must be a number from ${min} to ${max}.`)
  return Math.round(n * 100) / 100
}
export const switchValue = (name: string) => (value: unknown): Parsed => {
  if (typeof value === 'boolean') return value
  const v = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (['true', 'on', 'yes'].includes(v)) return true
  if (['false', 'off', 'no'].includes(v)) return false
  return fail(`${name} must be on or off (true or false).`)
}
export const oneOf = (name: string, options: readonly string[]) => (value: unknown): Parsed => {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!options.includes(v)) return fail(`${name} must be one of: ${options.join(', ')}.`)
  return v
}
/** A model id from the engine's list, or "default" (null) to let the engine choose. */
export const modelId = (value: unknown): Parsed => {
  if (value === null || (typeof value === 'string' && ['default', 'auto', ''].includes(value.trim().toLowerCase()))) return null
  if (typeof value !== 'string' || !/^[\w.:-]{1,128}$/.test(value.trim())) return fail('Give a model id from the engine\'s list, or "default".')
  return value.trim()
}
export const effortLevel = (value: unknown): Parsed => {
  if (value === null || (typeof value === 'string' && ['default', 'auto', ''].includes(value.trim().toLowerCase()))) return null
  return oneOf('Reasoning level', EFFORT_LEVELS)(value)
}
export const text = (name: string, min: number, max: number) => (value: unknown): Parsed => {
  const v = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  if (v.length < min || v.length > max) return fail(`${name} must be ${min}–${max} characters.`)
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(v)) return fail(`${name} cannot contain control characters.`)
  return v
}

const shown = (v: unknown) => (v === null || v === undefined ? 'default' : typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v))
/** The Setting table stores everything as text ('3'), so 3 and '3' (and '1.0' and 1) are the same value. */
export const sameValue = (a: unknown, b: unknown) => {
  if (shown(a) === shown(b)) return true
  const x = typeof a === 'string' ? Number(a) : a, y = typeof b === 'string' ? Number(b) : b
  return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && x === y
}

export const SETTINGS: SettingDef[] = [
  // ─── Download ───
  {
    id: 'downloads.folder', group: 'Download', label: 'Download root folder (where every series is saved)', allowed: 'a folder path', area: 'downloads',
    parse: text('The folder', 1, 500), pick: c => c.downloadRoot, body: v => ({ value: v }),
    risk: (v, cur) => `Change the download folder from ${shown(cur)} to ${v}. New downloads go there; files already downloaded are NOT moved, so the library will look empty until they are moved too`
  },
  { id: 'downloads.concurrency', group: 'Download', label: 'Max concurrent downloads', allowed: 'whole number 1–10', area: 'downloads', parse: whole('Concurrent downloads', 1, 10), pick: c => c.concurrency, body: v => ({ value: v }) },
  { id: 'downloads.request_delay_ms', group: 'Download', label: 'Delay between image downloads (ms)', allowed: 'whole number 0–5000', area: 'downloads', parse: whole('Request delay', 0, 5000), pick: c => c.requestDelayMs, body: v => ({ value: v }) },
  { id: 'downloads.user_agent', group: 'Download', label: 'Browser user agent sent with requests', allowed: 'text, 10–500 characters', area: 'downloads', parse: text('The user agent', 10, 500), pick: c => c.userAgent, body: v => ({ value: v }) },
  { id: 'downloads.min_image_width', group: 'Download', label: 'Minimum image width (px) to count as a page', allowed: 'whole number 100–1000', area: 'downloads', parse: whole('Minimum width', 100, 1000), pick: c => c.minImageWidth, body: v => ({ value: v }) },
  { id: 'downloads.min_aspect_ratio', group: 'Download', label: 'Minimum aspect ratio (height/width)', allowed: 'number 0.1–3', area: 'downloads', parse: decimal('Aspect ratio', 0.1, 3), pick: c => c.minAspectRatio, body: v => ({ value: v }) },

  // ─── Agent ───
  {
    id: 'agent.enabled', group: 'Agent', label: 'The agent is on', allowed: 'on or off', area: 'agent', parse: switchValue('The agent'), pick: c => c.enabled, body: v => ({ enabled: v }),
    risk: v => (v === false ? 'Turn the agent OFF. It leaves the sidebar and cannot be asked to turn itself back on (do that in Settings → Agent)' : null)
  },
  { id: 'agent.name', group: 'Agent', label: 'The agent\'s name', allowed: 'text, 1–40 characters', area: 'agent', parse: text('The name', 1, 40), pick: c => c.name, body: v => ({ name: v }) },
  { id: 'agent.engine', group: 'Agent', label: 'Which engine the agent chats with', allowed: 'auto, claude, codex or antigravity', area: 'agent', parse: oneOf('The engine', ['auto', ...ENGINES]), pick: c => c.engine, body: v => ({ engine: v }) },
  ...ENGINES.flatMap((e): SettingDef[] => [
    { id: `agent.model.${e}`, group: 'Agent', label: `Agent's ${e} model`, allowed: 'a model id, or default', area: 'agent', parse: modelId, pick: c => c.models?.[e], body: v => ({ models: { [e]: v } }) },
    { id: `agent.effort.${e}`, group: 'Agent', label: `Agent's ${e} reasoning level`, allowed: `${EFFORT_LEVELS.join(', ')} or default`, area: 'agent', parse: effortLevel, pick: c => c.efforts?.[e], body: v => ({ efforts: { [e]: v } }) }
  ]),

  // ─── AI engine (Settings → AntiGravity) ───
  {
    id: 'ai.engine', group: 'AI engine', label: 'Engine that runs new AntiGravity jobs (pages, scripts, metadata, timelines)', allowed: 'antigravity, codex or claude', area: 'antigravity',
    parse: oneOf('The engine', ['antigravity', 'codex', 'claude']), pick: c => c.engine, body: v => ({ engine: v }),
    risk: (v, cur) => `Switch the engine behind every new AntiGravity job from ${shown(cur)} to ${v} (running jobs keep their engine; Narration scripts on this Mac need antigravity or codex, and ${v} may need its compatibility test run again)`
  },
  { id: 'ai.antigravity.model', group: 'AI engine', label: 'Antigravity model', allowed: 'a model id offered by the signed-in Antigravity, or default', area: 'antigravity', parse: modelId, pick: c => c.model, body: v => ({ model: v }) },
  { id: 'ai.antigravity.effort', group: 'AI engine', label: 'Antigravity reasoning level', allowed: `${EFFORT_LEVELS.join(', ')} or default`, area: 'antigravity', parse: effortLevel, pick: c => c.effort, body: v => ({ effort: v }) },
  { id: 'ai.antigravity.concurrency', group: 'AI engine', label: 'Pages processed in parallel', allowed: 'whole number 1–4', area: 'antigravity', parse: whole('Parallel runs', 1, 4), pick: c => c.concurrency, body: v => ({ concurrency: v }) },
  { id: 'ai.antigravity.page_timeout_minutes', group: 'AI engine', label: 'Per-page deadline including review (minutes)', allowed: 'whole number 5–180', area: 'antigravity', parse: whole('The timeout', 5, 180), pick: c => c.pageTimeoutMinutes, body: v => ({ pageTimeoutMinutes: v }) },
  {
    id: 'ai.antigravity.sandbox', group: 'AI engine', label: 'Run Antigravity in its sandbox (blocks shell commands)', allowed: 'on or off', area: 'antigravity', parse: switchValue('The sandbox'), pick: c => c.sandbox, body: v => ({ sandbox: v }),
    risk: v => (v === false ? 'Turn Antigravity\'s sandbox OFF: it will be able to run shell commands that earlier approvals granted, and the compatibility test must be run again' : null)
  },
  { id: 'ai.codex.model', group: 'AI engine', label: 'ChatGPT (Codex) model', allowed: 'a model id with image input, or default', area: 'codex', parse: modelId, pick: c => c.model, body: v => ({ model: v }) },
  { id: 'ai.codex.effort', group: 'AI engine', label: 'ChatGPT (Codex) reasoning level', allowed: `${EFFORT_LEVELS.join(', ')} or default`, area: 'codex', parse: effortLevel, pick: c => c.effort, body: v => ({ effort: v }) },
  { id: 'ai.claude.model', group: 'AI engine', label: 'Claude (Claude Code) model', allowed: 'a Claude model id (for example claude-sonnet-5-5), or default', area: 'claude', parse: modelId, pick: c => c.model, body: v => ({ model: v }) },
  { id: 'ai.claude.effort', group: 'AI engine', label: 'Claude (Claude Code) reasoning level', allowed: `${EFFORT_LEVELS.join(', ')} or default`, area: 'claude', parse: effortLevel, pick: c => c.effort, body: v => ({ effort: v }) }
]

/** Matches an id exactly, or by its last part when that is unique ("concurrency" is ambiguous: say "downloads.concurrency"). */
export function findSetting(ref: unknown): SettingDef {
  const q = typeof ref === 'string' ? ref.trim().toLowerCase().replace(/[\s-]+/g, '_') : ''
  if (!q) return fail('Say which setting (its id from settings_list).')
  const exact = SETTINGS.find(s => s.id === q)
  if (exact) return exact
  const partial = SETTINGS.filter(s => s.id.endsWith(`.${q}`) || s.id.includes(q))
  if (partial.length === 1) return partial[0]
  if (!partial.length) return fail(`No setting matches "${ref}". Call settings_list to see them.`)
  return fail(`"${ref}" matches several settings: ${partial.slice(0, 8).map(s => s.id).join(', ')}. Use the exact id.`)
}

/** Settings the agent cannot change, and where the user does it (for settings_list). */
export const NOT_CHANGEABLE_BY_AGENT = [
  'Theme / dark mode: saved in the user\'s browser (Settings → Appearance).',
  'Cloudflare R2 keys, the phone relay URL/token and API keys: secrets (Settings → Cloudflare and the other tabs).',
  'CLI paths for Antigravity / Codex / Claude, and ChatGPT account sign-in or on/off per account (Settings → AntiGravity).',
  'YouTube guideline documents, the Editor 2.0 prompt and Storage clean-up (Settings → YouTube / Editor 2.0 / Storage).',
  'Gemini MCP connector (Settings → Gemini MCP).'
]

export function settingsTools(kit: ToolKit): AgentTool[] {
  const { call, ToolError } = kit

  /** SettingError (a plain message) becomes the tool's own error type so the agent sees it. */
  const guard = async <T>(task: () => T | Promise<T>): Promise<T> => {
    try { return await task() } catch (error) { throw error instanceof SettingError ? new ToolError(error.message) : error }
  }

  const readArea = async (ctx: ToolContext, area: Area): Promise<Record<string, any>> => {
    switch (area) {
      case 'downloads': return call(ctx, 'GET', '/settings')
      case 'agent': return ctx.store.settings() as any
      case 'antigravity': return call(ctx, 'GET', '/antigravity/settings')
      case 'codex': return (await call(ctx, 'GET', '/antigravity/codex/connection')).settings
      case 'claude': return (await call(ctx, 'GET', '/antigravity/claude/connection')).settings
    }
  }
  const areaPath: Record<Exclude<Area, 'downloads'>, string> = { agent: '/agent/settings', antigravity: '/antigravity/settings', codex: '/antigravity/codex/settings', claude: '/antigravity/claude/settings' }

  const ENV_OVERRIDES: Record<string, string> = { 'downloads.folder': 'DOWNLOAD_ROOT', 'downloads.concurrency': 'CONCURRENCY', 'downloads.request_delay_ms': 'REQUEST_DELAY_MS' }
  const envNote = (def: SettingDef) => (ENV_OVERRIDES[def.id] && process.env[ENV_OVERRIDES[def.id]] ? `The ${ENV_OVERRIDES[def.id]} environment variable is set and wins over this saved value until it is removed from .env.` : undefined)

  const KEY_OF: Record<string, string> = { 'downloads.folder': 'downloadRoot', 'downloads.concurrency': 'concurrency', 'downloads.request_delay_ms': 'requestDelayMs', 'downloads.user_agent': 'userAgent', 'downloads.min_image_width': 'minImageWidth', 'downloads.min_aspect_ratio': 'minAspectRatio' }

  const write = async (ctx: ToolContext, def: SettingDef, value: Parsed) => {
    if (def.area === 'downloads') return call(ctx, 'PUT', `/settings/${KEY_OF[def.id]}`, { value })
    const body: Record<string, unknown> = def.body(value)
    // An Antigravity model also stores its display label, which the model list gives.
    if (def.id === 'ai.antigravity.model' && value) {
      const list = await call<{ models?: { id: string; label: string }[] }>(ctx, 'GET', '/antigravity/models').catch(() => null)
      if (list?.models) {
        const model = list.models.find(m => m.id === value)
        if (!model) throw new ToolError(`The signed-in Antigravity does not offer "${value}". Its models: ${list.models.map(m => m.id).join(', ')}.`)
        body.modelLabel = model.label
      }
    }
    // Same for a ChatGPT (Codex) model; it must also see images (pages arrive as images).
    if (def.id === 'ai.codex.model' && value) {
      const cx = await call<{ models?: { id: string; label: string; image: boolean }[] | null }>(ctx, 'GET', '/antigravity/codex/connection').catch(() => null)
      if (cx?.models) {
        const model = cx.models.find(m => m.id === value)
        if (!model || !model.image) throw new ToolError(`ChatGPT (Codex) has no image model "${value}". Its models: ${cx.models.filter(m => m.image).map(m => `${m.id} (${m.label})`).join(', ')}.`)
        body.modelLabel = model.label
      }
    }
    return call(ctx, 'PUT', areaPath[def.area], body)
  }

  return [
    {
      name: 'settings_list',
      help: 'List the settings the user can change in Settings that you can change for them (download folder/speed/filters, the agent\'s own on/off/name/engine/model, and which AI engine/model/parallel runs/timeouts AntiGravity uses), each with its current value, what values are allowed and whether changing it needs approval. Also lists what you cannot change.',
      args: { group: 'optional: download | agent | ai (default: all)' },
      run: async (a, ctx) => guard(async () => {
        const g = typeof a.group === 'string' ? a.group.trim().toLowerCase() : ''
        const groups: Record<string, SettingDef['group']> = { download: 'Download', downloads: 'Download', agent: 'Agent', ai: 'AI engine', engine: 'AI engine', antigravity: 'AI engine' }
        if (g && !groups[g]) return fail('group must be download, agent or ai.')
        const want = SETTINGS.filter(s => !g || s.group === groups[g])
        const cache = new Map<Area, Record<string, any> | string>()
        for (const area of new Set(want.map(s => s.area))) {
          cache.set(area, await readArea(ctx, area).catch(error => `unavailable (${error instanceof Error ? error.message : 'error'})`))
        }
        // The model ids each engine offers, so "6.1 Terra" or "4 Hydrogen high" can be matched to an id.
        const modelChoices: Record<string, string[]> = {}
        if (want.some(s => s.id === 'ai.antigravity.model')) {
          const list = await call<{ models?: { id: string; label: string }[] }>(ctx, 'GET', '/antigravity/models').catch(() => null)
          if (list?.models) modelChoices['ai.antigravity.model'] = list.models.map(m => `${m.id} (${m.label})`)
        }
        if (want.some(s => s.id === 'ai.codex.model')) {
          const cx = await call<{ models?: { id: string; label: string; image: boolean }[] | null }>(ctx, 'GET', '/antigravity/codex/connection').catch(() => null)
          if (cx?.models) modelChoices['ai.codex.model'] = cx.models.filter(m => m.image).map(m => `${m.id} (${m.label})`)
        }
        return {
          settings: want.map(s => {
            const cur = cache.get(s.area)!
            const note = envNote(s)
            return {
              id: s.id, group: s.group, label: s.label,
              current: typeof cur === 'string' ? cur : shown(s.pick(cur)),
              allowed: s.allowed,
              ...(modelChoices[s.id] && { choices: modelChoices[s.id] }),
              ...(s.risk && { approval: s.id === 'agent.enabled' || s.id === 'ai.antigravity.sandbox' ? 'only when turning it off' : 'always' }),
              ...(note && { note })
            }
          }),
          youCannotChange: NOT_CHANGEABLE_BY_AGENT
        }
      })
    },
    {
      name: 'settings_change',
      help: 'Change ONE setting from settings_list (exactly as the Settings page would on Save). Use "default" to reset a model or reasoning level. Some changes need the user\'s approval (a different download folder, switching the AI engine, turning the Antigravity sandbox or the agent itself off). Only change what the user asked for; never change a setting to fix a problem on your own, and never touch a secret.',
      args: { setting: 'id from settings_list, e.g. downloads.concurrency', value: 'the new value (number, text, on/off, or "default")' },
      prepare: async (a, ctx) => guard(async () => {
        const def = findSetting(a.setting)
        if (!('value' in a)) return fail('Give the new value.')
        const value = def.parse(a.value)
        const before = def.pick(await readArea(ctx, def.area))
        if (sameValue(before, value)) return fail(`${def.id} is already ${shown(before)}. Nothing to change.`)
        return { setting: def.id, value, label: def.label, from: shown(before) }
      }),
      approval: async a => guard(() => {
        const def = findSetting(a.setting)
        const cur = a.from === 'default' ? null : a.from === 'on' ? true : a.from === 'off' ? false : a.from
        return def.risk?.(a.value as Parsed, cur) ?? null
      }),
      run: async (a, ctx) => guard(async () => {
        const def = findSetting(a.setting)
        const value = def.parse(a.value)
        await write(ctx, def, value)
        // Read back what was really saved: a route may adjust a value (for example a reasoning level the model lacks).
        const after = def.pick(await readArea(ctx, def.area))
        const note = envNote(def)
        const adjusted = !sameValue(after, value)
        return {
          setting: def.id, label: def.label, from: a.from, now: shown(after),
          ...(adjusted && { note: `Studio saved ${shown(after)} instead of ${shown(value)}.` }),
          ...(note && { envNote: note }),
          ...(def.area === 'downloads' && { reminder: 'Some download changes only apply after the server restarts.' })
        }
      })
    }
  ]
}
