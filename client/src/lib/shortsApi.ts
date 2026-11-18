export interface ShortShot {
  id: string; start: number; end: number; narration: string; caption: string
  note: string; motion: string; images: string[]
}
export interface ShortProject {
  id: string; revision: string; folder: string; timelineFile: string; title: string
  series: string; language: string; duration: number; shots: ShortShot[]
  audioFile: string | null; missingImages: string[]; warnings: string[]
}
export interface ShortPreviewJob {
  id: string; projectId: string; revision: string
  state: 'rendering' | 'complete' | 'failed' | 'cancelled'
  progress: number; message: string; videoUrl?: string
}
async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/shorts${url}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-studio-client': '1' }, body: JSON.stringify(body)
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Shorts request failed.')
  return data as T
}
export const shortsApi = {
  folders: () => request<{ name: string; folder: string }[]>('/folders'),
  load: (folder: string) => request<ShortProject>('/load', { folder }),
  start: (project: ShortProject) => request<ShortPreviewJob>(`/projects/${project.id}/preview`, { revision: project.revision }),
  latest: (id: string) => request<ShortPreviewJob | null>(`/projects/${id}/preview`),
  job: (id: string) => request<ShortPreviewJob>(`/previews/${id}`),
  cancel: (id: string) => request<ShortPreviewJob>(`/previews/${id}/cancel`, {}),
  image: (project: ShortProject, name: string) => `/api/shorts/projects/${project.id}/images/${encodeURIComponent(name)}?revision=${project.revision}`
}
