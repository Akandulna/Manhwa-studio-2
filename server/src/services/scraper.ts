/**
 * Scraper Service using Playwright
 * Handles page scraping, image detection, and chapter validation
 */

import { chromium, Browser, Page } from 'playwright';

let browserInstance: Browser | null = null;

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

// Keywords that indicate non-content images (ads, icons, etc.)
const EXCLUDED_KEYWORDS = [
  'avatar', 'icon', 'logo', 'banner', 'ad', 'advertisement', 
  'thumbnail', 'thumb', 'profile', 'button', 'sprite',
  'loading', 'spinner', 'placeholder', 'social', 'share',
  'facebook', 'twitter', 'discord', 'patreon', 'ko-fi'
];

export interface DetectedImage {
  src: string;
  width: number;
  height: number;
  top: number;
  index: number;
}

export interface ChapterValidationResult {
  exists: boolean;
  title?: string;
  pageImages: DetectedImage[];
  error?: string;
}

/**
 * Get or create browser instance
 */
async function getBrowser(): Promise<Browser> {
  if (!browserInstance || !browserInstance.isConnected()) {
    browserInstance = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process'
      ]
    });
  }
  return browserInstance;
}

/**
 * Close the browser instance
 */
export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

/**
 * Scroll page to trigger lazy loading
 */
async function scrollToBottom(page: Page, maxScrolls: number = 50): Promise<void> {
  let previousHeight = 0;
  let scrollAttempts = 0;
  
  while (scrollAttempts < maxScrolls) {
    const currentHeight = await page.evaluate(() => document.body.scrollHeight);
    
    if (currentHeight === previousHeight) {
      // Give lazy-load a chance to trigger
      await page.waitForTimeout(500);
      const newHeight = await page.evaluate(() => document.body.scrollHeight);
      if (newHeight === currentHeight) {
        break;
      }
    }
    
    previousHeight = currentHeight;
    
    // Scroll down in steps
    await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight);
    });
    
    // Wait for potential lazy-load
    await page.waitForTimeout(300);
    scrollAttempts++;
  }
  
  // Scroll back to top and then to bottom for any remaining lazy loads
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(500);
}

/**
 * Check if a URL looks like a content image (not ad/icon/etc)
 */
function isContentImageUrl(url: string): boolean {
  const lowerUrl = url.toLowerCase();
  return !EXCLUDED_KEYWORDS.some(keyword => lowerUrl.includes(keyword));
}

/**
 * Detect manhwa page images on a chapter page
 */
async function detectImages(page: Page): Promise<DetectedImage[]> {
  // Collect all images from various sources
  const images = await page.evaluate(() => {
    const results: Array<{
      src: string;
      width: number;
      height: number;
      top: number;
    }> = [];
    
    // Regular <img> elements
    document.querySelectorAll('img').forEach((img) => {
      const rect = img.getBoundingClientRect();
      const src = img.currentSrc || img.src;
      
      if (src && !src.startsWith('data:')) {
        results.push({
          src,
          width: img.naturalWidth || rect.width,
          height: img.naturalHeight || rect.height,
          top: rect.top + window.scrollY
        });
      }
    });
    
    // <picture> elements with <source>
    document.querySelectorAll('picture source').forEach((source) => {
      const srcset = source.getAttribute('srcset');
      if (srcset) {
        // Get the first URL from srcset
        const firstUrl = srcset.split(',')[0].trim().split(' ')[0];
        if (firstUrl && !firstUrl.startsWith('data:')) {
          const picture = source.closest('picture');
          const img = picture?.querySelector('img');
          const rect = img?.getBoundingClientRect() || { top: 0 };
          
          results.push({
            src: firstUrl,
            width: 0, // Unknown from srcset
            height: 0,
            top: rect.top + window.scrollY
          });
        }
      }
    });
    
    // CSS background images on common containers
    document.querySelectorAll('[style*="background"]').forEach((el) => {
      const style = window.getComputedStyle(el);
      const bgImage = style.backgroundImage;
      
      if (bgImage && bgImage !== 'none') {
        const match = bgImage.match(/url\(["']?([^"')]+)["']?\)/);
        if (match && match[1] && !match[1].startsWith('data:')) {
          const rect = el.getBoundingClientRect();
          results.push({
            src: match[1],
            width: rect.width,
            height: rect.height,
            top: rect.top + window.scrollY
          });
        }
      }
    });
    
    return results;
  });
  
  // Filter and sort images
  const filtered = images
    .filter(img => {
      // Must have a valid URL
      if (!img.src || !isContentImageUrl(img.src)) return false;
      
      // Size-based filtering for known dimensions
      if (img.width > 0 && img.height > 0) {
        // Minimum width of 400px for manhwa panels
        if (img.width < 400) return false;
        
        // Aspect ratio check: height/width >= 0.8 (tall images)
        // or width >= 600 (wide enough to be a page)
        const aspectRatio = img.height / img.width;
        if (aspectRatio < 0.8 && img.width < 600) return false;
      }
      
      return true;
    })
    .sort((a, b) => a.top - b.top) // Sort by vertical position
    .map((img, index) => ({ ...img, index }));
  
  // De-duplicate by URL
  const seen = new Set<string>();
  const unique: DetectedImage[] = [];
  
  for (const img of filtered) {
    if (!seen.has(img.src)) {
      seen.add(img.src);
      unique.push({ ...img, index: unique.length });
    }
  }
  
  return unique;
}

/**
 * Validate if a chapter URL exists and contains page images
 */
export async function validateChapter(
  url: string, 
  userAgent: string = DEFAULT_USER_AGENT
): Promise<ChapterValidationResult> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent,
    viewport: { width: 1280, height: 720 },
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    }
  });
  
  const page = await context.newPage();
  
  try {
    // Navigate to the page
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    
    if (!response) {
      return { exists: false, pageImages: [], error: 'No response from server' };
    }
    
    const status = response.status();
    
    if (status === 404 || status === 410) {
      return { exists: false, pageImages: [], error: `HTTP ${status}` };
    }
    
    // For 403, check if it's a Cloudflare challenge - wait and see if it resolves
    if (status === 403) {
      const title = await page.title();
      // Cloudflare challenge pages have specific titles
      if (title.includes('Just a moment') || title.includes('Cloudflare')) {
        // Wait for challenge to potentially resolve
        await page.waitForTimeout(5000);
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        
        // Check title again
        const newTitle = await page.title();
        if (newTitle.includes('Just a moment') || newTitle.includes('Cloudflare')) {
          return { exists: false, pageImages: [], error: 'Cloudflare challenge - try again or use a different source' };
        }
        // Challenge passed, continue with image detection
      } else {
        // Not a Cloudflare page but still 403 - might still have content
        // Continue to check for images anyway
      }
    }
    
    if (status >= 500) {
      return { exists: false, pageImages: [], error: `Server error (HTTP ${status})` };
    }
    
    // Wait for network to be mostly idle
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    
    // Scroll to trigger lazy loading
    await scrollToBottom(page);
    
    // Wait a bit more for images to load
    await page.waitForTimeout(1000);
    
    // Detect images
    const pageImages = await detectImages(page);
    
    // Get page title
    const title = await page.title();
    
    // A valid chapter should have at least 1 page image
    const exists = pageImages.length >= 1;
    
    return {
      exists,
      title,
      pageImages,
      error: exists ? undefined : 'No manga page images detected'
    };
    
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    
    if (message.includes('net::ERR_NAME_NOT_RESOLVED')) {
      return { exists: false, pageImages: [], error: 'Domain not found' };
    }
    
    if (message.includes('Timeout')) {
      return { exists: false, pageImages: [], error: 'Page load timeout' };
    }
    
    return { exists: false, pageImages: [], error: message };
    
  } finally {
    await context.close();
  }
}

/**
 * Get all images from a chapter page for downloading
 */
export async function getChapterImages(
  url: string,
  userAgent: string = DEFAULT_USER_AGENT
): Promise<{ images: DetectedImage[]; error?: string }> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent,
    viewport: { width: 1280, height: 720 }
  });
  
  const page = await context.newPage();
  
  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await scrollToBottom(page);
    await page.waitForTimeout(1000);
    
    const images = await detectImages(page);
    
    return { images };
    
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { images: [], error: message };
    
  } finally {
    await context.close();
  }
}

/**
 * Extract site domain from URL
 */
export function extractSiteDomain(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return 'unknown';
  }
}

/**
 * Extract page title from URL
 */
export async function getPageTitle(url: string): Promise<string | null> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: DEFAULT_USER_AGENT
  });
  
  const page = await context.newPage();
  
  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    });
    
    const title = await page.title();
    
    // Try to extract series name from title
    // Common patterns: "Series Name - Chapter X", "Chapter X | Series Name"
    const cleanTitle = title
      .replace(/chapter\s*\d+/i, '')
      .replace(/[-|:–—]\s*$/g, '')
      .replace(/^\s*[-|:–—]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    
    return cleanTitle || title;
    
  } catch {
    return null;
  } finally {
    await context.close();
  }
}
