import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { manualSlicesDir, readManualSlices, removeManualSlices, sliceManualPages } from '../narrationManualSlices.js'

describe('manual prompt page slices', () => {
  it('cuts tall pages into ≤2,000 px pieces in a temp folder, reuses them, and deletes them', async () => {
    const src = await fs.mkdtemp(path.join(os.tmpdir(), 'manual-slices-src-'))
    const chapterId = `test-${Date.now()}`
    try {
      const tall = path.join(src, '001.png')
      const short = path.join(src, '002.png')
      await sharp({ create: { width: 700, height: 5000, channels: 3, background: '#ffffff' } }).png().toFile(tall)
      await sharp({ create: { width: 700, height: 900, channels: 3, background: '#ffffff' } }).png().toFile(short)
      const pages = [{ file: tall, source: '001.png' }, { file: short, source: '002.png' }]

      const pieces = await sliceManualPages(chapterId, pages)
      expect(pieces.filter(p => p.page === 1).length).toBeGreaterThan(2)
      expect(pieces.filter(p => p.page === 2)).toEqual([{ file: 'P0002-T001.jpg', page: 2, part: 1, parts: 1, source: '002.png' }])
      for (const piece of pieces) {
        const meta = await sharp(path.join(manualSlicesDir(chapterId), piece.file)).metadata()
        expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(2000)
      }
      expect(await readManualSlices(chapterId, ['001.png', '002.png'])).toEqual(pieces)
      expect(await readManualSlices(chapterId, ['001.png'])).toBeNull()

      await removeManualSlices(chapterId)
      await expect(fs.access(manualSlicesDir(chapterId))).rejects.toThrow()
      expect(await readManualSlices(chapterId, ['001.png', '002.png'])).toBeNull()
    } finally {
      await fs.rm(src, { recursive: true, force: true })
      await removeManualSlices(chapterId)
    }
  })

  it('refuses a chapter id that could leave the temp folder', () => {
    expect(() => manualSlicesDir('../x')).toThrow(/Invalid chapter id/)
  })
})
