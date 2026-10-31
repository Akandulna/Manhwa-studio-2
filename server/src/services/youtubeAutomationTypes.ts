export type YouTubeAutomationKind = 'titles' | 'descriptions' | 'thumbnail_prepare' | 'thumbnail_generate'
export interface YouTubePhone { id: string; name: string; ready: boolean; reason: string; prefix: string; thumbnailPreparation?: boolean; thumbnailGeneration?: boolean }
export interface YouTubeJob {
 schema: 'youtube-automation/1'; id: string; seriesId: string; requestId: string; kind: YouTubeAutomationKind; device: string; prefix: string; expectedRevision: number; createdAt: string; expiresAt: string;
 status: 'dispatching' | 'waiting' | 'done' | 'needs_attention'; message: string; response?: string; lastCheckAt?: number; phoneFailed?: boolean; image?: { key: string; bytes: number; sha256: string; mime: string; width: number; height: number }; slot?: number; attachments?: { key: string; filename: string; sha256: string; bytes: number }[]
}
