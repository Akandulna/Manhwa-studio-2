/**
 * Image Preprocessing Service for Narration Studio
 * 
 * Handles loading, resizing, and preparing chapter images for AI processing.
 * - Downscales images to max width while preserving aspect ratio
 * - Splits very tall images into overlapping slices
 * - Re-encodes to webp/jpeg for efficient transfer
 */

import sharp from 'sharp'
import fs from 'fs/promises'
import path from 'path'
import { ImageInput } from './ai/types.js'

export interface ImageProcessingConfig {
  maxWidth: number           // Max width in pixels (default 1080)
  maxHeight: number          // Max height before slicing (default 4096)
  sliceOverlap: number       // Overlap pixels when slicing tall images (default 100)
  outputFormat: 'webp' | 'jpeg'
  quality: number            // Compression quality (1-100)
}

export interface ProcessedImage {
  originalPath: string
  originalIndex: number
  sliceIndex?: number        // If this is a slice of a tall image
  data: Buffer
  mimeType: 'image/webp' | 'image/jpeg'
  width: number
  height: number
}

export interface ChapterImageResult {
  images: ProcessedImage[]
  totalOriginalImages: number
  totalProcessedImages: number
  wasSliced: boolean
}

const DEFAULT_CONFIG: ImageProcessingConfig = {
  maxWidth: 1080,
  maxHeight: 4096,
  sliceOverlap: 100,
  outputFormat: 'webp',
  quality: 80
}

/**
 * Load and preprocess all images from a chapter folder
 */
export async function preprocessChapterImages(
  folderPath: string,
  config: Partial<ImageProcessingConfig> = {},
  onProgress?: (current: number, total: number) => void
): Promise<ChapterImageResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  
  // Find all image files in reading order
  const files = await getImageFiles(folderPath)
  
  if (files.length === 0) {
    throw new Error(`No images found in ${folderPath}`)
  }
  
  const processedImages: ProcessedImage[] = []
  let wasSliced = false
  
  for (let i = 0; i < files.length; i++) {
    const filePath = files[i]
    
    try {
      const images = await processImage(filePath, i, cfg)
      processedImages.push(...images)
      
      if (images.length > 1) {
        wasSliced = true
      }
    } catch (error) {
      console.error(`Error processing image ${filePath}:`, error)
      throw new Error(`Failed to process image ${path.basename(filePath)}: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
    
    onProgress?.(i + 1, files.length)
  }
  
  return {
    images: processedImages,
    totalOriginalImages: files.length,
    totalProcessedImages: processedImages.length,
    wasSliced
  }
}

/**
 * Get sorted list of image files from a folder
 */
async function getImageFiles(folderPath: string): Promise<string[]> {
  const entries = await fs.readdir(folderPath, { withFileTypes: true })
  
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif']
  
  const imageFiles = entries
    .filter(entry => {
      if (!entry.isFile()) return false
      const ext = path.extname(entry.name).toLowerCase()
      return imageExtensions.includes(ext)
    })
    .map(entry => ({
      name: entry.name,
      path: path.join(folderPath, entry.name)
    }))
    // Sort by filename (should be zero-padded like page_001.webp)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map(f => f.path)
  
  return imageFiles
}

/**
 * Process a single image - resize and optionally slice
 */
async function processImage(
  filePath: string,
  originalIndex: number,
  config: ImageProcessingConfig
): Promise<ProcessedImage[]> {
  const image = sharp(filePath)
  const metadata = await image.metadata()
  
  if (!metadata.width || !metadata.height) {
    throw new Error('Could not read image dimensions')
  }
  
  // Calculate resize dimensions
  let targetWidth = metadata.width
  let targetHeight = metadata.height
  
  if (targetWidth > config.maxWidth) {
    const ratio = config.maxWidth / targetWidth
    targetWidth = config.maxWidth
    targetHeight = Math.round(targetHeight * ratio)
  }
  
  // Check if we need to slice
  if (targetHeight > config.maxHeight) {
    return await sliceTallImage(filePath, originalIndex, targetWidth, targetHeight, config)
  }
  
  // Single image output
  const processed = await resizeAndEncode(filePath, targetWidth, targetHeight, config)
  
  return [{
    originalPath: filePath,
    originalIndex,
    data: processed.data,
    mimeType: processed.mimeType,
    width: processed.width,
    height: processed.height
  }]
}

/**
 * Slice a tall image into overlapping pieces
 */
async function sliceTallImage(
  filePath: string,
  originalIndex: number,
  targetWidth: number,
  targetHeight: number,
  config: ImageProcessingConfig
): Promise<ProcessedImage[]> {
  const sliceHeight = config.maxHeight
  const overlap = config.sliceOverlap
  const effectiveSliceHeight = sliceHeight - overlap
  
  const numSlices = Math.ceil((targetHeight - overlap) / effectiveSliceHeight)
  const results: ProcessedImage[] = []
  
  for (let i = 0; i < numSlices; i++) {
    const top = i * effectiveSliceHeight
    let height = sliceHeight
    
    // Adjust last slice
    if (top + height > targetHeight) {
      height = targetHeight - top
    }
    
    const sliced = await sharp(filePath)
      .resize(targetWidth, targetHeight, { fit: 'inside' })
      .extract({ left: 0, top, width: targetWidth, height })
      .toBuffer({ resolveWithObject: true })
    
    const encoded = config.outputFormat === 'webp'
      ? await sharp(sliced.data).webp({ quality: config.quality }).toBuffer()
      : await sharp(sliced.data).jpeg({ quality: config.quality }).toBuffer()
    
    results.push({
      originalPath: filePath,
      originalIndex,
      sliceIndex: i,
      data: encoded,
      mimeType: config.outputFormat === 'webp' ? 'image/webp' : 'image/jpeg',
      width: targetWidth,
      height
    })
  }
  
  return results
}

/**
 * Resize and encode a single image
 */
async function resizeAndEncode(
  filePath: string,
  width: number,
  height: number,
  config: ImageProcessingConfig
): Promise<{ data: Buffer; mimeType: 'image/webp' | 'image/jpeg'; width: number; height: number }> {
  let pipeline = sharp(filePath)
  
  // Get original metadata to check if resize is needed
  const metadata = await pipeline.metadata()
  
  if (metadata.width !== width || metadata.height !== height) {
    pipeline = pipeline.resize(width, height, { fit: 'inside' })
  }
  
  // Encode
  const data = config.outputFormat === 'webp'
    ? await pipeline.webp({ quality: config.quality }).toBuffer()
    : await pipeline.jpeg({ quality: config.quality }).toBuffer()
  
  // Get final dimensions
  const finalMeta = await sharp(data).metadata()
  
  return {
    data,
    mimeType: config.outputFormat === 'webp' ? 'image/webp' : 'image/jpeg',
    width: finalMeta.width || width,
    height: finalMeta.height || height
  }
}

/**
 * Convert processed images to AI provider input format
 */
export function toImageInputs(images: ProcessedImage[]): ImageInput[] {
  return images.map(img => ({
    data: img.data,
    mimeType: img.mimeType
  }))
}

/**
 * Batch images for map-reduce processing
 */
export function batchImages(
  images: ProcessedImage[],
  batchSize: number
): ProcessedImage[][] {
  const batches: ProcessedImage[][] = []
  
  for (let i = 0; i < images.length; i += batchSize) {
    batches.push(images.slice(i, i + batchSize))
  }
  
  return batches
}

/**
 * Check if a chapter has usable images
 */
export async function validateChapterImages(folderPath: string): Promise<{
  valid: boolean
  imageCount: number
  error?: string
}> {
  try {
    const files = await getImageFiles(folderPath)
    
    if (files.length === 0) {
      return { valid: false, imageCount: 0, error: 'No images found in chapter folder' }
    }
    
    // Quick check that first image is readable
    try {
      const metadata = await sharp(files[0]).metadata()
      if (!metadata.width || !metadata.height) {
        return { valid: false, imageCount: files.length, error: 'First image has invalid dimensions' }
      }
    } catch {
      return { valid: false, imageCount: files.length, error: 'Could not read first image' }
    }
    
    return { valid: true, imageCount: files.length }
  } catch (error) {
    return { 
      valid: false, 
      imageCount: 0, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    }
  }
}
