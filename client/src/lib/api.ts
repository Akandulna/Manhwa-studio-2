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
    const error = await response.json().catch(() => ({ error: 'Request failed' }))
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
    fetchApi<{ count: number; sections: AudioSection[] }>(`/voiceover/chapters/${chapterId}/init-sections`, {
      method: 'POST',
      body: JSON.stringify({ targetLength })
    }),
  
  updateSection: (sectionId: string, text: string) =>
    fetchApi<AudioSection>(`/voiceover/sections/${sectionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ text })
    }),
  
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
  getVoices: () =>
    fetchApi<{ provider: string; voices: VoiceInfo[] }>('/voiceover/voices'),
  
  // Audio streaming URL
  getAudioStreamUrl: (audioFileId: string) =>
    `${API_BASE}/voiceover/audio/${audioFileId}/stream`,
  
  getAudioDownloadUrl: (audioFileId: string) =>
    `${API_BASE}/voiceover/audio/${audioFileId}/download`
}

// ============ Image Clipper API (Module 3) ============

export interface ClipperSeries {
  id: string
  title: string
  sourceSite: string
  coverPath?: string
  rootFolder: string
  createdAt: string
  eligibleChapterCount: number
  croppedChapterCount: number
}

export interface ClipperChapterSummary {
  id: string
  number: number
  title?: string
  folderPath: string
  pageCount?: number
  hasSession: boolean
  sessionId: string | null
  sessionStatus: string | null
  cropCount: number
}

export interface ClipperSeriesDetail {
  id: string
  title: string
  sourceSite: string
  coverPath?: string
  rootFolder: string
  createdAt: string
  chapters: ClipperChapterSummary[]
}

/**
 * One source slice in both spaces. Webtoon chapters mix slice widths, so the canvas
 * scales every page up to the widest one; source pixels and canvas pixels are then
 * different units for any page with `scale !== 1`.
 *
 * Viewers must lay pages out with `manifest.canvasWidth` and `canvasHeight` — the
 * canvas extents — and never with `width`/`height`, which are the source file's own
 * pixels and would leave narrower pages as short, ragged columns.
 */
export interface ManifestImage {
  filename: string
  /** Source pixel width. */
  width: number
  /** Source pixel height. */
  height: number
  /** Top offset on the canvas, in canvas pixels. */
  canvasY: number
  /** This slice's canvas-space height (`height * scale`). */
  canvasHeight: number
  /** `manifest.canvasWidth / width` — always >= 1. */
  scale: number
}

export interface ImageManifest {
  canvasWidth: number
  canvasHeight: number
  images: ManifestImage[]
}

export interface CropData {
  id: string
  sessionId: string
  sequence: number
  canvasX: number
  canvasY: number
  canvasW: number
  canvasH: number
  normX: number
  normY: number
  normW: number
  normH: number
  sourceFiles: string
  aspectRatio?: string
  exportPath?: string
  createdAt: string
  updatedAt: string
}

export interface CropSession {
  id: string
  chapterId: string
  status: string
  cropCount: number
  crops: CropData[]
  chapter?: {
    id: string
    number: number
    folderPath: string
    seriesId: string
  }
  navigation?: {
    seriesId: string
    prevChapterId: string | null
    prevChapterNumber: number | null
    nextChapterId: string | null
    nextChapterNumber: number | null
  }
}

export const clipperApi = {
  // Series listing
  getSeries: () => fetchApi<ClipperSeries[]>('/clipper/series'),

  getSeriesDetail: (id: string) =>
    fetchApi<ClipperSeriesDetail>(`/clipper/series/${id}`),

  // Chapter operations
  getManifest: (chapterId: string) =>
    fetchApi<ImageManifest>(`/clipper/chapters/${chapterId}/manifest`),

  getImageUrl: (chapterId: string, filename: string) =>
    `${API_BASE}/clipper/chapters/${chapterId}/image/${encodeURIComponent(filename)}`,

  // Session operations
  createSession: (chapterId: string) =>
    fetchApi<CropSession>(`/clipper/chapters/${chapterId}/session`, {
      method: 'POST'
    }),

  getSession: (sessionId: string) =>
    fetchApi<CropSession>(`/clipper/sessions/${sessionId}`),

  // Crop operations
  createCrop: (sessionId: string, data: {
    canvasX: number
    canvasY: number
    canvasW: number
    canvasH: number
    aspectRatio?: string
  }) =>
    fetchApi<CropData>(`/clipper/sessions/${sessionId}/crops`, {
      method: 'POST',
      body: JSON.stringify(data)
    }),

  updateCrop: (cropId: string, data: {
    canvasX?: number
    canvasY?: number
    canvasW?: number
    canvasH?: number
    aspectRatio?: string
  }) =>
    fetchApi<CropData>(`/clipper/crops/${cropId}`, {
      method: 'PATCH',
      body: JSON.stringify(data)
    }),

  deleteCrop: (cropId: string) =>
    fetchApi<{ message: string }>(`/clipper/crops/${cropId}`, {
      method: 'DELETE'
    }),

  previewCrop: (cropId: string) =>
    fetchApi<{ preview: string }>(`/clipper/crops/${cropId}/preview`, {
      method: 'POST'
    }),

  reorderCrops: (sessionId: string, cropIds: string[]) =>
    fetchApi<{ message: string }>(`/clipper/sessions/${sessionId}/reorder`, {
      method: 'PUT',
      body: JSON.stringify({ cropIds })
    }),

  finalize: (sessionId: string) =>
    fetchApi<{ started: boolean; message: string }>(`/clipper/sessions/${sessionId}/finalize`, {
      method: 'POST'
    })
}

// ============ Module 3: Watermark white-fill ============

export interface WatermarkTemplate {
  id: string
  seriesId: string
  label: string
  width: number
  height: number
  threshold: number
  enabled: boolean
  createdAt: string
}

export interface WatermarkDetectResult {
  rects: { canvasX: number; canvasY: number; canvasW: number; canvasH: number }[]
  manifest: ImageManifest
}

export const watermarkApi = {
  getStatus: () => fetchApi<{ available: boolean; error?: string }>('/watermark/status'),

  listTemplates: (seriesId: string) =>
    fetchApi<WatermarkTemplate[]>(`/watermark/series/${seriesId}/templates`),

  createTemplate: (seriesId: string, data: {
    chapterId: string
    canvasX: number
    canvasY: number
    canvasW: number
    canvasH: number
    label?: string
  }) =>
    fetchApi<WatermarkTemplate>(`/watermark/series/${seriesId}/templates`, {
      method: 'POST',
      body: JSON.stringify(data)
    }),

  updateTemplate: (id: string, data: { label?: string; threshold?: number; enabled?: boolean }) =>
    fetchApi<{ id: string; label: string; threshold: number; enabled: boolean }>(`/watermark/templates/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data)
    }),

  deleteTemplate: (id: string) =>
    fetchApi<{ deleted: boolean }>(`/watermark/templates/${id}`, { method: 'DELETE' }),

  templateFileUrl: (id: string) => `${API_BASE}/watermark/templates/${id}/file`,

  detect: (chapterId: string) =>
    fetchApi<WatermarkDetectResult>(`/watermark/chapters/${chapterId}/detect`, { method: 'POST' })
}

// ============ Module 3 AI: Auto-Crop ============

export type CropEngine = 'guidelines' | 'trained'

export interface AiCropStatus {
  sidecarAvailable: boolean
  sidecarError?: string
  sampleCount: number
  minSamples: number
  canTrain: boolean
  activeModelVersion: number | null
  modelCount: number
  backboneAvailable: boolean
  engine: CropEngine
  geminiAvailable: boolean
  guidelinesPresent: boolean
  guidelinesUpdatedAt: string | null
}

export interface CropGuidelines {
  content: string
  updatedAt: string | null
  readOnly: boolean
  present: boolean
}

export interface AiSuggestion {
  id: string
  modelId?: string | null
  cropSessionId: string
  chapterId: string
  canvasX: number
  canvasY: number
  canvasW: number
  canvasH: number
  aspectPreset: string
  confidence: number
  status: 'pending' | 'accepted' | 'adjusted' | 'rejected'
  rating?: 'up' | 'down' | null
}

export const aiCropApi = {
  getStatus: () => fetchApi<AiCropStatus>('/ai-crop/status'),

  suggest: (cropSessionId: string) =>
    fetchApi<{ started: boolean }>('/ai-crop/suggest', {
      method: 'POST',
      body: JSON.stringify({ cropSessionId })
    }),

  cancel: (cropSessionId: string) =>
    fetchApi<{ cancelled: number }>('/ai-crop/cancel', {
      method: 'POST',
      body: JSON.stringify({ cropSessionId })
    }),

  getSuggestions: (cropSessionId: string, status: string = 'pending') =>
    fetchApi<AiSuggestion[]>(`/ai-crop/suggestions?cropSessionId=${cropSessionId}&status=${status}`),

  clearSuggestions: (cropSessionId: string) =>
    fetchApi<{ cleared: boolean }>('/ai-crop/suggestions/clear', {
      method: 'POST',
      body: JSON.stringify({ cropSessionId })
    }),

  updateSuggestion: (id: string, data: {
    status?: 'pending' | 'accepted' | 'adjusted' | 'rejected'
    finalRect?: { canvasX: number; canvasY: number; canvasW: number; canvasH: number }
    rating?: 'up' | 'down' | null
  }) =>
    fetchApi<{ id: string; status: string; rating?: string | null }>(`/ai-crop/suggestions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data)
    }),

  train: () =>
    fetchApi<{ started: boolean }>('/ai-crop/train', { method: 'POST' }),

  cancelTraining: () =>
    fetchApi<{ cancelled: number }>('/ai-crop/cancel', {
      method: 'POST',
      body: JSON.stringify({ scope: 'train' })
    }),

  getModels: () => fetchApi<AiModelInfo[]>('/ai-crop/models'),

  setActiveModel: (version: number) =>
    fetchApi<{ engine: CropEngine; activeModelVersion: number | null }>('/ai-crop/model/active', {
      method: 'POST',
      body: JSON.stringify({ version })
    }),

  getGuidelines: () => fetchApi<CropGuidelines>('/ai-crop/guidelines'),

  updateGuidelines: (content: string) =>
    fetchApi<{ updatedAt: string | null; readOnly: boolean; present: boolean }>('/ai-crop/guidelines', {
      method: 'PUT',
      body: JSON.stringify({ content })
    }),

  getEvalChapters: () => fetchApi<EvalChapters>('/ai-crop/eval-chapters'),

  getEvaluations: () => fetchApi<EvaluationRunInfo[]>('/ai-crop/evaluations'),

  evaluate: (chapterIds: string[]) =>
    fetchApi<{ started: boolean }>('/ai-crop/evaluate', {
      method: 'POST',
      body: JSON.stringify({ chapterIds })
    }),

  cancelEvaluation: () =>
    fetchApi<{ cancelled: number }>('/ai-crop/cancel', {
      method: 'POST',
      body: JSON.stringify({ scope: 'evaluate' })
    })
}

export interface AiCropMetrics {
  meanIoU: number | null
  precision?: number | null
  recall?: number | null
  f1?: number | null
  countAccuracy?: number | null
  presetAccuracy: number | null
  [k: string]: number | null | undefined
}

export interface AiModelInfo {
  id: string
  /** 0 = the built-in guideline (Gemini) cropper; ≥1 = a trained model. */
  version: number
  kind?: 'guidelines' | 'trained'
  label?: string
  status: 'training' | 'ready' | 'failed'
  trainingSampleCount: number
  metrics: AiCropMetrics | null
  hyperparams: Record<string, unknown> | null
  notes?: string | null
  createdAt: string
  active: boolean
}

export interface EvalChapterSummary {
  id: string
  number: number
  title?: string | null
  seriesTitle: string
  cropCount: number
}

export interface EvalChapters {
  holdout: EvalChapterSummary[]
  blind: EvalChapterSummary[]
}

export interface EvalRect {
  canvasX: number
  canvasY: number
  canvasW: number
  canvasH: number
  aspectPreset?: string
  confidence?: number
}

export interface EvalPerChapter {
  chapterId: string
  metrics: {
    meanIoU: number | null
    precision: number
    recall: number
    f1: number
    countAccuracy: number
    presetAccuracy: number | null
    userCount: number
    aiCount: number
    matched: number
  }
  aiCrops: EvalRect[]
}

export interface EvaluationRunInfo {
  id: string
  modelId?: string | null
  mode: string
  chapterIds: string[]
  metrics: {
    aggregate: AiCropMetrics & { chapterCount: number }
    perChapter: EvalPerChapter[]
  }
  createdAt: string
}

// ============ Module 3 v2: Image Clipper 2.0 ============

// Mirrors server/src/services/clipper2/fourPointTypes.ts. Point order is fixed:
// P1 top-left, P2 top-right, P3 bottom-right, P4 bottom-left.
export interface Clipper2Point {
  id: 'P1' | 'P2' | 'P3' | 'P4'
  x: number
  y: number
}

export interface Clipper2CropEntry {
  id: string
  reason: string
  crop: {
    mode: 'rectangle'
    points: Clipper2Point[]
  }
}

// The canonical on-disk artifact — the contract between detect and apply.
export interface Clipper2PointFile {
  format: string
  version: string
  image: {
    filename: string
    width: number
    height: number
  }
  coordinateSystem: string
  crops: Clipper2CropEntry[]
}

export interface Clipper2Issue {
  code: string
  /** The guidelines rule this enforces, e.g. 'OUT-08'. Empty for structural JSON errors. */
  rule: string
  message: string
  cropId?: string
  severity: 'error' | 'warning'
}

export interface Clipper2Validation {
  valid: boolean
  errors: Clipper2Issue[]
  warnings: Clipper2Issue[]
}

export interface Clipper2Segment {
  filename: string
  width: number
  height: number
  canvasY: number
}

// Non-canonical provenance file (crop_points.meta.json), kept outside the artifact.
export interface Clipper2Sidecar {
  source: string
  model: string | null
  guidelinesSha: string | null
  detectedAt: string
  segments: Clipper2Segment[]
  warnings: Clipper2Issue[]
}

/**
 * Which Stage 1 engine to run. `gemini` uploads downscaled pages to a vision
 * model; `offline` runs classical CV locally against the source pixels — no key,
 * no quota, no upload. Both write the same artifact.
 */
export type Clipper2Engine = 'gemini' | 'offline'

/** Body of a detect request. Every tunable applies to the offline engine only. */
export interface Clipper2DetectOptions {
  engine?: Clipper2Engine
  /** 'auto' reads each page's own margins; the others force the polarity. */
  gutterMode?: 'auto' | 'dark' | 'light'
  /** Smallest region that can be a section, in canvas px². */
  minPanelArea?: number
  /** Breathing room added to every edge so line art is never clipped, in px. */
  breakoutMargin?: number
  /** Exclude speech bubbles, narration boxes and watermarks. */
  filterOverlays?: boolean
}

export interface Clipper2Status {
  /** Whether GEMINI_API_KEY is configured — detection calls Gemini, no local model. */
  geminiAvailable: boolean
  geminiError: string | null
  /** Whether the Python venv backing the offline detector is installed. */
  offlineAvailable: boolean
  offlineError: string | null
  offlineModel: string
  guidelinesPresent: boolean
  guidelinesUpdatedAt: string | null
  guidelinesIsDefault: boolean
  model: string
  format: string
  formatVersion: string
}

export interface Clipper2Guidelines {
  content: string
  updatedAt: string | null
  readOnly: boolean
  present: boolean
  isDefault: boolean
}

export interface Clipper2ChapterSummary {
  id: string
  number: number
  title: string | null
  seriesId: string
  seriesTitle: string
  pageCount: number
  hasPoints: boolean
  cropCount: number
  /** 'detecting' | 'detected' | 'edited' | 'applied' | 'failed', or null when untouched. */
  status: string | null
  detectedAt: string | null
  appliedAt: string | null
  exportedCount: number
}

export interface Clipper2PointSet {
  chapterId: string
  /** Raw JSON text so the editor can round-trip hand edits; '' when no artifact exists. */
  content: string
  file: Clipper2PointFile | null
  sidecar: Clipper2Sidecar | null
  validation: Clipper2Validation
  status: string | null
  appliedAt: string | null
  exportDir: string | null
  jsonPath: string | null
  confidenceById: Record<string, number>
}

export interface Clipper2Output {
  filename: string
  bytes: number
  url: string
}

/** The text to paste into an external AI, composed server-side from the guidelines. */
export interface Clipper2Prompt {
  prompt: string
  guidelinesPresent: boolean
  guidelinesUpdatedAt: string | null
  guidelinesIsDefault: boolean
}

/**
 * The result of importing an external AI's JSON.
 *
 * Not a plain throw-on-error call: a rejected import is the interesting case, and
 * its 400 carries the full validation report that the UI renders rule-by-rule.
 * `repairs` on a success is equally load-bearing — the import deliberately fixes
 * what a model gets wrong (near-equal edges, id order, reason casing), and the user
 * is told exactly what changed rather than being handed a silently rewritten file.
 */
export type Clipper2ImportResult =
  | { ok: true; set: Clipper2PointSet; repairs: Clipper2Issue[] }
  | { ok: false; message: string; validation: Clipper2Validation | null }

export const clipper2Api = {
  getStatus: () => fetchApi<Clipper2Status>('/clipper2/status'),

  // Guidelines are user-upgradable from Settings; reset restores the shipped default.
  getGuidelines: () => fetchApi<Clipper2Guidelines>('/clipper2/guidelines'),

  updateGuidelines: (content: string) =>
    fetchApi<Clipper2Guidelines>('/clipper2/guidelines', {
      method: 'PUT',
      body: JSON.stringify({ content })
    }),

  resetGuidelines: () =>
    fetchApi<Clipper2Guidelines>('/clipper2/guidelines/reset', {
      method: 'POST'
    }),

  // The manual loop: copy this into an external chat that already holds the
  // chapter's pages, then bring the JSON back through importPoints().
  getPrompt: () => fetchApi<Clipper2Prompt>('/clipper2/prompt'),

  /**
   * Import an external AI's JSON, replacing the chapter's pointer file.
   *
   * Goes through a bare fetch rather than fetchApi because both outcomes carry a
   * body worth reading: a 400's `validation` report, and a success's `repairs`.
   * fetchApi would collapse the former to a message string and drop the latter.
   */
  importPoints: async (chapterId: string, content: string): Promise<Clipper2ImportResult> => {
    const response = await fetch(`${API_BASE}/clipper2/chapters/${chapterId}/points/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    })

    const payload = (await response.json().catch(() => null)) as
      | (Partial<Clipper2PointSet> & {
          error?: string
          validation?: Clipper2Validation
          repairs?: Clipper2Issue[]
        })
      | null

    if (response.ok) {
      if (!payload || typeof payload.content !== 'string') {
        return { ok: false, message: 'The server accepted the import but returned no artifact', validation: null }
      }
      return { ok: true, set: payload as Clipper2PointSet, repairs: payload.repairs ?? [] }
    }

    return {
      ok: false,
      message: payload?.error || `Import failed (HTTP ${response.status})`,
      validation: payload?.validation ?? null
    }
  },

  // Chapter listing
  getChapters: () => fetchApi<Clipper2ChapterSummary[]>('/clipper2/chapters'),

  // Stage 1 (detect) runs in the background; progress arrives over
  // 'clipper2:detect-progress' / 'clipper2:detect-complete'.
  // Omitting `opts` runs the Gemini engine, as it always has.
  detect: (chapterId: string, opts?: Clipper2DetectOptions) =>
    fetchApi<{ started: boolean; engine: Clipper2Engine }>(
      `/clipper2/chapters/${chapterId}/detect`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts ?? {})
      }
    ),

  cancel: (chapterId: string) =>
    fetchApi<{ cancelled: number }>(`/clipper2/chapters/${chapterId}/cancel`, {
      method: 'POST'
    }),

  // Point artifact operations
  getPoints: (chapterId: string) =>
    fetchApi<Clipper2PointSet>(`/clipper2/chapters/${chapterId}/points`),

  // A 400 from PUT /points carries a 'validation' payload describing why the edited
  // JSON was rejected; fetchApi surfaces its 'error' message as the thrown Error.
  savePoints: (chapterId: string, content: string) =>
    fetchApi<Clipper2PointSet>(`/clipper2/chapters/${chapterId}/points`, {
      method: 'PUT',
      body: JSON.stringify({ content })
    }),

  deletePoints: (chapterId: string) =>
    fetchApi<{ deleted: boolean }>(`/clipper2/chapters/${chapterId}/points`, {
      method: 'DELETE'
    }),

  // Stage 2 (apply) also runs in the background; see 'clipper2:apply-*' events.
  apply: (chapterId: string, opts?: { register?: boolean; replaceExisting?: boolean }) =>
    fetchApi<{ started: boolean }>(`/clipper2/chapters/${chapterId}/apply`, {
      method: 'POST',
      body: JSON.stringify(opts ?? {})
    }),

  previewCrop: (chapterId: string, cropId: string) =>
    fetchApi<{ preview: string }>(
      `/clipper2/chapters/${chapterId}/preview/${encodeURIComponent(cropId)}`,
      { method: 'POST' }
    ),

  getOutputs: (chapterId: string) =>
    fetchApi<{ exportDir: string | null; files: Clipper2Output[] }>(
      `/clipper2/chapters/${chapterId}/outputs`
    ),

  getPointsDownloadUrl: (chapterId: string) =>
    `${API_BASE}/clipper2/chapters/${chapterId}/points/download`,

  getOutputUrl: (chapterId: string, filename: string) =>
    `${API_BASE}/clipper2/chapters/${chapterId}/output/${encodeURIComponent(filename)}`
}

// ============ Image Clipper 2.0 Training (manual crop -> real PNG export, ============
// ============ no effect on crop_points.json / crops2 / CropSession / Module 4) ====

export interface TrainingChapterSummary {
  id: string
  number: number
  title: string | null
  seriesId: string
  seriesTitle: string
  pageCount: number
  exportedCount: number
}

export interface TrainingCropRect {
  canvasX: number
  canvasY: number
  canvasW: number
  canvasH: number
}

export interface TrainingExportedFile {
  filename: string
  bytes: number
  url: string
  width?: number
  height?: number
}

export interface TrainingExportResult {
  exported: number
  failed: number
  exportDir: string
  files: TrainingExportedFile[]
}

export const pointerTrainingApi = {
  getChapters: () => fetchApi<TrainingChapterSummary[]>('/clipper2/training/chapters'),

  export: (chapterId: string, crops: TrainingCropRect[]) =>
    fetchApi<TrainingExportResult>(`/clipper2/training/chapters/${chapterId}/export`, {
      method: 'POST',
      body: JSON.stringify({ crops })
    }),

  getOutputs: (chapterId: string) =>
    fetchApi<{ exportDir: string | null; files: TrainingExportedFile[] }>(
      `/clipper2/training/chapters/${chapterId}/outputs`
    ),

  clear: (chapterId: string) =>
    fetchApi<{ deleted: boolean }>(`/clipper2/training/chapters/${chapterId}`, {
      method: 'DELETE'
    })
}

// ============ Image Clipper 2.0 Training — manual image uploads ============
// A sandbox to test the crop tool on images that were never downloaded as a
// chapter: no Series/Chapter row is created, the upload lives purely as a
// folder on disk keyed by uploadId. Export/outputs/clear mirror pointerTrainingApi
// exactly, just addressed by uploadId instead of chapterId.

export interface TrainingUploadResult {
  uploadId: string
  manifest: ImageManifest
  pageCount: number
}

export const pointerTrainingUploadApi = {
  /**
   * Bare fetch: a FormData body must not get fetchApi's forced JSON
   * Content-Type header, or the browser never adds the multipart boundary.
   * `files` order is preserved end to end — the server names pages by
   * arrival order, not original filename.
   */
  upload: async (files: File[]): Promise<TrainingUploadResult> => {
    const form = new FormData()
    files.forEach(f => form.append('images', f))
    const response = await fetch(`${API_BASE}/clipper2/training/uploads`, { method: 'POST', body: form })
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      throw new Error(payload?.error || `Upload failed (HTTP ${response.status})`)
    }
    return payload as TrainingUploadResult
  },

  getImageUrl: (uploadId: string, filename: string) =>
    `${API_BASE}/clipper2/training/uploads/${uploadId}/image/${encodeURIComponent(filename)}`,

  export: (uploadId: string, crops: TrainingCropRect[]) =>
    fetchApi<TrainingExportResult>(`/clipper2/training/uploads/${uploadId}/export`, {
      method: 'POST',
      body: JSON.stringify({ crops })
    }),

  getOutputs: (uploadId: string) =>
    fetchApi<{ exportDir: string | null; files: TrainingExportedFile[] }>(
      `/clipper2/training/uploads/${uploadId}/outputs`
    ),

  /** Clears exported PNGs only — the uploaded source images stay put. */
  clearOutputs: (uploadId: string) =>
    fetchApi<{ deleted: boolean }>(`/clipper2/training/uploads/${uploadId}/outputs`, {
      method: 'DELETE'
    }),

  /** Deletes the whole sandbox session (source images + exports) — "start over". */
  remove: (uploadId: string) =>
    fetchApi<{ deleted: boolean }>(`/clipper2/training/uploads/${uploadId}`, {
      method: 'DELETE'
    })
}

// ============ Video Editor API (Module 4) ============

export interface VideoCapabilities {
  ffmpegAvailable: boolean
  ffmpegVersion?: string
  hasZoompan: boolean
  hasDrawtext: boolean
  blurFilter: 'gblur' | 'boxblur' | null
  error?: string
  resolutions: string[]
  aiAssist?: boolean
}

export interface EditableChapter {
  id: string
  number: number
  title: string | null
  ready: boolean
  reason: string | null
  hasFinalizedCrops: boolean
  cropCount: number
  hasSectionAudio: boolean
  sectionCount: number
  isPartEnd: boolean
}

export interface ChapterCrop {
  id: string
  sequence: number
  imagePath: string
  aspectRatio: string | null
}

export interface VideoPartImage {
  id: string
  partEditId: string
  cropId: string | null
  imagePath: string | null
  isFiller: boolean
  slotIndex: number
  duration: number
  motionMode: string
  motionEffect: string
  motionIntensity: number
  anchorX: number | null
  anchorY: number | null
  scale: number | null
  offsetX: number | null
  offsetY: number | null
  source: string
}

export interface VideoPart {
  id: string
  chapterId: string
  audioSectionId: string | null
  orderIndex: number
  isOutro: boolean
  audioDuration: number
  scriptText: string | null
  images: VideoPartImage[]
}

export interface MusicTrack {
  id: string
  filename: string
  filePath: string
  createdAt: string
}

export interface VideoProject {
  id: string
  seriesId: string
  seriesTitle: string
  name: string
  status: string
  chapterIds: string[]
  musicTrackId: string | null
  musicTrack: MusicTrack | null
  masterVolume: number
  musicVolume: number
  titleCardText: string | null
  titleCardDuration: number
  createdAt: string
  updatedAt: string
  parts: VideoPart[]
}

export interface VideoExport {
  id: string
  projectId: string
  outputPath: string
  resolution: string
  preset: string
  fileSizeMb: number | null
  durationSec: number | null
  status: string
  errorMsg: string | null
  createdAt: string
}

export interface SeriesProjectChapter {
  chapterId: string
  number: number | null
  totalParts: number
  editedParts: number
}

export interface SeriesProjectSummary {
  id: string
  name: string
  status: string
  chapterIds: string[]
  totalParts: number
  editedParts: number
  progress: number // 0–100
  hasExport: boolean
  updatedAt: string
  chapters: SeriesProjectChapter[]
}

export interface IncomingPartImage {
  cropId?: string | null
  isFiller?: boolean
  duration?: number
  motionMode?: string
  motionEffect?: string
  motionIntensity?: number
  anchorX?: number | null
  anchorY?: number | null
  scale?: number | null
  offsetX?: number | null
  offsetY?: number | null
  source?: string
}

export const videoApi = {
  getCapabilities: () => fetchApi<VideoCapabilities>('/video/capabilities'),

  // Per-series status map for library badges ('draft' | 'exported').
  getSeriesStatus: () => fetchApi<Record<string, 'draft' | 'exported'>>('/video/series-status'),

  // Projects
  initProject: (data: { seriesId: string; chapterIds: string[]; name?: string }) =>
    fetchApi<VideoProject>('/video/projects/init', { method: 'POST', body: JSON.stringify(data) }),

  getProject: (id: string) => fetchApi<VideoProject>(`/video/projects/${id}`),

  // Existing projects ("parts") for a series, with editing-progress summaries.
  listSeriesProjects: (seriesId: string) =>
    fetchApi<SeriesProjectSummary[]>(`/video/series/${seriesId}/projects`),

  deleteProject: (id: string) =>
    fetchApi<{ deleted: boolean }>(`/video/projects/${id}`, { method: 'DELETE' }),

  updateProject: (id: string, patch: Partial<{
    name: string
    chapterIds: string[]
    musicTrackId: string | null
    masterVolume: number
    musicVolume: number
    titleCardText: string | null
    titleCardDuration: number
  }>) => fetchApi<VideoProject>(`/video/projects/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),

  // Editable chapters + crop pool
  getEditableChapters: (seriesId: string) =>
    fetchApi<EditableChapter[]>(`/video/series/${seriesId}/editable-chapters`),

  getChapterCrops: (chapterId: string) =>
    fetchApi<ChapterCrop[]>(`/video/chapters/${chapterId}/crops`),

  // Part image editing
  setPartImages: (partId: string, images: IncomingPartImage[], event?: { eventType: string; payload?: unknown }) =>
    fetchApi<VideoPart>(`/video/parts/${partId}/images`, {
      method: 'PUT',
      body: JSON.stringify({ images, event })
    }),

  // Render / export
  render: (id: string, opts: { resolution: string; preset: string; fps?: number }) =>
    fetchApi<{ exportId: string }>(`/video/projects/${id}/render`, { method: 'POST', body: JSON.stringify(opts) }),

  cancelRender: (exportId: string) =>
    fetchApi<{ cancelled: boolean }>(`/video/exports/${exportId}/cancel`, { method: 'POST' }),

  getExport: (exportId: string) => fetchApi<VideoExport>(`/video/exports/${exportId}`),

  openExport: (exportId: string) =>
    fetchApi<{ success: boolean; path: string }>(`/video/exports/${exportId}/open`),

  // Proxy preview (pixel-accurate draft)
  renderPreview: (id: string, scope: 'project' | { partId?: string; chapterId?: string }) =>
    fetchApi<{ started: boolean }>(`/video/projects/${id}/preview`, {
      method: 'POST',
      body: JSON.stringify({ scope })
    }),

  exportFileUrl: (exportId: string) => `${API_BASE}/video/exports/${exportId}/file`,
  previewFileUrl: (projectId: string) => `${API_BASE}/video/projects/${projectId}/preview/file`,
  partAudioUrl: (partId: string) => `${API_BASE}/video/parts/${partId}/audio`,
  cropImageUrl: (cropId: string) => `${API_BASE}/video/crops/${cropId}/image`,

  // Music library
  listMusic: () => fetchApi<MusicTrack[]>('/video/music'),

  uploadMusic: (file: File) => {
    const formData = new FormData()
    formData.append('track', file)
    return fetch(`${API_BASE}/video/music`, { method: 'POST', body: formData }).then(res => {
      if (!res.ok) throw new Error('Upload failed')
      return res.json() as Promise<MusicTrack>
    })
  },

  deleteMusic: (id: string) =>
    fetchApi<{ message: string }>(`/video/music/${id}`, { method: 'DELETE' }),

  musicFileUrl: (id: string) => `${API_BASE}/video/music/${id}/file`,

  // AI assist (Part 6)
  suggestImages: (partId: string, minSequence = 0) =>
    fetchApi<{ suggested: ChapterCrop[]; range: { start: number; end: number } | null }>(
      `/video/parts/${partId}/suggest-images`,
      { method: 'POST', body: JSON.stringify({ minSequence }) }
    ),

  suggestDurations: (partId: string) =>
    fetchApi<{ durations: number[] }>(`/video/parts/${partId}/suggest-durations`, { method: 'POST' }),

  suggestAnchor: (imageId: string) =>
    fetchApi<{ anchorX: number; anchorY: number }>(`/video/images/${imageId}/suggest-anchor`, { method: 'POST' }),

  logPartEvent: (partId: string, eventType: string, payload?: unknown) =>
    fetchApi<{ logged: boolean }>(`/video/parts/${partId}/event`, {
      method: 'POST',
      body: JSON.stringify({ eventType, payload })
    })
}
