/**
 * Client-side live preview for Image Clipper 2.0 Training crops.
 *
 * 100% in-browser: the chapter's page images are already fetched for the main
 * canvas, so a preview is built by compositing the relevant slices onto an
 * offscreen canvas — the same cross-joint seam logic the server's executeCrop
 * uses (server/src/services/clipperService.ts), done here purely to draw a
 * quick preview before the real export runs.
 *
 * Drawing a cross-origin <img> onto a canvas and displaying that canvas is
 * fine without CORS headers; only reading pixels back (getImageData/
 * toDataURL) would be blocked by a tainted canvas, and nothing here does that.
 */

import type { ImageManifest, ManifestImage, TrainingCropRect } from './api'

const imageCache = new Map<string, Promise<HTMLImageElement>>()

function loadImageCached(url: string): Promise<HTMLImageElement> {
  let cached = imageCache.get(url)
  if (!cached) {
    cached = new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error(`Failed to load ${url}`))
      img.src = url
    })
    imageCache.set(url, cached)
  }
  return cached
}

const MAX_PREVIEW_DIM = 480

export async function renderTrainingCropPreview(
  manifest: ImageManifest,
  getImageUrl: (filename: string) => string,
  crop: TrainingCropRect,
  targetCanvas: HTMLCanvasElement
): Promise<void> {
  const { canvasX: minX, canvasY: minY, canvasW: width, canvasH: height } = crop
  const maxY = minY + height

  const scale = Math.min(1, MAX_PREVIEW_DIM / Math.max(width, height, 1))
  targetCanvas.width = Math.max(1, Math.round(width * scale))
  targetCanvas.height = Math.max(1, Math.round(height * scale))
  const ctx = targetCanvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height)

  const intersecting = manifest.images.filter(
    (img: ManifestImage) => img.canvasY < maxY && img.canvasY + img.canvasHeight > minY
  )

  await Promise.all(intersecting.map(async img => {
    let el: HTMLImageElement
    try {
      el = await loadImageCached(getImageUrl(img.filename))
    } catch {
      return
    }

    const sliceTop = Math.max(minY, img.canvasY)
    const sliceBottom = Math.min(maxY, img.canvasY + img.canvasHeight)
    if (sliceBottom <= sliceTop) return

    const srcX = minX / img.scale
    const srcY = (sliceTop - img.canvasY) / img.scale
    const srcW = width / img.scale
    const srcH = (sliceBottom - sliceTop) / img.scale

    const destY = (sliceTop - minY) * scale
    const destH = (sliceBottom - sliceTop) * scale

    ctx.drawImage(el, srcX, srcY, srcW, srcH, 0, destY, targetCanvas.width, destH)
  }))
}
