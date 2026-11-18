import { YouTubeAutomation } from '../services/youtubeAutomation.js'
import { youtubePhoneTransport } from '../services/youtubePhoneTransport.js'
import { Router } from 'express'
import { DEFAULT_HINDI_OVERLAY, hindiStampSvg } from '../services/youtubeHinglishThumbnail.js'
import { assertLocalClipboardRequest, copyReferenceFiles } from '../services/youtubeClipboard.js'
import multer from 'multer'
import archiver from 'archiver'
import sharp from 'sharp'
import { TaskConflict } from '../services/managedTaskProtocol.js'
import { cropInventory, readYouTubeCrop, type YouTubeCropChapter } from '../services/youtubeCrops.js'
import { MAX_YOUTUBE_IMAGE_BYTES } from '../services/youtubeThumbnails.js'
import { guidelineKind, MAX_GUIDELINE_BYTES, YouTubeError, YouTubeStore } from '../services/youtubeStore.js'
import { YouTubeTitleError } from '../services/youtubeTitles.js'

export function createYouTubeRouter(options: { seriesExists: (id: string) => Promise<boolean>; seriesTitle?: (id: string) => Promise<string | null>; store?: YouTubeStore; automation?: YouTubeAutomation; chapters?: (seriesId: string) => Promise<YouTubeCropChapter[]> }) {
  const router = Router()
  const store = options.store ?? new YouTubeStore()
  const automation = options.automation ?? new YouTubeAutomation(store, youtubePhoneTransport, undefined, true)
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_GUIDELINE_BYTES, files: 1, fields: 1, fieldSize: 100 } })
  const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_YOUTUBE_IMAGE_BYTES, files: 1, fields: 3, fieldSize: 100 } })
  const handle = (task: (req: import('express').Request, res: import('express').Response) => Promise<unknown>): import('express').RequestHandler =>
    (req, res, next) => { void task(req, res).catch(next) }

  router.post('/library/status', handle(async (req, res) => {
    const ids = req.body?.seriesIds
    if (!Array.isArray(ids) || ids.length > 500 || ids.some(id => typeof id !== 'string' || !id.trim() || id.length > 200)) throw new YouTubeError('Choose up to 500 series to check.')
    const unique: string[] = [...new Set<string>(ids)]
    const exists = await Promise.all(unique.map(id => options.seriesExists(id)))
    if (exists.some(found => !found)) throw new YouTubeError('A series was removed. Reload the YouTube library.', 404)
    res.json(await store.libraryStatuses(unique))
  }))
  router.put('/series/:seriesId/done', handle(async (req, res) => {
    if (!await options.seriesExists(req.params.seriesId)) throw new YouTubeError('Series not found.', 404)
    res.json(await store.setSeriesDone(req.params.seriesId, req.body ?? {}))
  }))
  router.get('/thumbnail-overlay/stamp', handle(async (req, res) => {
    const svg = hindiStampSvg({ ...DEFAULT_HINDI_OVERLAY, template: req.query.template ?? DEFAULT_HINDI_OVERLAY.template, color: req.query.color ?? DEFAULT_HINDI_OVERLAY.color })
    res.type('image/svg+xml').set('X-Content-Type-Options', 'nosniff').set('Cache-Control', 'public, max-age=86400').send(svg)
  }))
  router.get('/guidelines', handle(async (_req, res) => res.json(await store.guidelines())))
  router.get('/guidelines/:kind/history', handle(async (req, res) => res.json(await store.history(guidelineKind(req.params.kind)))))
  router.get('/guidelines/:kind/versions/:version', handle(async (req, res) => res.json(await store.version(guidelineKind(req.params.kind), req.params.version))))
  router.get('/guidelines/:kind/versions/:version/download', handle(async (req, res) => {
    const file = await store.original(guidelineKind(req.params.kind), req.params.version)
    res.setHeader('Content-Type', file.mediaType)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.attachment(file.sourceName).send(file.buffer)
  }))
  router.post('/guidelines/:kind', upload.single('file'), handle(async (req, res) => {
    const kind = guidelineKind(req.params.kind)
    if (kind === 'description') throw new YouTubeError('Use the description instructions editor.')
    if (!req.file) throw new YouTubeError('Choose a guideline document.')
    res.json(await store.replace(kind, req.file.buffer, req.file.originalname, req.body?.expectedVersion))
  }))
  router.put('/guidelines/description', handle(async (req, res) => {
    if (typeof req.body?.text !== 'string') throw new YouTubeError('Description instructions are required.')
    res.json(await store.replace('description', Buffer.from(req.body.text), 'description-instructions.txt', req.body.expectedVersion))
  }))
  router.post('/series/:seriesId/workspace', handle(async (req, res) => {
    if (!await options.seriesExists(req.params.seriesId)) throw new YouTubeError('Series not found.', 404)
    res.json(await store.openWorkspace(req.params.seriesId))
  }))
  router.post('/series/:seriesId/titles/prepare', handle(async (req, res) => {
    if (!await options.seriesExists(req.params.seriesId)) throw new YouTubeError('Series not found.', 404)
    const seriesName = await options.seriesTitle?.(req.params.seriesId)
    if (!seriesName) throw new YouTubeError('Could not read this series name.', 404)
    res.json(await store.prepareTitles(req.params.seriesId, seriesName, req.body?.expectedRevision))
  }))
  router.post('/series/:seriesId/titles/import', handle(async (req, res) => {
    if (!await options.seriesExists(req.params.seriesId)) throw new YouTubeError('Series not found.', 404)
    if (typeof req.body?.requestId !== 'string') throw new YouTubeError('Choose the prompt this response belongs to.')
    res.json(await store.importTitles(req.params.seriesId, req.body.requestId, req.body.response, req.body.expectedRevision))
  }))
  router.put('/series/:seriesId/titles/selection', handle(async (req, res) => {
    if (!await options.seriesExists(req.params.seriesId)) throw new YouTubeError('Series not found.', 404)
    res.json(await store.selectTitle(req.params.seriesId, { ...req.body, seriesName: await options.seriesTitle?.(req.params.seriesId) ?? undefined }))
  }))
  router.post('/series/:seriesId/descriptions/prepare', handle(async (req, res) => {
    if (!await options.seriesExists(req.params.seriesId)) throw new YouTubeError('Series not found.', 404)
    const name = await options.seriesTitle?.(req.params.seriesId)
    if (!name) throw new YouTubeError('Could not read the series name.', 404)
    res.json(await store.prepareDescription(req.params.seriesId, name, req.body ?? {}))
  }))
  router.post('/series/:seriesId/descriptions/import', handle(async (req, res) => {
    if (!await options.seriesExists(req.params.seriesId)) throw new YouTubeError('Series not found.', 404)
    res.json(await store.importDescription(req.params.seriesId, req.body ?? {}))
  }))
  router.put('/series/:seriesId/descriptions/current', handle(async (req, res) => {
    if (!await options.seriesExists(req.params.seriesId)) throw new YouTubeError('Series not found.', 404)
    res.json(await store.saveDescription(req.params.seriesId, req.body ?? {}))
  }))
  router.post('/series/:seriesId/descriptions/restore', handle(async (req, res) => {
    if (!await options.seriesExists(req.params.seriesId)) throw new YouTubeError('Series not found.', 404)
    res.json(await store.restoreDescription(req.params.seriesId, req.body ?? {}))
  }))
  // Every media and crop operation is scoped to an existing series and its chapters.
  router.use('/series/:seriesId', (req, _res, next) => { void options.seriesExists(req.params.seriesId).then(exists => exists ? next() : next(new YouTubeError('Series not found.', 404))).catch(next) })

  router.get('/automation/phones', handle(async (_req,res)=>res.json(await automation.phones())))
  router.post('/series/:seriesId/automation/:kind/start', handle(async(req,res)=>res.json(await automation.start(req.params.seriesId,req.params.kind,req.body??{}))))
  router.get('/series/:seriesId/automation/:kind/latest', handle(async(req,res)=>{
    if(!['titles','descriptions','thumbnail_prepare','thumbnail_generate'].includes(req.params.kind)||typeof req.query.requestId!=='string')throw new YouTubeError('Choose a prepared prompt.')
    res.json(await automation.latest(req.params.seriesId,req.params.kind as 'titles'|'descriptions'|'thumbnail_prepare'|'thumbnail_generate',req.query.requestId,req.query.slot===undefined?undefined:Number(req.query.slot)))
  }))
  router.post('/series/:seriesId/automation/jobs/:jobId/check',handle(async(req,res)=>res.json(await automation.check(req.params.seriesId,req.params.jobId))))

  router.post('/series/:seriesId/automation/jobs/:jobId/cancel',handle(async(req,res)=>res.json(await automation.cancel(req.params.seriesId,req.params.jobId))))
  router.post('/series/:seriesId/automation/jobs/:jobId/retry',handle(async(req,res)=>res.json(await automation.retry(req.params.seriesId,req.params.jobId,req.body??{}))))
  router.post('/series/:seriesId/automation/jobs/:jobId/retry-image',handle(async(req,res)=>res.json(await automation.retryImageTransfer(req.params.seriesId,req.params.jobId))))

  const chapterFor = async (seriesId: string, chapterId: string) => {
    const chapter = (await options.chapters?.(seriesId) ?? []).find(item => item.id === chapterId)
    if (!chapter) throw new YouTubeError('Chapter not found in this series.', 404)
    return chapter
  }
  router.get('/series/:seriesId/crop-chapters', handle(async (req, res) => {
    res.json((await options.chapters?.(req.params.seriesId) ?? []).map(({ id, number }) => ({ id, number })))
  }))
  router.get('/series/:seriesId/crops/:chapterId', handle(async (req, res) => {
    res.json((await cropInventory(await chapterFor(req.params.seriesId, req.params.chapterId))).files)
  }))
  router.get('/series/:seriesId/crops/:chapterId/:cropId', handle(async (req, res) => {
    const file = await readYouTubeCrop(await chapterFor(req.params.seriesId, req.params.chapterId), req.params.cropId)
    res.type('png').set('X-Content-Type-Options', 'nosniff').send(await sharp(file.buffer, { limitInputPixels: 40_000_000 }).resize(400, 400, { fit: 'inside', withoutEnlargement: true }).png().toBuffer())
  }))
  router.put('/series/:seriesId/thumbnails/references', handle(async (req, res) => {
    const body = req.body ?? {}
    const add = typeof body.chapterId === 'string' && typeof body.cropId === 'string'
      ? { ...await readYouTubeCrop(await chapterFor(req.params.seriesId, body.chapterId), body.cropId), chapterId: body.chapterId, cropId: body.cropId } : undefined
    res.json(await store.changeReference(req.params.seriesId, body, add))
  }))
  router.post('/series/:seriesId/thumbnails/prepare', handle(async (req, res) => {
    const name = await options.seriesTitle?.(req.params.seriesId)
    if (!name) throw new YouTubeError('Could not read the series name.', 404)
    res.json(await store.prepareThumbnails(req.params.seriesId, name, req.body ?? {}))
  }))
  router.post('/series/:seriesId/thumbnails/import', imageUpload.single('file'), handle(async (req, res) => {
    if (!req.file) throw new YouTubeError('Choose a generated image to import.')
    res.json(await store.importThumbnail(req.params.seriesId, { requestId: req.body.requestId, slot: Number(req.body.slot), expectedRevision: Number(req.body.expectedRevision) }, req.file.buffer))
  }))
  router.post('/series/:seriesId/thumbnails/replace', imageUpload.single('file'), handle(async (req, res) => {
    if (!req.file) throw new YouTubeError('Choose a replacement thumbnail image.')
    res.json(await store.replaceThumbnail(req.params.seriesId, { imageId: req.body.imageId, selectedId: req.body.selectedId, expectedRevision: Number(req.body.expectedRevision) }, req.file.buffer))
  }))
  router.put('/series/:seriesId/thumbnails/hindi-overlay', handle(async (req, res) => res.json(await store.saveHindiOverlay(req.params.seriesId, req.body ?? {}))))
  router.get('/series/:seriesId/thumbnails/hinglish/:imageId', handle(async (req, res) => {
    const image = await store.hinglishThumbnail(req.params.seriesId, req.params.imageId, req.query.styleKey)
    res.type('png').set('X-Content-Type-Options', 'nosniff').set('Cache-Control', 'no-store')
    if (req.query.download === '1') res.attachment('youtube-thumbnail-hindi.png')
    res.send(image)
  }))
  router.put('/series/:seriesId/thumbnails/selection', handle(async (req, res) => res.json(await store.selectThumbnail(req.params.seriesId, req.body ?? {}))))
  router.get('/series/:seriesId/thumbnails/media/:id', handle(async (req, res) => {
    const bytes = await store.thumbnailMedia(req.params.seriesId, req.params.id)
    res.type('png').set('X-Content-Type-Options', 'nosniff')
    if (req.query.download === '1') res.attachment('youtube-thumbnail.png')
    res.send(bytes)
  }))
  router.post('/series/:seriesId/thumbnails/requests/:id/copy-references', handle(async (req, res) => {
    assertLocalClipboardRequest(req)
    res.json(await copyReferenceFiles(store, req.params.seriesId, req.params.id))
  }))
  router.get('/series/:seriesId/thumbnails/requests/:id/package', handle(async (req, res) => {
    const w = await store.openWorkspace(req.params.seriesId)
    const request = w.thumbnails.requests.find(item => item.id === req.params.id)
    if (!request) throw new YouTubeError('Request not found for this series.', 404)
    // Resolve all attachments before starting the download, so failures return an actionable error.
    const files = await Promise.all(request.references.map(async (ref, i) => ({ name: `reference-${i + 1}.png`, buffer: await store.thumbnailMedia(w.seriesId, ref.id) })))
    if (request.parentId) files.push({ name: 'base-thumbnail.png', buffer: await store.thumbnailMedia(w.seriesId, request.parentId) })
    const zip = archiver('zip', { zlib: { level: 6 } })
    zip.on('error', error => res.destroy(error))
    res.on('close', () => { if (!res.writableFinished) zip.abort() })
    res.attachment(`youtube-thumbnails-${request.id}.zip`); zip.pipe(res)
    for (const file of files) zip.append(file.buffer, { name: file.name })
    request.prompts.forEach((prompt, i) => zip.append(prompt, { name: `variation-${i + 1}-prompt.txt` }))
    zip.append('Unzip this folder. For each variation, open its prompt text, attach the numbered reference images (and base-thumbnail.png for edits) to ChatGPT, then send the prompt in an image-capable chat. Export the finished image and import it into the matching variation in Studio. Do not attach the ZIP itself. Each prompt makes ONE image. Repeat for the other variations.\n', { name: 'READ-ME.txt' })
    await zip.finalize()
  }))
  router.use((error: unknown, _req: import('express').Request, res: import('express').Response, _next: import('express').NextFunction) => {
    if (error instanceof multer.MulterError) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'File exceeds the upload limit (documents: 10 MB; images: 20 MB).' : 'Upload one file at a time with the required fields.' })
    if (error instanceof TaskConflict) return res.status(409).json({ error: error.message })
    if (error instanceof YouTubeError || error instanceof YouTubeTitleError) return res.status(error.status).json({ error: error.message })
    console.error('[youtube]', error)
    res.status(500).json({ error: 'Could not read or save YouTube data. Existing saved work has been retained.' })
  })
  return router
}
