// Studio AntiGravity compatibility probe: a minimal stdio MCP server
// (newline-delimited JSON-RPC, no dependencies). Antigravity launches it from
// the probe workspace's .agents/mcp_config.json. It serves one synthetic image
// and records what the model submits, plus the conversation IDs Antigravity
// passes in tools/call _meta. Diagnostics go to the log file, never stdout.
// Usage: node probe-mcp.mjs <image.png> <events.jsonl>
import fs from 'node:fs'
import readline from 'node:readline'

const [imagePath, logPath] = process.argv.slice(2)
const record = event => fs.appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n')
const send = message => process.stdout.write(JSON.stringify(message) + '\n')
const meta = params => {
  const m = params?._meta ?? {}
  return { conversationId: m['antigravity.google/conversation_id'] ?? null, rootConversationId: m['antigravity.google/root_conversation_id'] ?? null }
}

const TOOLS = [
  {
    name: 'fetch_slice',
    description: 'Return the image of slice s1 of the assigned test page. Inspect the image itself.',
    inputSchema: { type: 'object', properties: { sliceId: { type: 'string' } }, required: ['sliceId'], additionalProperties: false }
  },
  {
    name: 'submit_analysis',
    description: 'Submit what the slice image shows.',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string' }, shape: { type: 'string', enum: ['circle', 'triangle', 'square'] }, color: { type: 'string', enum: ['red', 'blue', 'green'] } },
      required: ['code', 'shape', 'color'],
      additionalProperties: false
    }
  }
]

readline.createInterface({ input: process.stdin }).on('line', line => {
  let message
  try { message = JSON.parse(line) } catch { return }
  const { id, method, params } = message
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'studio-probe', version: '1.0.0' } } })
  }
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
  if (method === 'tools/call') {
    const { name, arguments: args } = params ?? {}
    if (name === 'fetch_slice') {
      const bytes = fs.readFileSync(imagePath)
      record({ type: 'fetch_slice', sliceId: args?.sliceId ?? null, bytes: bytes.length, ...meta(params) })
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Slice s1 of the test page.' }, { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' }] } })
    }
    if (name === 'submit_analysis') {
      record({ type: 'submit_analysis', submitted: args ?? null, ...meta(params) })
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Analysis checkpoint accepted.' }] } })
    }
    return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool ${name}` } })
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, result: {} })
})
