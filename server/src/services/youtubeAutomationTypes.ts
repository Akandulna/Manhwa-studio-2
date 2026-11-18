export type YouTubeAutomationKind = 'titles' | 'descriptions' | 'thumbnail_prepare' | 'thumbnail_generate'
export interface YouTubePhone { id: string; name: string; ready: boolean; reason: string; prefix: string; thumbnailPreparation?: boolean; thumbnailGeneration?: boolean; aiStudioText?: boolean }
/** Titles and descriptions run in AI Studio (Gemini 4 Hydrogen, High, Search grounding); thumbnails need ChatGPT's images. */
export type YouTubeProvider = 'aistudio' | 'chatgpt'
export const youtubeProvider = (kind: YouTubeAutomationKind): YouTubeProvider => kind === 'titles' || kind === 'descriptions' ? 'aistudio' : 'chatgpt'
/** What the phone's crops receipt says about one job, read from the relay's memory (no R2 request). */
export interface YouTubePhoneJobStatus { running: boolean; step?: string; start?: { state: string; reason?: string } }
export interface YouTubeJob {
 schema: 'youtube-automation/1'; id: string; seriesId: string; requestId: string; kind: YouTubeAutomationKind; device: string; prefix: string; expectedRevision: number; createdAt: string; expiresAt: string;
 status: 'dispatching' | 'waiting' | 'done' | 'needs_attention' | 'cancelled'; message: string; provider?: YouTubeProvider; phoneStep?: string; cancelledAt?: string; response?: string; lastCheckAt?: number; phoneFailed?: boolean; image?: { key: string; bytes: number; sha256: string; mime: string; width: number; height: number }; slot?: number; attachments?: { key: string; filename: string; sha256: string; bytes: number }[]
}
