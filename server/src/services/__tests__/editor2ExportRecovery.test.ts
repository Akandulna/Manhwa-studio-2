import { expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ finish: [] as (() => void)[] }))
vi.mock('../../index.js', () => ({ prisma: {
  series: { findUnique: async () => ({ title: 'Test', rootFolder: 'test' }) },
  chapter: { findMany: async () => [{ id: 'chapter', number: 1, title: null, folderPath: 'test' }] }
} }))
vi.mock('../videoRender.js', () => ({
  getVideoCapabilities: () => ({}), RESOLUTIONS: { '1920x1080': { width: 1920, height: 1080 } }
}))
vi.mock('../videoMath.js', () => ({ ensureFfmpegAvailable: () => {} }))
vi.mock('../seriesProcess.js', () => ({ notifySeriesProcessChanged: () => {} }))
vi.mock('../editor2Timeline.js', () => ({
  processTimelineJson: () => new Promise((_, reject) => {
    state.finish.push(() => reject(new Error('Synthetic render failure')))
  })
}))
import { getActiveExport2Job, getExport2Job, startBatchExport } from '../editor2Export.js'

it('recovers the same live progress across views, scoped to series and language, and forgets ended jobs', async () => {
  const start = (series: string, language: 'en' | 'hi') => startBatchExport(
    series, [{ chapterId: 'chapter', json: '{}' }],
    { resolution: '1920x1080', preset: 'medium', language, force: true }
  )
  expect(getActiveExport2Job('series', 'en')).toBeNull()
  const en = await start('series', 'en')
  const hi = await start('series', 'hi')
  const other = await start('other', 'en')
  const progress = getExport2Job(en)!
  progress.percent = 43
  progress.chapters[0].percent = 43
  expect(getActiveExport2Job('series', 'en')).toBe(progress)
  expect(getActiveExport2Job('series', 'en')?.percent).toBe(43)
  expect(getActiveExport2Job('series', 'hi')?.id).toBe(hi)
  expect(getActiveExport2Job('other', 'en')?.id).toBe(other)
  expect(getActiveExport2Job('missing', 'en')).toBeNull()
  for (const finish of state.finish) finish()
  await vi.waitFor(() => expect(getExport2Job(en)?.status).not.toBe('running'))
  expect(getActiveExport2Job('series', 'en')).toBeNull()
  expect(getActiveExport2Job('series', 'hi')).toBeNull()
  expect(getActiveExport2Job('other', 'en')).toBeNull()
})
