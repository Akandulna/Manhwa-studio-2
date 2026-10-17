import type { ProcessChapter, ProcessSeries, ProcessStage } from './seriesProcessModel.js'

export type ProductionStep = 'preparation' | 'scripts' | 'voiceover' | 'clipping' | 'review' | 'complete'
export const PRODUCTION_STEP_LABELS: Record<ProductionStep, string> = {
  preparation: '1. Preparation', scripts: '2. Script generation', voiceover: '3. Voiceover generation',
  clipping: '5. Image clipping', review: 'Manual review before Editor 2.0', complete: 'Series complete'
}
export interface ProductionDevice { device: string; profileId: string }
export interface ProductionConfig extends ProductionDevice {
  /** Additional phones for voiceovers and clipping; narration stays on the primary phone. */
  parallelDevices?: ProductionDevice[]
  clipper: { ai: 'chatgpt' | 'aistudio' | 'gemini'; flow: 'classic' | 'steps'; tabs: number; chatGpt: { mode: 'Chat' | 'Work' | null; model: string | null; effort: string | null } }
}
export interface ProductionJob {
  id: string
  seriesId: string
  config: ProductionConfig
  status: 'running' | 'review' | 'failed' | 'cancelled' | 'interrupted'
  step: ProductionStep
  message: string
  createdAt: string
  updatedAt: string
  /** Persisted before dispatch: never replay a possibly delivered command after a restart. */
  command?: { kind: 'narration' | 'voiceover' | 'clipper'; language?: 'en' | 'hi'; sentAt: string; devices?: string[] }
}
export const productionDevices = (config: ProductionConfig): ProductionDevice[] =>
  [{ device: config.device, profileId: config.profileId }, ...(config.parallelDevices ?? [])]

/** Disjoint chapter scopes in reading order. Scripts depend on the preceding chapter's summary. */
export function productionShares<T>(config: ProductionConfig, kind: 'narration' | 'voiceover' | 'clipper', chapters: T[]): { target: ProductionDevice; chapters: T[] }[] {
  const devices = kind === 'narration' ? productionDevices(config).slice(0, 1) : productionDevices(config)
  return devices.map((target, i) => ({ target, chapters: chapters.filter((_, n) => n % devices.length === i) })).filter(s => s.chapters.length)
}
export function productionChapters(series: ProcessSeries): ProcessChapter[] {
  return series.parts.filter(p => !p.complete).flatMap(p => p.chapters)
    .filter(c => c.stages.export_en.state !== 'done' || c.stages.export_hi.state !== 'done')
}
export const stagesDone = (chapters: ProcessChapter[], keys: ProcessStage[]): boolean =>
  chapters.length > 0 && chapters.every(c => keys.every(key => c.stages[key].state === 'done'))

/** Saved production work on old imports proves preparation already happened; never re-stitch it. */
export const chapterPrepared = (c: ProcessChapter): boolean =>
  stagesDone([c], ['download', 'cleanup', 'stitch']) ||
  ['script_en', 'script_hi', 'crop_json'].some(key => c.stages[key as ProcessStage].state === 'done')

/** Ordered prerequisites, using real chapters rather than the 20-chapter part denominator. */
export function nextProductionStep(series: ProcessSeries): ProductionStep {
  const chapters = productionChapters(series)
  if (!chapters.length) return series.parts.length ? 'complete' : 'preparation'
  if (!chapters.every(chapterPrepared)) return 'preparation'
  if (!stagesDone(chapters, ['script_en', 'script_hi'])) return 'scripts'
  if (!stagesDone(chapters, ['voice_en', 'voice_hi'])) return 'voiceover'
  // Alignment is triggered by the desktop voiceover import; it is not a phone run.
  if (!stagesDone(chapters, ['crop_json'])) return 'clipping'
  return 'review'
}

export function parseProductionConfig(value: unknown): ProductionConfig {
  if (!value || typeof value !== 'object') throw new Error('Choose a device, profile and clipping settings')
  const raw = value as Record<string, any>
  if (typeof raw.device !== 'string' || !raw.device.trim() || raw.device.length > 200) throw new Error('Choose a device')
  if (typeof raw.profileId !== 'string' || !raw.profileId.trim() || raw.profileId.length > 100) throw new Error('Choose a profile')
  let parallelDevices: ProductionDevice[] | undefined
  if (raw.parallelDevices !== undefined) {
    if (!Array.isArray(raw.parallelDevices) || raw.parallelDevices.length > 31) throw new Error('Choose valid parallel devices')
    const seen = new Set([raw.device])
    parallelDevices = raw.parallelDevices.map((target: any) => {
      if (!target || typeof target.device !== 'string' || !target.device.trim() || target.device.length > 200 || seen.has(target.device)) throw new Error('Choose each device only once')
      if (typeof target.profileId !== 'string' || !target.profileId.trim() || target.profileId.length > 100) throw new Error('Choose a profile on each device')
      seen.add(target.device)
      return { device: target.device, profileId: target.profileId }
    })
  }
  const c = raw.clipper
  if (!c || !['chatgpt', 'aistudio', 'gemini'].includes(c.ai) || !['classic', 'steps'].includes(c.flow) || !Number.isInteger(c.tabs) || c.tabs < 1 || c.tabs > 4) throw new Error('Choose valid Image Clipping settings (1–4 tabs)')
  const settings = c.chatGpt ?? { mode: null, model: null, effort: null }
  if (typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid ChatGPT settings')
  if (settings.mode != null && !['Chat', 'Work'].includes(settings.mode)) throw new Error('Invalid ChatGPT mode')
  for (const key of ['model', 'effort']) if (settings[key] != null && (typeof settings[key] !== 'string' || settings[key].length > 100)) throw new Error(`Invalid ChatGPT ${key}`)
  return { device: raw.device, profileId: raw.profileId, ...(parallelDevices ? { parallelDevices } : {}), clipper: { ai: c.ai, flow: c.flow, tabs: c.tabs,
    chatGpt: { mode: settings.mode ?? null, model: settings.model ?? null, effort: settings.effort ?? null } } }
}
