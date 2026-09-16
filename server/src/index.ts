import express from 'express';
import cors from 'cors';
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
import { initVoiceoverRoutes } from './routes/voiceover.js';
import { initClipperRoutes } from './routes/clipper.js';
import { initWatermarkRoutes } from './routes/watermark.js';
import { initAiCropRoutes } from './routes/aiCrop.js';
import { initClipper2Routes } from './routes/clipper2.js';
import { initClipper2TrainingRoutes } from './routes/clipper2Training.js';
import { initClipper3Routes } from './routes/clipper3.js';
import { initVisionRoutes } from './routes/vision.js';
import { initVideoEditorRoutes } from './routes/videoEditor.js';
import { initVideoEditor2Routes } from './routes/videoEditor2.js';
import { initMurgaaRoutes } from './routes/murgaa.js';
import { initStorageRoutes } from './routes/storage.js';
import { DownloadManager } from './services/downloadManager.js';

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
app.use('/api/narration', initNarrationRoutes(io));  // Module 2: Narration Studio
app.use('/api/voiceover', initVoiceoverRoutes(io));  // Module 2 Part 2: Voiceover
app.use('/api/clipper', initClipperRoutes(io));      // Module 3: Image Clipper
app.use('/api/watermark', initWatermarkRoutes());    // Module 3: Watermark white-fill
app.use('/api/ai-crop', initAiCropRoutes(io));       // Module 3 AI: Auto-Crop
app.use('/api/clipper2', initClipper2Routes(io));  // Module 3 v2: Image Clipper 2.0
app.use('/api/clipper2/training', initClipper2TrainingRoutes());  // Module 3 v2: manual training annotations (no effect on real crop/video pipeline)
app.use('/api/vision', initVisionRoutes());  // Vision providers (Qwen local, Gemini, OpenAI, Claude)
app.use('/api/clipper3', initClipper3Routes(io));  // Module 3 v3: Image Clipper 3.0 — per-image crop JSONs, page-local coordinates
app.use('/api/video', initVideoEditorRoutes(io));    // Module 4: Video Editor
app.use('/api/video2', initVideoEditor2Routes(io));  // Module 4v2: Editor 2.0
app.use('/api/murgaa', initMurgaaRoutes());          // Narration: Murgaa reference popup (global per page)
app.use('/api/storage', initStorageRoutes());        // Storage: local disk usage + reclaiming it

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

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

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  await downloadManager.shutdown();
  await prisma.$disconnect();
  process.exit(0);
});
