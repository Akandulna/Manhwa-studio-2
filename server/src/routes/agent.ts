/**
 * Studio Agent API: on/off + engine settings, the chat, approvals for risky actions, and the
 * agent's knowledge / memory files. Local-only like the other AI-engine routes.
 */

import { Router } from 'express'
import type { Server } from 'socket.io'
import type { PrismaClient } from '@prisma/client'
import { localOnlyGuard } from './googleDrive.js'
import { AgentService } from '../services/agent/agent.js'
import { AGENT_FILES, DEFAULT_KNOWLEDGE, type AgentFileKind } from '../services/agent/agentStore.js'

let instance: AgentService | null = null
export const agentService = () => instance

export function initAgentRoutes(prisma: PrismaClient, io?: Server): Router {
  const router = Router()
  router.use(localOnlyGuard())
  const service = new AgentService(prisma, () => `http://127.0.0.1:${process.env.PORT || 3001}/api`)
  instance = service
  // Script runs the agent started are watched; it posts in the chat by itself when one ends or hits a problem.
  service.onPosted = (chatId, text) => { io?.emit('agent:message', { chatId, text: text.slice(0, 300) }) }
  service.startWatching()
  const fail = (res: any, error: unknown, status = 400) => res.status(status).json({ error: error instanceof Error ? error.message : String(error) })
  const kind = (value: string): AgentFileKind => {
    if (!(AGENT_FILES as readonly string[]).includes(value)) throw new Error('Unknown agent file.')
    return value as AgentFileKind
  }

  router.get('/status', async (req, res) => {
    try { res.json(await service.status(req.query.fresh === '1')) } catch (e) { fail(res, e, 500) }
  })
  router.put('/settings', async (req, res) => {
    try { res.json(await service.store.saveSettings(req.body)) } catch (e) { fail(res, e) }
  })

  router.get('/chats', async (_req, res) => {
    try { res.json({ chats: await service.store.listChats(), busy: service.isBusy(), busyChatId: service.busyChatId() }) } catch (e) { fail(res, e, 500) }
  })
  router.post('/chats', async (_req, res) => {
    try { res.status(201).json(await service.store.newChat()) } catch (e) { fail(res, e, 500) }
  })
  router.get('/chats/:id', async (req, res) => {
    try {
      const chat = await service.store.getChat(req.params.id)
      if (!chat) return fail(res, new Error('That chat no longer exists.'), 404)
      res.json({ chat, busy: service.busyChatId() === chat.id })
    } catch (e) { fail(res, e, 500) }
  })
  router.post('/chats/:id/messages', async (req, res) => {
    try { res.status(202).json({ messages: await service.send(req.params.id, req.body?.text), busy: true }) } catch (e) { fail(res, e, 409) }
  })
  router.patch('/chats/:id', async (req, res) => {
    try { await service.store.renameChat(req.params.id, req.body?.title); res.json({ renamed: true }) } catch (e) { fail(res, e) }
  })
  router.delete('/chats/:id', async (req, res) => {
    try {
      if (service.busyChatId() === req.params.id) throw new Error('Stop the agent first.')
      await service.store.deleteChat(req.params.id); res.json({ deleted: true })
    } catch (e) { fail(res, e, 409) }
  })
  router.post('/stop', (_req, res) => { service.stop(); res.json({ stopping: service.isBusy() }) })
  router.post('/actions/:id/:decision', async (req, res) => {
    try {
      if (!['approve', 'reject'].includes(req.params.decision)) throw new Error('Choose approve or reject.')
      res.json({ messages: await service.decide(req.params.id, req.params.decision === 'approve') })
    } catch (e) { fail(res, e, 409) }
  })

  router.get('/files/:kind', async (req, res) => {
    try { res.json(await service.store.read(kind(req.params.kind))) } catch (e) { fail(res, e) }
  })
  router.put('/files/:kind', async (req, res) => {
    try { const k = kind(req.params.kind); await service.store.write(k, req.body?.text); res.json(await service.store.read(k)) } catch (e) { fail(res, e) }
  })
  router.post('/files/:kind/reset', async (req, res) => {
    try {
      const k = kind(req.params.kind)
      await service.store.write(k, k === 'knowledge' ? DEFAULT_KNOWLEDGE : '# Agent memory\n\n(Nothing saved yet. The agent adds short notes here when you ask it to remember something.)\n')
      res.json(await service.store.read(k))
    } catch (e) { fail(res, e) }
  })

  return router
}
