import type { NarrationLanguage } from './narrationLanguage'

const API_BASE = '/api'
import type { ProcessSnapshot } from '../../../server/src/services/seriesProcessModel'
export type { ProcessSnapshot, ProcessSeries, ProcessPart, ProcessStage, StageCount } from '../../../server/src/services/seriesProcessModel'
export const libraryProgressApi = { get: () => fetchApi<ProcessSnapshot>('/library/progress') }

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
  /** Page files listed as downloaded but deleted from disk (series detail only). */
  missingPages?: number
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
  deleteEverywhere: (id: string) => fetchApi<{ deleting: boolean }>(`/series/${id}/delete-everywhere`, { method: 'POST' }),
  markPart: (id: string, part: number, done: boolean) => fetchApi(`/series/${id}/parts/${part}/completion`, { method: 'PUT', body: JSON.stringify({ done }) }),
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
  
  openFolder: (path: string) => openFolder(path),
  
  getStats: () => fetchApi<DownloadStats>('/downloads/stats')
}

/** Opens a folder under the library root in Finder. */
export const openFolder = (path: string) =>
  fetchApi<{ message: string }>('/settings/open-folder', {
    method: 'POST',
    body: JSON.stringify({ path })
  })

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

// ============ Narration API (Module 2) ============
//
// The Sleeper-Cell phones write the scripts and voice them; Narration fetches
// both from R2 and aligns them. Every call takes the narration language:
// English and Hindi are separate scripts and voiceovers on the server.

export interface NarrationSeries {
  id: string
  title: string
  sourceSite: string
  rootFolder: string
  chapterCount: number
  scriptedCount: number
  /** Chapters where every section has audio. */
  voicedCount: number
  /** Chapters where every section has a timeline. */
  alignedCount: number
}

export interface NarrationChapter {
  id: string
  number: number
  title?: string | null
  folderPath: string
  hasScript: boolean
  /** Voiceover sections (the phone's splits). */
  sections: number
  withAudio: number
  aligned: number
  /** Sections queued or aligning right now. */
  aligning: boolean
  /** script-timeline.md (script-timeline.hi.md) is in the chapter folder. */
  documentWritten: boolean
  /** When its voiceover was last fetched from the phone. */
  fetchedAt: string | null
}

/** A "Fetch from phone" run, from `narration:fetch` (and the series detail while it runs). */
export interface NarrationPhoneFetch {
  seriesId: string
  language: NarrationLanguage
  stage: 'scripts' | 'voiceover' | 'done' | 'failed'
  chapterNumber?: number
  current?: number
  total?: number
  scripts?: { imported: number; aboutUpdated: boolean } | null
  voiceovers?: PhoneVoiceoverFetch | null
  error?: string
}

export interface NarrationSeriesDetail {
  id: string
  title: string
  rootFolder: string
  language: NarrationLanguage
  chapters: NarrationChapter[]
  phoneFetch: NarrationPhoneFetch | null
}

/** One chapter zip the phone uploaded to R2, before anything is downloaded. */
export interface PhoneVoiceoverPreviewChapter {
  chapterId: string
  number: number
  folder: string
  /** new: never attached · changed: re-uploaded since · same: already attached from this zip */
  state: 'new' | 'changed' | 'same'
  bytes: number
  uploadedAt: string | null
}

/** What "Fetch from phone" would bring (see routes/narration.ts). */
export interface NarrationPhonePreview {
  configured: boolean
  /** Null when the phone hasn't uploaded a script zip (or it couldn't be read: see scriptsError). */
  scripts: PhoneImportPreview | null
  scriptsError: string | null
  voiceovers: { chapters: PhoneVoiceoverPreviewChapter[]; unmatched: string[] } | null
}

/** One chapter attached by a voiceover fetch. */
export interface PhoneVoiceoverChapter {
  chapterId: string
  chapterNumber: number
  folder: string
  sections: number
  /** The phone's splits differed from the chapter's sections, so they were replaced. */
  resplit: boolean
  /** Whether this chapter's script is the one the phone split; null when unknown. */
  scriptMatches: boolean | null
}

/** What fetching the phone's voiceovers from R2 did (see phoneVoiceoverImport.ts). */
export interface PhoneVoiceoverFetch {
  configured: boolean
  found: number
  fetched: PhoneVoiceoverChapter[]
  upToDate: number
  unmatched: string[]
  failed: { folder: string; reason: string }[]
}

export const narrationApi = {
  getSeries: (lang: NarrationLanguage) => fetchApi<NarrationSeries[]>(`/narration/series?lang=${lang}`),

  getSeriesDetail: (id: string, lang: NarrationLanguage) =>
    fetchApi<NarrationSeriesDetail>(`/narration/series/${id}?lang=${lang}`),

  getAlignmentStatus: () =>
    fetchApi<{ available: boolean; error?: string }>('/narration/alignment/status'),

  /** Reads R2 (the script zip and the voiceover listing) — only on a click. */
  previewPhone: (seriesId: string, lang: NarrationLanguage) =>
    fetchApi<NarrationPhonePreview>(`/narration/series/${seriesId}/phone/preview?lang=${lang}`, { method: 'POST' }),

  /** Starts the fetch; progress and the outcome arrive on `narration:fetch`. */
  fetchFromPhone: (
    seriesId: string,
    lang: NarrationLanguage,
    body: { scriptsEtag?: string; scriptChapterIds: string[]; voiceoverChapterIds: string[] }
  ) =>
    fetchApi<{ started: true }>(`/narration/series/${seriesId}/phone/fetch?lang=${lang}`, {
      method: 'POST',
      body: JSON.stringify(body)
    }),

  /** Aligns the unaligned sections again, or only writes a missing alignment document. */
  alignChapter: (chapterId: string, lang: NarrationLanguage) =>
    fetchApi<{ started: boolean; sections: number; documentWritten?: boolean }>(
      `/narration/chapters/${chapterId}/align?lang=${lang}`,
      { method: 'POST' }
    )
}

// ============ Module 4 v2: Editor 2.0 ============
//
// Series → chapters, each with a four-item readiness checklist: voiceover
// audio on disk, the alignment document, a stored timeline JSON, and Image
// Clipper 3.0's crops cut and matching. Preview and Export wait for all four.

export type Editor2ChecklistKey = 'audio' | 'alignment' | 'timeline' | 'crops'

export interface Editor2ChecklistItem {
  ok: boolean
  /** What was found — why the item passes or what is missing. */
  detail: string
}

export interface Editable2Chapter {
  id: string
  number: number
  title: string | null
  checklist: Record<Editor2ChecklistKey, Editor2ChecklistItem>
  /** All four items pass (as the server saw it). */
  ready: boolean
  /** Labels of the items that don't pass, in checklist order. */
  missing: string[]
  /** Everything but the timeline JSON is there — what Send to phone waits for. */
  inputsReady: boolean
  /** Copy All has alignment text and crop metadata to copy. */
  canCopy: boolean
  copyBlockedReason: string | null
  sectionCount: number
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

/** A chapter's Editor 2.0 paste as the server stores it. json "" = cleared. */
export interface StoredTimeline2 {
  chapterId: string
  language: NarrationLanguage
  json: string
  processedJson: string | null
  /** Epoch ms of the write; the newest write wins. */
  updatedAt: number
}

export interface Editor2Completion {
  done: boolean
  /** Saved video paths relative to the series folder, in the selected language. */
  compressedVideos: string[]
}

export interface Editor2SeriesReadiness extends Editor2Completion {
  chapters: { id: string; ready: boolean }[]
}

export const videoApi2 = {
  /** Every stored Editor 2.0 paste for a series (see timelineHandoff). */
  getStoredTimelines: (seriesId: string, lang: NarrationLanguage) =>
    fetchApi<StoredTimeline2[]>(`/video2/series/${seriesId}/timelines?lang=${lang}`),

  getStoredTimeline: (chapterId: string, lang: NarrationLanguage) =>
    fetchApi<StoredTimeline2 | null>(`/video2/chapters/${chapterId}/timeline?lang=${lang}`),

  saveStoredTimeline: (chapterId: string, lang: NarrationLanguage, body: Omit<StoredTimeline2, 'chapterId' | 'language'>) =>
    fetchApi<StoredTimeline2>(`/video2/chapters/${chapterId}/timeline?lang=${lang}`, {
      method: 'PUT',
      body: JSON.stringify(body)
    }),

  getEditableChapters: (seriesId: string, lang: NarrationLanguage) =>
    fetchApi<Editable2Chapter[]>(`/video2/series/${seriesId}/editable-chapters?lang=${lang}`),

  /** Which chapters of a series have a complete checklist (the library's "N/M ready"). */
  getSeriesReadiness: (seriesId: string, lang: NarrationLanguage) =>
    fetchApi<Editor2SeriesReadiness>(`/video2/series/${seriesId}/readiness?lang=${lang}`),

  getSeriesCompletion: (seriesId: string, lang: NarrationLanguage) =>
    fetchApi<Editor2Completion>(`/video2/series/${seriesId}/completion?lang=${lang}`),

  /** Which chapters of this series have already been rendered to MP4 in this language. */
  getExportedChapters: (seriesId: string, lang: NarrationLanguage) =>
    fetchApi<Exported2Chapter[]>(`/video2/series/${seriesId}/exports?lang=${lang}`),

  getTimelineBundle: (chapterId: string, lang: NarrationLanguage) =>
    fetchApi<ChapterTimelineBundle>(`/video2/chapters/${chapterId}/timeline-bundle?lang=${lang}`),

  getCropMetadataBundle: (chapterId: string) =>
    fetchApi<ChapterCropMetadataBundle>(`/video2/chapters/${chapterId}/crop-metadata-bundle`),

  processTimeline: (chapterId: string, lang: NarrationLanguage, json: string) =>
    fetchApi<TimelinePlan>(`/video2/chapters/${chapterId}/process-timeline?lang=${lang}`, {
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
    lang: NarrationLanguage,
    chapters: { chapterId: string; json: string }[],
    options?: { resolution?: string; preset?: string; fps?: number; force?: boolean }
  ) =>
    fetchApi<{ jobId: string }>(`/video2/series/${seriesId}/export-all?lang=${lang}`, {
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
  language: NarrationLanguage
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
  /** How crops3/ compares with what the done pages should cut to. */
  cropOutputs: {
    /** Every page is done and crops3/ holds exactly the files those pages cut to. */
    complete: boolean
    files: number
    /** Expected files not on disk — cut again to add them. */
    missing: number
    /** Files no done page accounts for — the next cut removes them. */
    extra: number
    /** Done pages whose crop boxes changed after they were cut (same names, old pixels). */
    changed: number
  }
  /** Whether the whole chapter is reviewed — Crop Sections waits for it. */
  review: Clipper3ChapterReview
  neighbours: ChapterNeighbours
}

/**
 * A whole chapter's review (server services/clipper3/chapterReview.ts):
 * marked on the Master phone (arrives with Sync json) or in Preview — or
 * implied by the chapter being cut already (`by: 'cropped'`), unless new
 * unreviewed phone crops arrived after the cut.
 */
export interface Clipper3ChapterReview {
  reviewed: boolean
  reviewedAt: string | null
  by: 'phone' | 'desktop' | 'cropped' | null
  /** crops3/ holds output for this chapter. */
  cropped: boolean
  /** When the newest file in crops3/ was cut. */
  croppedAt: string | null
  /** The phone's name, for phone reviews. */
  device?: string
  etag?: string
  editedPages?: string[]
  movedCrops?: number
  deletedCrops?: number
}

/** Crop Sections refused because the chapter isn't reviewed yet (409 CHAPTER_NOT_REVIEWED). */
export class Clipper3NotReviewedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Clipper3NotReviewedError'
  }
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

/**
 * What Sync json did with one `Processed/page_###` folder — or, from the
 * preview, what it would do: 'ready' is the preview's form of 'imported'.
 */
export interface Clipper3SyncedPage {
  /** The folder as it appears on disk, e.g. "page_007". */
  folder: string
  /** The source image it resolved to, when it resolved to one. */
  filename: string | null
  /**
   * 'replaced': an attached page overwritten by the Master phone's review of
   * it — or, from the preview, about to be.
   */
  status: 'imported' | 'ready' | 'replaced' | 'skipped' | 'failed'
  /** Why, for 'replaced', 'skipped' and 'failed'. Empty for 'imported'/'ready'. */
  reason: string
  cropCount: number
}

export interface Clipper3ChapterSyncResult {
  chapterId: string
  chapterNumber: number
  imported: number
  /** Attachable, on a preview. Always 0 once the sync has actually run. */
  ready: number
  /** Attached pages replaced by a phone review (or to be, on a preview). */
  replaced: number
  skipped: number
  failed: number
  pages: Clipper3SyncedPage[]
}

/**
 * What Sync json's first step pulled from R2: the chapter zips the phone
 * uploads once every page of a chapter is done, unpacked into Processed/.
 */
export interface Clipper3PhoneCropsFetch {
  /** False when R2 is not set up; nothing was looked at. */
  configured: boolean
  /** Chapter zips in R2 for this series. */
  found: number
  /** Chapters unpacked by this run: new, or re-uploaded by the phone. */
  fetched: { chapterId: string; chapterNumber: number; folder: string; pages: number; reviewed: boolean }[]
  /** Chapters already unpacked from the same zip before. */
  upToDate: number
  /** Zips with no desktop chapter folder of that name. */
  unmatched: string[]
  failed: { folder: string; reason: string }[]
  /** Cropped markers written to R2 for chapters cut before they existed. */
  cropped: { published: string[]; failed: { folder: string; reason: string }[] }
}

/** What "Publish cropped chapters" wrote to R2 (Clipper3Library). */
export interface Clipper3CroppedPublishAll {
  configured: boolean
  /** Series with at least one cut chapter. */
  series: number
  published: { series: string; chapter: string }[]
  failed: { series: string; folder: string; reason: string }[]
}

/** The confirmation dialog's contents: what a sync would attach, before it runs. */
export interface Clipper3SyncPreview {
  chapters: number
  ready: number
  replaced: number
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
  /** Every page is done and crops3/ holds exactly the files they cut to. */
  cropComplete: boolean
  /** A cut is running right now (Crop Sections, or the auto crop after Sync json). */
  cropping: boolean
  review: Clipper3ChapterReview
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
  getSeries: () => fetchApi<Clipper3Series[]>('/clipper3/series'),

  getChapters: () => fetchApi<Clipper3Chapter[]>('/clipper3/chapters'),

  /** One source page image, served from the chapter folder. */
  getImageUrl: (chapterId: string, filename: string) =>
    `${API_BASE}/clipper3/chapters/${chapterId}/image/${encodeURIComponent(filename)}`,

  getImages: (chapterId: string) =>
    fetchApi<Clipper3ChapterImages>(`/clipper3/chapters/${chapterId}/images`),

  // The whole chapter's reviewed flag (Master phone or Preview).
  getChapterReview: (chapterId: string) =>
    fetchApi<Clipper3ChapterReview>(`/clipper3/chapters/${chapterId}/review`),

  // The desktop's Mark reviewed / Unmark (Preview); Crop Sections needs it.
  setChapterReview: (chapterId: string, reviewed: boolean) =>
    fetchApi<Clipper3ChapterReview>(`/clipper3/chapters/${chapterId}/review`, {
      method: 'PUT',
      body: JSON.stringify({ reviewed })
    }),

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

  // Downloads the phone's finished-chapter zips from R2 and unpacks them into
  // Processed/ so the preview below finds them. Only new or re-uploaded zips
  // are downloaded; nothing is attached.
  fetchPhoneCrops: (seriesId: string, chapterIds?: string[]) =>
    fetchApi<Clipper3PhoneCropsFetch>(
      `/clipper3/series/${seriesId}/fetch-phone-crops`,
      { method: 'POST', body: JSON.stringify({ chapterIds }) }
    ),

  // Tells the phones about every chapter already cut: writes the missing
  // `<Chapter>.cropped.json` markers beside the phone zips in R2.
  publishCroppedMarkers: () =>
    fetchApi<Clipper3CroppedPublishAll>('/clipper3/cropped-markers/publish', { method: 'POST' }),

  // What syncProcessed would attach, without writing anything — the same pass
  // with the write suppressed, so the preview cannot promise more than the
  // import delivers. Answers directly rather than over the socket.
  previewProcessed: (seriesId: string, chapterIds?: string[]) =>
    fetchApi<Clipper3SyncPreview>(
      `/clipper3/series/${seriesId}/sync-processed/preview`,
      { method: 'POST', body: JSON.stringify({ chapterIds }) }
    ),

  // Attaches the crop JSON sitting in each chapter's `Processed/` folder to the
  // pages it names, then queues every chapter reviewed on the Master phone for
  // cutting. Background job — the outcome arrives over `clipper3:sync-*` (its
  // `autoCrop` lists the chapters sent to crop), the cuts over `clipper3:crop-*`.
  // Omitting chapterIds syncs the whole series.
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

  // Cuts every Done image; progress over 'clipper3:crop-*'.
  // Not fetchApi: an unreviewed chapter answers 409 with a code in `error` and
  // the sentence in `message`, and the caller needs to tell that case apart.
  crop: async (chapterId: string): Promise<{ started: boolean; images: number }> => {
    const response = await fetch(`${API_BASE}/clipper3/chapters/${chapterId}/crop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    })
    const payload = await response.json().catch(() => null) as
      ({ started: boolean; images: number } & { error?: string; message?: string }) | null
    if (response.status === 409 && payload?.error === 'CHAPTER_NOT_REVIEWED') {
      throw new Clipper3NotReviewedError(payload.message || 'Mark this chapter reviewed before cropping.')
    }
    if (!response.ok || !payload) {
      throw new Error(payload?.error || payload?.message || `Request failed (${response.status} ${response.statusText})`)
    }
    return payload
  },

  getOutputs: (chapterId: string) =>
    fetchApi<{ exportDir: string | null; files: Clipper3Output[] }>(
      `/clipper3/chapters/${chapterId}/outputs`
    ),

  getOutputUrl: (chapterId: string, filename: string) =>
    `${API_BASE}/clipper3/chapters/${chapterId}/output/${encodeURIComponent(filename)}`
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
  /** The Part this chapter was completed with (files deleted), or null. */
  completedPart: number | null
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
  videoCleanupFolders: StorageVideoCleanupFolder[]
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

export interface StorageVideoCleanupFolder {
  dir: '_video' | '_video2' | '_video2_hi'
  compressedVideos: string[]
  renderedFileCount: number
  renderedBytes: number
}

export interface StorageVideoFile {
  seriesId: string
  dir: '_video' | '_video2' | '_video2_hi'
  fileName: string
  bytes: number
  modifiedAt: string
  chapterNumber: number | null
}

export interface PublishedMap {
  chapters: Record<string, boolean>
  series: Record<string, { published: number; total: number }>
  /** Chapter id → the Part it was completed with. */
  completed?: Record<string, number>
  /** Series id → its completed Part numbers. */
  completedParts?: Record<string, number[]>
  scannedAt: string
}

export interface PartChapter {
  id: string
  number: number
  title: string | null
  folderPath: string
  exportedEn: boolean
  exportedHi: boolean
  completed: boolean
}

export interface SeriesPart {
  number: number
  firstChapter: number
  lastChapter: number
  closed: boolean
  /** Ends at a "Part end" marked in Narration, rather than at the last exported chapter. */
  endMarked: boolean
  completed: boolean
  completedAt: string | null
  chapters: PartChapter[]
  exportedEn: number
  exportedHi: number
  ready: boolean
  blocker: string | null
  localBytes: number
}

export interface SeriesParts {
  seriesId: string
  title: string
  r2Configured: boolean
  parts: SeriesPart[]
}

export interface CompletePartResult {
  partNumber: number
  chapters: number
  continuityKey: string | null
  r2Deleted: string[]
  r2FreedBytes: number
  r2Kept: string[]
  localFreedBytes: number
  videosDeleted: number
  warnings: string[]
}

export const storageApi = {
  getOverview: () => fetchApi<StorageOverview>('/storage/overview'),

  // Cheap per-chapter "has a rendered video" lookup for the module pages.
  /** `lang` limits "published" to that narration language's renders; omit it for any render. */
  getPublished: (seriesId?: string, lang?: NarrationLanguage) => {
    const params = new URLSearchParams()
    if (seriesId) params.set('seriesId', seriesId)
    if (lang) params.set('lang', lang)
    const query = params.toString()
    return fetchApi<PublishedMap>(`/storage/published${query ? `?${query}` : ''}`)
  },

  getCategories: () => fetchApi<StorageCategoryMeta[]>('/storage/categories'),

  getParts: (seriesId: string) => fetchApi<SeriesParts>(`/storage/series/${seriesId}/parts`),

  /** Irreversible: deletes the Part locally and in R2, keeping only its continuity. */
  completePart: (seriesId: string, part: number, confirm: string) =>
    fetchApi<CompletePartResult>(`/storage/series/${seriesId}/parts/${part}/complete`, {
      method: 'POST',
      body: JSON.stringify({ confirm })
    }),

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

  deleteCompressedRenders: (seriesId: string, dir: string) =>
    fetchApi<{ freedBytes: number; deletedFiles: number }>(
      `/storage/series/${seriesId}/videos/${dir}`,
      { method: 'DELETE' }
    ),

  deleteVideo: (seriesId: string, dir: string, fileName: string) =>
    fetchApi<{ freedBytes: number }>(
      `/storage/series/${seriesId}/videos/${dir}/${encodeURIComponent(fileName)}`,
      { method: 'DELETE' }
    )
}

// ============ Cloudflare R2: sending chapters to the phone ============

/**
 * new:         never sent
 * changed:     sent, but its pages changed since (e.g. stitched)
 * sent:        in R2, the phone hasn't got it yet
 * downloading: the phone is downloading it
 * on_phone:    the phone has this copy
 * cleared:     the phone cleared it; not sent again unless picked
 */
export type PhoneChapterState = 'new' | 'changed' | 'sent' | 'downloading' | 'on_phone' | 'cleared'

export interface PhoneSendChapter {
  chapterId: string
  number: number
  folder: string
  pages: number
  bytes: number
  state: PhoneChapterState
  sentAt: string | null
  clearedAt: string | null
  /** When the phone unpacked this copy. */
  phoneAt: string | null
  /** Over the page limit: stitch it before sending (auto-send skips it). */
  needsStitch: boolean
  /** What the phone's "Clear done chapters" ticks: published, or crops and script. */
  desktop: { crops: boolean; script: boolean; scriptHi: boolean; published: boolean; done: boolean }
}

export interface PhoneSendSeries {
  seriesId: string
  title: string
  folder: string
  autoSend: boolean
  chapters: PhoneSendChapter[]
  /** New or changed: what a send picks by default. */
  toSend: number
  onPhone: number
  /** Sent, not on the phone yet. */
  waiting: number
  cleared: number
  /** The phone's chapter index is behind the desktop (chapters finished since). */
  indexStale: boolean
}

export interface PhoneSendPlan {
  configured: boolean
  missing: string[]
  device: string | null
  reportedAt: string | null
  series: PhoneSendSeries[]
}

export type PhoneSendSeriesState = 'queued' | 'sending' | 'done' | 'skipped' | 'failed' | 'cancelled'

export interface PhoneSendSeriesProgress {
  seriesId: string
  title: string
  state: PhoneSendSeriesState
  chaptersTotal: number
  chaptersSent: number
  current?: { folder: string; phase: 'zipping' | 'uploading' }
  bytesTotal: number
  bytesDone: number
  /** The series' folder in R2, once known. */
  folder?: string
  note?: string
  error?: string
}

export interface PhoneSendJob {
  id: string
  state: 'running' | 'done' | 'cancelled'
  bucket: string
  /** Started by auto-send after downloads. */
  auto: boolean
  startedAt: string
  finishedAt?: string
  /** How the phone was asked to fetch the new chapters. */
  phone: PhoneUpdateRequest | null
  phoneError?: string
  series: PhoneSendSeriesProgress[]
}

export interface R2Status {
  configured: boolean
  missing: string[]
  bucket: string | null
  prefix: string
  job: PhoneSendJob | null
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
  /** An Account Analytics token is saved, so request counts are Cloudflare's own. */
  hasAnalyticsToken: boolean
}

export interface R2ConfigUpdate {
  accountId?: string
  bucket?: string
  prefix?: string
  concurrency?: number
  accessKeyId?: string
  secretAccessKey?: string
  clearKeys?: boolean
  analyticsToken?: string
  clearAnalyticsToken?: boolean
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
  /**
   * cloudflare: Cloudflare's own count for the whole account this month (every client, a few minutes behind).
   * local: only the requests Manhwa Studio sent, used when no analytics token is saved or it failed.
   */
  ops: { classA: number; classB: number; free: number; ops: Record<string, number>; since: string; source: 'cloudflare' | 'local' }
  /** Why Cloudflare's count couldn't be read, when a token is saved. */
  analyticsError: string | null
}

export interface PhoneSeriesSync {
  /**
   * downloaded:  the phone has every chapter sent (and not cleared)
   * downloading: it is downloading some
   * outdated:    some chapters sent aren't on the phone yet
   * missing:     it has none of them
   */
  state: 'downloaded' | 'downloading' | 'outdated' | 'missing'
  /** When the phone last unpacked a chapter. */
  phoneAt: string | null
  /** When a chapter was last sent. */
  uploadedAt: string | null
  sent: number
  onPhone: number
  downloading: number
  /** Chapters the phone cleared once done. */
  cleared: number
}

/** What the Sleeper-Cell phone app has of the chapters sent to it, from its receipt. */
export interface PhoneSyncStatus {
  configured: boolean
  /** When the phone last reported; null if it never has. */
  reportedAt: string | null
  device: string | null
  /** By series id; only series with chapters sent. */
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
  /** The id of the "Refresh from phone" request the phone last answered. */
  answers: string | null
  /** By series id: chapters done on the phone out of those it has. */
  series: Record<string, { done: number; total: number }>
  /** By chapter id, for the series asked for; chapters with no script are left out. */
  chapters: Record<string, PhoneChapterScript>
  /** The same for the phone's Hinglish scripts (Hindi tab). */
  hi: {
    /** By series id: chapters converted (done or needing review) out of those on the phone. */
    series: Record<string, { done: number; total: number; uploadedAt: string | null }>
    chapters: Record<string, PhoneChapterHinglish>
  }
  /** Runs going now in the phone's Narration and Voiceover libraries (series and chapters by folder name). */
  runs: PhoneScriptRun[]
}

/**
 * A run going on the phone: Auto-run writing a series' scripts in AI Studio
 * (narration), or voicing its splits (voiceover). `done` of `total` counts
 * chapters for narration and the run's splits for voiceover.
 */
export interface PhoneScriptRun {
  kind: 'narration' | 'editor' | 'voiceover'
  series: string
  done: number
  total: number
  paused: boolean
  /** Ends once the chapter or splits it's on are saved. */
  stopping: boolean
  /** The browser profile the tabs are on, when the phone has more than one. */
  account: string | null
  since: string | null
  /** When the run last changed. */
  at: string | null
  /** What each AI Studio tab is on; a tab between splits is left out. */
  tabs: PhoneScriptRunTab[]
  /** The phone it's on: its id ("" for the old app, or the one phone R2 carries) and name; null when not known. */
  device: string | null
  phone: string | null
}

export interface PhoneScriptRunTab {
  chapter: string
  language: NarrationLanguage
  /** 1-based, voiceover only. */
  split: number | null
  splits: number | null
  since: string | null
}

/**
 * A chapter's Hinglish script on the phone:
 *   done:   converted and passed the check
 *   review: saved despite failing the check
 *   stale:  converted from an English script the phone has since changed
 */
export interface PhoneChapterHinglish {
  status: 'done' | 'review' | 'stale'
  savedAt: string | null
}

/** One language's view of the phone's scripts receipt. */
export interface PhoneScriptsView {
  reportedAt: string | null
  device: string | null
  series: Record<string, { done: number; total: number }>
  chapters: Record<string, { status: PhoneChapterScript['status'] | PhoneChapterHinglish['status']; savedAt: string | null }>
}

export function phoneScriptsIn(status: PhoneScriptsStatus | null, lang: NarrationLanguage): PhoneScriptsView | null {
  if (!status) return null
  const { reportedAt, device } = status
  if (lang === 'en') return { reportedAt, device, series: status.series, chapters: status.chapters }
  // Older servers and phones send no Hinglish block.
  return { reportedAt, device, series: status.hi?.series ?? {}, chapters: status.hi?.chapters ?? {} }
}

/**
 * A page's crop JSON on the Sleeper-Cell phone (Image Clipper's Auto-run):
 *   done:        crop pointers and metadata generated
 *   in_progress: sections made, the ChatGPT rounds not finished
 *   changed:     the page file was replaced since it was started, so it starts over
 */
export type PhonePageState = 'done' | 'in_progress' | 'changed'

/** A page the phone's Auto-run is on right now. */
export interface PhoneCropsWorking {
  chapterId: string
  /** The page file, the same name as the image in the chapter folder. */
  page: string
  /** When Auto-run started this page. */
  since: string | null
  paused: boolean
  /** The phone it's on: its id ("" for the old app, or the one phone R2 carries) and name; null when not known. */
  device: string | null
  phone: string | null
}

/** Crop pointers made on the Sleeper-Cell phone, from the receipt it writes to R2 as pages start and finish. */
export interface PhoneCropsStatus {
  configured: boolean
  /** When the phone last reported; null if it never has. */
  reportedAt: string | null
  device: string | null
  /** The id of the "Refresh from phone" request the phone last answered. */
  answers: string | null
  /** By series id: pages done on the phone out of those it has. */
  series: Record<string, { done: number; total: number }>
  /** By chapter id, for the series asked for; chapters with no page started are left out. */
  chapters: Record<string, { done: number; total: number }>
  /** The page Auto-run is on in the series asked for, or null when it isn't running there. The first of `workingPages`. */
  working: PhoneCropsWorking | null
  /** Every page Auto-run is on in the series asked for: one per ChatGPT tab, possibly across chapters. */
  workingPages: PhoneCropsWorking[]
  /** By image filename, for the chapter asked for; pages not started are left out. */
  pages: Record<string, PhonePageState>
  /** By image filename, for the chapter asked for: how each done page was finished on the phone. */
  finished: Record<string, PhonePageFinish>
  /** Every browser profile on the phone (one ChatGPT account each), with its uploads to ChatGPT; empty from older phone builds. */
  profiles: PhoneUploadProfile[]
}

/** A limit ChatGPT put on a phone profile. */
export interface PhoneUploadLimit {
  at: string
  /** When ChatGPT said it would lift (an hour when it said nothing). */
  until: string
  /** Images the profile uploaded from `countedSince` up to the limit. */
  used: number
  countedSince: string
  /** False for the first limit after tracking began: its count may have started mid-window. */
  complete: boolean
  /** A flag for suspicious activity, not the upload limit. */
  flagged: boolean
  reason: string
}

/** One of the phone's browser profiles and the images it uploaded to ChatGPT. */
export interface PhoneUploadProfile {
  id: string
  name: string
  /** The profile the phone's browser is on, which the next run starts in. */
  selected: boolean
  /** While ChatGPT's limit on it is noted as running; null otherwise. */
  limitedUntil: string | null
  trackingSince: string | null
  /** Images uploaded towards the next limit: since the last one, or since tracking began. */
  counting: { since: string; images: number } | null
  /** Images uploaded in the last day, by 5-minute slot, oldest first. */
  uploads: { at: string; images: number }[]
  /** Oldest first. */
  limits: PhoneUploadLimit[]
  /** The phone it's on (see PhoneScriptRun). With several phones, `id` is "<device>:<profile id>". */
  device: string | null
  phone: string | null
  /** The phone's own id for it, which profile requests name it by. */
  profileId: string
  /** What its ChatGPT account offered when last read, for Run automation's choices; null from older builds. */
  chatGpt: PhoneChatGptProfile | null
  /** Sleeper-Cell's Tools → Profiles → Check of it, as last done there: sign-ins and plans; null when never checked. */
  check: PhoneProfileCheck | null
  /** Its plan limits (5-hour and weekly), read in the check and during runs; null when never read or from older builds. */
  usage: PhoneChatGptUsage | null
}

/** One plan-limit window of a ChatGPT account (Codex, Work and the like share it; chats don't count). */
export interface PhoneUsageWindow {
  /** Its length: 18000 is the 5-hour limit, 604800 the weekly one. */
  seconds: number
  /** 0–100. */
  usedPercent: number
  /** When it's back to 0; null when ChatGPT didn't say. */
  resetAt: string | null
}

/** A ChatGPT account's plan limits as the phone last read them (ChatGptUsage.kt). */
export interface PhoneChatGptUsage {
  checkedAt: string
  limitReached: boolean
  /** Why the last read failed, when nothing better was kept (`windows` then empty). */
  error: string | null
  windows: PhoneUsageWindow[]
}

/** One site's part of a profile check on the phone. */
export interface PhoneSiteCheck {
  signedIn: boolean
  email: string | null
  /** ChatGPT's planType ("free", "go", "plus"…); Gemini's "free", "paid" or "Google AI Pro" and the like. */
  plan: string | null
  error: string | null
}

export interface PhoneProfileCheck {
  checkedAt: string
  chatGpt: PhoneSiteCheck | null
  gemini: PhoneSiteCheck | null
}

/** A mode's choices, as the phone read them off the ChatGPT account. */
export interface PhoneChatGptMode {
  /** "Chat" or "Work"; null for an account with no switch. */
  name: string | null
  models: { name: string; picked: boolean }[]
  /** The Power slider's steps, lowest first; a locked step's name isn't known. */
  efforts: { name: string | null; locked: boolean; picked: boolean }[]
}

/** Image Clipper's ChatGPT choices in Run automation; each null leaves it as the account has it. */
export interface PhoneChatGptSettings {
  mode: 'Chat' | 'Work' | null
  model: string | null
  effort: string | null
}

export interface PhoneChatGptProfile {
  /** Null until read. Free and Go list no modes: they have neither the switch nor the model picker. */
  options: { readAt: string | null; current: string | null; modes: PhoneChatGptMode[] } | null
  reading: boolean
  error: string | null
}

/** One phone profile's Gemini requests in AI Studio today, for one kind of run. */
export interface PhoneGeminiProfile {
  id: string
  name: string
  selected: boolean
  /** Requests since the last daily reset. */
  today: number
  /** How many requests it got to before its last limit; null until it has hit one. */
  limit: number | null
  /** While its speech limit is noted as used up; null otherwise. */
  limitedUntil: string | null
  /** The phone it's on: its id ("" for the old app, or the one phone R2 carries) and name; null when not known. */
  device: string | null
  phone: string | null
}

/** Gemini's limit for one kind of run on the phone's profiles. */
export interface PhoneGeminiUsage {
  /** Gemini's next daily reset, midnight Pacific. */
  resetsAt: string
  profiles: PhoneGeminiProfile[]
}

/** How a done page was finished on the phone. */
export interface PhonePageFinish {
  /** When its JSON files were exported. */
  at: string
  /** Seconds from making the page's sections to exporting its JSON files, wall clock (pauses count); null if unknown. */
  took: number | null
  /** auto: Sleeper-Cell's Auto-run; manual: pasted by hand. null for exports from before this was kept. */
  run: 'auto' | 'manual' | null
  /** The browser profile of the ChatGPT account Auto-run used, and that account's name in Sleeper-Cell. */
  profile: string | null
  account: string | null
  /** The ChatGPT models that answered, in order (a fix round can be answered by another). */
  models: string[]
  /** The phone that finished it; null when not known. */
  phone: string | null
}

/** Where a page is: the series and chapter in the library when they match, else the phone's folder names. */
interface PhoneOverviewPlace {
  seriesId: string | null
  series: string
  chapterId: string | null
  /** The chapter folder name, as on the phone. */
  chapter: string
  chapterNumber: number | null
}

/** A page the phone's Auto-run is on, in any series. */
export interface PhoneOverviewWorking extends PhoneOverviewPlace {
  page: string
  since: string | null
  paused: boolean
  /** The phone it's on: its id ("" for the old app, or the one phone R2 carries) and name; null when not known. */
  device: string | null
  phone: string | null
}

export interface PhoneOverviewFinish extends PhoneOverviewPlace, PhonePageFinish {
  page: string
}

/** A chapter the phone zipped with its JSON files and uploaded to R2. */
export interface PhoneOverviewChapterZip extends PhoneOverviewPlace {
  uploadedAt: string | null
  pages: number
}

export interface PhoneOverviewSeries {
  id: string
  title: string
  /** Has the phone downloaded this series' zip; null when there's no zip in R2. */
  sync: PhoneSeriesSync | null
  /** Chapters with a narration script on the phone; null when it has none. */
  scripts: { done: number; total: number } | null
  /** Pages with crop JSON on the phone; null when it has started none. */
  crops: { done: number; total: number } | null
  /** Chapters the phone has uploaded with their JSON files. */
  chaptersUploaded: number
  /** Pages Auto-run is on in this series right now. */
  working: number
  /** Narration and voiceover runs going in this series right now. */
  runs: PhoneScriptRun['kind'][]
}

export interface PhoneOverviewRunTab extends PhoneOverviewPlace, Omit<PhoneScriptRunTab, 'chapter'> {}

/** A narration or voiceover run on the phone, placed in the library. */
export interface PhoneOverviewRun extends Omit<PhoneScriptRun, 'series' | 'tabs'> {
  seriesId: string | null
  series: string
  tabs: PhoneOverviewRunTab[]
}

/** Sleeper-Cell's automation settings (Tools → Settings → Automation), and the run it will start by itself. */
export interface PhoneAutomation {
  /** personal: shows over the lock screen, PIN kept. dedicated: dismisses the lock screen, locks after. */
  wakeMode: 'personal' | 'dedicated'
  resumeAfterLimit: boolean
  /** "Start from Manhwa Studio" is on: Run automation and Stop reach it. */
  remoteStart: boolean
  /** The run waiting for a ChatGPT limit to lift, or for the phone to come online; null when none is. */
  resume: { seriesId: string | null; series: string; tabs: number; at: string } | null
  /** The runs it can start from here; builds before the others start only Image Clipper (older servers leave it out). */
  runs?: PhoneRunKind[]
  /** How Image Clipper last ran there; null from builds before it was sent. */
  clipper?: { ai: PhoneClipperAi; flow: PhoneClipperFlow; tabs: number; chatGpt?: PhoneChatGptSettings | null } | null
  /** Editor 2.0's tabs last used there; null from builds whose Editor 2.0 run takes neither tabs nor a share of a split. */
  editor?: { tabs: number } | null
  /** The runs that take a share of a split (a `chapters` list); empty or left out from builds before. */
  chapterRuns?: PhoneRunKind[]
  /** A run going there takes a split's start of it as its new scope, keeping what it's on; builds before would start over. */
  rescope?: boolean
  /** It can stop a run once what it's on is done; builds before can only stop now. */
  stopAfter?: boolean
  /** Image Clipper ends once the pages it's on are done. */
  clipperStopping?: boolean
}

/** The automation runs Sleeper-Cell can start from here (PhoneRunKind in r2Service.ts). */
export type PhoneRunKind = 'clipper' | 'narration' | 'editor' | 'voiceover'
/** Image Clipper's AI: ChatGPT, or Gemini in AI Studio. */
export type PhoneClipperAi = 'chatgpt' | 'aistudio'
/** Image Clipper's prompting: one prompt then review rounds (classic), or four steps. */
export type PhoneClipperFlow = 'classic' | 'steps'

/** What to start: the run, its series, and how (the options that run takes). */
export interface PhoneAutomationOptions {
  kind?: PhoneRunKind
  seriesId?: string
  tabs?: number
  ai?: PhoneClipperAi
  flow?: PhoneClipperFlow
  /** Image Clipper on ChatGPT: mode, model and effort; the phone keeps them for its later runs. */
  chatGpt?: PhoneChatGptSettings
  language?: NarrationLanguage
  device?: string
  split?: boolean
  /** A split as confirmed from its plan (planPhoneSplit): each phone's whole share, by device id, sent as it is. */
  assignments?: Record<string, string[]>
  /** A stop once the pages, chapter or splits the run is on are done ("Finish …, then stop" on the phone). */
  after?: boolean
}

/** One phone in a split's plan (server: phoneSplit.ts). */
export interface PhoneSplitTarget {
  device: string
  name: string
  /** Its whole share, in reading order: what it's on and what it's given. */
  chapters: string[]
  /** The chapters it's on now. */
  inProgress: string[]
  /** start: a free phone starts. rescope: already on this run, takes its share as its new scope. finish: already on it, nothing left: finishes what it's on. skip: left alone. */
  action: 'start' | 'rescope' | 'finish' | 'skip'
  reason?: string
}

/** Split across the phones, step 1: who takes what, before anything is sent. */
export interface PhoneSplitPlan {
  kind: PhoneRunKind
  seriesId: string
  series: string
  language: NarrationLanguage
  targets: PhoneSplitTarget[]
  /** Chapter numbers by folder. */
  numbers: Record<string, number>
}

/** One phone running Sleeper-Cell. */
export interface PhoneOverviewPhone {
  /** Its id; "" for a build from before phones had one, which can't be started on its own. */
  id: string
  name: string
  /** Sleeper-Cell's socket to the relay is open (the app is open, or listening for starts); null without the relay. */
  connected: boolean | null
  /**
   * When the relay last heard from it, and, when it isn't connected, how it went: "closed" (Sleeper-Cell closed
   * its link), "shutdown" (the phone switched off) or "lost" (the link broke or its pings stopped). Null from
   * relays and servers before they kept this.
   */
  seenAt?: string | null
  left?: PhoneLeft | null
  /** Its newest receipt. */
  reportedAt: string | null
  automation: PhoneAutomation | null
  /** Pages Auto-run is on there. */
  working: number
  /** Narration and voiceover runs going there. */
  runs: number
}

export type PhoneLeft = 'closed' | 'shutdown' | 'lost'

/** A phone's battery, sent with its screen state. */
export interface PhoneBattery {
  /** 0–100. */
  level: number
  /** Charging, or full on the charger. */
  charging: boolean
  plugged: 'ac' | 'usb' | 'wireless' | 'dock' | null
}

/** What a phone last said of its screen (it answers every screen command with this). */
export interface PhoneScreenState {
  at: string
  /** The request it answers, or null when the phone reported by itself (the screen went on or off). */
  answers: string | null
  on: boolean
  locked: boolean
  /** Sleeper-Cell is on screen. */
  appOpen: boolean
  /** Woken from here and kept on until Screen off. */
  keptOn: boolean
  /** Screen off locks at once (Sleeper-Cell is a device admin); otherwise the screen times out by itself. */
  canLock: boolean
  remoteStart: boolean
  last: { action: string; ok: boolean; note: string; at: string } | null
  /** As of `at`; null (or missing, from older servers) from Sleeper-Cell builds before they sent it. */
  battery?: PhoneBattery | null
}

/**
 * A phone's screen state, and the screenshot of its browser tabs waiting to be
 * seen: the server holds it in memory only, until its viewer closes (then
 * dropPhoneScreenshot) or for 10 minutes.
 */
export interface PhoneScreen {
  device: string
  screen: PhoneScreenState | null
  screenshot: {
    takenAt: string
    /** The Screenshot or Wake request it follows. */
    answers: string | null
    shots: { label: string; width: number; height: number; url: string }[]
  } | null
}

/** Everything Sleeper-Cell has reported, across every series and phone (the Sleeper Cells page). */
export interface PhoneOverview {
  configured: boolean
  /** Every phone's name, joined. */
  device: string | null
  /** Each phone (older servers leave it out). One without the relay: R2 carries one phone's receipts. */
  phones?: PhoneOverviewPhone[]
  /** The latest of the three receipts. */
  reportedAt: string | null
  /** When each receipt was last written; null if never. */
  reported: { sync: string | null; scripts: string | null; crops: string | null }
  /** The id of the "Refresh from phone" request the crops receipt last answered. */
  answers: string | null
  working: PhoneOverviewWorking[]
  /** Narration and voiceover runs going now. */
  runs: PhoneOverviewRun[]
  series: PhoneOverviewSeries[]
  /** Done pages, newest first (the latest few hundred). */
  recent: PhoneOverviewFinish[]
  /** True when there were more done pages than `recent` holds. */
  recentCapped: boolean
  /** Chapter zips the phone uploaded, newest first. */
  uploads: PhoneOverviewChapterZip[]
  profiles: PhoneUploadProfile[]
  /** Gemini requests per profile today: the voiceover run's speech and the narration run's scripts; null from builds before each was sent. */
  gemini: { speech: PhoneGeminiUsage | null; narration: PhoneGeminiUsage | null }
  /** The first phone's that can be started from here, else the first phone's; null from Sleeper-Cell builds before automation. */
  automation: PhoneAutomation | null
}

/** "Refresh from phone": how the ask went out. */
export interface PhoneUpdateRequest {
  id: string
  requestedAt: string
  /** relay: through the phone relay, answered the moment Sleeper-Cell is open. r2: left in the bucket. */
  via: 'relay' | 'r2'
  /** Through the relay: Sleeper-Cell sockets open when it was sent (0 = it answers once opened). */
  phones: number | null
}

/** The phone relay (a Cloudflare Worker) that carries Sleeper-Cell's status live, without R2. */
export interface RelayStatus {
  configured: boolean
  url: string
  hasToken: boolean
  connected: boolean
  /**
   * Sleeper-Cell sockets open right now: the app is open on the phone, or its
   * "Start from Manhwa Studio" setting keeps the socket open in the background.
   */
  phones: number
  /** The phones connected, and those the relay keeps receipts from (older servers leave it out). */
  devices?: { id: string; name: string; connected: boolean; seenAt?: string | null; left?: PhoneLeft | null }[]
  lastError: string | null
  lastReceiptAt: string | null
}

/** A run's start or stop, as sent: to each phone, or to every phone (device "*"). */
export interface PhoneAutomationSent extends PhoneUpdateRequest {
  targets?: { device: string; name: string; chapters: string[] | null; reached: boolean; action?: 'start' | 'rescope' | 'finish' }[]
  /** A split's chapter numbers by folder (when planned and sent at once). */
  numbers?: Record<string, number>
}

/** Run automation's checklist (server: phoneReadiness.ts): what a run needs of a series on the phone. */
export type PhoneReadinessState = 'ready' | 'waiting' | 'missing' | 'blocked' | 'note'
export type PhoneReadinessFixAction = 'send_pages' | 'ask_download' | 'send_editor' | 'send_prompt' | 'run_narration'

export interface PhoneReadinessItem {
  id: string
  label: string
  state: PhoneReadinessState
  detail: string
  fix?: { action: PhoneReadinessFixAction; label: string; chapterIds?: string[] }
  link?: { to: string; label: string }
}

export interface PhoneRunReadiness {
  seriesId: string
  kind: PhoneRunKind
  language: 'en' | 'hi'
  /** Nothing missing, waiting or blocked. */
  ready: boolean
  /** The run has something to work on now, even if not everything is there. */
  canWork: boolean
  items: PhoneReadinessItem[]
  /** A send to the phones is going; progress comes as `phone-send:progress`. */
  sending: boolean
}

/** The script zip the phone uploads once every chapter of a series is done ("Zip and upload to R2"). */
export interface PhoneScriptsZip {
  key: string
  etag: string
  size: number
  uploadedAt: string | null
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
  /** The chapter already has voiceover sections in this language. */
  hasVoiceover: boolean
  published: boolean
  /** Hinglish only: the phone saved it despite failing the check, with these issues. */
  review: string[] | null
  /** Hinglish only: converted from the English script this desktop has now (false: imports as stale). */
  sourceMatches: boolean | null
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

  /** From the server's copy of the phone's receipt; `fresh` re-reads it from R2 when there is no relay. */
  getPhoneSync: (fresh = false) =>
    fetchApi<PhoneSyncStatus>(`/r2/phone${fresh ? '?fresh=1' : ''}`),

  /**
   * With `seriesId`, also that series' chapters. The server answers from its
   * last copy of the phone's receipt; `fresh` re-reads it from R2.
   */
  getPhoneScripts: (seriesId?: string, fresh = false) => {
    const params = new URLSearchParams()
    if (seriesId) params.set('seriesId', seriesId)
    if (fresh) params.set('fresh', '1')
    const query = params.toString()
    return fetchApi<PhoneScriptsStatus>(`/r2/phone/scripts${query ? `?${query}` : ''}`)
  },

  /**
   * With `seriesId`, also that series' chapters and the page Auto-run is on;
   * with `chapterId`, that chapter's pages. `fresh` as for getPhoneScripts.
   */
  getPhoneCrops: (seriesId?: string, chapterId?: string, fresh = false) => {
    const params = new URLSearchParams()
    if (seriesId) params.set('seriesId', seriesId)
    if (chapterId) params.set('chapterId', chapterId)
    if (fresh) params.set('fresh', '1')
    const query = params.toString()
    return fetchApi<PhoneCropsStatus>(`/r2/phone/crops${query ? `?${query}` : ''}`)
  },

  /** Asks Sleeper-Cell to send its scripts and crops receipts again; they carry `id` in `answers`. */
  /** All three receipts across every series; `fresh` as for getPhoneScripts. */
  getPhoneOverview: (fresh = false) =>
    fetchApi<PhoneOverview>(`/r2/phone/overview${fresh ? '?fresh=1' : ''}`),

  requestPhoneUpdate: () =>
    fetchApi<PhoneUpdateRequest>('/r2/phone/request', { method: 'POST' }),

  /**
   * Starts a run on the phone, through the relay: `kind` (Image Clipper when
   * left out) on `seriesId`, with the options that run takes; Image Clipper
   * without a series goes on with the phone's last run. Or stops whichever run
   * is going. `device` sends it to that phone only; `split` with `assignments`
   * sends each phone its share of the series, as planPhoneSplit planned it.
   */
  sendPhoneAutomation: (command: 'start' | 'stop', options: PhoneAutomationOptions = {}) =>
    fetchApi<PhoneAutomationSent>('/r2/phone/automation', { method: 'POST', body: JSON.stringify({ command, ...options }) }),

  /** Split across the phones, step 1: which phone would take which chapters, sending nothing. */
  planPhoneSplit: (kind: PhoneRunKind, seriesId: string, language: NarrationLanguage = 'en') =>
    fetchApi<PhoneSplitPlan>('/r2/phone/automation/plan', { method: 'POST', body: JSON.stringify({ kind, seriesId, language }) }),

  /** What `kind` needs of the series on the phone, and the fixes. Editor 2.0's costs one R2 LIST: ask on demand only. */
  getRunReadiness: (kind: PhoneRunKind, seriesId: string, language: 'en' | 'hi' = 'en') =>
    fetchApi<PhoneRunReadiness>(`/r2/phone/readiness?${new URLSearchParams({ kind, seriesId, language })}`),

  /** One fix from that checklist; `prompt` (the Editor 2.0 prompt, kept in this browser) for send_prompt. */
  fixRunReadiness: (fix: { action: Exclude<PhoneReadinessFixAction, 'run_narration'>; seriesId: string; chapterIds?: string[]; prompt?: string }) =>
    fetchApi<{ message: string }>('/r2/phone/readiness/fix', { method: 'POST', body: JSON.stringify(fix) }),

  /** Each phone's screen state and last screenshot, from the relay. */
  getPhoneScreens: () => fetchApi<{ phones: PhoneScreen[] }>('/r2/phone/screens'),

  /**
   * On one phone: select a browser profile (the next run starts in it), or
   * read what one profile's ChatGPT account offers (modes, models, efforts).
   * `profile` is the phone's own id for it (PhoneUploadProfile.profileId).
   */
  sendPhoneProfile: (command: 'select' | 'options', device: string, profile: string) =>
    fetchApi<{ id: string; reached: boolean }>('/r2/phone/profile', {
      method: 'POST',
      body: JSON.stringify({ command, device, profile })
    }),

  /** Forgets a phone's screenshot on the server, once its viewer closes. */
  dropPhoneScreenshot: (device: string) =>
    fetchApi<{ ok: true; dropped: boolean }>(`/r2/phone/screens/${encodeURIComponent(device)}/screenshot`, { method: 'DELETE' }),

  /** Wake (`on`, kept on until `off`), Screen off, or Screenshot (`shot`) on one phone. */
  sendPhoneScreen: (command: 'on' | 'off' | 'shot', device: string) =>
    fetchApi<{ id: string; reached: boolean }>('/r2/phone/screen', { method: 'POST', body: JSON.stringify({ command, device }) }),

  /** Drops a phone's receipts from the relay: one no longer used, or the old app's copies. */
  forgetPhone: (device: string) =>
    fetchApi<{ ok: true }>('/r2/phone/forget', { method: 'POST', body: JSON.stringify({ device }) }),

  getRelay: () => fetchApi<RelayStatus>('/r2/relay'),

  /** A blank or missing token keeps the saved one. */
  saveRelay: (update: { url?: string; token?: string; clearToken?: boolean }) =>
    fetchApi<RelayStatus>('/r2/relay', { method: 'PUT', body: JSON.stringify(update) }),

  testRelay: () =>
    fetchApi<{ ok: true; receipts: { kind: string; at: number; size: number }[]; phones: number }>('/r2/relay/test', { method: 'POST' }),

  getUsage: () => fetchApi<R2Usage>('/r2/usage'),

  deleteObject: (key: string) =>
    fetchApi<{ ok: true }>(`/r2/objects?key=${encodeURIComponent(key)}`, { method: 'DELETE' }),

  getConfig: () => fetchApi<R2Config>('/r2/config'),

  saveConfig: (update: R2ConfigUpdate) =>
    fetchApi<R2Config>('/r2/config', { method: 'PUT', body: JSON.stringify(update) }),

  test: () => fetchApi<{ ok: true; bucket: string }>('/r2/test', { method: 'POST' }),

  /** Per series: chapters to send, on the phone, cleared there. Reads disk only, plus the phone's receipt. */
  getSendPlan: (fresh = false) =>
    fetchApi<PhoneSendPlan>(`/r2/phone-send/plan${fresh ? '?fresh=1' : ''}`),

  /** Sends each series' new and changed chapters, or exactly `chapterIds`. Progress comes as `phone-send:progress`. */
  sendToPhone: (series: { seriesId: string; chapterIds?: string[] }[]) =>
    fetchApi<PhoneSendJob>('/r2/phone-send', {
      method: 'POST',
      body: JSON.stringify({ series })
    }),

  setAutoSend: (seriesId: string, enabled: boolean) =>
    fetchApi<{ ok: true }>('/r2/phone-send/auto', { method: 'PUT', body: JSON.stringify({ seriesId, enabled }) }),

  /** Writes the phone's chapter index where it is behind, so its clear dialog ticks newly finished chapters. */
  updatePhoneIndex: (seriesId?: string) =>
    fetchApi<{ written: number }>('/r2/phone-send/index', { method: 'POST', body: JSON.stringify({ seriesId }) }),

  cancel: () => fetchApi<{ job: PhoneSendJob | null }>('/r2/cancel', { method: 'POST' }),

  /** Chapters the Master phone downloaded and sent that this library doesn't have. One bucket list + a GET per series index. */
  getPhonePull: () => fetchApi<PhonePullOffer>('/r2/phone-pull'),

  /** Brings the picked chapters into the library (Get chapters from phones). */
  pullFromPhones: (series: { folder: string; chapters: string[] }[]) =>
    fetchApi<PhonePullResult>('/r2/phone-pull', { method: 'POST', body: JSON.stringify({ series }) })
}

/** A chapter the Master phone sent (server/src/services/phonePull.ts). */
export interface PhonePullChapter {
  name: string
  number: number
  key: string
  etag: string | null
  sentAt: string
  files: number
  bytes: number
  fingerprint: string | null
  /** new: not here (or no pages here); changed: here, with other pages. */
  state: 'new' | 'changed'
}

export interface PhonePullOffer {
  configured: boolean
  series: { folder: string; seriesId: string | null; title: string; chapters: PhonePullChapter[] }[]
}

export interface PhonePullResult {
  pulled: { folder: string; chapter: string; pages: number }[]
  failed: { folder: string; chapter: string; reason: string }[]
}

// ============ Page Stitcher ============

/** A chapter with more pages than this is flagged for stitching; normal chapters run 14–20. */
export const LARGE_CHAPTER_PAGES = 40

export interface StitchChapterRow {
  id: string
  number: number
  title: string | null
  seriesId: string
  seriesTitle: string
  pageCount: number
  /** Set while the originals are still backed up, so the stitch can be undone. */
  stitched: { originalPages: number; stitchedAt: string } | null
}

export interface StitchPage {
  filename: string
  width: number
  height: number
  format: string
  bytes: number
}

export interface StitchRecord {
  stitchedAt: string
  originals: string[]
  excluded: string[]
  outputs: { filename: string; sources: string[]; width: number; height: number; bytes: number }[]
}

/** One page's rows for Auto stitch: base64, one byte per row, 0 = blank. */
export interface StitchProfile {
  filename: string
  rows: number
  ink: string
}

/** Repeated intro ends / outro starts at `row` of `file`; seen in chapter `referenceNumber` too. */
export interface StitchEdges {
  intro: { file: string; row: number; referenceNumber: number } | null
  outro: { file: string; row: number; referenceNumber: number } | null
}

/** A band of one page's source rows, [top, bottom). */
export interface StitchPieceSpec {
  file: string
  top: number
  bottom: number
}

/** The downloaded chapters either side of this one in its series. */
export interface ChapterNeighbours {
  prev: { id: string; number: number } | null
  next: { id: string; number: number } | null
}

export interface StitchChapterState {
  chapterId: string
  number: number
  title: string | null
  seriesId: string
  seriesTitle: string
  /** Tallest page a multi-page group may produce. */
  maxHeight: number
  pages: StitchPage[]
  record: StitchRecord | null
  backupBytes: number
  blockers: string[]
  neighbours: ChapterNeighbours
}

export const stitchApi = {
  getChapters: () => fetchApi<StitchChapterRow[]>('/stitch/chapters'),

  getChapter: (id: string) => fetchApi<StitchChapterState>(`/stitch/chapters/${id}`),

  /** `version` busts the cache: file names are reused across a stitch and its undo. */
  thumbUrl: (id: string, filename: string, version: string) =>
    `${API_BASE}/stitch/chapters/${id}/thumb/${encodeURIComponent(filename)}?v=${encodeURIComponent(version)}`,

  imageUrl: (id: string, filename: string, version: string) =>
    `${API_BASE}/stitch/chapters/${id}/image/${encodeURIComponent(filename)}?v=${encodeURIComponent(version)}`,

  /** Row profiles, plus where art repeated from nearby chapters (intro / outro) ends and starts. */
  profiles: (id: string) =>
    fetchApi<{ profileWidth: number; profiles: StitchProfile[]; edges: StitchEdges }>(
      `/stitch/chapters/${id}/profiles`
    ),

  /** Each group is one output page: whole pages by name, cut pages as row pieces. */
  stitch: (id: string, groups: (string | StitchPieceSpec)[][]) =>
    fetchApi<{ originalPages: number; stitchedPages: number; excluded: number }>(`/stitch/chapters/${id}`, {
      method: 'POST',
      body: JSON.stringify({ groups })
    }),

  undo: (id: string) => fetchApi<{ ok: true }>(`/stitch/chapters/${id}/undo`, { method: 'POST' }),

  discardBackup: (id: string) =>
    fetchApi<{ ok: true }>(`/stitch/chapters/${id}/backup`, { method: 'DELETE' })
}

// ============ Chapter page preview ============

export interface DeletedPage {
  filename: string
  deletedAt: string
  width: number
  height: number
  bytes: number
}

export interface ChapterPagesState {
  chapterId: string
  number: number
  title: string | null
  seriesId: string
  seriesTitle: string
  pages: StitchPage[]
  /** Pages in the chapter's bin, restorable until the bin is emptied. */
  deleted: DeletedPage[]
  blockers: string[]
  neighbours: ChapterNeighbours
}

export const pagePreviewApi = {
  getChapter: (id: string) => fetchApi<ChapterPagesState>(`/page-preview/chapters/${id}`),

  deletePages: (id: string, filenames: string[]) =>
    fetchApi<{ deleted: number }>(`/page-preview/chapters/${id}/delete`, {
      method: 'POST',
      body: JSON.stringify({ filenames })
    }),

  restorePages: (id: string, filenames: string[]) =>
    fetchApi<{ restored: number }>(`/page-preview/chapters/${id}/restore`, {
      method: 'POST',
      body: JSON.stringify({ filenames })
    }),

  emptyBin: (id: string) => fetchApi<{ removed: number }>(`/page-preview/chapters/${id}/bin`, { method: 'DELETE' }),

  /** Live pages use the stitcher's thumb/image endpoints; this one reads the bin. */
  binThumbUrl: (id: string, filename: string) =>
    `${API_BASE}/page-preview/chapters/${id}/bin/${encodeURIComponent(filename)}/thumb`
}
