import { buildThumbnailPrompts, thumbnailImage } from './youtubeThumbnails.js'
import type { YouTubeImage, YouTubeThumbnailRequest, YouTubeLibraryStatus } from './youtubeTypes.js'
import { DEFAULT_HINDI_OVERLAY, parseHindiOverlay, renderHinglishThumbnail, hindiOverlayKey } from './youtubeHinglishThumbnail.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import type { YouTubeGuideline, YouTubeGuidelineKind, YouTubeGuidelines, YouTubeWorkspace } from './youtubeTypes.js'
import { buildTitlePrompt, parseTitleResponse, titleKey, validateTitle, YouTubeTitleError } from './youtubeTitles.js'
import { buildDescriptionPrompt, parseDescriptionPair, validateDescription, validateHinglishDescription, assertDescriptionOmitsSeriesNames, descriptionSeriesNames, DESCRIPTION_IDENTITY_POLICY } from './youtubeDescriptions.js'
import type { YouTubeDescriptionRequest } from './youtubeTypes.js'

export const MAX_GUIDELINE_BYTES = 10 * 1024 * 1024
const MAX_TEXT_LENGTH = 500_000
const resources = fileURLToPath(new URL('../../resources/youtube/', import.meta.url))
const kinds: YouTubeGuidelineKind[] = ['title', 'thumbnail', 'description']
type StoredGuideline = YouTubeGuideline & { original: string }
type Index = Record<YouTubeGuidelineKind, string>

export class YouTubeError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}

export function guidelineKind(value: string): YouTubeGuidelineKind {
  if (!kinds.includes(value as YouTubeGuidelineKind)) throw new YouTubeError('Unknown guideline document.', 404)
  return value as YouTubeGuidelineKind
}

// Uploaded documents are reference material. They are never executed as code.
export async function readGuideline(buffer: Buffer, filename: string): Promise<{ text: string; mediaType: string }> {
  if (!buffer.length || buffer.length > MAX_GUIDELINE_BYTES) throw new YouTubeError('Choose a non-empty document up to 10 MB.')
  let text: string
  let mediaType = 'text/plain; charset=utf-8'
  if (buffer.subarray(0, 5).toString() === '%PDF-') {
    const { PDFParse } = await import('pdf-parse')
    const parser = new PDFParse({ data: new Uint8Array(buffer), isEvalSupported: false })
    try { text = (await parser.getText()).text }
    catch { throw new YouTubeError('Could not read this PDF. Use an unlocked PDF with selectable text, or upload a text file.', 422) }
    finally { await parser.destroy() }
    mediaType = 'application/pdf'
  } else {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '') }
    catch { throw new YouTubeError('Use a PDF, UTF-8 text/Markdown file, or title-report JSON export.', 422) }
    if (/\.pdf$/i.test(filename)) throw new YouTubeError('This file does not contain a valid PDF.', 422)
    if (/\.json$/i.test(filename) || text.trimStart().startsWith('{')) {
      try {
        const exported = JSON.parse(text)
        const parts = exported?.widget_state?.report_message?.content?.parts
        const content = typeof exported.text === 'string' ? exported.text : typeof exported.content === 'string' ? exported.content : null
        if (Array.isArray(parts) && parts.length && parts.every((part: unknown) => typeof part === 'string')) text = parts.join('\n\n')
        else if (content) text = content
        else throw new Error('Unsupported export')
        mediaType = 'application/json'
      } catch { throw new YouTubeError('JSON must contain report text, not an arbitrary data file.', 422) }
    } else if (/\.(?!txt$|md$|markdown$)[a-z0-9]+$/i.test(filename)) {
      throw new YouTubeError('Supported files: PDF, TXT, Markdown, and title-report JSON exports.', 422)
    }
  }
  text = text.replace(/\u0000/g, '').trim()
  if (text.length < 20) throw new YouTubeError('The document has too little readable text. For scanned PDFs, upload a text version.', 422)
  if (text.length > MAX_TEXT_LENGTH) throw new YouTubeError('The document is too long. Use up to 500,000 characters.', 422)
  return { text, mediaType }
}

export class YouTubeStore {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private root = path.resolve('.config/youtube'), private defaults = resources) {}

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task)
    this.queue = result.catch(() => undefined)
    return result
  }

  private async atomic(filename: string, value: unknown) {
    await fs.mkdir(path.dirname(filename), { recursive: true })
    const temporary = `${filename}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx' })
      await fs.rename(temporary, filename)
    } finally { await fs.rm(temporary, { force: true }) }
  }

  private async json<T>(filename: string): Promise<T | null> {
    try { return JSON.parse(await fs.readFile(filename, 'utf8')) as T }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error // Never replace unreadable saved work with an empty default.
    }
  }

  private versionPath(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new YouTubeError('Invalid document version.', 404)
    return path.join(this.root, 'versions', `${id}.json`)
  }

  private async createVersion(kind: YouTubeGuidelineKind, buffer: Buffer, name: string): Promise<StoredGuideline> {
    const parsed = await readGuideline(buffer, name)
    const version: StoredGuideline = {
      id: randomUUID(), kind, sourceName: path.basename(name.replace(/\\/g, '/')).replace(/[\r\n\x00-\x1f]/g, '').slice(0, 240) || 'guidelines.txt',
      createdAt: new Date().toISOString(), sha256: createHash('sha256').update(buffer).digest('hex'),
      bytes: buffer.length, mediaType: parsed.mediaType, text: parsed.text, original: buffer.toString('base64')
    }
    await this.atomic(this.versionPath(version.id), version)
    return version
  }

  private async index(): Promise<Index> {
    const filename = path.join(this.root, 'guidelines.json')
    const existing = await this.json<Index>(filename)
    if (existing) return existing
    const index = {} as Index
    for (const kind of kinds) {
      const name = `${kind}-guidelines.md`
      const version = await this.createVersion(kind, await fs.readFile(path.join(this.defaults, name)), name)
      index[kind] = version.id
    }
    await this.atomic(filename, index)
    return index
  }

  private async stored(kind: YouTubeGuidelineKind, id: string): Promise<StoredGuideline> {
    const value = await this.json<StoredGuideline>(this.versionPath(id))
    if (!value || value.kind !== kind) throw new YouTubeError('Document version not found.', 404)
    return value
  }

  private publicVersion({ original: _original, ...version }: StoredGuideline): YouTubeGuideline { return version }

  guidelines(): Promise<YouTubeGuidelines> {
    return this.serial(async () => {
      const index = await this.index()
      const entries = await Promise.all(kinds.map(async kind => [kind, this.publicVersion(await this.stored(kind, index[kind]))]))
      return Object.fromEntries(entries) as unknown as YouTubeGuidelines
    })
  }

  replace(kind: YouTubeGuidelineKind, buffer: Buffer, name: string, expectedVersion: unknown): Promise<YouTubeGuideline> {
    return this.serial(async () => {
      const index = await this.index()
      if (expectedVersion !== index[kind]) throw new YouTubeError('These guidelines changed in another window. Reload before replacing them.', 409)
      const current = await this.stored(kind, index[kind])
      if (createHash('sha256').update(buffer).digest('hex') === current.sha256) return this.publicVersion(current)
      const version = await this.createVersion(kind, buffer, name)
      await this.atomic(path.join(this.root, 'guidelines.json'), { ...index, [kind]: version.id })
      return this.publicVersion(version)
    })
  }

  history(kind: YouTubeGuidelineKind) {
    return this.serial(async () => {
      await this.index()
      const files = await fs.readdir(path.join(this.root, 'versions'))
      const versions = await Promise.all(files.filter(file => file.endsWith('.json')).map(file => this.json<StoredGuideline>(path.join(this.root, 'versions', file))))
      return versions.filter((version): version is StoredGuideline => version?.kind === kind)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(({ text: _text, original: _original, ...version }) => version)
    })
  }

  version(kind: YouTubeGuidelineKind, id: string) {
    return this.serial(async () => this.publicVersion(await this.stored(kind, id)))
  }

  original(kind: YouTubeGuidelineKind, id: string) {
    return this.serial(async () => {
      const version = await this.stored(kind, id)
      return { sourceName: version.sourceName, mediaType: version.mediaType, buffer: Buffer.from(version.original, 'base64') }
    })
  }

  private workspacePath(seriesId: string) {
    return path.join(this.root, 'workspaces', `${createHash('sha256').update(seriesId).digest('hex')}.json`)
  }

  private async workspace(seriesId: string): Promise<YouTubeWorkspace> {
    const filename = this.workspacePath(seriesId)
    const existing = await this.json<YouTubeWorkspace>(filename)
    if (existing) {
      if (existing.seriesId !== seriesId || existing.language !== 'en' || existing.schemaVersion !== 1) throw new YouTubeError('Saved workspace has an incompatible format.', 409)
      let migrated = false
      if (!existing.titles) {
        existing.titles = { revision: 0, requests: [], suggestions: [], selections: [] }
        migrated = true
      }
      if (!existing.thumbnails) { existing.thumbnails = { references: [], requests: [], versions: [] }; migrated = true }
      if (!existing.descriptions) {
        const legacy = existing.description ? { id: randomUUID(), title: existing.selectedTitle ?? '', text: existing.description, source: 'legacy' as const, requestId: null, createdAt: existing.updatedAt } : null
        existing.descriptions = { requests: [], versions: legacy ? [legacy] : [], selectedVersionId: legacy?.id ?? null }
        migrated = true
      }
      if (migrated) await this.atomic(filename, existing)
      return existing
    }
    const now = new Date().toISOString()
    const workspace: YouTubeWorkspace = {
      schemaVersion: 1, seriesId, language: 'en', createdAt: now, updatedAt: now,
      guidelineVersions: { ...await this.index() }, selectedTitle: null, description: null, hinglishDescription: null, selectedThumbnail: null,
      titles: { revision: 0, requests: [], suggestions: [], selections: [] },
      thumbnails: { references: [], requests: [], versions: [] },
      descriptions: { requests: [], versions: [], selectedVersionId: null }
    }
    await this.atomic(filename, workspace)
    return workspace
  }

  openWorkspace(seriesId: string): Promise<YouTubeWorkspace> {
    return this.serial(() => this.workspace(seriesId))
  }

  private libraryStatus(seriesId: string, w: YouTubeWorkspace | null): YouTubeLibraryStatus {
    const complete = Boolean(w?.selectedTitle?.trim() && w.description?.trim() && w.selectedThumbnail)
    const needsUpdate = Boolean(w?.descriptionNeedsUpdate || w?.thumbnailNeedsUpdate)
    const hasHinglishThumbnail = Boolean(w?.selectedThumbnail && w.thumbnails?.versions.some(image => image.id === w.selectedThumbnail))
    const started = Boolean(w?.selectedTitle || w?.description || w?.selectedThumbnail || w?.titles?.requests.length || w?.thumbnails?.requests.length || w?.descriptions?.requests.length)
    return { seriesId, revision: w?.titles?.revision ?? 0, english: needsUpdate ? 'needs_update' : complete ? 'done' : started ? 'in_progress' : 'not_started', hinglish: w?.hinglishDescriptionNeedsUpdate || (w?.hinglishDescription && w?.thumbnailNeedsUpdate) ? 'needs_update' : w?.selectedTitle && w?.hinglishDescription?.trim() ? hasHinglishThumbnail ? 'done' : 'thumbnail_pending' : w?.selectedTitle ? 'title_ready' : 'not_started', closedAt: w?.closedAt ?? null }
  }

  libraryStatuses(seriesIds: string[]): Promise<Record<string, YouTubeLibraryStatus>> {
    return this.serial(async () => {
      const result: Record<string, YouTubeLibraryStatus> = {}
      for (const seriesId of seriesIds) {
        // Listing the library never creates workspaces or initializes guideline documents.
        const w = await this.json<YouTubeWorkspace>(this.workspacePath(seriesId))
        if (w && (w.seriesId !== seriesId || w.schemaVersion !== 1 || w.language !== 'en')) throw new YouTubeError('Saved workspace has an incompatible format.', 409)
        result[seriesId] = this.libraryStatus(seriesId, w)
      }
      return result
    })
  }

  setSeriesDone(seriesId: string, input: { done?: unknown; expectedRevision?: unknown }): Promise<YouTubeLibraryStatus> {
    return this.serial(async () => {
      if (typeof input.done !== 'boolean') throw new YouTubeError('Choose whether to mark this series done or reopen it.')
      const w = await this.workspace(seriesId); this.checkRevision(w, input.expectedRevision)
      if (Boolean(w.closedAt) === input.done) return this.libraryStatus(seriesId, w)
      w.closedAt = input.done ? new Date().toISOString() : null
      await this.saveWorkspace(w)
      return this.libraryStatus(seriesId, w)
    })
  }

  private checkRevision(workspace: YouTubeWorkspace, expected: unknown) {
    if (!Number.isInteger(expected) || expected !== workspace.titles.revision) throw new YouTubeError('Workspace changed in another window. Reload before saving; your draft is retained.', 409)
  }

  private async saveWorkspace(workspace: YouTubeWorkspace) {
    workspace.updatedAt = new Date().toISOString()
    workspace.titles.revision++
    await this.atomic(this.workspacePath(workspace.seriesId), workspace)
    return workspace
  }

  prepareTitles(seriesId: string, seriesName: string, expectedRevision: unknown): Promise<YouTubeWorkspace> {
    return this.serial(async () => {
      const workspace = await this.workspace(seriesId)
      this.checkRevision(workspace, expectedRevision)
      if (!seriesName.trim() || seriesName.length > 500) throw new YouTubeError('The series name is missing or too long.')
      const index = await this.index()
      const guideline = this.publicVersion(await this.stored('title', index.title))
      const id = randomUUID()
      workspace.titles.requests.push({
        id, seriesName, createdAt: new Date().toISOString(), guidelineVersion: guideline.id, guidelineSha256: guideline.sha256,
        prompt: buildTitlePrompt({ id, seriesName, workspace, guideline }), importedAt: null, response: null
      })
      return this.saveWorkspace(workspace)
    })
  }

  importTitles(seriesId: string, requestId: string, rawResponse: unknown, expectedRevision: unknown): Promise<YouTubeWorkspace> {
    return this.serial(async () => {
      const workspace = await this.workspace(seriesId)
      const request = workspace.titles.requests.find(item => item.id === requestId)
      if (!request) throw new YouTubeError('Title prompt not found for this series. Prepare a prompt first.', 404)
      const response = parseTitleResponse(rawResponse, request.id, seriesId)
      if (request.response) {
        if (JSON.stringify(request.response) === JSON.stringify(response)) return workspace
        throw new YouTubeError('This prompt already has an imported response. Prepare another prompt for more titles.', 409)
      }
      this.checkRevision(workspace, expectedRevision)
      const previous = new Set([...workspace.titles.suggestions.map(item => titleKey(item.title)), ...workspace.titles.selections.map(item => titleKey(item.title)), ...(workspace.selectedTitle ? [titleKey(workspace.selectedTitle)] : [])])
      if (response.titles.some(title => previous.has(titleKey(title)))) throw new YouTubeTitleError('This response repeats a previous suggestion or custom title. Ask the AI for five new titles using the same prompt.')
      const now = new Date().toISOString()
      request.response = response
      request.importedAt = now
      workspace.titles.suggestions.push(...response.titles.map(title => ({ id: randomUUID(), title, requestId, createdAt: now })))
      return this.saveWorkspace(workspace)
    })
  }

  selectTitle(seriesId: string, input: { suggestionId?: unknown; title?: unknown; expectedRevision?: unknown; seriesName?: string }): Promise<YouTubeWorkspace> {
    return this.serial(async () => {
      const workspace = await this.workspace(seriesId)
      this.checkRevision(workspace, input.expectedRevision)
      let title: string
      let suggestionId: string | null = null
      if (typeof input.suggestionId === 'string' && input.title === undefined) {
        const suggestion = workspace.titles.suggestions.find(item => item.id === input.suggestionId)
        if (!suggestion) throw new YouTubeError('Choose a title suggestion from this series.', 404)
        title = suggestion.title
        suggestionId = suggestion.id
      } else if (input.suggestionId === undefined && typeof input.title === 'string') {
        title = validateTitle(input.title)
      } else throw new YouTubeError('Choose a suggestion or enter one custom title.')
      if (workspace.selectedTitle === title) return workspace
      workspace.selectedTitle = title
      const selectedDescription = workspace.descriptions.versions.find(item => item.id === workspace.descriptions.selectedVersionId)
      workspace.descriptionNeedsUpdate = Boolean(workspace.description) && (selectedDescription?.title !== title || Boolean(selectedDescription?.englishNeedsUpdate))
      workspace.hinglishDescriptionNeedsUpdate = Boolean(workspace.hinglishDescription) && (selectedDescription?.title !== title || Boolean(selectedDescription?.hinglishNeedsUpdate))
      workspace.thumbnailNeedsUpdate = Boolean(workspace.selectedThumbnail) && workspace.thumbnails.versions.find(item => item.id === workspace.selectedThumbnail)?.title !== title
      workspace.titles.selections.push({ id: randomUUID(), title, source: suggestionId ? 'suggestion' : 'custom', suggestionId, selectedAt: new Date().toISOString() })
      // Prepare the next manual step with the exact chosen title. Never lose the
      // title selection if description guidelines cannot be read temporarily.
      try { await this.appendDescriptionRequest(workspace, input.seriesName ?? title, '') }
      catch (error) { console.error('[youtube] Description prompt could not be prepared; retry from Description.', error) }
      return this.saveWorkspace(workspace)
    })
  }

  private async appendDescriptionRequest(workspace: YouTubeWorkspace, seriesName: string, feedback: string) {
    if (!workspace.selectedTitle) throw new YouTubeError('Choose a title before creating its description.')
    if (typeof seriesName !== 'string' || !seriesName.trim() || seriesName.length > 500) throw new YouTubeError('A valid series name is required.')
    const index = await this.index()
    const guideline = this.publicVersion(await this.stored('description', index.description))
    const selection = [...workspace.titles.selections].reverse().find(item => item.title === workspace.selectedTitle)
    const suggestion = workspace.titles.suggestions.find(item => item.id === selection?.suggestionId)
    const source = workspace.titles.requests.find(item => item.id === suggestion?.requestId)
    const latest = [...workspace.titles.requests].reverse().find(item => item.response)
    const request: YouTubeDescriptionRequest = {
      id: randomUUID(), title: workspace.selectedTitle, seriesName: source?.seriesName ?? latest?.seriesName ?? seriesName,
      createdAt: new Date().toISOString(), guidelineVersion: guideline.id, guidelineSha256: guideline.sha256,
      research: source?.response?.research ?? latest?.response?.research ?? null,
      feedback, prompt: '', importedAt: null, importedDescription: null, importedHinglishDescription: null, outputVersion: 2, identityPolicy: DESCRIPTION_IDENTITY_POLICY
    }
    request.prompt = buildDescriptionPrompt(request, workspace, guideline)
    workspace.descriptions.requests.push(request)
    return request
  }

  prepareDescription(seriesId: string, seriesName: string, input: { expectedRevision?: unknown; feedback?: unknown; reuse?: unknown }): Promise<YouTubeWorkspace> {
    return this.serial(async () => {
      const workspace = await this.workspace(seriesId)
      this.checkRevision(workspace, input.expectedRevision)
      if (input.feedback !== undefined && (typeof input.feedback !== 'string' || input.feedback.length > 4000)) throw new YouTubeError('Revision feedback must be text up to 4,000 characters.')
      const feedback = typeof input.feedback === 'string' ? input.feedback.trim() : ''
      if (!workspace.selectedTitle) throw new YouTubeError('Choose a title before creating its description.')
      if (input.reuse === true && !feedback) {
        const index = await this.index()
        if (workspace.descriptions.requests.some(item => item.title === workspace.selectedTitle && !item.importedAt && item.outputVersion === 2 && item.identityPolicy === DESCRIPTION_IDENTITY_POLICY && item.guidelineVersion === index.description)) return workspace
      }
      await this.appendDescriptionRequest(workspace, seriesName, feedback)
      return this.saveWorkspace(workspace)
    })
  }

  importDescription(seriesId: string, input: { requestId?: unknown; response?: unknown; expectedRevision?: unknown }): Promise<YouTubeWorkspace> {
    return this.serial(async () => {
      const workspace = await this.workspace(seriesId)
      const request = workspace.descriptions.requests.find(item => item.id === input.requestId)
      if (!request) throw new YouTubeError('Description prompt not found for this series.', 404)
      const pair = parseDescriptionPair(input.response, request, seriesId)
      const text = pair.english
      const names = descriptionSeriesNames(workspace)
      assertDescriptionOmitsSeriesNames(text, names)
      assertDescriptionOmitsSeriesNames(pair.hinglish ?? workspace.hinglishDescription, names)
      if (request.importedAt) {
        if (request.importedDescription === text && (request.importedHinglishDescription ?? null) === pair.hinglish) return workspace
        throw new YouTubeError('This prompt already has a description. Prepare a new prompt to regenerate it.', 409)
      }
      this.checkRevision(workspace, input.expectedRevision)
      if (request.title !== workspace.selectedTitle) throw new YouTubeError('The selected title changed. Prepare a description for the current title. Your response is still in the draft.', 409)
      const now = new Date().toISOString()
      const hinglishText = pair.hinglish ?? workspace.hinglishDescription ?? null
      const hinglishNeedsUpdate = pair.hinglish === null && Boolean(hinglishText)
      const version = { id: randomUUID(), title: request.title, text, hinglishText, englishNeedsUpdate: false, hinglishNeedsUpdate, source: 'generated' as const, requestId: request.id, createdAt: now }
      request.importedAt = now; request.importedDescription = text; request.importedHinglishDescription = pair.hinglish
      workspace.descriptions.versions.push(version)
      workspace.descriptions.selectedVersionId = version.id
      workspace.description = text; workspace.descriptionNeedsUpdate = false
      workspace.hinglishDescription = hinglishText; workspace.hinglishDescriptionNeedsUpdate = hinglishNeedsUpdate
      return this.saveWorkspace(workspace)
    })
  }

  saveDescription(seriesId: string, input: { text?: unknown; title?: unknown; expectedRevision?: unknown; variant?: unknown }): Promise<YouTubeWorkspace> {
    return this.serial(async () => {
      const workspace = await this.workspace(seriesId)
      this.checkRevision(workspace, input.expectedRevision)
      if (!workspace.selectedTitle || input.title !== workspace.selectedTitle) throw new YouTubeError('The selected title changed. Reload and review this description against the current title.', 409)
      const variant = input.variant ?? 'en'
      if (variant !== 'en' && variant !== 'hinglish') throw new YouTubeError('Choose the English or Hinglish description.')
      const text = variant === 'hinglish' ? validateHinglishDescription(input.text, workspace.description) : validateDescription(input.text)
      if (variant === 'en' && workspace.hinglishDescription) validateHinglishDescription(workspace.hinglishDescription, text)
      assertDescriptionOmitsSeriesNames(text, descriptionSeriesNames(workspace))
      const current = variant === 'en' ? workspace.description : workspace.hinglishDescription
      const needsUpdate = variant === 'en' ? workspace.descriptionNeedsUpdate : workspace.hinglishDescriptionNeedsUpdate
      if (text === current && !needsUpdate) return workspace
      if (variant === 'en') { workspace.description = text; workspace.descriptionNeedsUpdate = false }
      else { workspace.hinglishDescription = text; workspace.hinglishDescriptionNeedsUpdate = false }
      const version = { id: randomUUID(), title: workspace.selectedTitle, text: workspace.description ?? '', hinglishText: workspace.hinglishDescription ?? null, englishNeedsUpdate: Boolean(workspace.descriptionNeedsUpdate), hinglishNeedsUpdate: Boolean(workspace.hinglishDescriptionNeedsUpdate), source: 'edited' as const, requestId: null, createdAt: new Date().toISOString() }
      workspace.descriptions.versions.push(version); workspace.descriptions.selectedVersionId = version.id
      return this.saveWorkspace(workspace)
    })
  }

  restoreDescription(seriesId: string, input: { versionId?: unknown; expectedRevision?: unknown }): Promise<YouTubeWorkspace> {
    return this.serial(async () => {
      const workspace = await this.workspace(seriesId)
      this.checkRevision(workspace, input.expectedRevision)
      const version = workspace.descriptions.versions.find(item => item.id === input.versionId)
      if (!version) throw new YouTubeError('Description version not found for this series.', 404)
      const names = descriptionSeriesNames(workspace)
      assertDescriptionOmitsSeriesNames(version.text, names)
      assertDescriptionOmitsSeriesNames('hinglishText' in version ? version.hinglishText : workspace.hinglishDescription, names)
      workspace.descriptions.selectedVersionId = version.id; workspace.description = version.text
      workspace.descriptionNeedsUpdate = Boolean(version.text) && (version.title !== workspace.selectedTitle || Boolean(version.englishNeedsUpdate))
      if ('hinglishText' in version) workspace.hinglishDescription = version.hinglishText ?? null
      workspace.hinglishDescriptionNeedsUpdate = Boolean(workspace.hinglishDescription) && (version.title !== workspace.selectedTitle || Boolean(version.hinglishNeedsUpdate) || !('hinglishText' in version))
      return this.saveWorkspace(workspace)
    })
  }
  private mediaPath(seriesId: string, sha: string) {
    if (!/^[a-f0-9]{64}$/.test(sha)) throw new YouTubeError('Image not found.', 404)
    return path.join(this.root, 'images', createHash('sha256').update(seriesId).digest('hex'), `${sha}.png`)
  }

  private async saveImage(seriesId: string, buffer: Buffer, label: string): Promise<YouTubeImage> {
    const image = await thumbnailImage(buffer)
    const sha256 = createHash('sha256').update(image.buffer).digest('hex')
    const filename = this.mediaPath(seriesId, sha256)
    await fs.mkdir(path.dirname(filename), { recursive: true })
    try { await fs.writeFile(filename, image.buffer, { flag: 'wx' }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    return { id: randomUUID(), sha256, width: image.width, height: image.height, label }
  }

  // Snapshot references immediately on selection; later requests never depend on live crop files.
  changeReference(seriesId: string, input: { expectedRevision?: unknown; removeId?: unknown; primaryId?: unknown }, add?: { chapterId: string; cropId: string; label: string; buffer: Buffer }): Promise<YouTubeWorkspace> {
    return this.serial(async () => {
      const w = await this.workspace(seriesId); this.checkRevision(w, input.expectedRevision)
      const refs = w.thumbnails.references
      if (add) {
        if (refs.some(ref => ref.chapterId === add.chapterId && ref.cropId === add.cropId)) return w
        if (refs.length >= 10) throw new YouTubeError('Ten references selected. Remove one to choose another.')
        refs.push({ ...await this.saveImage(seriesId, add.buffer, add.label), chapterId: add.chapterId, cropId: add.cropId })
      } else if (typeof input.removeId === 'string') {
        if (!refs.some(ref => ref.id === input.removeId)) throw new YouTubeError('Reference not found.', 404)
        w.thumbnails.references = refs.filter(ref => ref.id !== input.removeId)
      } else if (typeof input.primaryId === 'string') {
        const primary = refs.find(ref => ref.id === input.primaryId)
        if (!primary) throw new YouTubeError('Reference not found.', 404)
        w.thumbnails.references = [primary, ...refs.filter(ref => ref !== primary)]
      } else throw new YouTubeError('Choose a crop, remove a reference, or choose its primary image.')
      return this.saveWorkspace(w)
    })
  }

  prepareThumbnails(seriesId: string, seriesName: string, input: { expectedRevision?: unknown; mode?: unknown; feedback?: unknown; parentId?: unknown }): Promise<YouTubeWorkspace> {
    return this.serial(async () => {
      const w = await this.workspace(seriesId); this.checkRevision(w, input.expectedRevision)
      if (!w.selectedTitle) throw new YouTubeError('Choose a title before creating thumbnails.')
      if (!w.thumbnails.references.length || w.thumbnails.references.length > 10) throw new YouTubeError('Select between one and ten crop references first.')
      if (!seriesName.trim() || seriesName.length > 500) throw new YouTubeError('A valid series name is required.')
      if (input.mode !== 'fresh' && input.mode !== 'edit') throw new YouTubeError('Choose a fresh thumbnail or an edit.')
      const feedback = input.feedback === undefined ? '' : input.feedback
      if (typeof feedback !== 'string' || feedback.length > 4000) throw new YouTubeError('Use revision feedback up to 4,000 characters.')
      if (input.mode === 'edit' && !feedback.trim()) throw new YouTubeError('Describe how to change this thumbnail.')
      const parent = w.thumbnails.versions.find(item => item.id === input.parentId)
      if (input.mode === 'edit' && !parent) throw new YouTubeError('Choose a thumbnail to edit.')
      const index = await this.index(); const guideline = this.publicVersion(await this.stored('thumbnail', index.thumbnail))
      const master = await fs.readFile(path.join(this.defaults, 'thumbnail-master-prompt.txt'), 'utf8')
      const request: YouTubeThumbnailRequest = { id: randomUUID(), title: w.selectedTitle, seriesName, createdAt: new Date().toISOString(), guidelineVersion: guideline.id, guidelineSha256: guideline.sha256, masterSha256: createHash('sha256').update(master).digest('hex'), mode: input.mode, feedback: feedback.trim(), parentId: input.mode === 'edit' ? parent!.id : null, references: structuredClone(w.thumbnails.references), prompts: [] }
      request.prompts = buildThumbnailPrompts(request, guideline, master)
      w.thumbnails.requests.push(request); w.guidelineVersions.thumbnail = guideline.id
      return this.saveWorkspace(w)
    })
  }

  importThumbnail(seriesId: string, input: { expectedRevision?: unknown; requestId?: unknown; slot?: unknown; automationJobId?: string }, buffer: Buffer): Promise<YouTubeWorkspace> {
    return this.serial(async () => {
      const w = await this.workspace(seriesId)
      if (input.automationJobId && w.thumbnails.versions.some(item => item.automationJobId === input.automationJobId && item.requestId === input.requestId && item.slot === input.slot && item.title === w.selectedTitle)) return w
      this.checkRevision(w, input.expectedRevision)
      const request = w.thumbnails.requests.find(item => item.id === input.requestId)
      if (!request) throw new YouTubeError('Thumbnail request not found.', 404)
      if (request.title !== w.selectedTitle) throw new YouTubeError('The selected title changed. Prepare a new thumbnail request.', 409)
      if (!Number.isInteger(input.slot) || Number(input.slot) < 0 || Number(input.slot) > 2) throw new YouTubeError('Choose variation 1, 2 or 3.')
      if (w.thumbnails.versions.some(item => item.requestId === request.id && item.slot === input.slot)) throw new YouTubeError('This variation already has an image. Prepare another request to keep its history.', 409)
      const image = await this.saveImage(seriesId, buffer, `Variation ${Number(input.slot) + 1}`)
      w.thumbnails.versions.push({ ...image, requestId: request.id, slot: Number(input.slot), title: request.title, ...(input.automationJobId ? { automationJobId:input.automationJobId, source:'generated' as const } : {}), createdAt: new Date().toISOString() })
      return this.saveWorkspace(w)
    })
  }

  replaceThumbnail(seriesId: string, input: { expectedRevision?: unknown; selectedId?: unknown; imageId?: unknown }, buffer: Buffer): Promise<YouTubeWorkspace> {
    return this.serial(async () => {
      const w = await this.workspace(seriesId); this.checkRevision(w, input.expectedRevision)
      if (!w.selectedTitle) throw new YouTubeError('Choose a title before replacing its thumbnail.')
      const previous = w.thumbnails.versions.find(item => item.id === (input.imageId ?? input.selectedId))
      if (!previous || (input.selectedId !== undefined && input.selectedId !== w.selectedThumbnail)) throw new YouTubeError('The selected thumbnail changed. Reload before replacing it.', 409)
      // Decode successfully before changing the selection; every previous version remains available.
      const image = await this.saveImage(seriesId, buffer, 'Uploaded replacement')
      w.thumbnails.versions.push({ ...image, title: w.selectedTitle, requestId: previous.title === w.selectedTitle ? previous.requestId : null, slot: previous.title === w.selectedTitle ? previous.slot : null, source: 'uploaded', replacesId: previous.id, createdAt: new Date().toISOString() })
      w.selectedThumbnail = image.id; w.thumbnailNeedsUpdate = false
      return this.saveWorkspace(w)
    })
  }

  selectThumbnail(seriesId: string, input: { expectedRevision?: unknown; id?: unknown }): Promise<YouTubeWorkspace> {
    return this.serial(async () => {
      const w = await this.workspace(seriesId); this.checkRevision(w, input.expectedRevision)
      const image = w.thumbnails.versions.find(item => item.id === input.id)
      if (!image) throw new YouTubeError('Thumbnail not found for this series.', 404)
      w.selectedThumbnail = image.id; w.thumbnailNeedsUpdate = image.title !== w.selectedTitle
      return this.saveWorkspace(w)
    })
  }

  saveHindiOverlay(seriesId: string, input: { expectedRevision?: unknown; imageId?: unknown; overlay?: unknown }): Promise<YouTubeWorkspace> {
    return this.serial(async () => {
      const w = await this.workspace(seriesId); this.checkRevision(w, input.expectedRevision)
      if (!w.selectedThumbnail || w.selectedThumbnail !== input.imageId || !w.thumbnails.versions.some(v => v.id === input.imageId)) throw new YouTubeError('The selected thumbnail changed. Reload before editing its Hindi overlay.', 409)
      const settings = parseHindiOverlay(input.overlay)
      if (w.hindiOverlay && hindiOverlayKey(w.hindiOverlay) === hindiOverlayKey(settings)) return w
      w.hindiOverlay = settings
      return this.saveWorkspace(w)
    })
  }

  hinglishThumbnail(seriesId: string, imageId: string, expectedStyle?: unknown): Promise<Buffer> {
    return this.serial(async () => {
      const w = await this.workspace(seriesId)
      const image = w.thumbnails.versions.find(v => v.id === imageId && v.id === w.selectedThumbnail)
      if (!image) throw new YouTubeError('The selected thumbnail changed. Reload before copying the Hinglish image.', 409)
      const settings = parseHindiOverlay(w.hindiOverlay ?? DEFAULT_HINDI_OVERLAY)
      if (expectedStyle !== undefined && expectedStyle !== hindiOverlayKey(settings)) throw new YouTubeError('The Hindi overlay changed in another window. Reload before copying or downloading it.', 409)
      const source = await fs.readFile(this.mediaPath(seriesId, image.sha256))
      if (createHash('sha256').update(source).digest('hex') !== image.sha256) throw new YouTubeError('Stored image failed its integrity check.', 409)
      return renderHinglishThumbnail(source, settings)
    })
  }

  thumbnailMedia(seriesId: string, id: string): Promise<Buffer> {
    return this.serial(async () => {
      const w = await this.workspace(seriesId)
      const image = [...w.thumbnails.references, ...w.thumbnails.requests.flatMap(r => r.references), ...w.thumbnails.versions].find(item => item.id === id)
      if (!image) throw new YouTubeError('Image not found for this series.', 404)
      const bytes = await fs.readFile(this.mediaPath(seriesId, image.sha256))
      if (createHash('sha256').update(bytes).digest('hex') !== image.sha256) throw new YouTubeError('Stored image failed its integrity check.', 409)
      return bytes
    })
  }

}
