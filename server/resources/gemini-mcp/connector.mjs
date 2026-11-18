// Manhwa Studio · Gemini MCP connector (docs/PRD-gemini-app-narration.md).
// The Gemini Mac app starts this as a local stdio MCP server (newline-delimited JSON-RPC, no
// dependencies). It only relays: every tool call goes to Studio's loopback bridge with the token in
// ./token, and Studio does all the work and checks. Settings → Gemini MCP installs it into
// ~/.local/share/manhwa-studio/gemini-mcp/ because the app's sandbox can't read Documents.
//
// THE TOOL LIST BELOW IS PERMANENT. The Gemini app saves it when the connector is added and never
// asks again, so changing a tool means every user must remove and re-add the connector. Stages and
// data change on Studio's side only.
//
// Replies are JSON data, never orders: the app refuses to act on instructions coming from a tool.
// stdout carries protocol only; nothing is logged.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

export const CONNECTOR_VERSION = 2
const here = path.dirname(fileURLToPath(import.meta.url))
const read = (name) => { try { return fs.readFileSync(path.join(here, name), 'utf8') } catch { return '' } }
let config = {}
try { config = JSON.parse(read('config.json')) } catch {}
const BRIDGE = typeof config.bridgeUrl === 'string' ? config.bridgeUrl : ''
const TOKEN = read('token').trim()
const bridgeOk = /^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(BRIDGE) && TOKEN.length >= 32
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')
const dataResult = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 1) }], isError: false })

const TOOLS = [
  {
    name: 'get_job',
    description: 'Manhwa Studio: returns a narration job as JSON data: its stage, the Google Drive folder and image files to read, and the chapter context. With a job id it returns that job; without one it returns the next job in the queue, or status "none" when nothing is left.',
    inputSchema: { type: 'object', properties: { job: { type: 'string', description: 'Job id, for example "NR-7K3Q". Optional.' } } },
    annotations: { title: 'Get job', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'get_reference',
    description: 'Manhwa Studio: returns reference data for a job as JSON, for example the writing rules, the accepted notes, the draft or the English script.',
    inputSchema: {
      type: 'object',
      properties: { job: { type: 'string', description: 'Job id.' }, name: { type: 'string', description: 'Which reference, as listed by get_job.' } },
      required: ['name']
    },
    annotations: { title: 'Get reference', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'submit',
    description: 'Manhwa Studio: submits the work for one stage of a job (notes, draft, review, check, and so on). Returns JSON with status "accepted" or "rejected", the problems found, and what the job needs next.',
    inputSchema: {
      type: 'object',
      properties: {
        job: { type: 'string', description: 'Job id.' },
        stage: { type: 'string', description: 'The stage named by get_job.' },
        content: { description: 'The stage\'s work: text or a JSON object.' }
      },
      required: ['job', 'stage', 'content']
    },
    // readOnlyHint: true at the user's explicit request (2026-11-12). The Gemini app asks "Allow Gemini to run submit?"
    // before every call of a tool that isn't read-only, has no "always allow", and a scheduled (Master) chat has
    // nobody to click Allow. submit does lead to saved scripts: Studio checks every submission and saves through
    // Narration's Replace (backup) only for chapters the user queued.
    annotations: { title: 'Submit', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }
]

let client = null
async function relay(tool, args) {
  if (!bridgeOk) return { status: 'error', reason: 'The Manhwa Studio connector is not set up. Install it again from Studio → Settings → Gemini MCP.' }
  try {
    const response = await fetch(`${BRIDGE}/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ tool, arguments: args ?? {}, client, connectorVersion: CONNECTOR_VERSION }),
      signal: AbortSignal.timeout(120_000)
    })
    const json = await response.json().catch(() => null)
    if (!response.ok || !json || typeof json.data !== 'object') return { status: 'error', reason: json?.error ?? `Manhwa Studio answered HTTP ${response.status}.` }
    return json.data
  } catch {
    return { status: 'error', reason: 'Manhwa Studio is not reachable. Is the Studio running on this Mac?' }
  }
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  const { id, method, params } = message
  if (method === 'initialize') {
    client = typeof params?.clientInfo?.name === 'string' ? params.clientInfo.name.slice(0, 80) : null
    return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'manhwa-studio', version: `${CONNECTOR_VERSION}.0.0` } } })
  }
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
  if (method === 'tools/call') {
    const name = params?.name
    if (!TOOLS.some(t => t.name === name)) return send({ jsonrpc: '2.0', id, result: dataResult({ status: 'error', reason: `Unknown tool ${name}.` }) })
    return send({ jsonrpc: '2.0', id, result: dataResult(await relay(name, params?.arguments)) })
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, result: {} })
})
