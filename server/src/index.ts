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
import manualRoutes from './routes/manual.js';
import { initNarrationRoutes } from './routes/narration.js';
import { initClipper3Routes } from './routes/clipper3.js';
import { initVideoEditor2Routes } from './routes/videoEditor2.js';
import { initStorageRoutes } from './routes/storage.js';
import { initR2Routes } from './routes/r2.js';
import { initStitchRoutes } from './routes/stitch.js';
import { initPagePreviewRoutes } from './routes/pagePreview.js';
import { DownloadManager } from './services/downloadManager.js';
import { startPhoneRelay } from './services/phoneRelay.js';
import { reconcileQuietly } from './services/diskReconcile.js';
import { backfillAlignmentDocumentsQuietly } from './services/alignment/alignmentDocument.js';

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

// Routes
app.use('/api/series', seriesRoutes);
app.use('/api/chapters', chapterRoutes);
app.use('/api/downloads', downloadRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/manual', manualRoutes);  // Manual upload mode
app.use('/api/narration', initNarrationRoutes(io));  // Module 2: Narration — fetch phone scripts + voiceovers, align
app.use('/api/clipper3', initClipper3Routes(io));  // Module 3: Image Clipper 3.0 — per-image crop JSONs, page-local coordinates
app.use('/api/video2', initVideoEditor2Routes(io));  // Module 4v2: Editor 2.0
app.use('/api/storage', initStorageRoutes());        // Storage: local disk usage + reclaiming it
app.use('/api/stitch', initStitchRoutes());          // Library: stitch a chapter's many short pages into a few tall ones
app.use('/api/page-preview', initPagePreviewRoutes()); // Library: preview a chapter's pages and delete unwanted ones
app.use('/api/r2', initR2Routes(io));                // Cloud backup: upload series folders to Cloudflare R2

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

// Live phone status through the relay Worker, when Settings → Cloudflare has it set up.
startPhoneRelay(io);

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  await downloadManager.shutdown();
  await prisma.$disconnect();
  process.exit(0);
});
