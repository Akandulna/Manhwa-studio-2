import { describe, expect, it, vi } from 'vitest'
import { buildProcessSeries, emptyStages, type ProcessChapter, type ProcessStage } from '../seriesProcessModel.js'

const state = vi.hoisted(() => ({
  stages: {} as Record<string, { state: string }>, secondStages: null as Record<string, { state: string }> | null,
  failDevice: '', holdClipping: false, commands: [] as any[], scripts: [] as any[], audio: [] as any[], attached: false, selectedProfile: false, events: [] as any[], saves: [] as any[]
}))
vi.mock('../../index.js', () => ({ prisma: {
  setting: { findMany: async () => [], upsert: async (args: any) => { state.saves.push(JSON.parse(args.update.value)) } },
  chapter: { findMany: async () => [1, ...(state.secondStages ? [2] : [])].map(n => ({ id: `c${n}`, seriesId: 's1', number: n, folderPath: `Demo/Chapter ${n}`, series: { title: 'Demo', rootFolder: 'Demo' } })) },
  chapterScript: { findMany: async ({ where }: any) => state.scripts.filter(s => s.language === where.language) },
  audioSection: { findMany: async ({ where }: any) => state.audio.filter(s => s.language === where.language) }
} }))
vi.mock('fs/promises', async original => ({ default: { ...(await original<any>()).default, stat: async () => ({ size: 100 }) } }))
vi.mock('../seriesProcess.js', () => ({
  getSeriesProcess: async () => ({ series: [buildProcessSeries({ id: 's1', title: 'Demo', rootFolder: 'Demo' }, [1, ...(state.secondStages ? [2] : [])].map(n => ({ id: `c${n}`, number: n, name: `Chapter ${n}`, stages: n === 1 ? state.stages : state.secondStages! } as ProcessChapter)))] }),
  notifySeriesProcessChanged: vi.fn()
}))
vi.mock('../r2Service.js', () => ({
  getR2Config: () => ({}),
  getPhoneOverview: async () => ({ phones: ['phone-a', ...(state.secondStages ? ['phone-b'] : [])].map(id => ({ id, name: id, connected: true, automation: { remoteStart: true, runs: ['narration', 'voiceover', 'clipper'], chapterRuns: ['narration', 'voiceover', 'clipper'], clipper: {} } })), profiles: ['phone-a', ...(state.secondStages ? ['phone-b'] : [])].map(device => ({ device, profileId: 'profile-2', selected: state.selectedProfile })), working: [], runs: [] }),
  sendAutomationCommand: async (command: string, options: any) => {
    state.commands.push({ command, ...options })
    if (command === 'start') {
      if (options.kind === 'clipper' && options.device === state.failDevice) throw new Error('phone-b failed to start')
      for (const name of options.chapters ?? []) {
        const stages = name === 'Chapter 1' ? state.stages : state.secondStages!
        if (options.kind === 'narration') for (const l of ['en', 'hi']) stages[`script_${l}`] = { state: 'done' }
        if (options.kind === 'voiceover') stages[`voice_${options.language}`] = { state: 'done' }
        if (options.kind === 'clipper' && !state.holdClipping) stages.crop_json = { state: 'done' }
      }
    }
    return { phones: 1 }
  }
}))
vi.mock('../phoneRelay.js', () => ({
  relayStatus: () => ({ configured: true, connected: true }),
  relayReceipts: (kind: string) => ['phone-a', 'phone-b'].map(device => {
    const chapters = Object.fromEntries(['Chapter 1', 'Chapter 2'].map(c => [c, kind === 'sync' ? { state: 'downloaded' } : { status: 'done', savedAt: '2026-10-16T00:00:00Z' }]))
    return { device, body: { series: { Demo: { chapters, hi: { chapters } } } } }
  }),
  sendPhoneRequest: vi.fn()
}))
vi.mock('../phoneSend.js', () => ({ getSendJob: vi.fn(), getSeriesSendPlan: vi.fn(), startPhoneSend: vi.fn() }))
vi.mock('../phoneProfiles.js', () => ({ sendProfileCommand: vi.fn(async () => { state.selectedProfile = true; return { id: 'profile-request', reached: true } }) }))
vi.mock('../phoneScreen.js', () => ({ getPhoneScreens: () => [] }))
vi.mock('../phoneScriptImport.js', () => ({
  previewPhoneScripts: async (_id: string, language: string) => ({ zip: { etag: language }, chapters: [1, ...(state.secondStages ? [2] : [])].map(n => ({ chapterId: `c${n}`, published: false, sourceMatches: true })) }),
  importPhoneScripts: vi.fn(async (_id: string, _etag: string, ids: string[], language: string) => { for (const chapterId of ids) state.scripts.push({ chapterId, language, scriptPath: `/test/${chapterId}-${language}.md` }) })
}))
vi.mock('../phoneVoiceoverImport.js', () => ({
  fetchPhoneVoiceover: vi.fn(async (_id: string, ids: string[], _io: unknown, language: string) => { for (const chapterId of ids) state.audio.push({ id: `${language}-${chapterId === 'c1' ? 'section' : 'section2'}`, chapterId, language, audioFile: { status: 'done', filePath: `/test/${chapterId}-${language}.wav` } }); return { failed: [] } })
}))
vi.mock('../alignment/alignmentService.js', () => ({
  pendingAlignments: () => 0,
  alignSectionInBackground: vi.fn((id: string) => { const s = state.audio.find(s => s.id === id); s.timelineScript = 'aligned'; state.stages[`align_${s.language}`] = { state: 'done' } })
}))
vi.mock('../chapterManifest.js', () => ({ getChapterManifest: async () => ({ images: [{ filename: 'page_001.jpg', width: 800, height: 12000 }] }) }))
vi.mock('../phoneCropImport.js', () => ({ fetchPhoneCrops: vi.fn(async () => ({ failed: [] })) }))
vi.mock('../clipper3/processedSync.js', () => ({ syncChapterProcessed: vi.fn(async () => { state.attached = true; return { failed: 0 } }) }))
vi.mock('../clipper3/chapterCrop.js', () => ({
  seriesSlug: () => 'demo', readChapterCropState: async () => ({ fullyAttached: state.attached }), queueAutoCrop: vi.fn(async () => [])
}))

const { productionAutomation, startProductionAutomation, getProductionStatus } = await import('../productionAutomation.js')
const { importPhoneScripts } = await import('../phoneScriptImport.js')
const { fetchPhoneVoiceover } = await import('../phoneVoiceoverImport.js')
const { fetchPhoneCrops } = await import('../phoneCropImport.js')
const { sendProfileCommand } = await import('../phoneProfiles.js')
const { alignSectionInBackground } = await import('../alignment/alignmentService.js')

describe('production service handoffs', () => {
  it('runs scripts, fetches both voiceovers through the Mac aligner’s import path, then clips on the chosen device and stops for review', async () => {
    state.stages = emptyStages()
    for (const key of ['download', 'cleanup', 'stitch'] as ProcessStage[]) state.stages[key] = { state: 'done' }
    startProductionAutomation({ emit: (_event: string, job: any) => state.events.push(structuredClone(job)) } as never)
    const config = { device: 'phone-a', profileId: 'profile-2', clipper: { ai: 'aistudio' as const, flow: 'steps' as const, tabs: 3, chatGpt: { mode: null, model: null, effort: null } } }
    await productionAutomation.start('s1', config)
    await vi.waitFor(() => expect(state.events.at(-1)?.status).toBe('review'))
    expect(state.commands.map(c => [c.kind, c.language])).toEqual([['narration', undefined], ['voiceover', 'en'], ['voiceover', 'hi'], ['clipper', undefined]])
    expect(state.commands.every(c => c.device === 'phone-a' && c.seriesId === 's1' && c.command === 'start')).toBe(true)
    expect(state.commands.every(c => JSON.stringify(c.chapters) === '["Chapter 1"]')).toBe(true)
    expect(state.commands.at(-1)).toMatchObject({ ai: 'aistudio', flow: 'steps', tabs: 3 })
    expect(sendProfileCommand).toHaveBeenCalledOnce()
    expect(sendProfileCommand).toHaveBeenCalledWith('select', 'phone-a', 'profile-2')
    expect(vi.mocked(alignSectionInBackground).mock.calls.map(c => c[0])).toEqual(['en-section', 'hi-section'])
    expect(vi.mocked(importPhoneScripts).mock.calls.map(c => c[3])).toEqual(['en', 'hi'])
    expect(vi.mocked(fetchPhoneVoiceover).mock.calls.map(c => c[3])).toEqual(['en', 'hi'])
    expect(fetchPhoneCrops).toHaveBeenCalledOnce()
    expect(state.saves.some(j => j.command?.kind === 'narration')).toBe(true)
    expect(state.events.at(-1)?.step).toBe('review')
    expect(state.commands.some(c => c.kind === 'editor')).toBe(false)
  })
  it('offers fetching when phone-complete crop JSON is not attached locally, without starting any phone run', async () => {
    state.attached = false
    const before = state.commands.length
    expect((await getProductionStatus('s1')).nextStep).toBe('clipping')
    state.attached = true
    expect((await getProductionStatus('s1')).nextStep).toBe('review')
    expect(state.commands).toHaveLength(before)
  })
  const parallelConfig = { device: 'phone-a', profileId: 'profile-2', parallelDevices: [{ device: 'phone-b', profileId: 'profile-2' }], clipper: { ai: 'aistudio' as const, flow: 'steps' as const, tabs: 3, chatGpt: { mode: null, model: null, effort: null } } }
  function resetParallel() {
    state.stages = emptyStages(); state.secondStages = emptyStages()
    for (const stages of [state.stages, state.secondStages]) for (const key of ['download', 'cleanup', 'stitch']) stages[key] = { state: 'done' }
    state.commands = []; state.events = []; state.scripts = []; state.audio = []; state.attached = false; state.selectedProfile = true
    state.failDevice = ''; state.holdClipping = false
  }
  it('runs both phones with disjoint chapters, while scripts stay on the primary', async () => {
    resetParallel()
    await productionAutomation.start('s1', parallelConfig)
    await vi.waitFor(() => expect(state.events.at(-1)?.status).toBe('review'))
    expect(state.commands.filter(c => c.kind === 'narration')).toMatchObject([{ device: 'phone-a', chapters: ['Chapter 1', 'Chapter 2'] }])
    for (const kind of ['voiceover', 'clipper']) {
      const commands = state.commands.filter(c => c.kind === kind)
      expect(commands.some(c => c.device === 'phone-a' && c.chapters.join() === 'Chapter 1')).toBe(true)
      expect(commands.some(c => c.device === 'phone-b' && c.chapters.join() === 'Chapter 2')).toBe(true)
      expect(commands.every(c => c.chapters.length === 1)).toBe(true)
    }
  })
  it('stops all dispatched phones when one parallel start fails', async () => {
    resetParallel(); state.failDevice = 'phone-b'
    await productionAutomation.start('s1', parallelConfig)
    await vi.waitFor(() => expect(state.events.at(-1)?.status).toBe('failed'))
    expect(state.events.at(-1)?.message).toContain('phone-b failed to start')
    expect(state.commands.filter(c => c.command === 'stop').map(c => c.device).sort()).toEqual(['phone-a', 'phone-b'])
  })
  it('cancels both phone runs without starting another stage', async () => {
    resetParallel(); state.holdClipping = true
    await productionAutomation.start('s1', parallelConfig)
    await vi.waitFor(() => expect(state.commands.filter(c => c.kind === 'clipper')).toHaveLength(2))
    await productionAutomation.cancel('s1')
    await vi.waitFor(() => expect(state.commands.filter(c => c.command === 'stop').length).toBeGreaterThanOrEqual(2))
    expect(new Set(state.commands.filter(c => c.command === 'stop').map(c => c.device))).toEqual(new Set(['phone-a', 'phone-b']))
    expect((await productionAutomation.get('s1')).job?.status).toBe('cancelled')
  })
})
