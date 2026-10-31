export type YouTubeGuidelineKind = 'title' | 'thumbnail' | 'description'

export interface YouTubeGuidelineVersion {
  id: string
  kind: YouTubeGuidelineKind
  sourceName: string
  createdAt: string
  sha256: string
  bytes: number
  mediaType: string
}

export interface YouTubeGuideline extends YouTubeGuidelineVersion {
  text: string
}

export interface YouTubeGuidelines {
  title: YouTubeGuideline
  thumbnail: YouTubeGuideline
  description: YouTubeGuideline
}

export interface YouTubeTitleResearch {
  resolvedTitle: string
  summary: string
  sources: { title: string; url: string }[]
}

export interface YouTubeTitleResponse {
  schemaVersion: 1
  requestId: string
  seriesId: string
  language: 'en'
  status: 'ok'
  research: YouTubeTitleResearch
  titles: string[]
}

export interface YouTubeTitleRequest {
  id: string
  seriesName: string
  createdAt: string
  guidelineVersion: string
  guidelineSha256: string
  prompt: string
  importedAt: string | null
  response: YouTubeTitleResponse | null
}

export interface YouTubeTitleSuggestion {
  id: string
  title: string
  requestId: string
  createdAt: string
}

export interface YouTubeTitleSelection {
  id: string
  title: string
  source: 'suggestion' | 'custom'
  suggestionId: string | null
  selectedAt: string
}

export interface YouTubeTitleState {
  revision: number
  requests: YouTubeTitleRequest[]
  suggestions: YouTubeTitleSuggestion[]
  selections: YouTubeTitleSelection[]
}

export interface YouTubeWorkspace {
  schemaVersion: 1
  seriesId: string
  language: 'en'
  createdAt: string
  updatedAt: string
  closedAt?: string | null
  guidelineVersions: Record<YouTubeGuidelineKind, string>
  selectedTitle: string | null
  description: string | null
  hinglishDescription?: string | null
  hinglishDescriptionNeedsUpdate?: boolean
  hindiOverlay?: YouTubeHindiOverlay
  selectedThumbnail: string | null
  thumbnails: YouTubeThumbnailState
  titles: YouTubeTitleState
  descriptionNeedsUpdate?: boolean
  thumbnailNeedsUpdate?: boolean
  descriptions: {
    requests: YouTubeDescriptionRequest[]
    versions: YouTubeDescriptionVersion[]
    selectedVersionId: string | null
  }
}

export interface YouTubeDescriptionRequest {
  id: string
  title: string
  seriesName: string
  createdAt: string
  guidelineVersion: string
  guidelineSha256: string
  research: YouTubeTitleResearch | null
  feedback: string
  prompt: string
  importedAt: string | null
  importedDescription: string | null
  importedHinglishDescription?: string | null
  outputVersion?: 2
}

export interface YouTubeDescriptionVersion {
  hinglishText?: string | null
  englishNeedsUpdate?: boolean
  hinglishNeedsUpdate?: boolean
  id: string
  title: string
  text: string
  source: 'generated' | 'edited' | 'legacy'
  requestId: string | null
  createdAt: string
}

export interface YouTubeImage {
  id: string
  sha256: string
  width: number
  height: number
  label: string
}
export interface YouTubeReference extends YouTubeImage { chapterId: string; cropId: string }
export interface YouTubeThumbnailRequest {
  id: string
  title: string
  seriesName: string
  createdAt: string
  guidelineVersion: string
  guidelineSha256: string
  masterSha256: string
  mode: 'fresh' | 'edit'
  feedback: string
  parentId: string | null
  references: YouTubeReference[]
  prompts: string[]
}
export interface YouTubeThumbnailVersion extends YouTubeImage {
  title: string
  requestId: string | null
  slot: number | null
  automationJobId?: string
  source?: 'generated' | 'uploaded'
  replacesId?: string
  createdAt: string
}
export interface YouTubeThumbnailState {
  references: YouTubeReference[]
  requests: YouTubeThumbnailRequest[]
  versions: YouTubeThumbnailVersion[]
}

export interface YouTubeLibraryStatus {
  seriesId: string
  revision: number
  english: 'not_started' | 'in_progress' | 'needs_update' | 'done'
  hinglish: 'not_started' | 'title_ready' | 'needs_update' | 'thumbnail_pending' | 'done'
  closedAt: string | null
}

export interface YouTubeHindiOverlay {
  template: 'outline' | 'shadow' | 'italic' | 'badge'
  color: string
  size: number
  x: number
  y: number
}
