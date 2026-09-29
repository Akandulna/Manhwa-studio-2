const API_BASE = '/api'

async function fetchApi<T>(
  endpoint: string, 
  options?: RequestInit
): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers
    }
  })
  
  if (!response.ok) {
    // Errors raised before a route runs (body-size rejections, proxy faults)
    // answer with HTML, not JSON, so the status is the only thing left to
    // report — without it the toast just says "Request failed".
    const error = await response
      .json()
      .catch(() => ({ error: `Request failed (${response.status} ${response.statusText})` }))
    throw new Error(error.error || error.message || 'Request failed')
  }
  
  if (response.status === 204) {
    return {} as T
  }
  
  return response.json()
}

// Series API
export interface Series {
  id: string
  title: string
  sourceSite: string
  coverPath?: string
  rootFolder: string
  urlTemplate?: string
  createdAt: string
  chapterCount?: number
  chapters?: Chapter[]
  statusCounts?: {
    pending: number
    queued: number
    downloading: number
    done: number
    failed: number
    skipped: number
  }
}

export interface Chapter {
  id: string
  seriesId: string
  number: number
  title?: string
  sourceUrl: string
  folderPath: string
  status: 'pending' | 'queued' | 'downloading' | 'done' | 'failed' | 'skipped'
  pageCount?: number
  downloadedCount: number
  error?: string
  createdAt: string
}

export interface PatternResult {
  template: string
  confidence: 'high' | 'medium' | 'low'
  startNumber: number
  increment: number
  padding: number
  message?: string
  suggestedTitle?: string
  sourceSite?: string
}

export interface DiscoveredChapter {
  number: number
  url: string
  title?: string
  pageCount: number
  exists: boolean
}

export interface QuickValidationResult {
  isValid: boolean
  firstChapter?: number
  lastValidated?: number
  message?: string
}

export const seriesApi = {
  getAll: () => fetchApi<Series[]>('/series'),
  
  getById: (id: string) => fetchApi<Series>(`/series/${id}`),
  
  inferPattern: (seedUrls: string[]) => 
    fetchApi<PatternResult>('/series/infer-pattern', {
      method: 'POST',
      body: JSON.stringify({ seedUrls })
    }),
  
  validatePattern: (params: {
    template: string
    startNumber?: number
    padding?: number
  }) =>
    fetchApi<QuickValidationResult>('/series/validate-pattern', {
      method: 'POST',
      body: JSON.stringify(params)
    }),
  
  discoverChapters: (params: { 
    template?: string
    fromChapter?: number
    toChapter?: number
    padding?: number
    manualUrls?: string[] 
  }) =>
    fetchApi<{ chapters: DiscoveredChapter[] }>('/series/discover-chapters', {
      method: 'POST',
      body: JSON.stringify(params)
    }),
  
  create: (data: {
    title: string
    sourceSite?: string
    urlTemplate?: string
    chapters: { number: number; url: string; title?: string }[]
    coverPath?: string
  }) =>
    fetchApi<Series>('/series', {
      method: 'POST',
      body: JSON.stringify(data)
    }),
  
  update: (id: string, data: Partial<Series>) =>
    fetchApi<Series>(`/series/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data)
    }),
  
  delete: (id: string) =>
    fetchApi<void>(`/series/${id}`, {
      method: 'DELETE'
    }),
  
  addChapters: (id: string, chapters: { number: number; url: string; title?: string }[]) =>
    fetchApi<Chapter[]>(`/series/${id}/chapters`, {
      method: 'POST',
      body: JSON.stringify({ chapters })
    })
}

// Chapters API
export const chaptersApi = {
  getById: (id: string) => fetchApi<Chapter>(`/chapters/${id}`),
  
  update: (id: string, data: Partial<Chapter>) =>
    fetchApi<Chapter>(`/chapters/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data)
    }),
  
  bulkUpdate: (chapterIds: string[], status: string) =>
    fetchApi<Chapter[]>('/chapters/bulk-update', {
      method: 'POST',
      body: JSON.stringify({ chapterIds, status })
    }),
  
  delete: (id: string) =>
    fetchApi<void>(`/chapters/${id}`, {
      method: 'DELETE'
    })
}

// Downloads API
export interface QueueStatus {
  isPaused: boolean
  pending: number
  active: number
  completed: number
  failed: number
  currentChapter?: string
}

export interface DownloadStats {
  completed: number
  failed: number
  pending: number
  downloading: number
  queued: number
  totalBytes: number
}

export const downloadsApi = {
  getStatus: () => fetchApi<QueueStatus>('/downloads/status'),
  
  queueChapters: (chapterIds: string[]) =>
    fetchApi<{ message: string; status: QueueStatus }>('/downloads/queue', {
      method: 'POST',
      body: JSON.stringify({ chapterIds })
    }),
  
  pause: () =>
    fetchApi<{ message: string; status: QueueStatus }>('/downloads/pause', {
      method: 'POST'
    }),
  
  resume: () =>
    fetchApi<{ message: string; status: QueueStatus }>('/downloads/resume', {
      method: 'POST'
    }),
  
  clear: () =>
    fetchApi<{ message: string; status: QueueStatus }>('/downloads/clear', {
      method: 'POST'
    }),
  
  retryFailed: (seriesId?: string) =>
    fetchApi<{ message: string; status: QueueStatus }>('/downloads/retry-failed', {
      method: 'POST',
      body: JSON.stringify({ seriesId })
    }),
  
  openFolder: (path: string) =>
    fetchApi<{ message: string }>('/downloads/open-folder', {
      method: 'POST',
      body: JSON.stringify({ path })
    }),
  
  getStats: () => fetchApi<DownloadStats>('/downloads/stats')
}

// Settings API
export interface Settings {
  downloadRoot: string
  concurrency: string
  requestDelayMs: string
  userAgent: string
  minImageWidth: string
  minAspectRatio: string
}

export const settingsApi = {
  getAll: () => fetchApi<Settings>('/settings'),
  
  update: (key: string, value: string) =>
    fetchApi<{ key: string; value: string }>(`/settings/${key}`, {
      method: 'PUT',
      body: JSON.stringify({ value })
    }),
  
  updateAll: (settings: Partial<Settings>) =>
    fetchApi<{ key: string; value: string }[]>('/settings', {
      method: 'PUT',
      body: JSON.stringify(settings)
    }),
  
  reset: () =>
    fetchApi<Settings>('/settings/reset', {
      method: 'POST'
    })
}

// ============ Narration Studio API (Module 2) ============

export interface NarrationSeries {
  id: string
  title: string
  sourceSite: string
  coverPath?: string
  rootFolder: string
  aboutSummary?: string
  createdAt: string
  downloadedChapterCount: number
  scriptedChapterCount: number
}

export interface NarrationChapterSummary {
  id: string
  number: number
  title?: string
  folderPath: string
  pageCount?: number
  voiceover: {
    status: 'none' | 'partial' | 'done'
    totalSections: number
    withAudio: number
  }
  script: {
    id: string
    status: 'none' | 'generating' | 'done' | 'failed' | 'edited' | 'stale'
    mode: 'api' | 'manual'
    isPartEnd: boolean
    hasOutro: boolean
    error?: string
    updatedAt: string
  } | null
  partNumber: number
}

export interface NarrationSeriesDetail {
  id: string
  title: string
  sourceSite: string
  coverPath?: string
  rootFolder: string
  aboutSummary?: string
  createdAt: string
  chapters: NarrationChapterSummary[]
}

export interface ChapterScriptDetail {
  id: string
  number: number
  title?: string
  seriesId: string
  seriesTitle: string
  folderPath: string
  imageCount: number
  imagesValid: boolean
  imageError?: string
  aboutSummary?: string
  script: {
    id: string
    status: string
    mode: string
    rollingSummary?: string
    closingParagraph?: string
    isPartEnd: boolean
    outroText?: string
    content?: string
    outroContent?: string
    error?: string
    tokensUsed?: number
    updatedAt: string
  } | null
  previousContext: {
    chapterNumber: number
    rollingSummary?: string
    closingParagraph?: string
  } | null
  prevChapterId: string | null
  prevChapterNumber: number | null
  nextChapterId: string | null
  nextChapterNumber: number | null
}

export interface ManualPromptResponse {
  prompt: string
  folderPath: string
  imageFiles: string[]
  chapterNumber: number
  seriesTitle: string
}

export interface AIStatus {
  configured: boolean
  defaultProvider: string | null
  model: string | null
  availableProviders: string[]
  hasApiKey: boolean
  connectionTest: {
    success: boolean
    error?: string
  } | null
}

export const narrationApi = {
  // Series listing
  getSeries: () => fetchApi<NarrationSeries[]>('/narration/series'),
  
  getSeriesDetail: (id: string) => 
    fetchApi<NarrationSeriesDetail>(`/narration/series/${id}`),
  
  // Chapter operations
  getChapterDetail: (id: string) =>
    fetchApi<ChapterScriptDetail>(`/narration/chapters/${id}`),
  
  generateScript: (chapterId: string, config?: Record<string, number>) =>
    fetchApi<{ success: boolean }>(`/narration/chapters/${chapterId}/generate`, {
      method: 'POST',
      body: JSON.stringify({ config })
    }),
  
  getManualPrompt: (chapterId: string) =>
    fetchApi<ManualPromptResponse>(`/narration/chapters/${chapterId}/manual-prompt`),
  
  submitManualResult: (chapterId: string, response: string) =>
    fetchApi<{ 
      success: boolean
      parsed: { hasScript: boolean; hasSummary: boolean; hasClosing: boolean; hasAbout: boolean }
      needsSummaryRegeneration: boolean
    }>(`/narration/chapters/${chapterId}/manual-submit`, {
      method: 'POST',
      body: JSON.stringify({ response })
    }),
  
  saveScript: (chapterId: string, content: string) =>
    fetchApi<{ success: boolean }>(`/narration/chapters/${chapterId}/script`, {
      method: 'PUT',
      body: JSON.stringify({ content })
    }),
  
  regenerateSummary: (chapterId: string) =>
    fetchApi<{ success: boolean }>(`/narration/chapters/${chapterId}/regenerate-summary`, {
      method: 'POST'
    }),
  
  togglePartEnd: (chapterId: string) =>
    fetchApi<{ success: boolean; isPartEnd: boolean }>(`/narration/chapters/${chapterId}/toggle-part-end`, {
      method: 'POST'
    }),
  
  generateOutro: (chapterId: string) =>
    fetchApi<{ success: boolean; outroText?: string }>(`/narration/chapters/${chapterId}/generate-outro`, {
      method: 'POST'
    }),
  
  // Range generation
  generateRange: (seriesId: string, fromChapter: number, toChapter: number, config?: Record<string, number>) =>
    fetchApi<{ started: boolean }>(`/narration/series/${seriesId}/generate-range`, {
      method: 'POST',
      body: JSON.stringify({ fromChapter, toChapter, config })
    }),
  
  // Part export
  exportPart: (seriesId: string, partNumber: number) =>
    fetchApi<{ success: boolean; path?: string }>(`/narration/series/${seriesId}/export-part`, {
      method: 'POST',
      body: JSON.stringify({ partNumber })
    }),
  
  // AI status
  getAIStatus: () => fetchApi<AIStatus>('/narration/ai/status'),
  
  // Save API key
  saveApiKey: (apiKey: string) => 
    fetchApi<{ success: boolean; configured: boolean; connectionTest: { success: boolean; error?: string } | null }>('/narration/ai/api-key', {
      method: 'POST',
      body: JSON.stringify({ apiKey })
    }),
  
  // Save AI model settings
  saveAIModels: (scriptModel: string, summaryModel: string) =>
    fetchApi<{ success: boolean }>('/narration/ai/models', {
      method: 'POST',
      body: JSON.stringify({ scriptModel, summaryModel })
    }),
  
  // Open folder (reuse downloads API)
  openFolder: (path: string) => downloadsApi.openFolder(path)
}

// ============ Voiceover API (Module 2 Part 2) ============

export interface VoiceoverSeries {
  id: string
  title: string
  sourceSite: string
  coverPath?: string
  rootFolder: string
  downloadedChapterCount: number
  scriptedChapterCount: number
  audioGeneratedCount: number
  audioJoinedCount: number
}

export interface AudioSection {
  id: string
  index: number
  text: string
  status: 'pending' | 'generating' | 'done' | 'error' | 'uploaded'
  error?: string
  timelineScript?: string | null
}

export interface AudioFile {
  id: string
  kind: 'generated' | 'uploaded' | 'joined'
  sectionId?: string
  provider?: string
  model?: string
  voice?: string
  durationMs?: number
  format: string
  filePath: string
  originalName?: string | null
  createdAt: string
}

export interface VoiceAnalysisResult {
  verdict: 'consistent' | 'mismatch' | 'inconclusive'
  metadataConsistent: boolean
  acousticAnalysisAvailable: boolean
  perFileResults: Array<{
    fileId: string
    kind: string
    voice?: string
    metadataMatch: boolean
    acousticSimilarity?: number
    isOutlier: boolean
    warning?: string
  }>
  warnings: string[]
}

export interface VoiceoverChapterDetail {
  id: string
  number: number
  title?: string
  folderPath: string
  series: {
    id: string
    title: string
  }
  script: {
    id: string
    status: string
    content?: string
  } | null
  sections: AudioSection[]
  audioFiles: AudioFile[]
  analysis: {
    verdict: string
    updatedAt: string
  } | null
  status: {
    totalSections: number
    generatedSections: number
    hasJoinedAudio: boolean
  }
  prevChapterId: string | null
  nextChapterId: string | null
}

export interface VoiceInfo {
  id: string
  name: string
  description?: string
  provider: string
}

export const voiceoverApi = {
  // Series listing
  getSeries: () => fetchApi<VoiceoverSeries[]>('/voiceover/series'),
  
  // Chapter operations
  getChapterDetail: (id: string) =>
    fetchApi<VoiceoverChapterDetail>(`/voiceover/chapters/${id}`),
  
  // Section operations
  initializeSections: (chapterId: string, targetLength?: number) =>
    fetchApi<{
      count: number
      replacedSections: number
      discardedAudio: number
      sections: AudioSection[]
    }>(`/voiceover/chapters/${chapterId}/init-sections`, {
      method: 'POST',
      body: JSON.stringify({ targetLength })
    }),
  
  // One-click: split script -> generate all audio -> align every section.
  // Returns as soon as the run starts; progress arrives on `voiceover:pipeline`.
  runPipeline: (chapterId: string, opts?: { voice?: string; targetLength?: number }) =>
    fetchApi<{ message: string; chapterId: string }>(`/voiceover/chapters/${chapterId}/pipeline`, {
      method: 'POST',
      body: JSON.stringify(opts ?? {})
    }),

  updateSection: (sectionId: string, text: string) =>
    fetchApi<AudioSection>(`/voiceover/sections/${sectionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ text })
    }),

  updateTimelineScript: (sectionId: string, timelineScript: string) =>
    fetchApi<AudioSection>(`/voiceover/sections/${sectionId}/timeline-script`, {
      method: 'PATCH',
      body: JSON.stringify({ timelineScript })
    }),

  // Forced alignment: builds "Script with Timeline" from a section's existing
  // audio, using the section's own script text as the source of the wording.
  alignSection: (sectionId: string) =>
    fetchApi<{ sectionId: string; timelineScript: string; beatCount: number; durationSec: number }>(
      `/voiceover/sections/${sectionId}/align`,
      { method: 'POST' }
    ),

  alignChapter: (chapterId: string) =>
    fetchApi<{ aligned: number; failed: number; errors: string[] }>(
      `/voiceover/chapters/${chapterId}/align`,
      { method: 'POST' }
    ),

  getAlignmentStatus: () =>
    fetchApi<{ available: boolean; error?: string }>('/voiceover/alignment/status'),

  deleteSection: (sectionId: string) =>
    fetchApi<{ message: string }>(`/voiceover/sections/${sectionId}`, {
      method: 'DELETE'
    }),
  
  addSection: (chapterId: string, text: string, index?: number) =>
    fetchApi<AudioSection>(`/voiceover/chapters/${chapterId}/sections`, {
      method: 'POST',
      body: JSON.stringify({ text, index })
    }),
  
  // TTS Generation
  generateSectionAudio: (sectionId: string, voice?: string, stylePrompt?: string) =>
    fetchApi<AudioFile>(`/voiceover/sections/${sectionId}/generate`, {
      method: 'POST',
      body: JSON.stringify({ voice, stylePrompt })
    }),
  
  generateAllSections: (chapterId: string, voice?: string, stylePrompt?: string, concurrency?: number) =>
    fetchApi<{ results: Array<{ sectionId: string; success: boolean; error?: string }> }>(`/voiceover/chapters/${chapterId}/generate-all`, {
      method: 'POST',
      body: JSON.stringify({ voice, stylePrompt, concurrency })
    }),
  
  // Audio file operations
  uploadSectionAudio: (sectionId: string, file: File) => {
    const formData = new FormData()
    formData.append('audio', file)
    return fetch(`${API_BASE}/voiceover/sections/${sectionId}/upload`, {
      method: 'POST',
      body: formData
    }).then(res => {
      if (!res.ok) throw new Error('Upload failed')
      return res.json() as Promise<AudioFile>
    })
  },
  
  uploadChapterAudio: (chapterId: string, file: File) => {
    const formData = new FormData()
    formData.append('audio', file)
    return fetch(`${API_BASE}/voiceover/chapters/${chapterId}/upload`, {
      method: 'POST',
      body: formData
    }).then(res => {
      if (!res.ok) throw new Error('Upload failed')
      return res.json() as Promise<AudioFile>
    })
  },
  
  deleteAudioFile: (audioFileId: string) =>
    fetchApi<{ message: string }>(`/voiceover/audio/${audioFileId}`, {
      method: 'DELETE'
    }),
  
  // Join audio
  joinChapterAudio: (chapterId: string, normalize?: boolean, outputFormat?: string) =>
    fetchApi<AudioFile>(`/voiceover/chapters/${chapterId}/join`, {
      method: 'POST',
      body: JSON.stringify({ normalize, outputFormat })
    }),
  
  // Analysis
  analyzeVoices: (chapterId: string, threshold?: number, includeAcoustic?: boolean) =>
    fetchApi<VoiceAnalysisResult>(`/voiceover/chapters/${chapterId}/analyze`, {
      method: 'POST',
      body: JSON.stringify({ threshold, includeAcoustic })
    }),
  
  getAnalysis: (chapterId: string) =>
    fetchApi<VoiceAnalysisResult>(`/voiceover/chapters/${chapterId}/analysis`),
  
  checkAnalysisAvailable: () =>
    fetchApi<{ available: boolean; error?: string }>('/voiceover/analysis/status'),
  
  // Check voice consistency - returns mismatch info without deleting
  checkVoiceConsistency: (chapterId: string, targetVoice?: string) =>
    fetchApi<{
      consistent: boolean
      message: string
      expectedVoice: string | null
      mismatchedSections: Array<{ sectionId: string; sectionIndex?: number; currentVoice?: string; expectedVoice?: string }>
    }>(`/voiceover/chapters/${chapterId}/check-voices`, {
      method: 'POST',
      body: JSON.stringify({ targetVoice })
    }),
  
  // Voices
  getVoices: (provider?: string) =>
    fetchApi<{ provider: string; requested?: string; voices: VoiceInfo[] }>(
      provider ? `/voiceover/voices?provider=${encodeURIComponent(provider)}` : '/voiceover/voices'
    ),

  // Local Kokoro Gradio app availability
  getKokoroStatus: () =>
    fetchApi<{ available: boolean; error?: string; url?: string }>('/voiceover/kokoro/status'),
  
  // Audio streaming URL
  getAudioStreamUrl: (audioFileId: string) =>
    `${API_BASE}/voiceover/audio/${audioFileId}/stream`,
  
  getAudioDownloadUrl: (audioFileId: string) =>
    `${API_BASE}/voiceover/audio/${audioFileId}/download`
}

// ============ Music Library ============

export interface MusicTrack {
  id: string
  filename: string
  filePath: string
  createdAt: string
}

export const musicApi = {
  list: () => fetchApi<MusicTrack[]>('/music'),

  upload: (file: File) => {
    const formData = new FormData()
    formData.append('track', file)
    return fetch(`${API_BASE}/music`, { method: 'POST', body: formData }).then(res => {
      if (!res.ok) throw new Error('Upload failed')
      return res.json() as Promise<MusicTrack>
    })
  },

  remove: (id: string) =>
    fetchApi<{ message: string }>(`/music/${id}`, { method: 'DELETE' }),

  fileUrl: (id: string) => `${API_BASE}/music/${id}/file`
}

// ============ Module 4 v2: Editor 2.0 ============
//
// Series → chapter readiness. Gates on 4 conditions — script generated,
// section audio generated, Image Clipper 3.0 crops done, and a "script with
// timeline" on every section.

export interface Editable2Chapter {
  id: string
  number: number
  title: string | null
  ready: boolean
  reason: string | null
  hasScript: boolean
  hasSectionAudio: boolean
  sectionCount: number
  hasCropsClipper3: boolean
  cropImageCount: number
  cropDoneCount: number
  hasTimelineScript: boolean
  isPartEnd: boolean
}

/** A chapter's per-section timeline scripts, stitched into one document. */
export interface ChapterTimelineBundle {
  chapterId: string
  number: number
  title: string | null
  sectionCount: number
  includedCount: number
  text: string
}

/** A chapter's per-image Clipper 3.0 metadata documents, stitched into one. */
export interface ChapterCropMetadataBundle {
  chapterId: string
  number: number
  title: string | null
  imageCount: number
  includedCount: number
  text: string
}

/**
 * One chapter that already has a rendered MP4 in the series' `_video2` folder.
 * Editor 2.0 keeps no export rows, so this comes from scanning that folder.
 */
export interface Exported2Chapter {
  chapterId: string
  chapterNumber: number
  fileName: string
  size: number
  modifiedAt: number
}

// ---- Timeline image-reference repair (Editor 2.0) ----

/** One timeline reference a repair run rewrites. */
export interface RepairedRef {
  /** The ref exactly as the pasted JSON wrote it. */
  was: string
  /** The crops3 filename it becomes. */
  now: string
  /** Where it appears: "Section 2 · 00:14.20 - 00:19.80". */
  where: string
}

/** One reference naming a crop the chapter does not have. Needs a re-cut. */
export interface UnfixableRef {
  ref: string
  where: string
  reason: string
}

export interface CropRepairChapter {
  chapterId: string
  chapterNumber: number
  chapterTitle: string | null
  repaired: RepairedRef[]
  unfixable: UnfixableRef[]
  /** The corrected paste, when anything was repaired. Null when nothing was. */
  correctedJson: string | null
  error: string | null
}

export interface CropRepairResult {
  seriesId: string
  seriesTitle: string
  /** Only chapters with something to report; clean ones are left out. */
  chapters: CropRepairChapter[]
  repairedCount: number
  unfixableCount: number
  chaptersChecked: number
}

export const videoApi2 = {
  getEditableChapters: (seriesId: string) =>
    fetchApi<Editable2Chapter[]>(`/video2/series/${seriesId}/editable-chapters`),

  /** Which chapters of this series have already been rendered to MP4. */
  getExportedChapters: (seriesId: string) =>
    fetchApi<Exported2Chapter[]>(`/video2/series/${seriesId}/exports`),

  getTimelineBundle: (chapterId: string) =>
    fetchApi<ChapterTimelineBundle>(`/video2/chapters/${chapterId}/timeline-bundle`),

  getCropMetadataBundle: (chapterId: string) =>
    fetchApi<ChapterCropMetadataBundle>(`/video2/chapters/${chapterId}/crop-metadata-bundle`),

  processTimeline: (chapterId: string, json: string) =>
    fetchApi<TimelinePlan>(`/video2/chapters/${chapterId}/process-timeline`, {
      method: 'POST',
      body: JSON.stringify({ json })
    }),

  /**
   * Render every processed chapter of a series to its own MP4 in one job.
   * The pasted JSON goes with the request because Editor 2.0 keeps it in the
   * browser rather than the database.
   *
   * Chapters that already have an MP4 come back as skipped, not re-rendered,
   * unless `force` is set.
   */
  exportAll: (
    seriesId: string,
    chapters: { chapterId: string; json: string }[],
    options?: { resolution?: string; preset?: string; fps?: number; force?: boolean }
  ) =>
    fetchApi<{ jobId: string }>(`/video2/series/${seriesId}/export-all`, {
      method: 'POST',
      body: JSON.stringify({ chapters, ...options })
    }),

  /**
   * Find timeline image references that name no file in their chapter's crops3
   * — the cause of the preview's "image references could not be found on disk"
   * — and rewrite each to the crop its page and index actually name.
   *
   * Writes nothing: the corrected JSON comes back per chapter, and the caller
   * saves it only once the user confirms. So the confirmation shows the real
   * result rather than a separate prediction of it.
   */
  checkImageRefs: (seriesId: string, chapters: { chapterId: string; json: string }[]) =>
    fetchApi<CropRepairResult>(`/video2/series/${seriesId}/check-image-refs`, {
      method: 'POST',
      body: JSON.stringify({ chapters })
    }),

  getExportJob: (jobId: string) => fetchApi<Export2Job>(`/video2/exports/${jobId}`),

  cancelExport: (jobId: string) =>
    fetchApi<{ cancelled: boolean }>(`/video2/exports/${jobId}/cancel`, { method: 'POST' })
}

// ---- Batch export job (Editor 2.0) ----

export type Export2ChapterStatus =
  | 'pending'
  | 'rendering'
  | 'done'
  | 'skipped'
  | 'failed'
  | 'cancelled'

export interface Export2ChapterState {
  chapterId: string
  chapterNumber: number
  chapterTitle: string | null
  status: Export2ChapterStatus
  percent: number
  outputPath: string | null
  error: string | null
}

export interface Export2Job {
  id: string
  seriesId: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  percent: number
  chapters: Export2ChapterState[]
  startedAt: number
  finishedAt: number | null
  error: string | null
}

// ---- Processed timeline plan (Editor 2.0 preview) ----

export type Editor2MotionEffect =
  | 'zoom-in'
  | 'zoom-out'
  | 'pan-left'
  | 'pan-right'
  | 'pan-up'
  | 'pan-down'

export interface PlanImage {
  ref: string
  sourceImage: string
  cropId: string
  filename: string | null
  url: string | null
  duration: number
  startTime: number
  endTime: number
  motionEffect: Editor2MotionEffect
  motionIntensity: number
}

export interface PlanSlot {
  timeline: string
  relStart: number
  relEnd: number
  startTime: number
  endTime: number
  images: PlanImage[]
}

export interface PlanSection {
  label: string
  index: number
  startTime: number
  audioDuration: number
  audioUrl: string | null
  slots: PlanSlot[]
}

export interface TimelinePlan {
  chapterId: string
  chapterNumber: number
  chapterTitle: string | null
  seriesTitle: string
  totalDuration: number
  imageCount: number
  missingRefs: string[]
  warnings: string[]
  sections: PlanSection[]
}

// ============ Module 3 v3: Image Clipper 3.0 ============
//
// The 3.0 model is per-image, not per-chapter: every source image has its own
// crop JSON whose coordinates are normalized 0.0–1.0 against THAT IMAGE alone.
// There is no stitched canvas here, so nothing in this section carries canvas
// offsets, and an image's status never depends on another image's crops.

export interface Clipper3Image {
  filename: string
  /** The image's own pixel size — the space its JSON is normalized against. */
  width: number
  height: number
  hasPoints: boolean
  hasMetadata: boolean
  /** The stored metadata still validates against this image's crop ids. */
  metadataValid: boolean
  /** Why validation failed — empty whenever metadataValid or hasMetadata is false. */
  metadataErrors: string[]
  cropCount: number
  /** 'done' only once this image has crops AND metadata that still matches them. */
  status: 'done' | 'pending'
}

export interface Clipper3ChapterImages {
  chapterId: string
  number: number
  title: string | null
  seriesId: string
  seriesTitle: string
  images: Clipper3Image[]
}

export interface Clipper3Point {
  id: string
  x: number
  y: number
}

export interface Clipper3CropEntry {
  id: string
  reason: string
  crop: {
    mode: 'rectangle' | 'perspective'
    points: Clipper3Point[]
  }
}

export interface Clipper3ImageCropFile {
  format: string
  version: string
  image: { filename: string; width?: number; height?: number }
  coordinateSystem: string
  crops: Clipper3CropEntry[]
  receivedAt?: string
}

export interface Clipper3ImagePoints {
  filename: string
  /** Raw stored bytes, so the preview shows exactly what will be cut. */
  content: string
  file: Clipper3ImageCropFile | null
  cropCount: number
  hasMetadata: boolean
  metadataValid: boolean
  /** The IMAGE's status, which also depends on its metadata document. */
  status: 'done' | 'pending'
}

export interface Clipper3ImageMetadata {
  filename: string
  /** The metadata document verbatim; '' when none is stored. */
  content: string
  hasMetadata: boolean
  /** False whenever hasMetadata is true but it no longer matches this image's crops. */
  metadataValid: boolean
  /** Why validation failed — empty when metadataValid, or when there's no metadata at all. */
  metadataErrors: string[]
  cropCount?: number
  status?: 'done' | 'pending'
}

export interface Clipper3Output {
  filename: string
  bytes: number
  url: string
}

export interface Clipper3SliceFile {
  /** 1-based, in top-to-bottom order. */
  index: number
  filename: string
  width: number
  height: number
  bytes: number
}

export interface Clipper3SliceResult {
  imageFilename: string
  /** Absolute path of the folder holding the slices. */
  directory: string
  sourceWidth: number
  sourceHeight: number
  files: Clipper3SliceFile[]
}

/**
 * Crop Studio — the ChatGPT handoff package for one page (server
 * services/clipper3/handoff.ts). Slices are verified pixel-exact against the
 * fingerprinted original before the manifest is written.
 */
export interface Clipper3HandoffSlice {
  id: string
  file: string
  x0: number
  y0: number
  x1: number
  y1: number
  width: number
  height: number
  sha256: string
}

export interface Clipper3HandoffManifest {
  schema_version: 'handoff/1.0'
  job_id: string
  created_at: string
  source: {
    series_title: string
    series_slug: string
    chapter_folder: string
    chapter_number: number
    page_stem: string
    original_filename: string
    sha256: string
    width: number
    height: number
    format: string
    orientation: 'stored_pixels'
  }
  coordinate_system: 'canonical_original_pixels'
  slices: Clipper3HandoffSlice[]
  manifest_sha256: string
}

export interface Clipper3HandoffStatus {
  status: 'none' | 'ready' | 'stale'
  staleReasons: { code: 'SOURCE_CHANGED' | 'SLICES_CHANGED' | 'MANIFEST_CORRUPT'; message: string }[]
  manifest: Clipper3HandoffManifest | null
  prompt: string | null
}

export interface Clipper3HandoffBuild {
  status: 'ready'
  manifest: Clipper3HandoffManifest
  prompt: string
  studioDirectory: string
  sliceDirectory: string
  sliced: Clipper3SliceResult
}

/** One problem with a pasted ChatGPT reply (server services/clipper3/analysisImport.ts). */
export interface Clipper3ImportIssue {
  code: string
  /** Where in the reply, e.g. `candidates[2].bottom_right.y`; '' for the whole document. */
  field: string
  message: string
  candidateId?: string
}

export interface Clipper3Candidate {
  candidate_id: string
  reason: string
  /** Integer pixels on the original page; x1/y1 exclusive. */
  bounds: { x0: number; y0: number; x1: number; y1: number }
  description: string
  visual_evidence: string
  review_flags: string[]
  unknown_flags: string[]
  /** Slices the box overlaps; more than one means it crosses a seam. */
  slices: string[]
}

export interface Clipper3ImportedAnalysis {
  job_id: string
  source_sha256: string
  page_stem: string
  source_width: number
  source_height: number
  imported_at: string
  reply_coordinate_system: string
  response_file: string
  page_inspection_complete: boolean
  page_review_flags: string[]
  candidates: Clipper3Candidate[]
  warnings: Clipper3ImportIssue[]
}

export interface Clipper3AnalysisStatus {
  analysis: Clipper3ImportedAnalysis | null
  stale: boolean
  staleReasons: string[]
}

export interface Clipper3ImportOutcome {
  imported: boolean
  analysis: Clipper3ImportedAnalysis | null
  errors: Clipper3ImportIssue[]
  warnings: Clipper3ImportIssue[]
}

/** Crop Studio review (server services/clipper3/reviewState.ts + auditRules.ts). */
export type Clipper3Disposition = 'unreviewed' | 'kept' | 'adjusted' | 'split' | 'merged' | 'unresolved'
export type Clipper3DescriptionStatus = 'approved' | 'unreviewed' | 'stale' | 'missing'

export interface Clipper3ReviewCrop {
  key: string
  origin: 'chatgpt' | 'existing_pointers' | 'operator'
  reason: string
  bounds: { x0: number; y0: number; x1: number; y1: number }
  description: string
  description_status: Clipper3DescriptionStatus
  disposition: Clipper3Disposition
  visual_evidence: string
  gpt_flags: string[]
  unknown_flags: string[]
  acknowledged: string[]
  note: string
}

export interface Clipper3ReviewState {
  schema_version: 'crop-studio-review/1.0'
  job_id: string | null
  source_sha256: string
  source_width: number
  source_height: number
  page_stem: string
  review_revision: number
  created_at: string
  updated_at: string
  based_on:
    | { kind: 'chatgpt_import'; response_sha256: string; imported_at: string }
    | { kind: 'existing_pointers'; points_sha256: string }
  crops: Clipper3ReviewCrop[]
  page: { sweep_done: boolean; no_eligible_artwork_confirmed: boolean; note: string }
}

export interface Clipper3ReviewItem {
  token: string
  key: string
  source: 'system' | 'chatgpt'
  code: string
  message: string
  acknowledged: boolean
}

export interface Clipper3ReviewView {
  state: Clipper3ReviewState | null
  audit: {
    findings: { code: string; key: string; otherKey?: string; edge?: string; message: string }[]
    gaps: { y0: number; y1: number; nonBlankShare: number | null }[]
  } | null
  items: Clipper3ReviewItem[]
  readiness: { ready: boolean; blockers: { code: string; key?: string; message: string }[] }
  stale: boolean
  staleReasons: string[]
  newerImportAvailable: boolean
}

/** What a ChatGPT review round did (server services/clipper3/chatgptReview.ts). */
export interface Clipper3ChatGptReviewOutcome {
  applied: boolean
  view: Clipper3ReviewView | null
  errors: Clipper3ImportIssue[]
  warnings: Clipper3ImportIssue[]
  summary: { kept: number; adjusted: number; split: number; merged: number; added: number; removed: number } | null
}

/** ChatGPT-API settings (server services/clipper3/openaiAuto.ts) — the key itself never leaves the server. */
export interface Clipper3OpenAiSettings {
  hasKey: boolean
  keyHint: string | null
  model: string
  baseUrl: string
  /** '' = the model's own default. */
  reasoningEffort: '' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  reviewRounds: number
  includeRules: boolean
  concurrency: number
}

export type Clipper3AutoStep =
  | 'queued' | 'packaging' | 'analyzing' | 'reviewing' | 'exporting'
  | 'done' | 'ready' | 'needs_review' | 'failed' | 'cancelled'

export interface Clipper3AutoPage {
  filename: string
  step: Clipper3AutoStep
  message: string
  round: number
  crops: number | null
  blockers: string[]
  tokens: number
  startedAt: string | null
  finishedAt: string | null
}

/** One chapter's run of the ChatGPT loop through the OpenAI API. */
export interface Clipper3AutoJob {
  chapterId: string
  running: boolean
  cancelled: boolean
  model: string
  reasoningEffort: Clipper3OpenAiSettings['reasoningEffort']
  export: boolean
  startedAt: string
  finishedAt: string | null
  pages: Clipper3AutoPage[]
}

/** One page's export (server services/clipper3/exportPage.ts). */
export interface Clipper3ExportReport {
  status: 'completed' | 'failed'
  exported_at: string
  page_stem: string
  original_filename: string
  source_sha256: string
  review_revision: number
  crop_count: number
  crops: { id: string; key: string; reason: string; exportedFilename: string; width: number; height: number; sha256: string }[]
  destinations: { processed: string; crops: string; store: string[] }
  replaced: string[]
  files: { path: string; sha256: string; bytes: number }[]
  notes: string[]
  error?: string
}

export interface Clipper3ExportStatus {
  report: Clipper3ExportReport | null
  upToDate: boolean
}

/** A refused export: the message, every problem, and the review blockers when it wasn't finished. */
export class Clipper3ExportError extends Error {
  constructor(message: string, public readonly details: string[], public readonly blockers: { code: string; key?: string; message: string }[]) {
    super(message)
    this.name = 'Clipper3ExportError'
  }
}

/** A refused review save: the message, every problem, and (on a conflict) the current review. */
export class Clipper3ReviewSaveError extends Error {
  constructor(message: string, public readonly status: number, public readonly details: string[], public readonly current: Clipper3ReviewView | null) {
    super(message)
    this.name = 'Clipper3ReviewSaveError'
  }
}

/**
 * What Sync json did with one `Processed/page_###` folder — or, from the
 * preview, what it would do: 'ready' is the preview's form of 'imported'.
 */
export interface Clipper3SyncedPage {
  /** The folder as it appears on disk, e.g. "page_007". */
  folder: string
  /** The source image it resolved to, when it resolved to one. */
  filename: string | null
  status: 'imported' | 'ready' | 'skipped' | 'failed'
  /** Why, for 'skipped' and 'failed'. Empty for 'imported'/'ready'. */
  reason: string
  cropCount: number
}

export interface Clipper3ChapterSyncResult {
  chapterId: string
  chapterNumber: number
  imported: number
  /** Attachable, on a preview. Always 0 once the sync has actually run. */
  ready: number
  skipped: number
  failed: number
  pages: Clipper3SyncedPage[]
}

/** The confirmation dialog's contents: what a sync would attach, before it runs. */
export interface Clipper3SyncPreview {
  chapters: number
  ready: number
  skipped: number
  failed: number
  results: Clipper3ChapterSyncResult[]
}

/**
 * What Unsync did to one page — or, from the preview, what it would do:
 * 'attached' is the preview's form of 'detached'.
 */
export interface Clipper3UnsyncedPage {
  filename: string
  status: 'detached' | 'attached' | 'failed'
  /** Why, for 'failed'. Empty otherwise. */
  reason: string
  /** Which halves were on disk. Both are cleared together. */
  hadPoints: boolean
  hadMetadata: boolean
}

export interface Clipper3ChapterUnsyncResult {
  chapterId: string
  chapterNumber: number
  detached: number
  /** Clearable, on a preview. Always 0 once the unsync has actually run. */
  attached: number
  failed: number
  pages: Clipper3UnsyncedPage[]
}

/** The confirmation dialog's contents: what an unsync would clear, before it runs. */
export interface Clipper3UnsyncPreview {
  chapters: number
  attached: number
  failed: number
  results: Clipper3ChapterUnsyncResult[]
}

export interface Clipper3ChapterSummary {
  chapterId: string
  totalImages: number
  attachedImages: number
  /** Every image has crops and metadata that still validates against them. */
  fullyAttached: boolean
  /** The chapter has been cut — crops3/ has at least one output file. */
  chopped: boolean
}

/** Crop rules document state (Settings → Crop Pointers). */
export interface Clipper3Status {
  guidelinesPresent: boolean
  guidelinesUpdatedAt: string | null
  guidelinesIsDefault: boolean
}

export interface Clipper3Guidelines {
  content: string
  updatedAt: string | null
  readOnly: boolean
  present: boolean
  isDefault: boolean
}

export interface Clipper3Series {
  id: string
  title: string
  sourceSite: string
  coverPath: string | null
  chapterCount: number
}

export interface Clipper3Chapter {
  id: string
  number: number
  title: string | null
  seriesId: string
  seriesTitle: string
  pageCount: number
}

export const clipper3Api = {
  getStatus: () => fetchApi<Clipper3Status>('/clipper3/status'),

  getGuidelines: () => fetchApi<Clipper3Guidelines>('/clipper3/guidelines'),

  updateGuidelines: (content: string) =>
    fetchApi<Clipper3Guidelines>('/clipper3/guidelines', {
      method: 'PUT',
      body: JSON.stringify({ content })
    }),

  resetGuidelines: () =>
    fetchApi<Clipper3Guidelines>('/clipper3/guidelines/reset', { method: 'POST' }),

  getSeries: () => fetchApi<Clipper3Series[]>('/clipper3/series'),

  getChapters: () => fetchApi<Clipper3Chapter[]>('/clipper3/chapters'),

  /** One source page image, served from the chapter folder. */
  getImageUrl: (chapterId: string, filename: string) =>
    `${API_BASE}/clipper3/chapters/${chapterId}/image/${encodeURIComponent(filename)}`,

  getImages: (chapterId: string) =>
    fetchApi<Clipper3ChapterImages>(`/clipper3/chapters/${chapterId}/images`),

  getSeriesSummary: (seriesId: string) =>
    fetchApi<{ chapters: Clipper3ChapterSummary[] }>(`/clipper3/series/${seriesId}/summary`),

  getImagePoints: (chapterId: string, filename: string) =>
    fetchApi<Clipper3ImagePoints>(
      `/clipper3/chapters/${chapterId}/images/${encodeURIComponent(filename)}/points`
    ),

  putImagePoints: (chapterId: string, filename: string, content: string) =>
    fetchApi<Clipper3ImagePoints>(
      `/clipper3/chapters/${chapterId}/images/${encodeURIComponent(filename)}/points`,
      { method: 'PUT', body: JSON.stringify({ content }) }
    ),

  deleteImagePoints: (chapterId: string, filename: string) =>
    fetchApi<{ deleted: boolean }>(
      `/clipper3/chapters/${chapterId}/images/${encodeURIComponent(filename)}/points`,
      { method: 'DELETE' }
    ),

  // The metadata document is stored verbatim and never parsed.
  getImageMetadata: (chapterId: string, filename: string) =>
    fetchApi<Clipper3ImageMetadata>(
      `/clipper3/chapters/${chapterId}/images/${encodeURIComponent(filename)}/metadata`
    ),

  putImageMetadata: (chapterId: string, filename: string, content: string) =>
    fetchApi<Clipper3ImageMetadata>(
      `/clipper3/chapters/${chapterId}/images/${encodeURIComponent(filename)}/metadata`,
      { method: 'PUT', body: JSON.stringify({ content }) }
    ),

  deleteImageMetadata: (chapterId: string, filename: string) =>
    fetchApi<{ deleted: boolean }>(
      `/clipper3/chapters/${chapterId}/images/${encodeURIComponent(filename)}/metadata`,
      { method: 'DELETE' }
    ),

  // Slices are written to disk rather than handed back as blobs: the clipboard
  // holds one image at a time, so selecting them all in the file explorer is
  // the only way to copy the whole set at once.
  sliceImage: (chapterId: string, filename: string) =>
    fetchApi<Clipper3SliceResult>(
      `/clipper3/chapters/${chapterId}/images/${encodeURIComponent(filename)}/slices`,
      { method: 'POST' }
    ),

  openSliceFolder: (chapterId: string, filename: string) =>
    fetchApi<{ success: boolean; path: string }>(
      `/clipper3/chapters/${chapterId}/images/${encodeURIComponent(filename)}/slices/open`,
      { method: 'POST' }
    ),

  // The ChatGPT package: slices verified against the original, plus the
  // manifest and prompt. A blocked page (corrupt, rotated, animated) answers
  // 422 and the error message lists every issue.
  getHandoff: (chapterId: string, filename: string) =>
    fetchApi<Clipper3HandoffStatus>(
      `/clipper3/chapters/${chapterId}/images/${encodeURIComponent(filename)}/handoff`
    ),

  buildHandoff: (chapterId: string, filename: string) =>
    fetchApi<Clipper3HandoffBuild>(
      `/clipper3/chapters/${chapterId}/images/${encodeURIComponent(filename)}/handoff`,
      { method: 'POST' }
    ),

  getAnalysis: (chapterId: string, filename: string) =>
    fetchApi<Clipper3AnalysisStatus>(
      `/clipper3/chapters/${chapterId}/images/${encodeURIComponent(filename)}/analysis`
    ),

  // Not fetchApi: a rejected reply answers 422 with field-level errors the UI
  // lists, and fetchApi would reduce that to a single message.
  importAnalysis: async (chapterId: string, filename: string, content: string): Promise<Clipper3ImportOutcome> => {
    const response = await fetch(
      `${API_BASE}/clipper3/chapters/${chapterId}/images/${encodeURIComponent(filename)}/analysis`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) }
    )
    const payload = await response.json().catch(() => null) as (Clipper3ImportOutcome & { error?: string }) | null
    if (response.status === 422 && payload && Array.isArray(payload.errors)) return payload
    if (!response.ok || !payload) {
      throw new Error(payload?.error || `Import failed (${response.status} ${response.statusText})`)
    }
    return payload
  },

  getReview: (chapterId: string, filename: string) =>
    fetchApi<Clipper3ReviewView>(
      `/clipper3/chapters/${chapterId}/images/${encodeURIComponent(filename)}/review`
    ),

  startReview: (chapterId: string, filename: string, from: 'import' | 'pointers', replace = false) =>
    fetchApi<Clipper3ReviewView>(
      `/clipper3/chapters/${chapterId}/images/${encodeURIComponent(filename)}/review`,
      { method: 'POST', body: JSON.stringify({ from, replace }) }
    ),

  // Not fetchApi: a refused save carries a detail list, and a revision
  // conflict carries the current review so the UI can resync to it.
  saveReview: async (chapterId: string, filename: string, state: Clipper3ReviewState, expectedRevision: number): Promise<Clipper3ReviewView> => {
    const response = await fetch(
      `${API_BASE}/clipper3/chapters/${chapterId}/images/${encodeURIComponent(filename)}/review`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state, expectedRevision }) }
    )
    const payload = await response.json().catch(() => null) as
      (Clipper3ReviewView & { error?: string; details?: string[]; current?: Clipper3ReviewView | null }) | null
    if (!response.ok || !payload) {
      throw new Clipper3ReviewSaveError(
        payload?.error || `Save failed (${response.status} ${response.statusText})`,
        response.status,
        payload?.details ?? [],
        payload?.current ?? null
      )
    }
    return payload
  },

  getReviewPrompt: (chapterId: string, filename: string) =>
    fetchApi<{ prompt: string; review_revision: number }>(
      `/clipper3/chapters/${chapterId}/images/${encodeURIComponent(filename)}/review/chatgpt-prompt`
    ),

  // Not fetchApi: a refused reply answers 422 with field-level errors to list.
  applyChatGptReview: async (chapterId: string, filename: string, content: string): Promise<Clipper3ChatGptReviewOutcome> => {
    const response = await fetch(
      `${API_BASE}/clipper3/chapters/${chapterId}/images/${encodeURIComponent(filename)}/review/chatgpt`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) }
    )
    const payload = await response.json().catch(() => null) as (Clipper3ChatGptReviewOutcome & { error?: string }) | null
    if (response.status === 422 && payload && Array.isArray(payload.errors)) return payload
    if (!response.ok || !payload) throw new Error(payload?.error || `Review import failed (${response.status} ${response.statusText})`)
    return payload
  },

  getExport: (chapterId: string, filename: string) =>
    fetchApi<Clipper3ExportStatus>(
      `/clipper3/chapters/${chapterId}/images/${encodeURIComponent(filename)}/export`
    ),

  // Not fetchApi: a refused export carries its problems and the review blockers.
  exportPage: async (chapterId: string, filename: string): Promise<Clipper3ExportReport> => {
    const response = await fetch(
      `${API_BASE}/clipper3/chapters/${chapterId}/images/${encodeURIComponent(filename)}/export`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } }
    )
    const payload = await response.json().catch(() => null) as
      (Clipper3ExportReport & { error?: string; details?: string[]; blockers?: Clipper3ExportError['blockers'] }) | null
    if (!response.ok || !payload) {
      throw new Clipper3ExportError(payload?.error || `Export failed (${response.status} ${response.statusText})`, payload?.details ?? [], payload?.blockers ?? [])
    }
    return payload
  },

  openExportFolder: (chapterId: string, filename: string) =>
    fetchApi<{ success: boolean; path: string }>(
      `/clipper3/chapters/${chapterId}/images/${encodeURIComponent(filename)}/export/open`,
      { method: 'POST' }
    ),

  getOpenAiSettings: () => fetchApi<Clipper3OpenAiSettings>('/clipper3/openai'),

  saveOpenAiSettings: (update: Partial<Omit<Clipper3OpenAiSettings, 'hasKey' | 'keyHint'>> & { apiKey?: string; clearKey?: boolean }) =>
    fetchApi<Clipper3OpenAiSettings>('/clipper3/openai', { method: 'PUT', body: JSON.stringify(update) }),

  testOpenAi: () =>
    fetchApi<{ success: boolean; model: string; error?: string }>('/clipper3/openai/test', { method: 'POST' }),

  // The ChatGPT loop (package → analysis → review → export) run through the
  // OpenAI API in the background; poll getAutoRun for progress.
  getAutoRun: (chapterId: string) =>
    fetchApi<{ job: Clipper3AutoJob | null }>(`/clipper3/chapters/${chapterId}/auto`),

  startAutoRun: (chapterId: string, filenames: string[], exportPages: boolean) =>
    fetchApi<{ job: Clipper3AutoJob }>(
      `/clipper3/chapters/${chapterId}/auto`,
      { method: 'POST', body: JSON.stringify({ filenames, export: exportPages }) }
    ),

  cancelAutoRun: (chapterId: string) =>
    fetchApi<{ cancelled: boolean; job: Clipper3AutoJob | null }>(`/clipper3/chapters/${chapterId}/auto/cancel`, { method: 'POST' }),

  getSliceUrl: (chapterId: string, filename: string, sliceName: string) =>
    `${API_BASE}/clipper3/chapters/${chapterId}/images/${encodeURIComponent(filename)}` +
    `/slices/${encodeURIComponent(sliceName)}`,

  // What syncProcessed would attach, without writing anything — the same pass
  // with the write suppressed, so the preview cannot promise more than the
  // import delivers. Answers directly rather than over the socket.
  previewProcessed: (seriesId: string, chapterIds?: string[]) =>
    fetchApi<Clipper3SyncPreview>(
      `/clipper3/series/${seriesId}/sync-processed/preview`,
      { method: 'POST', body: JSON.stringify({ chapterIds }) }
    ),

  // Imports hand-made crop JSON sitting in each chapter's `Processed/` folder
  // and attaches it to the pages it names. Background job — the outcome
  // arrives over `clipper3:sync-*`. Omitting chapterIds syncs the whole series.
  syncProcessed: (seriesId: string, chapterIds?: string[]) =>
    fetchApi<{ started: boolean; chapters: number }>(
      `/clipper3/series/${seriesId}/sync-processed`,
      { method: 'POST', body: JSON.stringify({ chapterIds }) }
    ),

  // How many attached pages the selected chapters are carrying, so the
  // confirmation dialog names a real number before anything is deleted.
  previewUnsyncProcessed: (seriesId: string, chapterIds: string[]) =>
    fetchApi<Clipper3UnsyncPreview>(
      `/clipper3/series/${seriesId}/unsync-processed/preview`,
      { method: 'POST', body: JSON.stringify({ chapterIds }) }
    ),

  // Removes the attached crop JSON and metadata from the selected chapters'
  // store, putting those pages back to pending. The hand-made files under
  // `Processed/` are left alone, so Sync json can re-attach them. Background
  // job — the outcome arrives over `clipper3:unsync-*`. chapterIds is required:
  // unsyncing a whole series by accident would clear hand-pasted work too.
  unsyncProcessed: (seriesId: string, chapterIds: string[]) =>
    fetchApi<{ started: boolean; chapters: number }>(
      `/clipper3/series/${seriesId}/unsync-processed`,
      { method: 'POST', body: JSON.stringify({ chapterIds }) }
    ),

  // Runs in the background — progress arrives over `clipper3:slice-*`.
  // Omitting chapterIds slices the whole series.
  sliceSeries: (seriesId: string, chapterIds?: string[]) =>
    fetchApi<{ started: boolean; chapters: number; images: number }>(
      `/clipper3/series/${seriesId}/slices`,
      { method: 'POST', body: JSON.stringify({ chapterIds }) }
    ),

  // Cuts every image that has its own artifact; progress over 'clipper3:crop-*'.
  crop: (chapterId: string) =>
    fetchApi<{ started: boolean; images: number }>(`/clipper3/chapters/${chapterId}/crop`, {
      method: 'POST'
    }),

  getOutputs: (chapterId: string) =>
    fetchApi<{ exportDir: string | null; files: Clipper3Output[] }>(
      `/clipper3/chapters/${chapterId}/outputs`
    ),

  getOutputUrl: (chapterId: string, filename: string) =>
    `${API_BASE}/clipper3/chapters/${chapterId}/output/${encodeURIComponent(filename)}`
}

// Murgaa API — the reference popup in the narration Script/Voiceover headers.
// One global config per page scope, shared across every series and chapter.
export type MurgaaScope = 'script' | 'voice' | 'clipper3' | 'editor2'

export interface MurgaaApp {
  id: string
  name: string
  /** Config still points at this application's file, but it's gone from disk. */
  missing: boolean
}

export interface MurgaaConfig {
  scope: MurgaaScope
  description: string
  imageName: string | null
  hasImage: boolean
  apps: MurgaaApp[]
  updatedAt: string | null
}

export const murgaaApi = {
  get: (scope: MurgaaScope) =>
    fetchApi<MurgaaConfig>(`/murgaa/${scope}`),

  updateDescription: (scope: MurgaaScope, description: string) =>
    fetchApi<MurgaaConfig>(`/murgaa/${scope}`, {
      method: 'PUT',
      body: JSON.stringify({ description })
    }),

  // Cache-busted so a freshly uploaded image replaces the old one in-place.
  imageUrl: (scope: MurgaaScope, version?: string | null) =>
    `${API_BASE}/murgaa/${scope}/image${version ? `?v=${encodeURIComponent(version)}` : ''}`,

  uploadImage: (scope: MurgaaScope, file: File) => {
    const formData = new FormData()
    formData.append('file', file)
    return fetch(`${API_BASE}/murgaa/${scope}/image`, {
      method: 'POST',
      body: formData
    }).then(async res => {
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Image upload failed' }))
        throw new Error(err.error || 'Image upload failed')
      }
      return res.json() as Promise<MurgaaConfig>
    })
  },

  // Adds a new application to the list — never replaces an existing one.
  addApp: (scope: MurgaaScope, file: File) => {
    const formData = new FormData()
    formData.append('file', file)
    return fetch(`${API_BASE}/murgaa/${scope}/apps`, {
      method: 'POST',
      body: formData
    }).then(async res => {
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Application upload failed' }))
        throw new Error(err.error || 'Application upload failed')
      }
      return res.json() as Promise<MurgaaConfig>
    })
  },

  renameApp: (scope: MurgaaScope, appId: string, name: string) =>
    fetchApi<MurgaaConfig>(`/murgaa/${scope}/apps/${appId}`, {
      method: 'PUT',
      body: JSON.stringify({ name })
    }),

  removeApp: (scope: MurgaaScope, appId: string) =>
    fetchApi<MurgaaConfig>(`/murgaa/${scope}/apps/${appId}`, { method: 'DELETE' }),

  launchApp: (scope: MurgaaScope, appId: string) =>
    fetchApi<{ message: string }>(`/murgaa/${scope}/apps/${appId}/launch`, { method: 'POST' })
}

// ============ Storage: local disk usage + reclaiming it ============

export type StorageCategoryKey =
  | 'pages' | 'crops' | 'cropJson' | 'audio' | 'script' | 'video' | 'other'

export interface StorageCategoryMeta {
  key: StorageCategoryKey
  label: string
  description: string
  reclaimable: boolean
}

export type StorageSizes = Record<StorageCategoryKey, number>

export interface ChapterStorage {
  id: string
  number: number
  title: string | null
  folderPath: string
  exists: boolean
  status: string
  pageCount: number | null
  sizes: StorageSizes
  totalBytes: number
  reclaimableBytes: number
  fileCount: number
  exported: boolean
  exportedVia: 'editor2' | null
}

export interface SeriesStorage {
  id: string
  title: string
  rootFolder: string
  exists: boolean
  sizes: StorageSizes
  totalBytes: number
  reclaimableBytes: number
  fileCount: number
  chapterCount: number
  exportedChapterCount: number
  safeToDeleteBytes: number
  videoBytes: number
  videoFileCount: number
  chapters: ChapterStorage[]
}

export interface StorageOverview {
  downloadRoot: string
  totalBytes: number
  reclaimableBytes: number
  safeToDeleteBytes: number
  videoBytes: number
  sharedBytes: number
  series: SeriesStorage[]
  scannedAt: string
}

export interface StorageDeleteResult {
  chapterId: string
  chapterNumber: number
  categories: StorageCategoryKey[]
  freedBytes: number
  skipped?: string
}

export interface StorageVideoFile {
  seriesId: string
  dir: '_video' | '_video2'
  fileName: string
  bytes: number
  modifiedAt: string
  chapterNumber: number | null
}

export interface PublishedMap {
  chapters: Record<string, boolean>
  series: Record<string, { published: number; total: number }>
  scannedAt: string
}

export const storageApi = {
  getOverview: () => fetchApi<StorageOverview>('/storage/overview'),

  // Cheap per-chapter "has a rendered video" lookup for the module pages.
  getPublished: (seriesId?: string) =>
    fetchApi<PublishedMap>(`/storage/published${seriesId ? `?seriesId=${seriesId}` : ''}`),

  getCategories: () => fetchApi<StorageCategoryMeta[]>('/storage/categories'),

  getSeriesVideos: (seriesId: string) =>
    fetchApi<StorageVideoFile[]>(`/storage/series/${seriesId}/videos`),

  deleteChapterData: (
    chapterId: string,
    categories: StorageCategoryKey[],
    allowUnexported = false
  ) =>
    fetchApi<StorageDeleteResult>(`/storage/chapters/${chapterId}/delete`, {
      method: 'POST',
      body: JSON.stringify({ categories, allowUnexported })
    }),

  deleteSeriesData: (
    seriesId: string,
    categories: StorageCategoryKey[],
    allowUnexported = false
  ) =>
    fetchApi<{ results: StorageDeleteResult[]; freedBytes: number }>(
      `/storage/series/${seriesId}/delete`,
      { method: 'POST', body: JSON.stringify({ categories, allowUnexported }) }
    ),

  deleteVideo: (seriesId: string, dir: string, fileName: string) =>
    fetchApi<{ freedBytes: number }>(
      `/storage/series/${seriesId}/videos/${dir}/${encodeURIComponent(fileName)}`,
      { method: 'DELETE' }
    )
}

// ============ Cloudflare R2 backup ============

export type R2SeriesState = 'queued' | 'zipping' | 'uploading' | 'done' | 'skipped' | 'failed' | 'cancelled'

export interface R2SeriesProgress {
  seriesId: string
  title: string
  state: R2SeriesState
  /** Unpublished chapters that go in the zip. */
  chaptersIncluded: number
  /** Published chapters left out. */
  chaptersPublished: number
  zipBytesTotal: number
  zipBytesDone: number
  /** Size of the finished zip, and how much has reached R2. */
  uploadBytesTotal: number
  uploadBytesDone: number
  /** Object key in the bucket once uploaded. */
  key?: string
  /** Why a series was skipped. */
  note?: string
  error?: string
}

export interface R2UploadJob {
  id: string
  state: 'running' | 'done' | 'cancelled'
  bucket: string
  startedAt: string
  finishedAt?: string
  series: R2SeriesProgress[]
}

export interface R2Status {
  configured: boolean
  missing: string[]
  bucket: string | null
  prefix: string
  job: R2UploadJob | null
}

export interface R2Config {
  configured: boolean
  missing: string[]
  accountId: string
  bucket: string
  prefix: string
  concurrency: number
  hasAccessKey: boolean
  accessKeyHint: string | null
  hasSecret: boolean
}

export interface R2ConfigUpdate {
  accountId?: string
  bucket?: string
  prefix?: string
  concurrency?: number
  accessKeyId?: string
  secretAccessKey?: string
  clearKeys?: boolean
}

export interface R2Usage {
  bucket: string
  /** "2026-09" — calendar month, UTC. */
  month: string
  resetsAt: string
  limits: { storageBytes: number; classA: number; classB: number }
  storage: {
    bytes: number
    objectCount: number
    measuredAt: string
    /** Largest first. */
    objects: { key: string; size: number; lastModified: string | null }[]
  }
  /** Requests sent by Manhwa Studio this month. */
  ops: { classA: number; classB: number; free: number; ops: Record<string, number>; since: string }
}

export interface PhoneSeriesSync {
  /**
   * downloaded:  the phone has unzipped the zip now in R2
   * downloading: the phone is downloading it
   * outdated:    the phone has an earlier upload of this series
   * missing:     the phone has none
   */
  state: 'downloaded' | 'downloading' | 'outdated' | 'missing'
  /** When the phone finished unzipping the copy it has. */
  phoneAt: string | null
  /** When the zip now in R2 was uploaded. */
  uploadedAt: string | null
}

/** What the Sleeper-Cell phone app has downloaded, from the receipt it writes to R2. */
export interface PhoneSyncStatus {
  configured: boolean
  /** When the phone last reported; null if it never has. */
  reportedAt: string | null
  device: string | null
  /** By series id; only series with a zip in R2. */
  series: Record<string, PhoneSeriesSync>
}

/**
 * A chapter's narration script on the Sleeper-Cell phone:
 *   done:          script, summary and closing saved, so the next chapter can follow
 *   needs_summary: a script was saved without its summary or closing paragraph
 *   stale:         an earlier chapter was saved again after this one
 */
export interface PhoneChapterScript {
  status: 'done' | 'needs_summary' | 'stale'
  /** When the phone saved the reply. */
  savedAt: string | null
}

/** Scripts written on the Sleeper-Cell phone, from the receipt it writes to R2 after each save. */
export interface PhoneScriptsStatus {
  configured: boolean
  /** When the phone last reported; null if it never has. */
  reportedAt: string | null
  device: string | null
  /** By series id: chapters done on the phone out of those it has. */
  series: Record<string, { done: number; total: number }>
  /** By chapter id, for the series asked for; chapters with no script are left out. */
  chapters: Record<string, PhoneChapterScript>
}

/**
 * A page's crop JSON on the Sleeper-Cell phone (Image Clipper's Auto-run):
 *   done:        crop pointers and metadata generated
 *   in_progress: sections made, the ChatGPT rounds not finished
 *   changed:     the page file was replaced since it was started, so it starts over
 */
export type PhonePageState = 'done' | 'in_progress' | 'changed'

/** Crop pointers made on the Sleeper-Cell phone, from the receipt it writes to R2 as pages start and finish. */
export interface PhoneCropsStatus {
  configured: boolean
  /** When the phone last reported; null if it never has. */
  reportedAt: string | null
  device: string | null
  /** By series id: pages done on the phone out of those it has. */
  series: Record<string, { done: number; total: number }>
  /** By chapter id, for the series asked for; chapters with no page started are left out. */
  chapters: Record<string, { done: number; total: number }>
  /** The page Auto-run is on in the series asked for, or null when it isn't running there. */
  working: { chapterId: string; page: string; since: string | null; paused: boolean } | null
  /** By image filename, for the chapter asked for; pages not started are left out. */
  pages: Record<string, PhonePageState>
}

/** The script zip the phone uploads once every chapter of a series is done ("Zip and upload to R2"). */
export interface PhoneScriptsZip {
  key: string
  etag: string
  size: number
  uploadedAt: string | null
}

export interface PhoneScriptsZipStatus {
  configured: boolean
  /** Null until the phone has uploaded one for this series. */
  zip: PhoneScriptsZip | null
  /** The zip last imported into this series, if any. */
  lastImport: { etag: string; at: string; chapters: number } | null
}

/**
 * What importing does to one chapter:
 *   new:     the desktop has no script yet
 *   replace: the desktop has a different script
 *   same:    the desktop already has exactly this script, summary and closing
 */
export interface PhoneImportChapter {
  chapterId: string
  number: number
  folder: string
  action: 'new' | 'replace' | 'same'
  desktopStatus: string | null
  hasSummary: boolean
  hasClosing: boolean
  savedAt: string | null
  /** Voiceover sections were already split from the desktop's script. */
  hasVoiceover: boolean
  published: boolean
}

export interface PhoneImportPreview {
  zip: PhoneScriptsZip
  chapters: PhoneImportChapter[]
  /** Chapter folders in the zip with no matching chapter here. */
  unmatched: string[]
  /** set: series has none · replace: phone has chapter 1 · keep: desktop's is kept · same · none: zip has no about */
  about: 'set' | 'replace' | 'keep' | 'same' | 'none'
}

export const r2Api = {
  getStatus: () => fetchApi<R2Status>('/r2/status'),

  /** `fresh` re-lists the bucket instead of using the server's one-minute cache. */
  getPhoneSync: (fresh = false) => fetchApi<PhoneSyncStatus>(`/r2/phone${fresh ? '?fresh=1' : ''}`),

  /** With `seriesId`, also that series' chapters. */
  getPhoneScripts: (seriesId?: string) =>
    fetchApi<PhoneScriptsStatus>(`/r2/phone/scripts${seriesId ? `?seriesId=${encodeURIComponent(seriesId)}` : ''}`),

  /** With `seriesId`, also that series' chapters and the page Auto-run is on; with `chapterId`, that chapter's pages. */
  getPhoneCrops: (seriesId?: string, chapterId?: string) => {
    const params = new URLSearchParams()
    if (seriesId) params.set('seriesId', seriesId)
    if (chapterId) params.set('chapterId', chapterId)
    const query = params.toString()
    return fetchApi<PhoneCropsStatus>(`/r2/phone/crops${query ? `?${query}` : ''}`)
  },

  getPhoneScriptsZip: (seriesId: string) =>
    fetchApi<PhoneScriptsZipStatus>(`/r2/phone/scripts/zip?seriesId=${encodeURIComponent(seriesId)}`),

  /** Downloads and parses the phone's script zip; nothing is changed yet. */
  previewPhoneScripts: (seriesId: string) =>
    fetchApi<PhoneImportPreview>('/r2/phone/scripts/preview', {
      method: 'POST',
      body: JSON.stringify({ seriesId })
    }),

  /** Attaches the previewed zip's scripts to `chapterIds`. */
  importPhoneScripts: (seriesId: string, etag: string, chapterIds: string[]) =>
    fetchApi<{ imported: number; aboutUpdated: boolean }>('/r2/phone/scripts/import', {
      method: 'POST',
      body: JSON.stringify({ seriesId, etag, chapterIds })
    }),

  getUsage: () => fetchApi<R2Usage>('/r2/usage'),

  deleteObject: (key: string) =>
    fetchApi<{ ok: true }>(`/r2/objects?key=${encodeURIComponent(key)}`, { method: 'DELETE' }),

  getConfig: () => fetchApi<R2Config>('/r2/config'),

  saveConfig: (update: R2ConfigUpdate) =>
    fetchApi<R2Config>('/r2/config', { method: 'PUT', body: JSON.stringify(update) }),

  test: () => fetchApi<{ ok: true; bucket: string }>('/r2/test', { method: 'POST' }),

  upload: (seriesIds: string[]) =>
    fetchApi<R2UploadJob>('/r2/upload', {
      method: 'POST',
      body: JSON.stringify({ seriesIds })
    }),

  cancel: () => fetchApi<{ job: R2UploadJob | null }>('/r2/cancel', { method: 'POST' })
}
