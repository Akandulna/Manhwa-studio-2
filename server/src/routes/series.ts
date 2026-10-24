/**
 * Series API Routes
 */

import { withSeriesActivity } from '../services/seriesActivity.js';
import { Router, Request, Response } from 'express';
import { prisma, downloadManager } from '../index.js';
import { ownLibrarySeries, scheduleLibraryPublish } from '../services/librarySync.js';
import { inferPattern, sanitizeTitle, zeroPad, generateUrl } from '../utils/urlPattern.js';
import { extractSiteDomain, getPageTitle } from '../services/scraper.js';
import { validateManualChapters } from '../services/discovery.js';
import { Server } from 'socket.io';
import { reconcileQuietly } from '../services/diskReconcile.js';
import path from 'path';
import fs from 'node:fs/promises';
import { newSeriesFolder } from '../services/newSeriesFolder.js';
import { libraryDeviceId, scheduleLibraryCleanup } from '../services/librarySync.js';
import { libraryControl, libraryControls, saveLibraryControls, hiddenLibraryFolders } from '../services/libraryControls.js';
import { notifySeriesProcessChanged } from '../services/seriesProcess.js';
import { productionAutomation, getProductionStatus, reconcileManagedProduction, resumeManagedProduction, exportManagedProduction, adoptManagedProduction, pauseManagedProduction, handoffManagedProduction, accountHandoffManagedProduction, disposeManagedProductionRecovery } from '../services/productionAutomation.js';
import { parseProductionConfig } from '../services/productionAutomationModel.js';

const router = Router();

router.get('/:id/automation', async (req, res) => {
  try { res.json(await getProductionStatus(req.params.id)); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});
router.post('/:id/automation', async (req, res) => {
  try { res.json(await productionAutomation.start(req.params.id, parseProductionConfig(req.body))); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});
router.post('/:id/automation/reconcile', async (req, res) => {
  try { res.json(await reconcileManagedProduction(req.params.id,req.body)); }
  catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
});
router.post('/:id/automation/resume', async (req, res) => {
  try { res.json(await resumeManagedProduction(req.params.id,req.body)); }
  catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
});
router.post('/:id/automation/export-run', async (req, res) => {
  try { res.json(await exportManagedProduction(req.params.id,req.body)); }
  catch (error) { res.status(409).json({error:error instanceof Error?error.message:String(error)}); }
});
router.post('/:id/automation/adopt-run', async (req, res) => {
  try { res.json(await adoptManagedProduction(req.params.id,req.body)); }
  catch (error) { res.status(409).json({error:error instanceof Error?error.message:String(error)}); }
});
router.post('/:id/automation/pause-handoff',async(req,res)=>{try{res.json(await pauseManagedProduction(req.params.id,req.body))}catch(error){res.status(409).json({error:error instanceof Error?error.message:String(error)})}});
router.post('/:id/automation/recovery-disposition',async(req,res)=>{try{res.json(await disposeManagedProductionRecovery(req.params.id,req.body))}catch(error){res.status(409).json({error:error instanceof Error?error.message:String(error)})}});
router.post('/:id/automation/account-handoff',async(req,res)=>{try{res.json(await accountHandoffManagedProduction(req.params.id,req.body))}catch(error){res.status(409).json({error:error instanceof Error?error.message:String(error)})}});
router.post('/:id/automation/handoff',async(req,res)=>{try{res.json(await handoffManagedProduction(req.params.id,req.body))}catch(error){res.status(409).json({error:error instanceof Error?error.message:String(error)})}});
router.post('/:id/automation/stop', async (req, res) => {
  try { res.json(await productionAutomation.cancel(req.params.id)); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});

// Reversible visibility only: retains files, durable authority and diagnostic evidence.
router.get('/archived', async (_req,res) => {
  try { const folders=(await libraryControls()).filter(c=>c.archived?.done&&!c.deleted).map(c=>c.folder);res.json(await prisma.series.findMany({where:{rootFolder:{in:folders}},select:{id:true,title:true,rootFolder:true}})); }
  catch { res.status(500).json({error:'Archive inventory unavailable'}); }
});
router.post('/:id/archive', async (req,res) => {
  try {
    if(Object.keys(req.body??{}).join(',')!=='archived'||typeof req.body.archived!=='boolean')throw new Error('Explicit archive or restore decision required');
    const row=await prisma.series.findUnique({where:{id:req.params.id}});if(!row)throw new Error('Series not found');
    const prior=await libraryControl(row.rootFolder);if(prior.deleted)throw new Error('Series is being deleted');
    await saveLibraryControls([{folder:row.rootFolder,archived:{at:Math.max(Date.now(),(prior.archived?.at??0)+1),deviceId:await libraryDeviceId(),done:req.body.archived}}]);
    scheduleLibraryPublish();notifySeriesProcessChanged();res.json({archived:req.body.archived,retained:true});
  } catch(error) { res.status(409).json({error:error instanceof Error?error.message:'Archive unavailable'}); }
});

// Get all series
router.get('/', async (req: Request, res: Response) => {
  try {
    await reconcileQuietly();
    const deleted = await hiddenLibraryFolders();
    const series = await prisma.series.findMany({
      where: { rootFolder: { notIn: deleted } },
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
    
    res.json(await withSeriesActivity(result));
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

// Infer URL pattern from seed URLs
router.post('/infer-pattern', async (req: Request, res: Response) => {
  try {
    const { seedUrls } = req.body;
    
    if (!Array.isArray(seedUrls) || seedUrls.length < 2) {
      return res.status(400).json({ error: 'At least 2 seed URLs required' });
    }
    
    const result = inferPattern(seedUrls.filter(Boolean));

    // Title lookup drives a real browser, so it can fail for reasons that have
    // nothing to do with the URLs (missing Playwright binary, site protection,
    // no network). Pattern inference is pure string work and must still be
    // returned when that happens — the title is only a convenience.
    let suggestedTitle: string | null = null;
    if (seedUrls[0]) {
      try {
        suggestedTitle = await getPageTitle(seedUrls[0]);
      } catch (titleError) {
        console.warn('Could not fetch page title for suggestion:', titleError);
      }
    }

    const sourceSite = extractSiteDomain(seedUrls[0] || '');
    
    res.json({
      ...result,
      suggestedTitle,
      sourceSite
    });
  } catch (error) {
    console.error('Error inferring pattern:', error);
    // Pass the real reason through; the client toast shows this verbatim and
    // "Failed to infer pattern" alone leaves no way to tell what went wrong.
    const detail = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: `Failed to infer pattern: ${detail}` });
  }
});

// Quick validate pattern (doesn't scan all chapters)
router.post('/validate-pattern', async (req: Request, res: Response) => {
  try {
    const { template, startNumber, padding } = req.body;
    const io: Server = req.app.get('io');
    
    if (!template || !template.includes('{n}')) {
      return res.status(400).json({ error: 'Invalid URL template - must contain {n}' });
    }
    
    const { quickValidatePattern } = await import('../services/discovery.js');
    
    const result = await quickValidatePattern(
      template,
      startNumber || 1,
      padding || 0,
      (progress) => {
        io.emit('discovery:progress', progress);
      }
    );
    
    res.json(result);
  } catch (error) {
    console.error('Error validating pattern:', error);
    res.status(500).json({ error: 'Failed to validate pattern' });
  }
});

// Discover chapters within a specific range
router.post('/discover-chapters', async (req: Request, res: Response) => {
  try {
    const { template, fromChapter, toChapter, padding, manualUrls } = req.body;
    const io: Server = req.app.get('io');
    
    let chapters;
    
    if (manualUrls && Array.isArray(manualUrls) && manualUrls.length > 0) {
      // Manual URL mode
      chapters = await validateManualChapters(manualUrls, (progress) => {
        io.emit('discovery:progress', progress);
      });
    } else {
      // Pattern-based discovery with range
      if (!template || !template.includes('{n}')) {
        return res.status(400).json({ error: 'Invalid URL template - must contain {n}' });
      }
      
      const from = fromChapter || 1;
      const to = toChapter || from + 19; // Default to 20 chapters
      
      if (to < from) {
        return res.status(400).json({ error: 'toChapter must be >= fromChapter' });
      }
      
      if (to - from > 200) {
        return res.status(400).json({ error: 'Maximum 200 chapters per request. Add chapters in batches.' });
      }
      
      const { discoverChaptersInRange } = await import('../services/discovery.js');
      
      chapters = await discoverChaptersInRange(
        template,
        from,
        to,
        padding || 0,
        (progress) => {
          io.emit('discovery:progress', progress);
        }
      );
    }
    
    res.json({ chapters });
  } catch (error) {
    console.error('Error discovering chapters:', error);
    res.status(500).json({ error: 'Failed to discover chapters' });
  }
});

// Create a new series with chapters
router.post('/', async (req: Request, res: Response) => {
  try {
    const { title, sourceSite, urlTemplate, chapters, coverPath } = req.body;
    
    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }
    
    if (!chapters || !Array.isArray(chapters) || chapters.length === 0) {
      return res.status(400).json({ error: 'At least one chapter is required' });
    }
    
    const rootFolder = await newSeriesFolder(title,
      async folder => !!(await libraryControl(folder)).deleted,
      async folder => {
        const control = await libraryControl(folder);
        if (control.deleted || control.archived || control.parts) return true;
        if (await prisma.series.findFirst({ where: { rootFolder: folder } })) return true;
        try {
          await fs.stat(path.resolve(process.env.DOWNLOAD_ROOT || './downloads', folder));
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw error;
        }
      });
    
    // Create series
    const series = await prisma.series.create({
      data: {
        title,
        sourceSite: sourceSite || 'unknown',
        urlTemplate,
        rootFolder,
        coverPath,
        chapters: {
          create: chapters.map((ch: { number: number; url: string; title?: string }) => ({
            number: ch.number,
            sourceUrl: ch.url,
            title: ch.title,
            folderPath: `${rootFolder}/Chapter ${zeroPad(ch.number)}`,
            status: 'pending'
          }))
        }
      },
      include: {
        chapters: {
          orderBy: { number: 'asc' }
        }
      }
    });
    
    await ownLibrarySeries(series.id);
    await downloadManager.queueChapters(series.chapters.map(c => c.id));
    res.status(201).json(series);
  } catch (error) {
    console.error('Error creating series:', error);
    res.status(500).json({ error: 'Failed to create series' });
  }
});

// Update series
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const { title, urlTemplate, coverPath } = req.body;
    
    const updateData: any = {};
    if (title) {
      updateData.title = title;
      updateData.rootFolder = sanitizeTitle(title);
    }
    if (urlTemplate !== undefined) {
      updateData.urlTemplate = urlTemplate;
    }
    if (coverPath !== undefined) {
      updateData.coverPath = coverPath;
    }
    
    const series = await prisma.series.update({
      where: { id: req.params.id },
      data: updateData
    });
    
    res.json(series);
  } catch (error) {
    console.error('Error updating series:', error);
    res.status(500).json({ error: 'Failed to update series' });
  }
});

// Delete series
router.post('/:id/delete-everywhere', async (req: Request, res: Response) => {
  try {
    const series = await prisma.series.findUnique({ where: { id: req.params.id } });
    if (!series) return res.status(404).json({ error: 'Series not found' });
    await saveLibraryControls([{ folder: path.basename(series.rootFolder), deleted: { at: Date.now(), deviceId: await libraryDeviceId(), done: true } }]);
    scheduleLibraryPublish(); scheduleLibraryCleanup(); notifySeriesProcessChanged(true);
    req.app.get('io')?.emit('library:updated');
    res.status(202).json({ deleting: true });
  } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : 'Could not delete series' }); }
});

router.put('/:id/parts/:part/completion', async (req: Request, res: Response) => {
  try {
    const part = Number(req.params.part);
    if (!Number.isInteger(part) || part < 1 || part > 99999 || typeof req.body.done !== 'boolean') return res.status(400).json({ error: 'Choose a valid part and completion state' });
    const series = await prisma.series.findUnique({ where: { id: req.params.id } });
    if (!series) return res.status(404).json({ error: 'Series not found' });
    const folder = path.basename(series.rootFolder);
    const prior = await libraryControl(folder);
    if (prior.deleted) return res.status(409).json({ error: 'This series is being deleted' });
    await saveLibraryControls([{ folder, parts: { [part]: { at: Math.max(Date.now(), (prior.parts?.[part]?.at ?? 0) + 1), deviceId: await libraryDeviceId(), done: req.body.done } } }]);
    scheduleLibraryPublish(); notifySeriesProcessChanged();
    res.json({ done: req.body.done });
  } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : 'Could not update part completion' }); }
});

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    await prisma.series.delete({
      where: { id: req.params.id }
    });
    
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting series:', error);
    res.status(500).json({ error: 'Failed to delete series' });
  }
});

// Add more chapters to existing series
router.post('/:id/chapters', async (req: Request, res: Response) => {
  try {
    const { chapters } = req.body;
    const seriesId = req.params.id;
    
    const series = await prisma.series.findUnique({
      where: { id: seriesId }
    });
    
    if (!series) {
      return res.status(404).json({ error: 'Series not found' });
    }
    
    const createdChapters = await Promise.all(
      chapters.map(async (ch: { number: number; url: string; title?: string }) => {
        return prisma.chapter.upsert({
          where: {
            seriesId_number: {
              seriesId,
              number: ch.number
            }
          },
          create: {
            seriesId,
            number: ch.number,
            sourceUrl: ch.url,
            title: ch.title,
            folderPath: `${series.rootFolder}/Chapter ${zeroPad(ch.number)}`,
            status: 'pending'
          },
          update: {
            sourceUrl: ch.url,
            title: ch.title
          }
        });
      })
    );
    
    scheduleLibraryPublish();
    await downloadManager.queueChapters(createdChapters.filter(c => c.status !== 'done').map(c => c.id));
    res.status(201).json(createdChapters);
  } catch (error) {
    console.error('Error adding chapters:', error);
    res.status(500).json({ error: 'Failed to add chapters' });
  }
});

export default router;
