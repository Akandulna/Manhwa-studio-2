import { Router, type Request, type Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import { createHash } from 'crypto';
import { prisma } from '../index.js';
import { writeEnvVars } from '../utils/envFile.js';
import { getChapterManifest } from '../services/chapterManifest.js';
import { getSourceFolderPath, readImagePoints } from '../services/clipper3/perImageStore.js';
import { getProcessedDir, syncChapterProcessed } from '../services/clipper3/processedSync.js';
import { readEffectiveReview } from '../services/clipper3/chapterReview.js';
import { assertUnmanagedCropChapter, withUnmanagedCropChapter } from '../services/managedCropProjection.js';
import { libraryControl } from '../services/libraryControls.js';
import { restartRevision } from '../services/seriesRestartModel.js';
import { pageReplacementActive, readPageReplacement } from '../services/chapterPageReplacement.js';
import { readPageRedo } from '../services/clipper3/pageRedo.js';
const hash = (v: Buffer | string) => createHash('sha256').update(v).digest('hex');
const jobs = new Map<string, {
    running: boolean;
    done: number;
    total: number;
    page?: string;
    error?: string;
    cancelled?: boolean;
}>();
function configuration() { const url = (process.env.CLIPPER_CLOUD_URL ?? '').trim().replace(/\/$/, ''); const token = process.env.CLIPPER_CLOUD_TOKEN ?? ''; if (!url || !token)
    throw Error('Configure the R2 Cloud controller URL and key first'); const u = new URL(url); if (u.protocol !== 'https:' || u.pathname !== '/' || u.search || u.hash || u.username || u.password)
    throw Error('Controller URL must be an HTTPS origin'); return { url, token }; }
async function cloud(endpoint: string, body?: unknown, method?: string) { const { url, token } = configuration(); const response = await fetch(url + endpoint, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { authorization: `Bearer ${token}`, ...(body instanceof Buffer ? { 'content-type': 'application/octet-stream' } : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : body instanceof Buffer ? body : JSON.stringify(body), signal: AbortSignal.timeout(120000) }); const value: any = await response.json(); if (!response.ok)
    throw Error(value.error ?? `Controller HTTP ${response.status}`); return value; }
async function chapters(seriesId: string, ids?: string[]) { const series = await prisma.series.findUnique({ where: { id: seriesId }, select: { id: true, title: true, rootFolder: true, chapters: { where: { status: 'done', ...(ids?.length ? { id: { in: ids } } : {}) }, select: { id: true, number: true, folderPath: true }, orderBy: { number: 'asc' } } } }); if (!series)
    throw Error('Series not found'); return series; }
async function generation(seriesFolder: string, chapterFolder: string) { return { restartRevision: restartRevision(await libraryControl(seriesFolder)), pageRevision: (await readPageReplacement(chapterFolder))?.revision ?? null }; }
function defaultPrompt(h: any) { const s = h.source; return `Find every independently readable illustrated shot in this ONE page and measure its rectangle. Geometry only: no descriptions or story associations. Follow continuous artwork across upload seams: a slice boundary is never a shot boundary. Keep whole faces, hair, bodies, hands and significant objects. Split genuinely separate framed moments; do not invent boundaries inside one continuous scene. Exclude isolated bubbles, narration, captions and SFX over filler backgrounds. Inspect every slice top to bottom, left to right. Corners use slice-local integer pixels; bottom_right is exclusive. A crop may span several slices.\n${h.slices.map((v: any) => `${v.id}: ${v.width}x${v.height}, original y=${v.y0}..${v.y1}`).join('\n')}\nSubmit analysis in this shape: ${JSON.stringify({ schema_version: 'chatgpt-analysis/1.0', job_id: h.job_id, source_sha256: s.sha256, page_stem: s.page_stem, source_width: s.width, source_height: s.height, coordinate_system: 'slice_local_pixels', page_inspection_complete: true, page_review_flags: [], candidates: [{ candidate_id: 'candidate-01', reason: 'illustrated_shot', top_left: { slice_id: h.slices[0].id, x: 0, y: 0 }, bottom_right: { slice_id: h.slices[0].id, x: s.width, y: h.slices[0].height }, visual_evidence: 'Describe the visible shot boundary', review_flags: [] }] })}\nThe example rectangle is not a target. Empty candidates require visual confirmation of no eligible artwork. After submit_analysis, follow the separate full-page sweep and submit_review instructions. Human review in Studio remains required.`; }
async function prepare(seriesId: string, ids: string[] | undefined, rules: string) {
    const job = jobs.get(seriesId)!;
    try {
        const series = await chapters(seriesId, ids);
        job.total = 0;
        for (const c of series.chapters)
            job.total += (await getChapterManifest(c.folderPath)).images.length;
        for (const c of series.chapters) {
            await assertUnmanagedCropChapter(c.folderPath);
            if ((await readEffectiveReview(c.folderPath)).reviewed) {
                job.done += (await getChapterManifest(c.folderPath)).images.length;
                continue;
            }
            const sourceDir = getSourceFolderPath(c.folderPath), chapter = path.basename(sourceDir), seriesFolder = path.basename(path.dirname(sourceDir));
            const context = await generation(seriesFolder, c.folderPath);
            for (const image of (await getChapterManifest(c.folderPath)).images) {
                if (job.cancelled)
                    return;
                if (pageReplacementActive(c.folderPath))
                    throw Error('Chapter pages are being replaced');
                if (await readImagePoints(c.folderPath, image.filename)) {
                    job.done++;
                    continue;
                }
                if ((await readPageRedo(c.folderPath, image.filename))?.status === 'pending')
                    throw Error('Resolve the explicit page redo before cloud preparation');
                job.page = `${chapter} · ${image.filename}`;
                const source = await fs.readFile(path.join(sourceDir, image.filename)), meta = await sharp(source).metadata(), width = meta.width!, height = meta.height!;
                if (!width || !height || width > 16383 || !['jpeg', 'png', 'webp'].includes(meta.format ?? ''))
                    throw Error('Unsupported source image');
                const stem = path.parse(image.filename).name, slices: any[] = [], images: Buffer[] = [];
                for (let y = 0; y < height; y += 2048) {
                    const rect = { left: 0, top: y, width, height: Math.min(2048, height - y) }, encoded = await sharp(source).extract(rect).webp({ lossless: true }).toBuffer();
                    const decoded = await sharp(encoded).ensureAlpha().raw().toBuffer(), original = await sharp(source).extract(rect).ensureAlpha().raw().toBuffer();
                    if (!decoded.equals(original))
                        throw Error('Slice pixels do not match source');
                    const n = String(slices.length + 1).padStart(2, '0');
                    images.push(encoded);
                    slices.push({ id: `slice-${n}`, file: `${stem}_slice-${n}.webp`, x0: 0, y0: y, x1: width, y1: y + rect.height, width, height: rect.height, sha256: hash(encoded) });
                }
                const sourceHash = hash(source), slug = seriesFolder.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'series', date = new Date().toISOString();
                const h: any = { schema_version: 'handoff/1.0', job_id: `${slug}-ch${String(c.number).padStart(3, '0')}-${stem}-${sourceHash.slice(0, 12)}`, created_at: date, source: { series_title: seriesFolder, series_slug: slug, chapter_folder: chapter, chapter_number: c.number, page_stem: stem, original_filename: image.filename, sha256: sourceHash, width, height, format: meta.format, orientation: 'stored_pixels' }, coordinate_system: 'canonical_original_pixels', slicing: { mode: 'full_width_fixed_height', slice_height: 2048, encoding: 'webp_lossless' }, slices, verification: { tiling: 'exact', pixels: 'identical', verified_at: date } };
                h.manifest_sha256 = hash(JSON.stringify(h));
                const pkg = { handoff: h, prompt: (rules.trim() ? rules.trim() + '\n\n' : '') + defaultPrompt(h), context };
                if (JSON.stringify(await generation(seriesFolder, c.folderPath)) !== JSON.stringify(context) || hash(await fs.readFile(path.join(sourceDir, image.filename))) !== sourceHash)
                    throw Error('Source revision changed while preparing');
                const page = await cloud('/api/pages', pkg);
                if (page.state === 'uploading') {
                    for (let i = 0; i < slices.length; i++) {
                        if (job.cancelled)
                            return;
                        await cloud(`/api/pages/${page.id}/slices/${slices[i].id}`, images[i], 'PUT');
                    }
                    await cloud(`/api/pages/${page.id}/ready`, {});
                }
                job.done++;
            }
        }
    }
    catch (e) {
        job.error = e instanceof Error ? e.message : String(e);
    }
    finally {
        job.running = false;
    }
}
async function importResults(seriesId: string) {
    const series = await chapters(seriesId), first = series.chapters[0];
    if (!first)
        return { imported: 0, skipped: 0, errors: [] };
    const seriesFolder = path.basename(path.dirname(getSourceFolderPath(first.folderPath))), status = await cloud('/api/status?series=' + encodeURIComponent(seriesFolder));
    let imported = 0, skipped = 0;
    const errors: string[] = [];
    for (const page of status.pages.filter((p: any) => p.state === 'saved')) {
        try {
            const chapter = series.chapters.find(c => path.basename(getSourceFolderPath(c.folderPath)) === page.chapter);
            if (!chapter) {
                skipped++;
                continue;
            }
            await withUnmanagedCropChapter(chapter.folderPath, async () => {
                if (pageReplacementActive(chapter.folderPath) || (await readEffectiveReview(chapter.folderPath)).reviewed || await readImagePoints(chapter.folderPath, page.filename)) {
                    skipped++;
                    return;
                }
                if ((await readPageRedo(chapter.folderPath, page.filename))?.status === 'pending')
                    throw Error('Pending explicit redo; cloud result not imported');
                const result = await cloud(`/api/pages/${page.id}/result`);
                const image = (await getChapterManifest(chapter.folderPath)).images.find(i => i.filename === page.filename);
                if (!image)
                    throw Error('Source page no longer exists');
                if (result.schema !== 'clipper-cloud-result/1' || result.pageId !== page.id || result.handoff.source.original_filename !== image.filename || result.handoff.source.series_title !== seriesFolder || result.handoff.source.chapter_folder !== page.chapter || result.pageFolder !== `page_${String(Number(/(\d+)(?!.*\d)/.exec(path.parse(image.filename).name)?.[1])).padStart(3, '0')}`)
                    throw Error('Cloud result identity mismatch');
                if (JSON.stringify(result.context) !== JSON.stringify(await generation(seriesFolder, chapter.folderPath)))
                    throw Error('Cloud result belongs to an obsolete source generation');
                if (hash(await fs.readFile(path.join(getSourceFolderPath(chapter.folderPath), image.filename))) !== result.sourceSha256 || result.pointers.sourceSha256 !== result.sourceSha256 || result.pointers.image.width !== image.width || result.pointers.image.height !== image.height)
                    throw Error('Cloud result source does not match current page');
                if (path.basename(result.pointerFilename) !== result.pointerFilename || !/^crop-pointers-ch[0-9.]+-p\d+\.json$/.test(result.pointerFilename))
                    throw Error('Invalid pointer filename');
                const folder = path.join(getProcessedDir(chapter.folderPath), result.pageFolder);
                await fs.mkdir(folder, { recursive: true });
                const dest = path.join(folder, result.pointerFilename);
                try {
                    await fs.access(dest);
                    skipped++;
                    return;
                }
                catch { }
                const temp = dest + '.cloud-incoming';
                await fs.writeFile(temp, JSON.stringify(result.pointers, null, 2));
                await fs.rename(temp, dest);
                imported++;
            });
            // Existing importer validates the individual pointer file and keeps human review separate.
            await syncChapterProcessed({ chapterId: chapter.id, images: (await getChapterManifest(chapter.folderPath)).images, folderPath: chapter.folderPath, chapterNumber: chapter.number, seriesSlug: seriesFolder.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) });
        }
        catch (e) {
            errors.push(`${page.chapter} · ${page.filename}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    return { imported, skipped, errors };
}
export function cloudClipperRoutes() {
    const router = Router();
    const handler = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response) => { try {
        res.json(await fn(req));
    }
    catch (e) {
        res.status(409).json({ error: e instanceof Error ? e.message : String(e) });
    } };
    router.get('/settings', handler(async () => ({ url: process.env.CLIPPER_CLOUD_URL ?? '', configured: !!process.env.CLIPPER_CLOUD_URL && !!process.env.CLIPPER_CLOUD_TOKEN })));
    router.put('/settings', handler(async (req) => { const { url, token } = req.body; if (typeof url !== 'string' || !url.startsWith('https://'))
        throw Error('HTTPS controller URL required'); const parsed = new URL(url); if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password)
        throw Error('Controller URL must be an HTTPS origin'); if (typeof token !== 'string' || token.trim().length < 24)
        throw Error('Enter the controller key (at least 24 characters)'); await writeEnvVars({ CLIPPER_CLOUD_URL: parsed.origin, CLIPPER_CLOUD_TOKEN: token.trim() }); process.env.CLIPPER_CLOUD_URL = parsed.origin; process.env.CLIPPER_CLOUD_TOKEN = token.trim(); return { configured: true }; }));
    router.get('/status', handler(async (req) => { const series = await chapters(String(req.query.seriesId)); const c = series.chapters[0]; const folder = c ? path.basename(path.dirname(getSourceFolderPath(c.folderPath))) : series.title; return { ...await cloud('/api/status?series=' + encodeURIComponent(folder)), preparation: jobs.get(series.id) ?? null, controllerUrl: configuration().url, seriesFolder: folder }; }));
    router.post('/prepare', handler(async (req) => { const id = String(req.body.seriesId); if (jobs.get(id)?.running)
        throw Error('Preparation is already running'); if (!Array.isArray(req.body.chapterIds) || req.body.chapterIds.length === 0 || req.body.chapterIds.some((v: unknown) => typeof v !== 'string'))
        throw Error('Select chapters to prepare'); const rules = String(req.body.rules ?? ''); if (rules.length > 100000)
        throw Error('Crop rules are too long'); configuration(); await chapters(id, req.body.chapterIds); jobs.set(id, { running: true, done: 0, total: 0 }); void prepare(id, req.body.chapterIds, rules); return { preparing: true }; }));
    router.post('/cancel-preparation', handler(async (req) => { const j = jobs.get(String(req.body.seriesId)); if (j)
        j.cancelled = true; return { cancelled: true }; }));
    router.post('/import', handler(async (req) => importResults(String(req.body.seriesId))));
    router.post('/accounts', handler(async (req) => cloud('/api/accounts', { label: req.body.label })));
    router.post('/runs', handler(async (req) => cloud('/api/runs', req.body)));
    router.post('/runs/:id/:action', handler(async (req) => { if (!['pause', 'resume', 'stop'].includes(req.params.action))
        throw Error('Unknown run action'); return cloud(`/api/runs/${encodeURIComponent(req.params.id)}/${req.params.action}`, {}); }));
    router.post('/accounts/:id/availability', handler(async (req) => cloud(`/api/accounts/${encodeURIComponent(req.params.id)}/availability`, req.body)));
    return router;
}
