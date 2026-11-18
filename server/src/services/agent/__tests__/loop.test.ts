import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const replies: string[] = []
vi.mock('../agentEngine.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../agentEngine.js')>()),
  engineStatuses: async () => [{ id: 'codex', label: 'codex', available: true, detail: '', models: [] }],
  runAgentTurn: async () => replies.shift() ?? 'done'
}))
vi.mock('../../antigravity/codexCli.js', async importOriginal => ({ ...(await importOriginal<typeof import('../../antigravity/codexCli.js')>()), detectCodex: async () => ({ path: '/bin/codex' }) }))

const { AgentService } = await import('../agent.js')
const { AgentStore } = await import('../agentStore.js')
const { TOOLS } = await import('../agentTools.js')

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-loop-'))
  const prisma: any = { setting: { findUnique: async () => ({ value: JSON.stringify({ enabled: true, engine: 'codex' }) }) } }
  const store = new AgentStore(prisma, dir)
  const service = new AgentService(prisma, () => 'http://x/api', store)
  const chat = await store.newChat()
  const ask = async (text: string) => {
    await service.send(chat.id, text)
    for (let i = 0; i < 100 && service.isBusy(); i++) await new Promise(r => setTimeout(r, 20))
    return store.chat(chat.id)
  }
  return { service, store, chat, ask, dir }
}

describe('agent loop with script tools', () => {
  beforeEach(() => { replies.length = 0 })

  it('parks an action that needs approval instead of running it, then runs it on Approve', async () => {
    const run = vi.fn(async () => ({ saved: true }))
    const tool = TOOLS.find(t => t.name === 'scripts_clear')!
    const saved = { prepare: tool.prepare, run: tool.run }
    tool.prepare = async a => ({ ...a, title: 'Show', numbers: [1, 2] })
    tool.run = run
    try {
      const { ask, service, dir } = await setup()
      replies.push('<action>{"tool":"scripts_clear","args":{"series":"Show","chapters":[1,2]}}</action>', 'Waiting for your approval.')
      const messages = await ask('clear chapters 1 and 2 of Show')
      const reply = messages.at(-1)!
      expect(run).not.toHaveBeenCalled()
      expect(reply.actions).toHaveLength(1)
      expect(reply.actions![0].status).toBe('pending')
      expect(reply.actions![0].summary).toMatch(/Clear the English and Hinglish scripts, voiceovers, alignment and Editor timelines of "Show" chapter 1-2/)
      await service.decide(reply.actions![0].id, true)
      expect(run).toHaveBeenCalledTimes(1)
      await fs.rm(dir, { recursive: true, force: true })
    } finally { Object.assign(tool, saved) }
  })

  it('hands a prepare error back to the agent, never to the approval card', async () => {
    const { ask, dir } = await setup()
    replies.push('<action>{"tool":"script_replace","args":{"series":"Show","chapter":1,"source":"last_message"}}</action>', 'Please paste the script.')
    const messages = await ask('replace chapter 1')
    const reply = messages.at(-1)!
    expect(reply.actions ?? []).toHaveLength(0)
    expect(reply.steps!.join('\n')).toMatch(/✗ script_replace/)
    expect(reply.text).toBe('Please paste the script.')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('lets the agent post to a chat by itself', async () => {
    const { service, store, chat, dir } = await setup()
    const seen: string[] = []
    service.onPosted = (_id, text) => { seen.push(text) }
    await (service as any).postToChat(chat.id, '✓ The script run finished')
    expect((await store.chat(chat.id)).at(-1)).toMatchObject({ role: 'agent', text: '✓ The script run finished' })
    expect(seen).toEqual(['✓ The script run finished'])
    expect(await (service as any).postToChat('gone', 'x')).toBe(false)
    await fs.rm(dir, { recursive: true, force: true })
  })
})
