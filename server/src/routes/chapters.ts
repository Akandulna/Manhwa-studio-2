/**
 * Chapters API Routes
 */

import { Router, Request, Response } from 'express';
import { prisma } from '../index.js';

const router = Router();

// Get chapter by ID with pages
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const chapter = await prisma.chapter.findUnique({
      where: { id: req.params.id },
      include: {
        pages: {
          orderBy: { index: 'asc' }
        },
        series: true
      }
    });
    
    if (!chapter) {
      return res.status(404).json({ error: 'Chapter not found' });
    }
    
    res.json(chapter);
  } catch (error) {
    console.error('Error fetching chapter:', error);
    res.status(500).json({ error: 'Failed to fetch chapter' });
  }
});

// Update chapter status
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const { status, error } = req.body;
    
    const updateData: any = {};
    if (status) updateData.status = status;
    if (error !== undefined) updateData.error = error;
    
    const chapter = await prisma.chapter.update({
      where: { id: req.params.id },
      data: updateData
    });
    
    res.json(chapter);
  } catch (error) {
    console.error('Error updating chapter:', error);
    res.status(500).json({ error: 'Failed to update chapter' });
  }
});

// Update multiple chapters' status (for skipping)
router.post('/bulk-update', async (req: Request, res: Response) => {
  try {
    const { chapterIds, status } = req.body;
    
    if (!Array.isArray(chapterIds) || !status) {
      return res.status(400).json({ error: 'chapterIds array and status required' });
    }
    
    await prisma.chapter.updateMany({
      where: { id: { in: chapterIds } },
      data: { status }
    });
    
    const updated = await prisma.chapter.findMany({
      where: { id: { in: chapterIds } }
    });
    
    res.json(updated);
  } catch (error) {
    console.error('Error bulk updating chapters:', error);
    res.status(500).json({ error: 'Failed to bulk update chapters' });
  }
});

// Delete chapter
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    await prisma.chapter.delete({
      where: { id: req.params.id }
    });
    
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting chapter:', error);
    res.status(500).json({ error: 'Failed to delete chapter' });
  }
});

// Get failed pages for a chapter
router.get('/:id/failed-pages', async (req: Request, res: Response) => {
  try {
    const pages = await prisma.page.findMany({
      where: {
        chapterId: req.params.id,
        status: 'failed'
      },
      orderBy: { index: 'asc' }
    });
    
    res.json(pages);
  } catch (error) {
    console.error('Error fetching failed pages:', error);
    res.status(500).json({ error: 'Failed to fetch failed pages' });
  }
});

export default router;
