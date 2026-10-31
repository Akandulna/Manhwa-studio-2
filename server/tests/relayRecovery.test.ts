import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ManagerStore } from '../src/services/managerStore.js'
import { sendManagerReport } from '../src/services/managerReportDelivery.js'
import { RelayDeliveryPause, relayRetryDeadline } from '../src/services/relayDeliveryPause.js'
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
const at = Date.parse('2026-10-19T00:00:00Z')

describe('forced relay rate-limit recovery', () => {
  it('retains exact events through HTTP 429, disk restart and pause expiry, then drains once', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'relay-recovery-'))
    let db = new DatabaseSync(path.join(dir, 'journal.sqlite'))
    db.exec('CREATE TABLE state (key TEXT PRIMARY KEY, body TEXT NOT NULL)')
    const load = (key: string) => (db.prepare('SELECT body FROM state WHERE key = ?').get(key) as { body: string } | undefined)?.body ?? null
    const save = (key: string, value: string) => { db.prepare('INSERT INTO state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body').run(key, value) }
    let now = at, requests = 0
    const accepted = new Map<string, unknown>(), received: string[] = []
    const http = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const raw = Buffer.concat(chunks).toString(); received.push(raw); requests++
      if (now < at + 600_000) { res.writeHead(429, { 'Retry-After': '600' }); res.end('{}'); return }
      const report = JSON.parse(raw)
      accepted.set(report.eventId, report)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ report: { ...report, receivedAt: new Date(now).toISOString() } }))
    })
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
    const address = http.address() as { port: number }, url = `http://127.0.0.1:${address.port}`
    const restore = () => ({
      store: new ManagerStore({ load: async () => { const raw = load('journal'); return raw ? JSON.parse(raw) : null }, save: async state => save('journal', JSON.stringify(state)) }, undefined, () => new Date(now).toISOString()),
      pause: new RelayDeliveryPause({ load: async () => load('pause'), save: async value => save('pause', value) }, () => now)
    })
    try {
      let client = restore()
      await client.store.observe('clipping', [], new Date(now).toISOString())
      const original = (await client.store.snapshot()).outbox
      const drain = () => client.store.drain(report => sendManagerReport(url, 'isolated-fixture-token', report, client.pause))
      await drain()
      expect(requests).toBe(1)
      expect((await client.store.snapshot()).outbox).toEqual(original)
      expect(load('pause')).toBe(String(at + 600_000))
      db.close(); db = new DatabaseSync(path.join(dir, 'journal.sqlite'))
      client = restore(); now += 599_999
      for (let i = 0; i < 10; i++) await drain()
      expect(requests).toBe(1)
      expect((await client.store.snapshot()).outbox).toEqual(original)
      now++
      await drain(); await drain()
      expect(requests).toBe(2)
      expect(received[1]).toBe(received[0])
      expect(accepted.size).toBe(1)
      expect((await client.store.snapshot()).outbox).toEqual([])
      expect((await client.store.snapshot()).lastDeliveryError).toBeNull()
    } finally {
      http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()))
      db.close(); await rm(dir, { recursive: true, force: true })
    }
  })
  it('honors HTTP dates and delays beyond a day; malformed values use the conservative fallback', () => {
    expect(relayRetryDeadline('Mon, 19 Oct 2026 01:00:00 GMT', at)).toBe(at + 3600_000)
    expect(relayRetryDeadline('172800', at)).toBe(at + 172800_000)
    expect(relayRetryDeadline('1', at)).toBe(at + 300_000)
    for (const value of [null, '', '-1', '1.5', 'bad', '999999999999999999999999']) expect(relayRetryDeadline(value, at)).toBe(at + 900_000)
  })
  it('serializes concurrent rejection persistence and never shortens a pause after restart', async () => {
    let saved: string | null = null, release!: () => void, writes = 0
    const persistence = { load: async () => saved, save: async (value: string) => { if (++writes === 1) await new Promise<void>(resolve => { release = resolve }); saved = value } }
    const pause = new RelayDeliveryPause(persistence, () => at)
    const a = pause.record('3600')
    while (!release) await new Promise(resolve => setTimeout(resolve, 0))
    const b = pause.record('300')
    release(); await Promise.all([a, b])
    expect(saved).toBe(String(at + 3600_000))
    await expect(new RelayDeliveryPause(persistence, () => at + 3599_999).beforeSend()).rejects.toThrow('paused')
  })
  it('fails closed on corrupt pause state and failed persistence', async () => {
    const corrupt = new RelayDeliveryPause({ load: async () => 'NaN', save: async () => {} }, () => at)
    await expect(corrupt.beforeSend()).rejects.toThrow('Invalid persisted')
    const failed = new RelayDeliveryPause({ load: async () => null, save: async () => { throw new Error('disk full') } }, () => at)
    await expect(failed.record('600')).rejects.toThrow('disk full')
    await expect(failed.beforeSend()).rejects.toThrow('disk full')
  })
})
