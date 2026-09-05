/**
 * Manual Upload API Routes
 * For when URL pattern detection doesn't work - manual folder creation and image uploads
 */

import { Router, Request, Response } from 'express';
import { prisma } from '../index.js';
import { sanitizeTitle, zeroPad } from '../utils/urlPattern.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';

const router = Router();

// Helper to get download root
function getDownloadRoot(): string {
  return process.env.DOWNLOAD_ROOT || './downloads';
}

// Configure multer for page image uploads
const uploadStorage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const { seriesId, chapterNumber } = req.params;
    
    try {
      // Get series folder path
      const series = await prisma.series.findUnique({
        where: { id: seriesId },
        select: { rootFolder: true }
      });
      
      if (!series) {
        return cb(new Error('Series not found'), '');
      }
      
      const chapterFolder = path.join(
        getDownloadRoot(),
        series.rootFolder,
        `Chapter ${zeroPad(parseInt(chapterNumber))}`
      );
      
      // Ensure folder exists
      await fs.mkdir(chapterFolder, { recursive: true });
      
      cb(null, chapterFolder);
    } catch (error) {
      cb(error as Error, '');
    }
  },
  filename: (req, file, cb) => {
    // Keep original name or generate sequential name
    const ext = path.extname(file.originalname).toLowerCase();
    const baseName = path.basename(file.originalname, ext);
    cb(null, `${baseName}${ext}`);
  }
});

const upload = multer({
  storage: uploadStorage,
  limits: {
    fileSize: 20 * 1024 * 1024, // 20MB per file
    files: 100 // Max 100 files at once
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type: ${file.mimetype}. Only JPEG, PNG, WebP, and GIF are allowed.`));
    }
  }
});

/**
 * Create a manual series (no URL pattern, no source site)
 */
router.post('/series', async (req: Request, res: Response) => {
  try {
    const { title, chapterCount } = req.body;
    
    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }
    
    const numChapters = Math.max(1, Math.min(chapterCount || 1, 500));
    const sanitizedTitle = sanitizeTitle(title);
    const rootFolder = sanitizedTitle;
    
    // Create the root folder
    const rootPath = path.join(getDownloadRoot(), rootFolder);
    await fs.mkdir(rootPath, { recursive: true });
    
    // Create chapter folders
    const chapterData = [];
    for (let i = 1; i <= numChapters; i++) {
      const chapterFolder = `Chapter ${zeroPad(i)}`;
      const chapterPath = path.join(rootPath, chapterFolder);
      await fs.mkdir(chapterPath, { recursive: true });
      
      chapterData.push({
        number: i,
        folderPath: `${rootFolder}/${chapterFolder}`,
        status: 'pending' as const,
        sourceUrl: null,
        title: `Chapter ${i}`
      });
    }
    
    // Create series in database
    const series = await prisma.series.create({
      data: {
        title,
        sourceSite: 'manual',
        urlTemplate: null,
        rootFolder,
        chapters: {
          create: chapterData
        }
      },
      include: {
        chapters: {
          orderBy: { number: 'asc' }
        }
      }
    });
    
    res.status(201).json(series);
  } catch (error) {
    console.error('Error creating manual series:', error);
    res.status(500).json({ error: 'Failed to create manual series' });
  }
});

/**
 * Add chapters to an existing manual series
 */
router.post('/series/:seriesId/chapters', async (req: Request, res: Response) => {
  try {
    const { seriesId } = req.params;
    const { fromChapter, toChapter } = req.body;
    
    const series = await prisma.series.findUnique({
      where: { id: seriesId },
      include: {
        chapters: {
          select: { number: true }
        }
      }
    });
    
    if (!series) {
      return res.status(404).json({ error: 'Series not found' });
    }
    
    const existingNumbers = new Set(series.chapters.map(c => c.number));
    const from = Math.max(1, fromChapter || 1);
    const to = Math.max(from, toChapter || from);
    
    if (to - from > 100) {
      return res.status(400).json({ error: 'Maximum 100 chapters at a time' });
    }
    
    const newChapters = [];
    const rootPath = path.join(getDownloadRoot(), series.rootFolder);
    
    for (let i = from; i <= to; i++) {
      if (!existingNumbers.has(i)) {
        const chapterFolder = `Chapter ${zeroPad(i)}`;
        const chapterPath = path.join(rootPath, chapterFolder);
        await fs.mkdir(chapterPath, { recursive: true });
        
        newChapters.push({
          number: i,
          folderPath: `${series.rootFolder}/${chapterFolder}`,
          status: 'pending' as const,
          sourceUrl: null,
          title: `Chapter ${i}`,
          seriesId
        });
      }
    }
    
    if (newChapters.length === 0) {
      return res.json({ message: 'No new chapters to add', added: 0 });
    }
    
    // Create chapters
    await prisma.chapter.createMany({
      data: newChapters
    });
    
    const updatedSeries = await prisma.series.findUnique({
      where: { id: seriesId },
      include: {
        chapters: {
          orderBy: { number: 'asc' }
        }
      }
    });
    
    res.json({
      message: `Added ${newChapters.length} chapters`,
      added: newChapters.length,
      series: updatedSeries
    });
  } catch (error) {
    console.error('Error adding chapters:', error);
    res.status(500).json({ error: 'Failed to add chapters' });
  }
});

/**
 * Upload images to a chapter
 */
router.post(
  '/series/:seriesId/chapters/:chapterNumber/upload',
  upload.array('images', 100),
  async (req: Request, res: Response) => {
    try {
      const { seriesId, chapterNumber } = req.params;
      const files = req.files as Express.Multer.File[];
      
      if (!files || files.length === 0) {
        return res.status(400).json({ error: 'No images uploaded' });
      }
      
      // Get chapter
      const chapter = await prisma.chapter.findFirst({
        where: {
          seriesId,
          number: parseInt(chapterNumber)
        },
        include: {
          series: true,
          pages: true
        }
      });
      
      if (!chapter) {
        return res.status(404).json({ error: 'Chapter not found' });
      }
      
      // Get existing page count for indexing
      const existingCount = chapter.pages.length;
      
      // Sort files by name to maintain order
      const sortedFiles = files.sort((a, b) => 
        a.originalname.localeCompare(b.originalname, undefined, { numeric: true })
      );
      
      // Create page records
      const pageData = sortedFiles.map((file, idx) => ({
        chapterId: chapter.id,
        index: existingCount + idx + 1,
        localPath: path.join(chapter.folderPath, file.filename),
        sourceUrl: null,
        status: 'done' as const
      }));
      
      await prisma.page.createMany({
        data: pageData
      });
      
      // Update chapter status to done if it has pages now
      const totalPages = existingCount + files.length;
      await prisma.chapter.update({
        where: { id: chapter.id },
        data: {
          status: 'done',
          pageCount: totalPages
        }
      });
      
      res.json({
        message: `Uploaded ${files.length} images`,
        uploadedCount: files.length,
        totalPages,
        files: sortedFiles.map(f => f.filename)
      });
    } catch (error) {
      console.error('Error uploading images:', error);
      res.status(500).json({ error: 'Failed to upload images' });
    }
  }
);

/**
 * Get chapter folder contents
 */
router.get('/series/:seriesId/chapters/:chapterNumber/files', async (req: Request, res: Response) => {
  try {
    const { seriesId, chapterNumber } = req.params;
    
    const chapter = await prisma.chapter.findFirst({
      where: {
        seriesId,
        number: parseInt(chapterNumber)
      },
      include: {
        series: true,
        pages: {
          orderBy: { index: 'asc' }
        }
      }
    });
    
    if (!chapter) {
      return res.status(404).json({ error: 'Chapter not found' });
    }
    
    const chapterPath = path.join(getDownloadRoot(), chapter.folderPath);
    
    try {
      const files = await fs.readdir(chapterPath);
      const imageFiles = files.filter(f => 
        /\.(jpg|jpeg|png|webp|gif)$/i.test(f)
      ).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      
      res.json({
        chapter: {
          id: chapter.id,
          number: chapter.number,
          title: chapter.title,
          status: chapter.status
        },
        folderPath: chapter.folderPath,
        files: imageFiles,
        pageCount: chapter.pages.length
      });
    } catch (e) {
      // Folder might not exist yet
      res.json({
        chapter: {
          id: chapter.id,
          number: chapter.number,
          title: chapter.title,
          status: chapter.status
        },
        folderPath: chapter.folderPath,
        files: [],
        pageCount: 0
      });
    }
  } catch (error) {
    console.error('Error listing chapter files:', error);
    res.status(500).json({ error: 'Failed to list chapter files' });
  }
});

/**
 * Delete images from a chapter
 */
router.delete('/series/:seriesId/chapters/:chapterNumber/files', async (req: Request, res: Response) => {
  try {
    const { seriesId, chapterNumber } = req.params;
    const { filenames } = req.body;
    
    if (!filenames || !Array.isArray(filenames)) {
      return res.status(400).json({ error: 'filenames array required' });
    }
    
    const chapter = await prisma.chapter.findFirst({
      where: {
        seriesId,
        number: parseInt(chapterNumber)
      },
      include: { series: true }
    });
    
    if (!chapter) {
      return res.status(404).json({ error: 'Chapter not found' });
    }
    
    const chapterPath = path.join(getDownloadRoot(), chapter.folderPath);
    let deletedCount = 0;
    
    for (const filename of filenames) {
      try {
        const filePath = path.join(chapterPath, filename);
        await fs.unlink(filePath);
        
        // Also remove from pages table
        await prisma.page.deleteMany({
          where: {
            chapterId: chapter.id,
            localPath: path.join(chapter.folderPath, filename)
          }
        });
        
        deletedCount++;
      } catch (e) {
        console.error(`Failed to delete ${filename}:`, e);
      }
    }
    
    // Update page count
    const remainingPages = await prisma.page.count({
      where: { chapterId: chapter.id }
    });
    
    await prisma.chapter.update({
      where: { id: chapter.id },
      data: {
        pageCount: remainingPages,
        status: remainingPages === 0 ? 'pending' : 'done'
      }
    });
    
    res.json({
      deleted: deletedCount,
      remaining: remainingPages
    });
  } catch (error) {
    console.error('Error deleting files:', error);
    res.status(500).json({ error: 'Failed to delete files' });
  }
});

/**
 * Reindex chapter pages from folder
 */
router.post('/series/:seriesId/chapters/:chapterNumber/reindex', async (req: Request, res: Response) => {
  try {
    const { seriesId, chapterNumber } = req.params;
    
    const chapter = await prisma.chapter.findFirst({
      where: {
        seriesId,
        number: parseInt(chapterNumber)
      },
      include: { series: true }
    });
    
    if (!chapter) {
      return res.status(404).json({ error: 'Chapter not found' });
    }
    
    const chapterPath = path.join(getDownloadRoot(), chapter.folderPath);
    
    // Delete existing pages
    await prisma.page.deleteMany({
      where: { chapterId: chapter.id }
    });
    
    try {
      const files = await fs.readdir(chapterPath);
      const imageFiles = files.filter(f => 
        /\.(jpg|jpeg|png|webp|gif)$/i.test(f)
      ).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      
      // Create new page records
      const pageData = imageFiles.map((filename, idx) => ({
        chapterId: chapter.id,
        index: idx + 1,
        localPath: path.join(chapter.folderPath, filename),
        sourceUrl: null,
        status: 'done' as const
      }));
      
      if (pageData.length > 0) {
        await prisma.page.createMany({
          data: pageData
        });
      }
      
      // Update chapter
      await prisma.chapter.update({
        where: { id: chapter.id },
        data: {
          pageCount: imageFiles.length,
          status: imageFiles.length > 0 ? 'done' : 'pending'
        }
      });
      
      res.json({
        message: `Reindexed ${imageFiles.length} pages`,
        pageCount: imageFiles.length,
        files: imageFiles
      });
    } catch (e) {
      // Folder doesn't exist
      await prisma.chapter.update({
        where: { id: chapter.id },
        data: {
          pageCount: 0,
          status: 'pending'
        }
      });
      
      res.json({
        message: 'Folder empty or not found',
        pageCount: 0,
        files: []
      });
    }
  } catch (error) {
    console.error('Error reindexing chapter:', error);
    res.status(500).json({ error: 'Failed to reindex chapter' });
  }
});

// ==========================================
// Import Existing Files Routes
// ==========================================

import { 
  scanDownloadsFolder, 
  importExistingSeries, 
  getImportPreview 
} from '../services/importService.js';

/**
 * Preview what can be imported from downloads folder
 */
router.get('/import/preview', async (req: Request, res: Response) => {
  try {
    const preview = await getImportPreview();
    res.json(preview);
  } catch (error) {
    console.error('Error getting import preview:', error);
    res.status(500).json({ error: 'Failed to scan downloads folder' });
  }
});

/**
 * Scan downloads folder for existing series
 */
router.get('/import/scan', async (req: Request, res: Response) => {
  try {
    const scanned = await scanDownloadsFolder();
    res.json({
      found: scanned.length,
      series: scanned.map(s => ({
        name: s.name,
        folderPath: s.folderPath,
        chapterCount: s.chapters.length,
        chapters: s.chapters.map(c => ({
          number: c.number,
          pageCount: c.images.length
        }))
      }))
    });
  } catch (error) {
    console.error('Error scanning downloads:', error);
    res.status(500).json({ error: 'Failed to scan downloads folder' });
  }
});

/**
 * Import all existing series from downloads folder
 */
router.post('/import/all', async (req: Request, res: Response) => {
  try {
    const scanned = await scanDownloadsFolder();
    
    if (scanned.length === 0) {
      return res.json({
        message: 'No series found to import',
        seriesImported: 0,
        chaptersImported: 0,
        pagesImported: 0
      });
    }
    
    const result = await importExistingSeries(scanned, (msg) => {
      console.log(`[Import] ${msg}`);
    });
    
    res.json({
      message: `Imported ${result.seriesImported} series, ${result.chaptersImported} chapters, ${result.pagesImported} pages`,
      ...result
    });
  } catch (error) {
    console.error('Error importing series:', error);
    res.status(500).json({ error: 'Failed to import series' });
  }
});

/**
 * Import specific series by folder name
 */
router.post('/import/series', async (req: Request, res: Response) => {
  try {
    const { folderNames } = req.body;
    
    if (!folderNames || !Array.isArray(folderNames)) {
      return res.status(400).json({ error: 'folderNames array required' });
    }
    
    const scanned = await scanDownloadsFolder();
    const toImport = scanned.filter(s => folderNames.includes(s.folderPath));
    
    if (toImport.length === 0) {
      return res.json({
        message: 'No matching series found',
        seriesImported: 0,
        chaptersImported: 0,
        pagesImported: 0
      });
    }
    
    const result = await importExistingSeries(toImport, (msg) => {
      console.log(`[Import] ${msg}`);
    });
    
    res.json({
      message: `Imported ${result.seriesImported} series, ${result.chaptersImported} chapters, ${result.pagesImported} pages`,
      ...result
    });
  } catch (error) {
    console.error('Error importing series:', error);
    res.status(500).json({ error: 'Failed to import series' });
  }
});

export default router;
