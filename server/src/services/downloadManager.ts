/**
 * Download Manager Service
 * Handles concurrent downloading of manhwa images with progress tracking
 */

import { Server } from 'socket.io';
import PQueue from 'p-queue';
import { prisma } from '../index.js';
import { getChapterImages } from './scraper.js';
import { zeroPad, sanitizeTitle } from '../utils/urlPattern.js';
import { storePageImage } from './pageImageStore.js';
import { flushAutoSend, noteChapterDownloaded } from './phoneSend.js';
import { notifySeriesProcessChanged } from './seriesProcess.js';
import * as fs from 'fs';
import * as path from 'path';
import { downloadImage } from './imageDownload.js';

interface DownloadTask {
  chapterId: string;
  seriesId: string;
  chapterNumber: number;
  sourceUrl: string;
  folderPath: string;
  seriesTitle: string;
}

interface QueueStatus {
  isPaused: boolean;
  pending: number;
  active: number;
  completed: number;
  failed: number;
  currentChapter?: string;
}

export class DownloadManager {
  private io: Server;
  private queue: PQueue;
  private isPaused: boolean = false;
  private completedCount: number = 0;
  private failedCount: number = 0;
  private currentChapterId?: string;
  private scheduled = new Set<string>();
  private cancelledSeries = new Set<string>();
  private activeSeries = new Map<string, number>();
  private downloadControllers = new Map<string, Set<AbortController>>();

  async cancelSeries(seriesId: string): Promise<void> {
    this.cancelledSeries.add(seriesId);
    for (const controller of this.downloadControllers.get(seriesId) ?? []) controller.abort();
    await prisma.chapter.updateMany({ where: { seriesId, status: 'queued' }, data: { status: 'skipped' } });
    const deadline = Date.now() + 60_000;
    while (this.activeSeries.get(seriesId)) {
      if (Date.now() > deadline) throw new Error('Waiting for the current page download to finish; deletion will retry');
      await this.delay(100);
    }
  }
  
  constructor(io: Server) {
    this.io = io;
    
    const concurrency = parseInt(process.env.CONCURRENCY || '3', 10);
    this.queue = new PQueue({ concurrency });
    
    // Emit status updates when queue changes
    this.queue.on('active', () => {
      this.emitStatus();
    });
    
    this.queue.on('idle', () => {
      this.emitStatus();
      // Series set to auto-send get their new chapters sent to the phone now the downloads are done.
      flushAutoSend(this.io);
    });
  }
  
  /**
   * Get current queue status
   */
  getQueueStatus(): QueueStatus {
    return {
      isPaused: this.isPaused,
      pending: this.queue.pending,
      active: this.queue.size,
      completed: this.completedCount,
      failed: this.failedCount,
      currentChapter: this.currentChapterId
    };
  }
  
  /**
   * Emit current status to all connected clients
   */
  private emitStatus(): void {
    this.io.emit('queue:status', this.getQueueStatus());
    notifySeriesProcessChanged();
  }
  
  /**
   * Add chapters to download queue
   */
  async queueChapters(chapterIds: string[]): Promise<void> {
    for (const chapterId of chapterIds) {
      if (this.scheduled.has(chapterId)) continue;
      const chapter = await prisma.chapter.findUnique({
        where: { id: chapterId },
        include: { series: true }
      });
      
      // A completed Part's chapters were deleted on purpose (partArchive.ts).
      if (!chapter || chapter.completedAt) continue;
      // Chapters pulled from the phones (phonePull.ts) have no source page to download from.
      if (!chapter.sourceUrl) continue;
      
      // Mark as queued
      await prisma.chapter.update({
        where: { id: chapterId },
        data: { status: 'queued', error: null }
      });
      
      const task: DownloadTask = {
        chapterId,
        seriesId: chapter.seriesId,
        chapterNumber: chapter.number,
        sourceUrl: chapter.sourceUrl,
        folderPath: chapter.folderPath,
        seriesTitle: chapter.series.title
      };
      
      // Add to queue
      this.scheduled.add(chapterId);
      void this.queue.add(() => this.downloadChapter(task)).finally(() => this.scheduled.delete(chapterId));
    }
    
    this.emitStatus();
    this.io.emit('chapters:updated', chapterIds);
  }
  
  /**
   * Download a single chapter
   */
  private async downloadChapter(task: DownloadTask): Promise<void> {
    if (this.cancelledSeries.has(task.seriesId)) return;
    if (this.isPaused) {
      // Re-queue if paused
      await prisma.chapter.update({
        where: { id: task.chapterId },
        data: { status: 'queued' }
      });
      return;
    }
    
    const controller = new AbortController();
    const controllers = this.downloadControllers.get(task.seriesId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.downloadControllers.set(task.seriesId, controllers);
    this.currentChapterId = task.chapterId;
    this.activeSeries.set(task.seriesId, (this.activeSeries.get(task.seriesId) ?? 0) + 1);
    
    try {
      // Update status to downloading
      await prisma.chapter.update({
        where: { id: task.chapterId },
        data: { status: 'downloading', error: null }
      });
      
      if (controller.signal.aborted || this.cancelledSeries.has(task.seriesId)) return;
      this.io.emit('chapter:status', {
        chapterId: task.chapterId,
        status: 'downloading'
      });
      
      // Get images from chapter page
      const { images, error } = await getChapterImages(task.sourceUrl);
      if (controller.signal.aborted || this.cancelledSeries.has(task.seriesId)) return;
      
      if (error) {
        throw new Error(error);
      }
      
      if (images.length === 0) {
        throw new Error('No images found on chapter page');
      }
      
      // Update page count
      await prisma.chapter.update({
        where: { id: task.chapterId },
        data: { pageCount: images.length }
      });
      
      // Ensure folder exists
      const downloadRoot = process.env.DOWNLOAD_ROOT || './downloads';
      const fullFolderPath = path.join(downloadRoot, task.folderPath);
      await fs.promises.mkdir(fullFolderPath, { recursive: true });
      
      // Create/update page records
      for (let i = 0; i < images.length; i++) {
        if (controller.signal.aborted || this.cancelledSeries.has(task.seriesId)) return;
        await prisma.page.upsert({
          where: {
            chapterId_index: {
              chapterId: task.chapterId,
              index: i
            }
          },
          create: {
            chapterId: task.chapterId,
            index: i,
            sourceUrl: images[i].src,
            status: 'pending'
          },
          update: {
            sourceUrl: images[i].src
          }
        });
      }
      
      // Download each image
      let downloadedCount = 0;
      const requestDelay = parseInt(process.env.REQUEST_DELAY_MS || '500', 10);
      
      for (let i = 0; i < images.length; i++) {
        if (controller.signal.aborted || this.cancelledSeries.has(task.seriesId)) return;
        const image = images[i];
        const pageNum = zeroPad(i + 1);
        const destBase = path.join(fullFolderPath, `page_${pageNum}`);
        // Raw bytes land here first; storePageImage moves/converts them into place
        const partPath = `${destBase}${this.getImageExtension(image.src)}.part`;
        
        try {
          // Check if already downloaded
          const existingPage = await prisma.page.findUnique({
            where: {
              chapterId_index: {
                chapterId: task.chapterId,
                index: i
              }
            }
          });
          
          if (existingPage?.status === 'done' && existingPage.localPath) {
            const existsOnDisk = await this.fileExists(path.join(downloadRoot, existingPage.localPath));
            if (existsOnDisk) {
              downloadedCount++;
              continue;
            }
          }
          
          // Download the image, then store it in its smallest lossless form
          await downloadImage(image.src, partPath, task.sourceUrl, { signal: controller.signal });
          if (controller.signal.aborted || this.cancelledSeries.has(task.seriesId)) { await fs.promises.unlink(partPath).catch(() => {}); return; }
          const result = await storePageImage(partPath, destBase);
          if (controller.signal.aborted || this.cancelledSeries.has(task.seriesId)) return;
          const localPath = path.join(task.folderPath, path.basename(result.path));
          
          // A stale file from an earlier attempt would show up as a duplicate page
          if (existingPage?.localPath && existingPage.localPath !== localPath) {
            await fs.promises.unlink(path.join(downloadRoot, existingPage.localPath)).catch(() => {});
          }
          
          if (controller.signal.aborted || this.cancelledSeries.has(task.seriesId)) return;
          // Update page record
          await prisma.page.update({
            where: {
              chapterId_index: {
                chapterId: task.chapterId,
                index: i
              }
            },
            data: {
              localPath,
              status: 'done',
              bytes: result.bytes
            }
          });
          
          if (controller.signal.aborted || this.cancelledSeries.has(task.seriesId)) return;
          downloadedCount++;
          
          // Update chapter progress
          await prisma.chapter.update({
            where: { id: task.chapterId },
            data: { downloadedCount }
          });
          
          if (controller.signal.aborted || this.cancelledSeries.has(task.seriesId)) return;
          // Emit progress
          this.io.emit('chapter:progress', {
            chapterId: task.chapterId,
            downloaded: downloadedCount,
            total: images.length,
            percent: Math.round((downloadedCount / images.length) * 100)
          });
          
          // Delay between requests
          if (i < images.length - 1) {
            await this.delay(requestDelay + Math.random() * 200);
          }
          
        } catch (pageError) {
          await fs.promises.unlink(partPath).catch(() => {});
          if (controller.signal.aborted || this.cancelledSeries.has(task.seriesId)) return;
          
          // Mark page as failed but continue
          await prisma.page.update({
            where: {
              chapterId_index: {
                chapterId: task.chapterId,
                index: i
              }
            },
            data: { status: 'failed' }
          });
          
          console.error(`Failed to download page ${i + 1}:`, pageError);
        }
      }
      
      if (controller.signal.aborted || this.cancelledSeries.has(task.seriesId)) return;
      // Check if all pages downloaded
      const failedPages = await prisma.page.count({
        where: {
          chapterId: task.chapterId,
          status: 'failed'
        }
      });
      
      if (controller.signal.aborted || this.cancelledSeries.has(task.seriesId)) return;
      const finalStatus = failedPages > 0 ? 'failed' : 'done';
      
      await prisma.chapter.update({
        where: { id: task.chapterId },
        data: {
          status: finalStatus,
          downloadedCount,
          error: failedPages > 0 ? `${failedPages} pages failed to download` : null
        }
      });
      
      if (controller.signal.aborted || this.cancelledSeries.has(task.seriesId)) return;
      if (finalStatus === 'done') {
        this.completedCount++;
        await noteChapterDownloaded(task.seriesId);
      } else {
        this.failedCount++;
      }
      
      this.io.emit('chapter:status', {
        chapterId: task.chapterId,
        status: finalStatus
      });
      
    } catch (error) {
      if (controller.signal.aborted || this.cancelledSeries.has(task.seriesId)) return;
      const message = error instanceof Error ? error.message : 'Unknown error';
      
      await prisma.chapter.update({
        where: { id: task.chapterId },
        data: {
          status: 'failed',
          error: message
        }
      });
      
      this.failedCount++;
      
      this.io.emit('chapter:status', {
        chapterId: task.chapterId,
        status: 'failed',
        error: message
      });
      
    } finally {
      controllers.delete(controller);
      if (controllers.size === 0) this.downloadControllers.delete(task.seriesId);
      this.activeSeries.set(task.seriesId, Math.max(0, (this.activeSeries.get(task.seriesId) ?? 1) - 1));
      if (this.cancelledSeries.has(task.seriesId)) await prisma.chapter.updateMany({ where: { id: task.chapterId }, data: { status: 'skipped' } });
      this.currentChapterId = undefined;
      this.emitStatus();
    }
  }
  
  /**
   * Get image extension from URL
   */
  private getImageExtension(url: string): string {
    try {
      const pathname = new URL(url).pathname;
      const ext = path.extname(pathname).toLowerCase();
      
      if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif'].includes(ext)) {
        return ext;
      }
    } catch {}
    
    return '.webp'; // Default to webp
  }
  
  /**
   * Check if file exists
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
  
  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * Pause the download queue
   */
  pause(): void {
    this.isPaused = true;
    this.queue.pause();
    this.emitStatus();
  }
  
  /**
   * Resume the download queue
   */
  resume(): void {
    this.isPaused = false;
    this.queue.start();
    this.emitStatus();
  }
  
  /**
   * Clear the queue
   */
  async clear(): Promise<void> {
    this.queue.clear();
    
    // Reset queued chapters to pending
    await prisma.chapter.updateMany({
      where: { status: 'queued' },
      data: { status: 'pending' }
    });
    
    this.emitStatus();
  }
  
  /**
   * Retry failed chapters
   */
  async retryFailed(seriesId?: string): Promise<void> {
    const where = seriesId 
      ? { status: 'failed', seriesId }
      : { status: 'failed' };
    
    const failedChapters = await prisma.chapter.findMany({
      where,
      select: { id: true }
    });
    
    this.failedCount = 0;
    
    await this.queueChapters(failedChapters.map(c => c.id));
  }
  
  /**
   * Shutdown the download manager
   */
  async shutdown(): Promise<void> {
    for (const controllers of this.downloadControllers.values()) for (const controller of controllers) controller.abort();
    this.queue.pause();
    this.queue.clear();
    
    // Mark downloading chapters as pending
    await prisma.chapter.updateMany({
      where: { status: { in: ['downloading', 'queued'] } },
      data: { status: 'pending' }
    });
  }
}
