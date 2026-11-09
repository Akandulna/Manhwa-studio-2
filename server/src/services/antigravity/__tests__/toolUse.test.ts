import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { describeToolUse, summarizeToolUse } from '../toolUse.js'

const home = '/Users/x/.gemini/antigravity-cli'
const conv = 'c18f7e81-6387-4d5c-ae74-a5666bcc1269'
const step = (...calls: unknown[]) => JSON.stringify({ type: 'PLANNER_RESPONSE', tool_calls: calls })

describe('effective tool set per attempt (live transcript shapes, agy 1.5.2)', () => {
  it('counts Studio tools in both naming styles and accepts the CLI reading its own files', () => {
    const lines = [
      step({ name: 'call_mcp_tool', args: { ServerName: '"studio"', ToolName: '"get_job_context"', Arguments: '{}' } }),
      step({ name: 'mcp_studio_fetch_slice', args: { slice_id: '"s01"' } }, { name: 'call_mcp_tool', args: { ServerName: '"studio"', ToolName: '"fetch_slice"' } }),
      step({ name: 'read_file', args: { Path: `"${path.join(home, 'brain', conv, '.system_generated/steps/4/media_0.webp')}"` } }),
      step({ name: 'read_file', args: { Path: `"${path.join(home, 'mcp/studio/fetch_slice.json')}"` } }),
      'not json',
      JSON.stringify({ type: 'USER_INPUT' })
    ]
    const use = summarizeToolUse(lines, { conversationId: conv, cliHome: home })
    expect(use).toEqual({ studio: { get_job_context: 1, fetch_slice: 2 }, cliReads: 2, unexpected: [] })
    expect(describeToolUse(use)).toBe('tools used — studio: get_job_context×1, fetch_slice×2; CLI\'s own files read ×2; nothing unexpected')
  })

  it('flags commands, other MCP servers and reads outside the CLI\'s own files', () => {
    const lines = [
      step({ name: 'run_command', args: { CommandLine: '"python3 -c ..."' } }),
      step({ name: 'call_mcp_tool', args: { ServerName: '"gdrive"', ToolName: '"search"' } }),
      step({ name: 'read_file', args: { Path: `"${path.join(home, 'brain', 'other-conversation', 'x.webp')}"` } }),
      step({ name: 'read_file', args: { Path: '"/etc/hosts"' } })
    ]
    const use = summarizeToolUse(lines, { conversationId: conv, cliHome: home })
    expect(use.unexpected).toEqual(['run_command', 'call_mcp_tool (gdrive:search)', `read_file ${path.join(home, 'brain', 'other-conversation', 'x.webp')}`, 'read_file /etc/hosts'])
    expect(describeToolUse(use)).toMatch(/UNEXPECTED: run_command/)
  })
})
