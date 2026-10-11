/**
 * Settings API Routes
 */

import { Router, Request, Response } from 'express';
import { execFile } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { prisma } from '../index.js';

const router = Router();

// Default settings
const DEFAULT_SETTINGS: Record<string, string> = {
  downloadRoot: './downloads'
};

// Get all settings
router.get('/', async (req: Request, res: Response) => {
  try {
    const dbSettings = await prisma.setting.findMany();
    
    // Merge with defaults
    const settings: Record<string, string> = { ...DEFAULT_SETTINGS };
    dbSettings.forEach(s => {
      settings[s.key] = s.value;
    });
    
    // Override with env vars if present
    if (process.env.DOWNLOAD_ROOT) settings.downloadRoot = process.env.DOWNLOAD_ROOT;
    
    res.json(settings);
  } catch (error) {
    console.error('Error fetching settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// Update a setting
router.put('/:key', async (req: Request, res: Response) => {
  try {
    const { value } = req.body;
    const { key } = req.params;
    
    if (value === undefined) {
      return res.status(400).json({ error: 'Value required' });
    }
    
    const setting = await prisma.setting.upsert({
      where: { key },
      create: { key, value: String(value) },
      update: { value: String(value) }
    });
    
    res.json(setting);
  } catch (error) {
    console.error('Error updating setting:', error);
    res.status(500).json({ error: 'Failed to update setting' });
  }
});

// Update multiple settings
router.put('/', async (req: Request, res: Response) => {
  try {
    const settings = req.body;
    
    if (typeof settings !== 'object') {
      return res.status(400).json({ error: 'Settings object required' });
    }
    
    const updates = await Promise.all(
      Object.entries(settings).map(([key, value]) =>
        prisma.setting.upsert({
          where: { key },
          create: { key, value: String(value) },
          update: { value: String(value) }
        })
      )
    );
    
    res.json(updates);
  } catch (error) {
    console.error('Error updating settings:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// Reset to defaults
router.post('/reset', async (req: Request, res: Response) => {
  try {
    await prisma.setting.deleteMany();
    res.json(DEFAULT_SETTINGS);
  } catch (error) {
    console.error('Error resetting settings:', error);
    res.status(500).json({ error: 'Failed to reset settings' });
  }
});

// Open a folder under the library root in Finder (or the platform's file manager)
router.post('/open-folder', (req: Request, res: Response) => {
  const { path: folderPath } = req.body;
  const fullPath = path.resolve(process.env.DOWNLOAD_ROOT || './downloads', folderPath);
  const platform = os.platform();
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'explorer' : 'xdg-open';
  execFile(command, [fullPath], (error) => {
    if (error) {
      console.error('Error opening folder:', error);
      return res.status(500).json({ error: 'Failed to open folder' });
    }
    res.json({ message: 'Folder opened' });
  });
});

export default router;
