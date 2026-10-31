import { describe, expect, it, vi } from 'vitest'
import { newSeriesFolder } from '../src/services/newSeriesFolder.js'
import { isSeriesObject } from '../src/services/libraryControlModel.js'

describe('new series folder after synced deletion', () => {
  it('keeps the normal sanitized folder when it has not been deleted', async () => {
    const reserved = vi.fn()
    expect(await newSeriesFolder('  New: Series  ', async () => false, reserved)).toBe('New Series')
    expect(reserved).not.toHaveBeenCalled()
  })
  it('preserves the tombstone and puts all new files outside its cleanup scope', async () => {
    const deleted = new Set(['Sandmancer of the Scorched Desert'])
    const folder = await newSeriesFolder([...deleted][0], async f => deleted.has(f), async f => deleted.has(f), () => 'new-copy')
    expect(folder).toBe('Sandmancer of the Scorched Desert (new-copy)')
    expect([...deleted]).toEqual(['Sandmancer of the Scorched Desert'])
    for (const kind of ['manhwa', 'scripts', 'crops', 'voiceover', 'editor']) {
      expect(isSeriesObject(`${kind}/${folder}/Chapter 001/page.png`, [...deleted][0])).toBe(false)
    }
    expect(isSeriesObject(`manhwa/${folder}.zip`, [...deleted][0])).toBe(false)
  })
  it('skips identities already occupied by files, rows or sync controls', async () => {
    const ids = ['occupied', 'fresh']
    expect(await newSeriesFolder('Series', async () => true, async f => f.endsWith('(occupied)'), () => ids.shift()!)).toBe('Series (fresh)')
  })
  it('does not fall back to a deleted folder if allocation fails', async () => {
    await expect(newSeriesFolder('Series', async () => true, async () => true, () => 'taken')).rejects.toThrow('fresh series folder')
  })
  it('rejects empty and unsafe titles before a row can be inserted', async () => {
    for (const title of [' ', '/*?', '.', '..']) {
      await expect(newSeriesFolder(title, async () => false, async () => false)).rejects.toThrow('valid title')
    }
  })
})
