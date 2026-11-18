import { cloudClipperRoutes } from './routes/cloudClipper.js';
import { configureRelayTraffic } from './services/relayTraffic.js'
import { initAgentRoutes } from './routes/agent.js';
import {initManagedMaintenanceRoutes} from './routes/managedMaintenance.js';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import seriesRoutes from './routes/series.js';
import chapterRoutes from './routes/chapters.js';
import downloadRoutes from './routes/downloads.js';
import settingsRoutes from './routes/settings.js';
import { createYouTubeRouter } from './routes/youtube.js';
import manualRoutes from './routes/manual.js';
import { initNarrationRoutes } from './routes/narration.js';
import { initClipper3Routes } from './routes/clipper3.js';
import { initVideoEditor2Routes } from './routes/videoEditor2.js';
import { createShortsRouter } from './routes/shorts.js';
import { initStorageRoutes } from './routes/storage.js';
import { initR2Routes } from './routes/r2.js';
import {initManagedPilotRoutes} from './routes/managedPilot.js';
import { initStitchRoutes } from './routes/stitch.js';
import { initPagePreviewRoutes } from './routes/pagePreview.js';
import { initGoogleDriveRoutes } from './routes/googleDrive.js';
import { initGeminiMcpRoutes } from './routes/geminiMcp.js';
import { initAntigravityRoutes } from './routes/antigravity.js';
import { DownloadManager } from './services/downloadManager.js';
import { startPhoneRelay, receiveWifiReceipt, sendPhoneRequest, onPhoneReceipt } from './services/phoneRelay.js';
import { startNarrationAutoSync } from './services/phoneNarrationAutoSync.js';
import { startMetadataAutoSync, stopMetadataAutoSync } from './services/metadataLibrary.js';
import { metadataRoutes } from './routes/metadata.js';
import { recordMetadataReceipt } from './services/metadataPageTimes.js';
import { installWifiStatus, wifiHub } from './services/wifiStatus.js';
import { reconcileQuietly } from './services/diskReconcile.js';
import { backfillAlignmentDocumentsQuietly } from './services/alignment/alignmentDocument.js';
import { publishEditorPackagesAtStartup } from './services/editorAutoPublish.js';
import { publishLibrary, startLibrarySync } from './services/librarySync.js';
import { getSeriesProcess, notifySeriesProcessChanged, startSeriesProcess } from './services/seriesProcess.js';
import { startSeriesActivity, seriesActivityMiddleware, flushSeriesActivity } from './services/seriesActivity.js';
import { productionAutomation, startProductionAutomation, stopProductionAutomation } from './services/productionAutomation.js';
import { startManagerReporting, managerOverview, acknowledgeManagerIncident, recordManagerStorage, managerRelayUsage } from './services/managerReporting.js';

dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: 'http://localhost:5173',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']
  }
});

export const prisma = new PrismaClient();
startSeriesActivity(prisma, io);
export const downloadManager = new DownloadManager(io);

// Middleware
app.use(cors({
  origin: 'http://localhost:5173',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']
}));
// Editor 2.0's batch export posts every chapter's pasted timeline JSON in one
// body, which runs well past the 100kb default, so the cap is raised here.
app.use(express.json({ limit: '50mb' }));

// Make io available to routes
app.set('io', io);
app.use(seriesActivityMiddleware(prisma));
app.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && /^\/api\/(series|manual|narration|clipper3|clipper-cloud|video2|storage|stitch|page-preview)(\/|$)/.test(req.path)) {
    res.on('finish', () => { if (res.statusCode < 400) notifySeriesProcessChanged(true) });
  }
  next();
});
app.get('/api/library/progress', async (_req, res) => {
  try { res.json(await getSeriesProcess()); }
  catch (error) { console.error('[series-process]', error); res.status(500).json({ error: 'Could not read series progress' }); }
});
app.get('/api/library/automation', async (_req, res) => {
  try { res.json(await productionAutomation.list()); }
  catch (error) { res.status(500).json({ error: 'Could not read production automation' }); }
});
app.post('/api/library/publish', async (_req, res) => {
  try { await publishLibrary(); res.json({ published: true }); }
  catch (error) { console.error('[library-sync]', error); res.status(500).json({ error: 'Could not publish the shared library' }); }
});

installWifiStatus(app,{receipt:receiveWifiReceipt,cloudRefresh:async m=>{await sendPhoneRequest(undefined,{device:m.device},m,true)}});

// Routes
app.use('/api/series', seriesRoutes);
app.use('/api/chapters', chapterRoutes);
app.use('/api/downloads', downloadRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/youtube', createYouTubeRouter({
  seriesExists: async id => !!await prisma.series.findUnique({ where: { id }, select: { id: true } }),
  seriesTitle: async id => (await prisma.series.findUnique({ where: { id }, select: { title: true } }))?.title ?? null,
  chapters: async seriesId => prisma.chapter.findMany({ where: { seriesId, completedAt: null }, select: { id: true, number: true, folderPath: true }, orderBy: { number: 'asc' } })
}));
app.use('/api/manual', manualRoutes);  // Manual upload mode
app.use('/api/narration', initNarrationRoutes(io));  // Module 2: Narration — fetch phone scripts + voiceovers, align
app.use('/api/clipper-cloud', cloudClipperRoutes());
app.use('/api/clipper3', initClipper3Routes(io));  // Module 3: Image Clipper 3.0 — per-image crop JSONs, page-local coordinates
app.use('/api/metadata', metadataRoutes());
app.use('/api/video2', initVideoEditor2Routes(io));  // Module 4v2: Editor 2.0
app.use('/api/shorts', createShortsRouter());
app.use('/api/storage', initStorageRoutes());        // Storage: local disk usage + reclaiming it
app.use('/api/stitch', initStitchRoutes());          // Library: stitch a chapter's many short pages into a few tall ones
app.use('/api/page-preview', initPagePreviewRoutes()); // Library: preview a chapter's pages and delete unwanted ones
app.use('/api/r2', initR2Routes(io));                // Cloud backup: upload series folders to Cloudflare R2
app.use('/api/google-drive', initGoogleDriveRoutes(prisma)); // Studio AntiGravity: Google Drive connection (local-only)
app.use('/api/antigravity', initAntigravityRoutes(prisma, io));   // Studio AntiGravity: local CLI, models, settings (local-only)
app.use('/api/agent', initAgentRoutes(prisma, io));                    // Studio Agent: chat + library actions through a local CLI AI engine
app.use('/api/gemini-mcp', initGeminiMcpRoutes(prisma));         // Gemini MCP: connector for the Gemini Mac app (docs/PRD-gemini-app-narration.md)
app.use('/api/managed-pilot',initManagedPilotRoutes(prisma));
app.use('/api/managed-maintenance',initManagedMaintenanceRoutes(prisma));
app.get('/api/managers', async (_req, res) => {
  try { res.json(await managerOverview()); }
  catch { res.status(503).json({ error: 'Manager reporting is unavailable. Existing production is unaffected.' }); }
});
app.get('/api/managers/relay-usage', async (_req, res) => {
  try { res.json(await managerRelayUsage()); }
  catch { res.status(503).json({ error: 'Relay usage is unavailable.' }); }
});
app.post('/api/managers/acknowledge', async (req, res) => {
  if (typeof req.body?.incidentId !== 'string' || typeof req.body?.notificationId !== 'string') return res.status(400).json({ error: 'Choose an incident notification.' });
  try { await acknowledgeManagerIncident(req.body.incidentId, req.body.notificationId); res.json({ queued: true }); }
  catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : 'Could not acknowledge incident.' }); }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Built client (`vite build` → client/dist), served so the Mac app (desktop/)
// needs only this one port. Dev keeps using Vite on :5173; this is a no-op
// until the client has been built.
const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'dist');
if (fs.existsSync(path.join(clientDist, 'index.html'))) {
  app.use(express.static(clientDist));
  // SPA fallback: any non-API path is a client route.
  app.get(/^\/(?!api\/|socket\.io\/).*/, (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  // Send current queue status on connect
  socket.emit('queue:status', downloadManager.getQueueStatus());
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3001;

httpServer.listen(PORT, () => {
  console.log(`🚀 Manhwa Studio server running on http://localhost:${PORT}`);
  console.log(`📁 Download root: ${process.env.DOWNLOAD_ROOT || './downloads'}`);
});

// Catch up on chapter files deleted by hand while the server was down.
reconcileQuietly();

// Fully aligned chapters missing their alignment document (script-timeline.md) get it.
backfillAlignmentDocumentsQuietly();

// Chapters that got ready for their timeline JSON while the server was down go to the phone's Editor 2.0.
publishEditorPackagesAtStartup();

// Live phone status through the relay Worker, when Settings → Cloudflare has it set up.
configureRelayTraffic(prisma);
startManagerReporting(prisma, io);
startLibrarySync(io);
startSeriesProcess(io);
startPhoneRelay(io);
startNarrationAutoSync(io);
startMetadataAutoSync(io);
// Times the phones' Metadata pages for Live Progress (they report no finish times).
onPhoneReceipt((kind, device, body) => { if (kind === 'crops') recordMetadataReceipt(device, body) });
startProductionAutomation(io);
void getSeriesProcess().catch(error => console.error('[process] initial scan:', error));
void recordManagerStorage().catch(error => console.error('[managers] storage:', error));
const managerStorageTimer = setInterval(() => { void recordManagerStorage().catch(error => console.error('[managers] storage:', error)); }, 60_000);
managerStorageTimer.unref();

// Graceful shutdown
let shuttingDown=false;
const shutdown=async () => {
  if(shuttingDown)return;
  shuttingDown=true;
  console.log('Shutting down...');
  wifiHub()?.close();
  stopMetadataAutoSync();
  await stopProductionAutomation().catch(error=>console.error('[production] shutdown:',error));
  await downloadManager.shutdown();
  await flushSeriesActivity();
  // Stop only Studio's own agy process groups; their pages become Interrupted.
  await (await import('./routes/antigravity.js')).antigravityJobs()?.shutdown().catch(error=>console.error('[antigravity] shutdown:',error));
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGINT',shutdown);
process.on('SIGTERM',shutdown);
