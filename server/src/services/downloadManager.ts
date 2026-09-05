/**
 * Download Manager Service
 * Handles concurrent downloading of manhwa images with progress tracking
 */

import { Server } from 'socket.io';
import PQueue from 'p-queue';
import { prisma } from '../index.js';
import { getChapterImages, DetectedImage } from './scraper.js';
import { zeroPad, sanitizeTitle } from '../utils/urlPattern.js';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';

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

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

export class DownloadManager {
  private io: Server;
  private queue: PQueue;
  private isPaused: boolean = false;
  private completedCount: number = 0;
  private failedCount: number = 0;
  private currentChapterId?: string;
  
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
  }
  
  /**
   * Add chapters to download queue
   */
  async queueChapters(chapterIds: string[]): Promise<void> {
    for (const chapterId of chapterIds) {
      const chapter = await prisma.chapter.findUnique({
        where: { id: chapterId },
        include: { series: true }
      });
      
      if (!chapter) continue;
      
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
      this.queue.add(() => this.downloadChapter(task));
    }
    
    this.emitStatus();
    this.io.emit('chapters:updated', chapterIds);
  }
  
  /**
   * Download a single chapter
   */
  private async downloadChapter(task: DownloadTask): Promise<void> {
    if (this.isPaused) {
      // Re-queue if paused
      await prisma.chapter.update({
        where: { id: task.chapterId },
        data: { status: 'queued' }
      });
      return;
    }
    
    this.currentChapterId = task.chapterId;
    
    try {
      // Update status to downloading
      await prisma.chapter.update({
        where: { id: task.chapterId },
        data: { status: 'downloading', error: null }
      });
      
      this.io.emit('chapter:status', {
        chapterId: task.chapterId,
        status: 'downloading'
      });
      
      // Get images from chapter page
      const { images, error } = await getChapterImages(task.sourceUrl);
      
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
        const image = images[i];
        const pageNum = zeroPad(i + 1);
        const ext = this.getImageExtension(image.src);
        const filename = `page_${pageNum}${ext}`;
        const localPath = path.join(task.folderPath, filename);
        const fullPath = path.join(fullFolderPath, filename);
        
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
          
          // Download the image
          const bytes = await this.downloadImage(image.src, fullPath, task.sourceUrl);
          
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
              bytes
            }
          });
          
          downloadedCount++;
          
          // Update chapter progress
          await prisma.chapter.update({
            where: { id: task.chapterId },
            data: { downloadedCount }
          });
          
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
      
      // Check if all pages downloaded
      const failedPages = await prisma.page.count({
        where: {
          chapterId: task.chapterId,
          status: 'failed'
        }
      });
      
      const finalStatus = failedPages > 0 ? 'failed' : 'done';
      
      await prisma.chapter.update({
        where: { id: task.chapterId },
        data: {
          status: finalStatus,
          downloadedCount,
          error: failedPages > 0 ? `${failedPages} pages failed to download` : null
        }
      });
      
      if (finalStatus === 'done') {
        this.completedCount++;
      } else {
        this.failedCount++;
      }
      
      this.io.emit('chapter:status', {
        chapterId: task.chapterId,
        status: finalStatus
      });
      
    } catch (error) {
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
      this.currentChapterId = undefined;
      this.emitStatus();
    }
  }
  
  /**
   * Download an image with proper headers
   */
  private downloadImage(url: string, destPath: string, referer: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const userAgent = DEFAULT_USER_AGENT;
      
      const parsedUrl = new URL(url);
      const client = parsedUrl.protocol === 'https:' ? https : http;
      
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
          'User-Agent': userAgent,
          'Referer': referer,
          'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache'
        }
      };
      
      const makeRequest = (url: string, retries: number = 3): void => {
        const parsedUrl = new URL(url);
        const client = parsedUrl.protocol === 'https:' ? https : http;
        
        const reqOptions = {
          ...options,
          hostname: parsedUrl.hostname,
          port: parsedUrl.port,
          path: parsedUrl.pathname + parsedUrl.search
        };
        
        const req = client.request(reqOptions, (res) => {
          // Handle redirects
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            makeRequest(res.headers.location, retries);
            return;
          }
          
          if (res.statusCode === 403) {
            reject(new Error('403 Forbidden - CDN may be blocking requests. Check Referer/User-Agent settings.'));
            return;
          }
          
          if (res.statusCode === 429 && retries > 0) {
            // Rate limited, retry after delay
            setTimeout(() => makeRequest(url, retries - 1), 2000);
            return;
          }
          
          if (res.statusCode && res.statusCode >= 500 && retries > 0) {
            // Server error, retry
            setTimeout(() => makeRequest(url, retries - 1), 1000);
            return;
          }
          
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          
          const fileStream = fs.createWriteStream(destPath);
          let bytes = 0;
          
          res.on('data', (chunk) => {
            bytes += chunk.length;
          });
          
          res.pipe(fileStream);
          
          fileStream.on('finish', () => {
            fileStream.close();
            resolve(bytes);
          });
          
          fileStream.on('error', (err) => {
            fs.unlink(destPath, () => {});
            reject(err);
          });
        });
        
        req.on('error', (err) => {
          if (retries > 0) {
            setTimeout(() => makeRequest(url, retries - 1), 1000);
          } else {
            reject(err);
          }
        });
        
        req.setTimeout(30000, () => {
          req.destroy();
          if (retries > 0) {
            setTimeout(() => makeRequest(url, retries - 1), 1000);
          } else {
            reject(new Error('Request timeout'));
          }
        });
        
        req.end();
      };
      
      makeRequest(url);
    });
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
    this.queue.pause();
    this.queue.clear();
    
    // Mark downloading chapters as pending
    await prisma.chapter.updateMany({
      where: { status: { in: ['downloading', 'queued'] } },
      data: { status: 'pending' }
    });
  }
}
