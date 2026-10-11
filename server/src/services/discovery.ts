/**
 * Chapter Discovery Service
 * Validates chapters within a specified range
 */

import { generateUrl } from '../utils/urlPattern.js';
import { validateChapter, ChapterValidationResult } from './scraper.js';

export interface DiscoveredChapter {
  number: number;
  url: string;
  title?: string;
  pageCount: number;
  exists: boolean;
}

export interface DiscoveryProgress {
  currentNumber: number;
  discovered: number;
  total: number;
  status: 'checking' | 'found' | 'miss' | 'stopped';
}

export interface QuickValidationResult {
  isValid: boolean;
  firstChapter?: number;
  lastValidated?: number;
  message?: string;
}

export type ProgressCallback = (progress: DiscoveryProgress) => void;

/**
 * Quick validation - just check a few sample chapters to confirm the pattern works
 * Returns estimated range without scanning everything
 */
export async function quickValidatePattern(
  template: string,
  startNumber: number,
  padding: number,
  onProgress?: ProgressCallback
): Promise<QuickValidationResult> {
  // Check the first 3 chapters to validate pattern
  const samplesToCheck = [startNumber, startNumber + 1, startNumber + 2];
  let validCount = 0;
  let firstValid: number | undefined;
  
  for (const num of samplesToCheck) {
    const url = generateUrl(template, num, padding);
    
    onProgress?.({
      currentNumber: num,
      discovered: validCount,
      total: samplesToCheck.length,
      status: 'checking'
    });
    
    const result = await validateChapter(url);
    
    if (result.exists) {
      validCount++;
      if (firstValid === undefined) firstValid = num;
      
      onProgress?.({
        currentNumber: num,
        discovered: validCount,
        total: samplesToCheck.length,
        status: 'found'
      });
    } else {
      onProgress?.({
        currentNumber: num,
        discovered: validCount,
        total: samplesToCheck.length,
        status: 'miss'
      });
    }
  }
  
  onProgress?.({
    currentNumber: -1,
    discovered: validCount,
    total: samplesToCheck.length,
    status: 'stopped'
  });
  
  if (validCount >= 2) {
    return {
      isValid: true,
      firstChapter: firstValid,
      lastValidated: samplesToCheck[samplesToCheck.length - 1],
      message: `Pattern validated! Found ${validCount} chapters. Enter the chapter range you want to add.`
    };
  }
  
  return {
    isValid: false,
    message: `Pattern validation failed. Only ${validCount} of ${samplesToCheck.length} test chapters found.`
  };
}

/**
 * Discover chapters within a specific range
 * This is much faster than scanning everything
 */
export async function discoverChaptersInRange(
  template: string,
  fromChapter: number,
  toChapter: number,
  padding: number,
  onProgress?: ProgressCallback
): Promise<DiscoveredChapter[]> {
  const discovered: DiscoveredChapter[] = [];
  const total = toChapter - fromChapter + 1;
  
  for (let num = fromChapter; num <= toChapter; num++) {
    const url = generateUrl(template, num, padding);
    
    onProgress?.({
      currentNumber: num,
      discovered: discovered.length,
      total,
      status: 'checking'
    });
    
    const result = await validateChapter(url);
    
    if (result.exists) {
      discovered.push({
        number: num,
        url,
        title: result.title,
        pageCount: result.pageImages.length,
        exists: true
      });
      
      onProgress?.({
        currentNumber: num,
        discovered: discovered.length,
        total,
        status: 'found'
      });
    } else {
      onProgress?.({
        currentNumber: num,
        discovered: discovered.length,
        total,
        status: 'miss'
      });
    }
  }
  
  onProgress?.({
    currentNumber: -1,
    discovered: discovered.length,
    total,
    status: 'stopped'
  });
  
  return discovered;
}

/**
 * Legacy function - now just calls discoverChaptersInRange with a small default range
 */
export async function discoverChapters(
  template: string,
  startNumber: number,
  padding: number,
  onProgress?: ProgressCallback,
  _maxMisses: number = 2
): Promise<DiscoveredChapter[]> {
  // Default to discovering first 20 chapters if no range specified
  return discoverChaptersInRange(template, startNumber, startNumber + 19, padding, onProgress);
}

/**
 * Validate a list of manually provided chapter URLs
 */
export async function validateManualChapters(
  urls: string[],
  onProgress?: ProgressCallback
): Promise<DiscoveredChapter[]> {
  const discovered: DiscoveredChapter[] = [];
  const total = urls.filter(u => u.trim()).length;
  
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i].trim();
    if (!url) continue;
    
    onProgress?.({
      currentNumber: i + 1,
      discovered: discovered.length,
      total,
      status: 'checking'
    });
    
    const result = await validateChapter(url);
    
    if (result.exists) {
      discovered.push({
        number: i + 1,
        url,
        title: result.title,
        pageCount: result.pageImages.length,
        exists: true
      });
      
      onProgress?.({
        currentNumber: i + 1,
        discovered: discovered.length,
        total,
        status: 'found'
      });
    } else {
      onProgress?.({
        currentNumber: i + 1,
        discovered: discovered.length,
        total,
        status: 'miss'
      });
    }
  }
  
  onProgress?.({
    currentNumber: -1,
    discovered: discovered.length,
    total,
    status: 'stopped'
  });
  
  return discovered;
}
