/**
 * Import Service
 * Scans the downloads folder for existing series/chapters and imports them into the database
 */

import path from 'path';
import fs from 'fs/promises';
import { prisma } from '../index.js';
import { zeroPad } from '../utils/urlPattern.js';

const DOWNLOAD_ROOT = process.env.DOWNLOAD_ROOT || './downloads';

interface ImportResult {
  seriesImported: number;
  chaptersImported: number;
  pagesImported: number;
  skipped: string[];
  errors: string[];
}

interface SeriesScanResult {
  name: string;
  folderPath: string;
  chapters: ChapterScanResult[];
}

interface ChapterScanResult {
  number: number;
  folderPath: string;
  images: string[];
}

/**
 * Scan downloads folder for existing series
 */
export async function scanDownloadsFolder(): Promise<SeriesScanResult[]> {
  const results: SeriesScanResult[] = [];
  
  try {
    const entries = await fs.readdir(DOWNLOAD_ROOT, { withFileTypes: true });
    
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) {
        continue;
      }
      
      const seriesPath = path.join(DOWNLOAD_ROOT, entry.name);
      const chapters = await scanSeriesFolder(seriesPath, entry.name);
      
      if (chapters.length > 0) {
        results.push({
          name: entry.name,
          folderPath: entry.name,
          chapters
        });
      }
    }
  } catch (error) {
    console.error('Error scanning downloads folder:', error);
  }
  
  return results;
}

/**
 * Scan a series folder for chapters
 */
async function scanSeriesFolder(seriesPath: string, seriesName: string): Promise<ChapterScanResult[]> {
  const chapters: ChapterScanResult[] = [];
  
  try {
    const entries = await fs.readdir(seriesPath, { withFileTypes: true });
    
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) {
        continue;
      }
      
      // Try to extract chapter number from folder name
      const chapterMatch = entry.name.match(/chapter\s*(\d+)/i);
      if (!chapterMatch) {
        continue;
      }
      
      const chapterNumber = parseInt(chapterMatch[1]);
      const chapterPath = path.join(seriesPath, entry.name);
      const images = await scanChapterFolder(chapterPath);
      
      if (images.length > 0) {
        chapters.push({
          number: chapterNumber,
          folderPath: `${seriesName}/${entry.name}`,
          images
        });
      }
    }
  } catch (error) {
    console.error(`Error scanning series folder ${seriesPath}:`, error);
  }
  
  // Sort by chapter number
  chapters.sort((a, b) => a.number - b.number);
  
  return chapters;
}

/**
 * Scan a chapter folder for images
 */
async function scanChapterFolder(chapterPath: string): Promise<string[]> {
  const images: string[] = [];
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
  
  try {
    const entries = await fs.readdir(chapterPath, { withFileTypes: true });
    
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      
      const ext = path.extname(entry.name).toLowerCase();
      if (imageExtensions.includes(ext)) {
        images.push(entry.name);
      }
    }
  } catch (error) {
    console.error(`Error scanning chapter folder ${chapterPath}:`, error);
  }
  
  // Sort images by name (usually page_001, page_002, etc.)
  images.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  
  return images;
}

/**
 * Import scanned series into the database
 */
export async function importExistingSeries(
  seriesToImport: SeriesScanResult[],
  onProgress?: (message: string) => void
): Promise<ImportResult> {
  const result: ImportResult = {
    seriesImported: 0,
    chaptersImported: 0,
    pagesImported: 0,
    skipped: [],
    errors: []
  };
  
  for (const seriesScan of seriesToImport) {
    try {
      // Check if series already exists by rootFolder
      const existingSeries = await prisma.series.findFirst({
        where: { rootFolder: seriesScan.folderPath }
      });
      
      if (existingSeries) {
        onProgress?.(`Skipping "${seriesScan.name}" - already in database`);
        result.skipped.push(seriesScan.name);
        
        // Still try to import missing chapters
        await importMissingChapters(existingSeries.id, seriesScan, result, onProgress);
        continue;
      }
      
      onProgress?.(`Importing series: ${seriesScan.name}`);
      
      // Create series
      const series = await prisma.series.create({
        data: {
          title: seriesScan.name,
          sourceSite: 'imported',
          rootFolder: seriesScan.folderPath,
          urlTemplate: null
        }
      });
      
      result.seriesImported++;
      
      // Import chapters
      for (const chapterScan of seriesScan.chapters) {
        try {
          onProgress?.(`  Importing Chapter ${chapterScan.number} (${chapterScan.images.length} pages)`);
          
          // Create chapter
          const chapter = await prisma.chapter.create({
            data: {
              seriesId: series.id,
              number: chapterScan.number,
              title: `Chapter ${chapterScan.number}`,
              folderPath: chapterScan.folderPath,
              sourceUrl: null,
              status: 'done',
              pageCount: chapterScan.images.length
            }
          });
          
          result.chaptersImported++;
          
          // Create pages
          const pageData = chapterScan.images.map((filename, idx) => ({
            chapterId: chapter.id,
            index: idx + 1,
            localPath: `${chapterScan.folderPath}/${filename}`,
            sourceUrl: null,
            status: 'done' as const
          }));
          
          if (pageData.length > 0) {
            await prisma.page.createMany({ data: pageData });
            result.pagesImported += pageData.length;
          }
        } catch (chapterError) {
          const errorMsg = `Failed to import Chapter ${chapterScan.number} of "${seriesScan.name}"`;
          console.error(errorMsg, chapterError);
          result.errors.push(errorMsg);
        }
      }
    } catch (seriesError) {
      const errorMsg = `Failed to import series "${seriesScan.name}"`;
      console.error(errorMsg, seriesError);
      result.errors.push(errorMsg);
    }
  }
  
  return result;
}

/**
 * Import missing chapters for an existing series
 */
async function importMissingChapters(
  seriesId: string,
  seriesScan: SeriesScanResult,
  result: ImportResult,
  onProgress?: (message: string) => void
): Promise<void> {
  // Get existing chapters
  const existingChapters = await prisma.chapter.findMany({
    where: { seriesId },
    select: { number: true }
  });
  
  const existingNumbers = new Set(existingChapters.map(c => c.number));
  
  for (const chapterScan of seriesScan.chapters) {
    if (existingNumbers.has(chapterScan.number)) {
      continue;
    }
    
    try {
      onProgress?.(`  Adding missing Chapter ${chapterScan.number} (${chapterScan.images.length} pages)`);
      
      const chapter = await prisma.chapter.create({
        data: {
          seriesId,
          number: chapterScan.number,
          title: `Chapter ${chapterScan.number}`,
          folderPath: chapterScan.folderPath,
          sourceUrl: null,
          status: 'done',
          pageCount: chapterScan.images.length
        }
      });
      
      result.chaptersImported++;
      
      const pageData = chapterScan.images.map((filename, idx) => ({
        chapterId: chapter.id,
        index: idx + 1,
        localPath: `${chapterScan.folderPath}/${filename}`,
        sourceUrl: null,
        status: 'done' as const
      }));
      
      if (pageData.length > 0) {
        await prisma.page.createMany({ data: pageData });
        result.pagesImported += pageData.length;
      }
    } catch (error) {
      const errorMsg = `Failed to import missing Chapter ${chapterScan.number}`;
      console.error(errorMsg, error);
      result.errors.push(errorMsg);
    }
  }
}

/**
 * Get preview of what would be imported
 */
export async function getImportPreview(): Promise<{
  newSeries: SeriesScanResult[];
  existingSeries: { name: string; missingChapters: number[] }[];
}> {
  const scanned = await scanDownloadsFolder();
  const newSeries: SeriesScanResult[] = [];
  const existingSeries: { name: string; missingChapters: number[] }[] = [];
  
  for (const seriesScan of scanned) {
    const existing = await prisma.series.findFirst({
      where: { rootFolder: seriesScan.folderPath },
      include: {
        chapters: {
          select: { number: true }
        }
      }
    });
    
    if (!existing) {
      newSeries.push(seriesScan);
    } else {
      const existingNumbers = new Set(existing.chapters.map(c => c.number));
      const missingChapters = seriesScan.chapters
        .filter(c => !existingNumbers.has(c.number))
        .map(c => c.number);
      
      if (missingChapters.length > 0) {
        existingSeries.push({
          name: seriesScan.name,
          missingChapters
        });
      }
    }
  }
  
  return { newSeries, existingSeries };
}
