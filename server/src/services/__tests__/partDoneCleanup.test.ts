import { describe, expect, it, vi } from 'vitest'

const chapter = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `c${n}`, folderPath: `Summon/Chapter ${String(n).padStart(3, '0')}`, number: n, completedAt: null,
  phoneSend: { key: `manhwa/Summon/Chapter ${String(n).padStart(3, '0')}.zip`, bytes: 100 }, ...extra
})
vi.mock('../../index.js', () => ({ prisma: { series: { findMany: async () => [
  { id: 's1', rootFolder: 'Summon', chapters: [chapter(1), chapter(20), chapter(21), chapter(22, { phoneSend: { key: null, bytes: 5 } }), chapter(41, { completedAt: new Date() })] },
  { id: 's2', rootFolder: 'Restarting', chapters: [chapter(1)] }
] } } }))
vi.mock('../libraryControls.js', () => ({ libraryControls: async () => [
  { folder: 'Summon', parts: { '1': { at: 100, deviceId: 'mac', done: true } } },
  { folder: 'Restarting', parts: { '1': { at: 100, deviceId: 'mac', done: true } } }
] }))
vi.mock('../seriesRestartGuard.js', () => ({ seriesRestartPending: async (folder: string) => folder === 'Restarting' }))
vi.mock('../r2Service.js', () => ({ getR2Config: () => ({ bucket: 'b', prefix: 'Manhwa/' }), createClient: vi.fn(), invalidateStorage: vi.fn() }))

import { cleanupDonePartPages } from '../partDoneCleanup.js'

describe('cleanupDonePartPages', () => {
  it('picks only done chapters that still have a zip, skipping series mid-restart', async () => {
    const plan = await cleanupDonePartPages({ dryRun: true })
    expect(plan.cleared.map(t => t.chapter)).toEqual(['Chapter 001', 'Chapter 020', 'Chapter 041'])
    expect(plan.freedBytes).toBe(300)
  })
})
