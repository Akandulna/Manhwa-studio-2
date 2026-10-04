import { afterAll, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import type { AddressInfo } from 'net'

// R2 must not be touched while the relay is set up.
const send = vi.fn(async () => { throw new Error('R2 should not be called') })
vi.mock('@aws-sdk/client-s3', async importOriginal => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>()
  return { ...actual, S3Client: class { send = send } }
})
vi.mock('../r2Usage.js', () => ({ FREE_PLAN: {}, attachUsageCounter: () => {}, getMonthUsage: () => ({}), monthKey: () => '' }))
vi.mock('../../index.js', () => ({
  prisma: {
    series: {
      findMany: async () => [{ id: 's1', rootFolder: '/lib/Solo Hero' }],
      findUnique: async ({ where }: { where: { id: string } }) => (where.id === 's1' ? { rootFolder: '/lib/Solo Hero' } : null)
    },
    chapter: { findMany: async () => [{ id: 'c1', folderPath: 'Solo Hero/Chapter 001' }] }
  }
}))
vi.mock('../../utils/envFile.js', () => ({ writeEnvVars: async () => {} }))

// A stand-in for the relay Worker: checks the token, sends hello + a stored receipt, records what it's sent.
const received: string[] = []
let desktop: WebSocket | null = null
const relay = new WebSocketServer({ port: 0 })
relay.on('connection', (ws, req) => {
  expect(req.headers.authorization).toBe('Bearer t0ken')
  expect(req.url).toBe('/ws?role=desktop')
  desktop = ws
  ws.on('message', data => received.push(data.toString()))
  ws.send(JSON.stringify({ type: 'hello', phones: 1, request: null }))
  ws.send(JSON.stringify({ type: 'receipt', kind: 'scripts', at: 1, body: { device: 'Pixel', answers: 'a1', series: { 'Solo Hero': {
    total: 3, done: 1, chapters: { 'Chapter 001': { status: 'done' } },
    hi: { total: 3, done: 1, uploadedAt: '2026-10-04T10:00:00Z', chapters: { 'Chapter 001': { status: 'review', savedAt: '2026-10-04T09:00:00Z' }, 'Chapter 404': { status: 'done' } } }
  } } } }))
})
await new Promise(resolve => relay.once('listening', resolve))

Object.assign(process.env, {
  R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET: 'b',
  RELAY_URL: `http://localhost:${(relay.address() as AddressInfo).port}/`, RELAY_TOKEN: 't0ken'
})
const { startPhoneRelay, relayStatus } = await import('../phoneRelay.js')
const { getPhoneScripts, getPhoneCrops, getPhoneOverview, requestPhoneUpdate, sendClipperCommand } = await import('../r2Service.js')

const emitted: { event: string; payload: unknown }[] = []
startPhoneRelay({ emit: (event: string, payload: unknown) => emitted.push({ event, payload }) } as never)

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise(r => setTimeout(r, 20))
  expect(check()).toBe(true)
}

afterAll(() => relay.close())

describe('phone relay', () => {
  it('serves receipts the relay pushed, without R2', async () => {
    await until(() => emitted.some(e => e.event === 'phone:receipt'))
    expect(relayStatus()).toMatchObject({ configured: true, connected: true, phones: 1 })

    const scripts = await getPhoneScripts('s1', true)
    expect(scripts).toMatchObject({ configured: true, device: 'Pixel', answers: 'a1', series: { s1: { done: 1, total: 3 } } })
    expect(scripts.chapters).toEqual({ c1: { status: 'done', savedAt: null } })
    // The optional Hinglish block, matched to chapters the same way.
    expect(scripts.hi).toEqual({
      series: { s1: { done: 1, total: 3, uploadedAt: '2026-10-04T10:00:00Z' } },
      chapters: { c1: { status: 'review', savedAt: '2026-10-04T09:00:00Z' } }
    })
    // Nothing from the phone yet for crops: empty, still not R2.
    expect((await getPhoneCrops('s1', undefined, true)).series).toEqual({})
    expect(send).not.toHaveBeenCalled()
  })

  it('pushes a new receipt to the browser and answers from it', async () => {
    emitted.length = 0
    desktop!.send(JSON.stringify({ type: 'receipt', kind: 'crops', at: 2, body: { answers: 'a2', series: { 'Solo Hero': { total: 9, done: 4, chapters: {} } } } }))
    await until(() => emitted.some(e => e.event === 'phone:receipt'))
    expect(emitted.find(e => e.event === 'phone:receipt')!.payload).toEqual({ kind: 'crops' })
    expect((await getPhoneCrops('s1')).series).toEqual({ s1: { done: 4, total: 9 } })
  })

  it('sends "Refresh from phone" over the socket', async () => {
    const request = await requestPhoneUpdate()
    expect(request).toMatchObject({ via: 'relay', phones: 1 })
    await until(() => received.some(m => m.includes(request.id)))
    expect(JSON.parse(received.find(m => m.includes(request.id))!)).toEqual({ type: 'request', id: request.id, requestedAt: request.requestedAt })
    expect(send).not.toHaveBeenCalled()
  })

  it('starts Image Clipper on the phone with the series folder and tabs, and stops it', async () => {
    const start = await sendClipperCommand('start', { seriesId: 's1', tabs: 3 })
    expect(start).toMatchObject({ via: 'relay', phones: 1 })
    await until(() => received.some(m => m.includes(start.id)))
    expect(JSON.parse(received.find(m => m.includes(start.id))!)).toEqual({
      type: 'request', id: start.id, requestedAt: start.requestedAt, action: 'clipper_start', series: 'Solo Hero', tabs: 3
    })

    const stop = await sendClipperCommand('stop')
    await until(() => received.some(m => m.includes(stop.id)))
    expect(JSON.parse(received.find(m => m.includes(stop.id))!)).toEqual({
      type: 'request', id: stop.id, requestedAt: stop.requestedAt, action: 'clipper_stop'
    })

    await expect(sendClipperCommand('start', { seriesId: 'nope' })).rejects.toThrow('Series not found')
    await expect(sendClipperCommand('start', { tabs: 9 })).rejects.toThrow('tabs must be 1 to 4')
    expect(send).not.toHaveBeenCalled()
  })

  it('reads the phone\'s automation from the crops receipt', async () => {
    emitted.length = 0
    desktop!.send(JSON.stringify({
      type: 'receipt', kind: 'crops', at: 3, body: {
        series: {},
        automation: { wakeMode: 'dedicated', resumeAfterLimit: true, remoteStart: true, resume: { series: 'Solo Hero', tabs: 2, at: '2026-10-02T15:40:00.000Z' } }
      }
    }))
    await until(() => emitted.some(e => e.event === 'phone:receipt'))
    expect((await getPhoneOverview(null)).automation).toEqual({
      wakeMode: 'dedicated', resumeAfterLimit: true, remoteStart: true,
      resume: { seriesId: 's1', series: 'Solo Hero', tabs: 2, at: '2026-10-02T15:40:00.000Z' }
    })
  })

  it('tracks the phone coming and going', async () => {
    desktop!.send(JSON.stringify({ type: 'presence', phones: 0 }))
    await until(() => relayStatus().phones === 0)
  })
})
