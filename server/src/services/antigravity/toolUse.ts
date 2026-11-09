/**
 * The effective tool set of one attempt (operator decision, Phase 2: keep the
 * allow-only `mcp(studio/*)` rule plus the sandbox, and record what each job
 * actually used). agy doesn't report its tool list, so Studio reads the
 * conversation's own transcript after the attempt:
 *
 *   ~/.gemini/antigravity-cli/brain/<conversation>/.system_generated/logs/transcript.jsonl
 *
 * Observed live (agy 1.5.2): besides Studio's MCP tools, models call
 * `read_file` on the CLI's offloaded copies of the slice images Studio sent
 * (brain/<conversation>/.system_generated/steps/N/media_0.webp) and on the
 * CLI's cached Studio tool schemas (antigravity-cli/mcp/studio/*.json). Those
 * are the CLI's own files. Anything else is reported as unexpected.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const CLI_HOME = path.join(os.homedir(), '.gemini', 'antigravity-cli')

export interface ToolUse {
  studio: Record<string, number>
  cliReads: number
  unexpected: string[]
}

const unquote = (v: unknown) => (typeof v === 'string' ? v.replace(/^"(.*)"$/s, '$1') : '')

/** Tally the tool calls in transcript lines (one JSON object per line). */
export function summarizeToolUse(lines: string[], ctx: { conversationId: string; cliHome?: string }): ToolUse {
  const home = ctx.cliHome ?? CLI_HOME
  const own = [path.join(home, 'brain', ctx.conversationId) + path.sep, path.join(home, 'mcp', 'studio') + path.sep]
  const out: ToolUse = { studio: {}, cliReads: 0, unexpected: [] }
  for (const line of lines) {
    let step: any
    try { step = JSON.parse(line) } catch { continue }
    for (const call of Array.isArray(step?.tool_calls) ? step.tool_calls : []) {
      const name = String(call?.name ?? '')
      const args = call?.args ?? {}
      const server = unquote(args.ServerName)
      const studioTool = name === 'call_mcp_tool' && server === 'studio' ? unquote(args.ToolName) : name.startsWith('mcp_studio_') ? name.slice('mcp_studio_'.length) : null
      if (studioTool) { out.studio[studioTool] = (out.studio[studioTool] ?? 0) + 1; continue }
      if (name === 'read_file') {
        const target = path.normalize(unquote(args.Path ?? args.path))
        if (own.some(prefix => target.startsWith(prefix))) { out.cliReads++; continue }
        out.unexpected.push(`read_file ${target.startsWith(os.homedir()) ? '~' + target.slice(os.homedir().length) : target}`.slice(0, 200))
        continue
      }
      out.unexpected.push(`${name}${server ? ` (${server}:${unquote(args.ToolName)})` : ''}`.slice(0, 200))
    }
  }
  return out
}

export function describeToolUse(use: ToolUse): string {
  const studio = Object.entries(use.studio).map(([tool, n]) => `${tool}×${n}`).join(', ') || 'none'
  const reads = use.cliReads ? `; CLI's own files read ×${use.cliReads}` : ''
  const unexpected = use.unexpected.length ? `; UNEXPECTED: ${[...new Set(use.unexpected)].slice(0, 5).join(', ')}` : '; nothing unexpected'
  return `tools used — studio: ${studio}${reads}${unexpected}`
}

export async function readToolUse(conversationId: string, cliHome = CLI_HOME): Promise<ToolUse | null> {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(conversationId)) return null
  const file = path.join(cliHome, 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl')
  const text = await fs.readFile(file, 'utf8').catch(() => null)
  return text === null ? null : summarizeToolUse(text.split('\n'), { conversationId, cliHome })
}

/**
 * Which Studio images the model actually opened. agy does not hand MCP images to the model: it saves each
 * one under the conversation (`[Resource offloaded to file://…/steps/N/media_0.webp]`) and the model sees it
 * only by calling read_file on that path (observed live 2026-11-08: Gemini 3.8 Flash runs that never did
 * answered with the prompt's example). [fetched] maps an image id (s01, review-s01, candidate-01) to the
 * files its fetches were offloaded to; [read] holds every path read_file opened.
 */
export interface ImagesViewed {
  fetched: Map<string, Set<string>>
  read: Set<string>
}

/** Only an absolute path: Studio's own hint quotes the marker with "…" in place of a path. */
const OFFLOADED = /\[Resource offloaded to (?:file:\/\/)?(\/[^\]\s]+)\]/
/** The first line of a Studio image result: "s01: …", "review-s01: …" or "1/3 · candidate-01: …". */
const IMAGE_LABEL = /^(?:\d+\/\d+ · )?([A-Za-z0-9._-]+):/m

export function summarizeImagesViewed(lines: string[]): ImagesViewed {
  const out: ImagesViewed = { fetched: new Map(), read: new Set() }
  for (const line of lines) {
    let step: any
    try { step = JSON.parse(line) } catch { continue }
    for (const call of Array.isArray(step?.tool_calls) ? step.tool_calls : []) {
      if (call?.name !== 'read_file') continue
      const target = unquote(call?.args?.Path ?? call?.args?.path).replace(/^file:\/\//, '')
      if (target) out.read.add(path.normalize(target))
    }
    const content = typeof step?.content === 'string' ? step.content : ''
    const file = OFFLOADED.exec(content)?.[1]
    if (!file) continue
    const body = content.replace(/^(?:Created|Completed) At:.*\n/gm, '')
    const id = IMAGE_LABEL.exec(body)?.[1]
    if (!id) continue
    const files = out.fetched.get(id) ?? new Set<string>()
    files.add(path.normalize(file))
    out.fetched.set(id, files)
  }
  return out
}

export async function readImagesViewed(conversationId: string, cliHome = CLI_HOME): Promise<ImagesViewed | null> {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(conversationId)) return null
  const file = path.join(cliHome, 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl')
  const text = await fs.readFile(file, 'utf8').catch(() => null)
  return text === null ? null : summarizeImagesViewed(text.split('\n'))
}

/**
 * The image ids among [ids] that were fetched (and offloaded) but never opened, each with the file to open.
 * An id whose fetch isn't in the transcript yet is not reported: the check never blocks on a log that lags.
 */
export function unopenedImages(viewed: ImagesViewed, ids: string[]): { id: string; file: string }[] {
  return ids.flatMap(id => {
    const files = viewed.fetched.get(id)
    if (!files?.size || [...files].some(f => viewed.read.has(f))) return []
    return [{ id, file: [...files].at(-1)! }]
  })
}
