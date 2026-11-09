import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { createHash } from 'crypto';
const mock = vi.hoisted(() => ({ series: null as any, root: '', reviewed: false, points: false, sync: vi.fn(), status: { pages: [] } as any, result: null as any, requests: [] as any[] }));
vi.mock('../../index.js', () => ({ prisma: { series: { findUnique: vi.fn(async () => mock.series) } } }));
vi.mock('../../utils/envFile.js', () => ({ writeEnvVars: vi.fn() }));
vi.mock('../managedCropProjection.js', () => ({ assertUnmanagedCropChapter: vi.fn(), withUnmanagedCropChapter: vi.fn(async (_f, fn) => fn()) }));
vi.mock('../clipper3/chapterReview.js', () => ({ readEffectiveReview: vi.fn(async () => ({ reviewed: mock.reviewed })) }));
vi.mock('../clipper3/perImageStore.js', () => ({ getSourceFolderPath: (f: string) => f, readImagePoints: vi.fn(async () => mock.points ? {} : null) }));
vi.mock('../clipper3/processedSync.js', () => ({ getProcessedDir: (f: string) => path.join(path.dirname(f), 'Processed', path.basename(f)), syncChapterProcessed: mock.sync }));
vi.mock('../chapterManifest.js', () => ({ getChapterManifest: vi.fn(async () => ({ images: [{ filename: 'page_001.webp', width: 80, height: 2200 }] })) }));
vi.mock('../libraryControls.js', () => ({ libraryControl: vi.fn(async () => ({})) }));
vi.mock('../seriesRestartModel.js', () => ({ restartRevision: () => null }));
vi.mock('../chapterPageReplacement.js', () => ({ pageReplacementActive: () => false, readPageReplacement: async () => null }));
vi.mock('../clipper3/pageRedo.js', () => ({ readPageRedo: async () => null }));
import { cloudClipperRoutes } from '../../routes/cloudClipper.js';
const hash = (v: Buffer) => createHash('sha256').update(v).digest('hex');
function invoke(method: string, route: string, body: any = {}, query: any = {}) {
    const router: any = cloudClipperRoutes(), layer = router.stack.find((v: any) => v.route?.path === route && v.route.methods[method]);
    return new Promise<any>((resolve, reject) => { const res = { statusCode: 200, status(n: number) { this.statusCode = n; return this; }, json(value: any) { resolve({ status: this.statusCode, body: value }); return this; } }; Promise.resolve(layer.route.stack[0].handle({ body, query, params: {} }, res)).catch(reject); });
}
describe('R2 Cloud Studio integration', () => {
    beforeEach(async () => {
        mock.root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-clipper-studio-'));
        const folder = path.join(mock.root, 'Series', 'Chapter 001');
        await fs.mkdir(folder, { recursive: true });
        await sharp({ create: { width: 80, height: 2200, channels: 3, background: '#456789' } }).webp({ lossless: true }).toFile(path.join(folder, 'page_001.webp'));
        mock.series = { id: 'series-id', title: 'Series', rootFolder: 'Series', chapters: [{ id: 'chapter-id', number: 1, folderPath: folder }] };
        mock.reviewed = false;
        mock.points = false;
        mock.requests = [];
        mock.status = { pages: [] };
        mock.sync.mockReset();
        process.env.CLIPPER_CLOUD_URL = 'https://clipper.example';
        process.env.CLIPPER_CLOUD_TOKEN = 'x'.repeat(32);
        vi.stubGlobal('fetch', vi.fn(async (url: string, options: any = {}) => { mock.requests.push({ url, options }); let value: any = {}; if (url.endsWith('/api/pages'))
            value = { id: 'page-id', state: 'uploading' };
        else if (url.includes('/api/status'))
            value = mock.status;
        else if (url.endsWith('/result'))
            value = mock.result; return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }); }));
    });
    afterEach(async () => { vi.unstubAllGlobals(); delete process.env.CLIPPER_CLOUD_URL; delete process.env.CLIPPER_CLOUD_TOKEN; await fs.rm(mock.root, { recursive: true, force: true }); });
    it('uploads verified lossless slices and prompt; never starts a run', async () => {
        const prepared = await invoke('post', '/prepare', { seriesId: 'series-id', chapterIds: ['chapter-id'], rules: 'Preserve complete subjects.' });
        expect(prepared.status).toBe(200);
        await vi.waitFor(async () => { const status = await invoke('get', '/status', {}, { seriesId: 'series-id' }); expect(status.body.preparation.running).toBe(false); expect(status.body.preparation.error).toBeUndefined(); });
        const packageRequest = mock.requests.find(r => r.url.endsWith('/api/pages')), pkg = JSON.parse(packageRequest.options.body);
        expect(pkg.prompt).toContain('Preserve complete subjects.');
        expect(pkg.context).toEqual({ restartRevision: null, pageRevision: null });
        expect(pkg.handoff.slices).toHaveLength(2);
        const uploads = mock.requests.filter(r => r.url.includes('/slices/'));
        expect(uploads).toHaveLength(2);
        for (let i = 0; i < uploads.length; i++) {
            expect(hash(uploads[i].options.body)).toBe(pkg.handoff.slices[i].sha256);
            const metadata = await sharp(uploads[i].options.body).metadata();
            expect(metadata.height).toBe(i === 0 ? 2048 : 152);
        }
        expect(mock.requests.some(r => r.url.includes('/api/runs'))).toBe(false);
        expect(mock.requests.some(r => r.url.endsWith('/ready'))).toBe(true);
    });
    it('does not prepare already approved chapter geometry', async () => {
        mock.reviewed = true;
        await invoke('post', '/prepare', { seriesId: 'series-id', chapterIds: ['chapter-id'] });
        await vi.waitFor(async () => expect((await invoke('get', '/status', {}, { seriesId: 'series-id' })).body.preparation.running).toBe(false));
        expect(mock.requests.some(r => r.url.endsWith('/api/pages'))).toBe(false);
    });
    it('requires explicit chapter selection', async () => { expect((await invoke('post', '/prepare', { seriesId: 'series-id', chapterIds: [] })).status).toBe(409); });
    it('imports individual pointer files and preserves approved existing geometry', async () => {
        const source = await fs.readFile(path.join(mock.series.chapters[0].folderPath, 'page_001.webp')), sha = hash(source);
        mock.status = { pages: [{ id: 'page-id', series: 'Series', chapter: 'Chapter 001', filename: 'page_001.webp', state: 'saved' }] };
        mock.result = { schema: 'clipper-cloud-result/1', pageId: 'page-id', pageFolder: 'page_001', pointerFilename: 'crop-pointers-ch001-p001.json', context: { restartRevision: null, pageRevision: null }, sourceSha256: sha, handoff: { source: { original_filename: 'page_001.webp', series_title: 'Series', chapter_folder: 'Chapter 001' } }, pointers: { workflow: 'clipper-geometry/1', sourceSha256: sha, image: { width: 80, height: 2200 }, crops: [] } };
        const result = await invoke('post', '/import', { seriesId: 'series-id' });
        expect(result.body.errors).toEqual([]);
        expect(result.body.imported).toBe(1);
        const file = path.join(mock.root, 'Series', 'Processed', 'Chapter 001', 'page_001', 'crop-pointers-ch001-p001.json');
        expect(JSON.parse(await fs.readFile(file, 'utf8')).sourceSha256).toBe(sha);
        expect(mock.sync).toHaveBeenCalled();
        mock.reviewed = true;
        mock.requests = [];
        const again = await invoke('post', '/import', { seriesId: 'series-id' });
        expect(again.body.imported).toBe(0);
        expect(mock.requests.some(r => r.url.endsWith('/result'))).toBe(false);
    });
    it('rejects stale source bytes before installing output', async () => {
        mock.status = { pages: [{ id: 'page-id', series: 'Series', chapter: 'Chapter 001', filename: 'page_001.webp', state: 'saved' }] };
        mock.result = { schema: 'clipper-cloud-result/1', pageId: 'page-id', pageFolder: 'page_001', pointerFilename: 'crop-pointers-ch001-p001.json', context: { restartRevision: null, pageRevision: null }, sourceSha256: '0'.repeat(64), handoff: { source: { original_filename: 'page_001.webp', series_title: 'Series', chapter_folder: 'Chapter 001' } }, pointers: { image: { width: 80, height: 2200 } } };
        const result = await invoke('post', '/import', { seriesId: 'series-id' });
        expect(result.body.imported).toBe(0);
        expect(result.body.errors.join()).toContain('source does not match');
        expect(mock.sync).not.toHaveBeenCalled();
    });
});
