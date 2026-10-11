/**
 * Series API Routes — read-only: series and chapters arrive from the phones
 * (Get from phones), so nothing here creates or edits them.
 */

import { Router, Request, Response } from 'express';
import { prisma } from '../index.js';
import { reconcileQuietly } from '../services/diskReconcile.js';

const router = Router();

// Get all series
router.get('/', async (req: Request, res: Response) => {
  try {
    await reconcileQuietly();
    const series = await prisma.series.findMany({
      include: {
        _count: {
          select: { chapters: true }
        },
        chapters: {
          select: {
            status: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    
    // Calculate status summary for each series
    const result = series.map(s => {
      const statusCounts = {
        pending: 0,
        queued: 0,
        downloading: 0,
        done: 0,
        failed: 0,
        skipped: 0
      };
      
      s.chapters.forEach(ch => {
        if (ch.status in statusCounts) {
          statusCounts[ch.status as keyof typeof statusCounts]++;
        }
      });
      
      return {
        ...s,
        chapterCount: s._count.chapters,
        statusCounts,
        chapters: undefined,
        _count: undefined
      };
    });
    
    res.json(result);
  } catch (error) {
    console.error('Error fetching series:', error);
    res.status(500).json({ error: 'Failed to fetch series' });
  }
});

// Get single series with chapters
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const reconcile = await reconcileQuietly();
    const series = await prisma.series.findUnique({
      where: { id: req.params.id },
      include: {
        chapters: {
          orderBy: { number: 'asc' }
        }
      }
    });
    
    if (!series) {
      return res.status(404).json({ error: 'Series not found' });
    }
    
    // Pages trimmed by hand stay "done" in the database; report the gap so
    // the row can show it.
    res.json({
      ...series,
      chapters: series.chapters.map(c => ({
        ...c,
        missingPages: reconcile?.missingPages[c.id] ?? 0
      }))
    });
  } catch (error) {
    console.error('Error fetching series:', error);
    res.status(500).json({ error: 'Failed to fetch series' });
  }
});

export default router;
