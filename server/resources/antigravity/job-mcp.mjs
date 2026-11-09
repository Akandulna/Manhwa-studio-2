// Studio AntiGravity job MCP server (stdio, newline-delimited JSON-RPC, no dependencies).
// Antigravity launches it from the attempt workspace's .agents/mcp_config.json.
// It only relays: every tool call goes to Studio's loopback bridge with this
// attempt's capability token, and Studio enforces stage, allow-list, hashes and
// acceptance. stdout carries protocol only; nothing is logged.
// Env: STUDIO_BRIDGE_URL (http://127.0.0.1:<port>/api/antigravity/bridge), and either
// STUDIO_ATTEMPT_TOKEN (agy: written into the workspace MCP config) or
// STUDIO_ATTEMPT_TOKEN_FILE (Codex: MCP config travels on its command line, so
// only the path of a 0600 token file is passed there, never the token).
import fs from 'node:fs'
import readline from 'node:readline'

const BRIDGE = process.env.STUDIO_BRIDGE_URL ?? ''
const readTokenFile = file => { try { return fs.readFileSync(file, 'utf8').trim() } catch { return '' } }
const TOKEN = process.env.STUDIO_ATTEMPT_TOKEN ?? (process.env.STUDIO_ATTEMPT_TOKEN_FILE ? readTokenFile(process.env.STUDIO_ATTEMPT_TOKEN_FILE) : '')
const send = message => process.stdout.write(JSON.stringify(message) + '\n')
const bridgeOk = /^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(BRIDGE) && TOKEN.length >= 32

const call = async (path, body) => {
  const response = await fetch(`${BRIDGE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, 'X-Studio-Client': '1' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(170_000)
  })
  const json = await response.json().catch(() => null)
  if (!response.ok || !json) throw new Error(json?.error ?? `Studio bridge HTTP ${response.status}`)
  return json
}

let toolList = null
readline.createInterface({ input: process.stdin }).on('line', async line => {
  let message
  try { message = JSON.parse(line) } catch { return }
  const { id, method, params } = message
  try {
    if (method === 'initialize') {
      return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'studio-antigravity', version: '1.1.0' } } })
    }
    if (method === 'tools/list') {
      if (!bridgeOk) return send({ jsonrpc: '2.0', id, result: { tools: [] } })
      toolList ??= (await call('/tools', {})).tools
      return send({ jsonrpc: '2.0', id, result: { tools: toolList } })
    }
    if (method === 'tools/call') {
      if (!bridgeOk) return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'Studio bridge is not configured for this workspace.' }] } })
      const meta = params?._meta ?? {}
      // Codex sends no conversation id in _meta; Studio then relies on the per-attempt capability alone.
      const result = await call('/call', {
        tool: params?.name,
        arguments: params?.arguments ?? {},
        conversationId: meta['antigravity.google/conversation_id'] ?? null,
        rootConversationId: meta['antigravity.google/root_conversation_id'] ?? null
      })
      return send({ jsonrpc: '2.0', id, result })
    }
    if (id !== undefined) send({ jsonrpc: '2.0', id, result: {} })
  } catch (error) {
    if (id !== undefined) send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `Studio could not handle this call: ${error?.message ?? 'unknown error'}` }] } })
  }
})
