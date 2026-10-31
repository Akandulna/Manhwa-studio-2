import type { YouTubeJob } from '../../../server/src/services/youtubeAutomationTypes'
export type { YouTubeJob }
import type { YouTubeGuideline, YouTubeGuidelineKind, YouTubeGuidelines, YouTubeGuidelineVersion, YouTubeWorkspace, YouTubeLibraryStatus, YouTubeHindiOverlay } from '../../../server/src/services/youtubeTypes'
export type { YouTubeGuideline, YouTubeGuidelineKind, YouTubeGuidelines, YouTubeGuidelineVersion, YouTubeWorkspace, YouTubeLibraryStatus, YouTubeHindiOverlay }

async function request<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api/youtube${endpoint}`, options)
  if (!response.ok) {
    const result = await response.json().catch(() => null)
    throw new Error(result?.error || `YouTube request failed (${response.status}).`)
  }
  return response.json()
}

function descriptionRequest(seriesId: string, action: string, body: unknown, method = 'POST') {
  return request<YouTubeWorkspace>(`/series/${encodeURIComponent(seriesId)}/descriptions/${action}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

export const youtubeApi = {
  automationPhones: () => request<{id:string;name:string;ready:boolean;reason:string;thumbnailPreparation?:boolean;thumbnailGeneration?:boolean}[]>('/automation/phones'),
  automationLatest: (id:string,kind:'titles'|'descriptions'|'thumbnail_prepare'|'thumbnail_generate',requestId:string,slot?:number) => request<YouTubeJob|null>(`/series/${encodeURIComponent(id)}/automation/${kind}/latest?requestId=${encodeURIComponent(requestId)}${slot===undefined?'':`&slot=${slot}`}`),
  automationStart: (id:string,kind:'titles'|'descriptions'|'thumbnail_prepare'|'thumbnail_generate',requestId:string,device:string,expectedRevision:number,slot?:number) => request<YouTubeJob>(`/series/${encodeURIComponent(id)}/automation/${kind}/start`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId,device,expectedRevision,slot})}),
  automationRetryImage: (id:string,jobId:string) => request<YouTubeJob>(`/series/${encodeURIComponent(id)}/automation/jobs/${encodeURIComponent(jobId)}/retry-image`,{method:'POST'}),
  automationCheck: (id:string,jobId:string) => request<YouTubeJob>(`/series/${encodeURIComponent(id)}/automation/jobs/${encodeURIComponent(jobId)}/check`,{method:'POST'}),
  libraryStatuses: (seriesIds: string[]) => request<Record<string, YouTubeLibraryStatus>>('/library/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seriesIds }) }),
  setSeriesDone: (seriesId: string, done: boolean, expectedRevision: number) => request<YouTubeLibraryStatus>(`/series/${encodeURIComponent(seriesId)}/done`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done, expectedRevision }) }),
  prepareDescription: (seriesId: string, expectedRevision: number, feedback = '', reuse = false) => descriptionRequest(seriesId, 'prepare', { expectedRevision, feedback, reuse }),
  importDescription: (seriesId: string, requestId: string, response: string, expectedRevision: number) => descriptionRequest(seriesId, 'import', { requestId, response, expectedRevision }),
  saveDescriptionText: (seriesId: string, title: string, text: string, expectedRevision: number, variant: 'en' | 'hinglish' = 'en') => descriptionRequest(seriesId, 'current', { title, text, expectedRevision, variant }, 'PUT'),
  restoreDescription: (seriesId: string, versionId: string, expectedRevision: number) => descriptionRequest(seriesId, 'restore', { versionId, expectedRevision }),
  guidelines: () => request<YouTubeGuidelines>('/guidelines'),
  history: (kind: YouTubeGuidelineKind) => request<YouTubeGuidelineVersion[]>(`/guidelines/${kind}/history`),
  version: (kind: YouTubeGuidelineKind, id: string) => request<YouTubeGuideline>(`/guidelines/${kind}/versions/${encodeURIComponent(id)}`),
  download: (kind: YouTubeGuidelineKind, id: string) => `/api/youtube/guidelines/${kind}/versions/${encodeURIComponent(id)}/download`,
  upload: (kind: 'title' | 'thumbnail', file: File, expectedVersion: string) => {
    const body = new FormData()
    body.append('expectedVersion', expectedVersion)
    body.append('file', file)
    return request<YouTubeGuideline>(`/guidelines/${kind}`, { method: 'POST', body })
  },
  saveDescription: (text: string, expectedVersion: string) => request<YouTubeGuideline>('/guidelines/description', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, expectedVersion })
  }),
  openWorkspace: (seriesId: string) => request<YouTubeWorkspace>(`/series/${encodeURIComponent(seriesId)}/workspace`, { method: 'POST' }),
  prepareTitles: (seriesId: string, expectedRevision: number) => request<YouTubeWorkspace>(`/series/${encodeURIComponent(seriesId)}/titles/prepare`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision })
  }),
  importTitles: (seriesId: string, requestId: string, response: string, expectedRevision: number) => request<YouTubeWorkspace>(`/series/${encodeURIComponent(seriesId)}/titles/import`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId, response, expectedRevision })
  }),
  selectTitle: (seriesId: string, choice: { suggestionId: string } | { title: string }, expectedRevision: number) => request<YouTubeWorkspace>(`/series/${encodeURIComponent(seriesId)}/titles/selection`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...choice, expectedRevision })
  })
}

export interface YouTubeCrop { id: string; chapterId: string; label: string; filename: string; bytes: number }
const thumbPath = (id: string) => `/series/${encodeURIComponent(id)}/thumbnails`
function thumbnailRequest(id: string, action: string, body: unknown, method = 'POST') {
  return request<YouTubeWorkspace>(`${thumbPath(id)}/${action}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}
export const thumbnailApi = {
  overlayStamp: (settings: Pick<YouTubeHindiOverlay, 'template' | 'color'>) => `/api/youtube/thumbnail-overlay/stamp?template=${settings.template}&color=${encodeURIComponent(settings.color)}`,
  saveHindiOverlay: (id: string, imageId: string, overlay: YouTubeHindiOverlay, expectedRevision: number) => thumbnailRequest(id, 'hindi-overlay', { imageId, overlay, expectedRevision }, 'PUT'),
  hinglishMedia: (id: string, imageId: string, settings: YouTubeHindiOverlay, download = false) => `/api/youtube${thumbPath(id)}/hinglish/${encodeURIComponent(imageId)}?styleKey=${encodeURIComponent(`${settings.template}|${settings.color}|${settings.size}|${settings.x}|${settings.y}`)}${download ? '&download=1' : ''}`,
  replace: (id: string, imageId: string, file: File, expectedRevision: number) => {
    const body = new FormData(); body.append('imageId', imageId); body.append('expectedRevision', String(expectedRevision)); body.append('file', file)
    return request<YouTubeWorkspace>(`${thumbPath(id)}/replace`, { method: 'POST', body })
  },
  copyReferences: (id: string, requestId: string) => request<{ count: number; includesBase: boolean }>(`${thumbPath(id)}/requests/${encodeURIComponent(requestId)}/copy-references`, { method: 'POST', headers: { 'X-Studio-Clipboard': 'references' } }),
  chapters: (id: string) => request<{ id: string; number: number }[]>(`/series/${encodeURIComponent(id)}/crop-chapters`),
  crops: (id: string, chapterId: string) => request<YouTubeCrop[]>(`/series/${encodeURIComponent(id)}/crops/${encodeURIComponent(chapterId)}`),
  cropUrl: (id: string, crop: YouTubeCrop) => `/api/youtube/series/${encodeURIComponent(id)}/crops/${encodeURIComponent(crop.chapterId)}/${crop.id}`,
  reference: (id: string, expectedRevision: number, choice: { chapterId: string; cropId: string } | { removeId: string } | { primaryId: string }) => thumbnailRequest(id, 'references', { ...choice, expectedRevision }, 'PUT'),
  prepare: (id: string, expectedRevision: number, mode: 'fresh' | 'edit', feedback = '', parentId?: string) => thumbnailRequest(id, 'prepare', { expectedRevision, mode, feedback, parentId }),
  import: (id: string, requestId: string, slot: number, file: File, expectedRevision: number) => {
    const body = new FormData(); body.append('requestId', requestId); body.append('slot', String(slot)); body.append('expectedRevision', String(expectedRevision)); body.append('file', file)
    return request<YouTubeWorkspace>(`${thumbPath(id)}/import`, { method: 'POST', body })
  },
  select: (id: string, imageId: string, expectedRevision: number) => thumbnailRequest(id, 'selection', { id: imageId, expectedRevision }, 'PUT'),
  media: (id: string, imageId: string, download = false) => `/api/youtube${thumbPath(id)}/media/${encodeURIComponent(imageId)}${download ? '?download=1' : ''}`,
  package: (id: string, requestId: string) => `/api/youtube${thumbPath(id)}/requests/${encodeURIComponent(requestId)}/package`
}
