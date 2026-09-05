/**
 * Downloads API Routes
 */

import { Router, Request, Response } from 'express';
import { downloadManager, prisma } from '../index.js';
import { exec } from 'child_process';
import * as path from 'path';
import * as os from 'os';

const router = Router();

// Get queue status
router.get('/status', (req: Request, res: Response) => {
  res.json(downloadManager.getQueueStatus());
});

// Queue chapters for download
router.post('/queue', async (req: Request, res: Response) => {
  try {
    const { chapterIds } = req.body;
    
    if (!Array.isArray(chapterIds) || chapterIds.length === 0) {
      return res.status(400).json({ error: 'chapterIds array required' });
    }
    
    await downloadManager.queueChapters(chapterIds);
    
    res.json({ 
      message: `Queued ${chapterIds.length} chapter(s) for download`,
      status: downloadManager.getQueueStatus()
    });
  } catch (error) {
    console.error('Error queuing downloads:', error);
    res.status(500).json({ error: 'Failed to queue downloads' });
  }
});

// Pause downloads
router.post('/pause', (req: Request, res: Response) => {
  downloadManager.pause();
  res.json({ 
    message: 'Downloads paused',
    status: downloadManager.getQueueStatus()
  });
});

// Resume downloads
router.post('/resume', (req: Request, res: Response) => {
  downloadManager.resume();
  res.json({ 
    message: 'Downloads resumed',
    status: downloadManager.getQueueStatus()
  });
});

// Clear queue
router.post('/clear', async (req: Request, res: Response) => {
  await downloadManager.clear();
  res.json({ 
    message: 'Queue cleared',
    status: downloadManager.getQueueStatus()
  });
});

// Retry failed chapters
router.post('/retry-failed', async (req: Request, res: Response) => {
  const { seriesId } = req.body;
  await downloadManager.retryFailed(seriesId);
  res.json({ 
    message: 'Retrying failed chapters',
    status: downloadManager.getQueueStatus()
  });
});

// Open folder in file explorer
router.post('/open-folder', async (req: Request, res: Response) => {
  try {
    const { path: folderPath } = req.body;
    const downloadRoot = process.env.DOWNLOAD_ROOT || './downloads';
    const fullPath = path.resolve(downloadRoot, folderPath);
    
    // Platform-specific open command
    const platform = os.platform();
    let command: string;
    
    if (platform === 'darwin') {
      command = `open "${fullPath}"`;
    } else if (platform === 'win32') {
      command = `explorer "${fullPath}"`;
    } else {
      command = `xdg-open "${fullPath}"`;
    }
    
    exec(command, (error) => {
      if (error) {
        console.error('Error opening folder:', error);
        return res.status(500).json({ error: 'Failed to open folder' });
      }
      res.json({ message: 'Folder opened' });
    });
  } catch (error) {
    console.error('Error opening folder:', error);
    res.status(500).json({ error: 'Failed to open folder' });
  }
});

// Get download statistics
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const stats = await prisma.$transaction([
      prisma.chapter.count({ where: { status: 'done' } }),
      prisma.chapter.count({ where: { status: 'failed' } }),
      prisma.chapter.count({ where: { status: 'pending' } }),
      prisma.chapter.count({ where: { status: 'downloading' } }),
      prisma.chapter.count({ where: { status: 'queued' } }),
      prisma.page.aggregate({ where: { status: 'done' }, _sum: { bytes: true } })
    ]);
    
    res.json({
      completed: stats[0],
      failed: stats[1],
      pending: stats[2],
      downloading: stats[3],
      queued: stats[4],
      totalBytes: stats[5]._sum.bytes || 0
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

export default router;
