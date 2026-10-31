import { describe, it, expect, vi } from 'vitest'
import { CropReviewSession, type CropReviewPage } from '../../../client/src/lib/cropReviewSession'

function page(filename = 'page_001.png'): CropReviewPage {
  const crops = ['c1', 'c2'].map((id, i) => ({
    id,
    reason: 'panel',
    crop: {
      mode: 'rectangle' as const,
      points: [
        { id: 'P1', x: 0.1, y: i * 0.5 + 0.1 },
        { id: 'P2', x: 0.8, y: i * 0.5 + 0.1 },
        { id: 'P3', x: 0.8, y: i * 0.5 + 0.4 },
        { id: 'P4', x: 0.1, y: i * 0.5 + 0.4 }
      ]
    }
  }))
  return {
    file: { format: 'test', version: '1', coordinateSystem: 'normalized', image: { filename }, crops },
    metadata: JSON.stringify({ crops: crops.map((c, i) => ({
      id: c.id,
      description: `Description for ${c.id}`,
      exportedFilename: `solo_${filename.replace('.png', '')}_0${i + 1}_panel.png`
    })) })
  }
}

function moved(original: CropReviewPage, offset = 0.01) {
  return {
    ...original.file,
    crops: original.file.crops.map(crop => ({
      ...crop,
      crop: { ...crop.crop, points: crop.crop.points.map(p => ({ ...p, x: p.x + offset })) }
    }))
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function setup() {
  const pages = { 'page_001.png': page(), 'page_002.png': page('page_002.png') }
  const store = { putPoints: vi.fn(async () => {}), putMetadata: vi.fn(async () => {}) }
  const session = new CropReviewSession(pages, 'Solo', store, vi.fn())
  return { session, store, pages }
}

async function saved(session: CropReviewSession) {
  await vi.waitFor(() => expect(session.pending).toBe(false))
}

describe('chapter review autosave and Undo', () => {
  it('saves adjustments without rewriting descriptions and ignores selection-only commits', async () => {
    const { session, pages, store } = setup()
    session.commit('page_001.png', pages['page_001.png'].file)
    expect(store.putPoints).not.toHaveBeenCalled()
    expect(session.undoFilename).toBeUndefined()
    const next = moved(pages['page_001.png'])
    session.commit('page_001.png', next)
    await saved(session)
    expect(store.putPoints).toHaveBeenCalledWith('page_001.png', next)
    expect(store.putMetadata).not.toHaveBeenCalled()
  })

  it('undoes across pages in edit order and autosaves the restored pointers', async () => {
    const { session, pages, store } = setup()
    session.commit('page_001.png', moved(pages['page_001.png']))
    session.commit('page_002.png', moved(pages['page_002.png']))
    await saved(session)
    expect(session.undo()).toBe('page_002.png')
    await saved(session)
    expect(session.pages['page_002.png']).toBe(pages['page_002.png'])
    expect(store.putPoints).toHaveBeenLastCalledWith('page_002.png', pages['page_002.png'].file)
    expect(session.undo()).toBe('page_001.png')
    await saved(session)
    expect(session.undoFilename).toBeUndefined()
  })

  it('queues newer edits and Undo while an older save is in flight', async () => {
    const { session, pages, store } = setup()
    const first = deferred()
    store.putPoints.mockImplementationOnce(() => first.promise)
    session.commit('page_001.png', moved(pages['page_001.png']))
    const latest = moved(pages['page_001.png'], 0.03)
    session.commit('page_001.png', latest)
    expect(store.putPoints).toHaveBeenCalledTimes(1)
    expect(session.pages['page_001.png'].file).toBe(latest)
    session.undo()
    session.undo()
    first.resolve()
    await saved(session)
    expect(store.putPoints).toHaveBeenCalledTimes(2)
    expect(store.putPoints).toHaveBeenLastCalledWith('page_001.png', pages['page_001.png'].file)
    expect(session.pages['page_001.png']).toBe(pages['page_001.png'])
  })

  it('persists the newest adjustment after an older response without reverting the draft', async () => {
    const { session, pages, store } = setup()
    const first = deferred()
    store.putPoints.mockImplementationOnce(() => first.promise)
    session.commit('page_001.png', moved(pages['page_001.png']))
    const latest = moved(pages['page_001.png'], 0.03)
    session.commit('page_001.png', latest)
    first.resolve()
    await saved(session)
    expect(store.putPoints).toHaveBeenLastCalledWith('page_001.png', latest)
    expect(session.pages['page_001.png'].file).toBe(latest)
  })

  it('removes and renumbers metadata, then restores the original description on Undo', async () => {
    const { session, pages, store } = setup()
    const original = pages['page_001.png']
    session.commit('page_001.png', { ...original.file, crops: original.file.crops.slice(1) }, 'c1')
    await saved(session)
    const metadata = JSON.parse(session.pages['page_001.png'].metadata)
    expect(metadata.crops).toEqual([{
      id: 'c2', description: 'Description for c2', exportedFilename: 'solo_page_001_01_panel.png'
    }])
    session.undo()
    await saved(session)
    expect(store.putMetadata).toHaveBeenLastCalledWith('page_001.png', original.metadata)
    expect(session.pages['page_001.png']).toBe(original)
  })

  it('retains failed drafts and history so Retry can save without losing edits', async () => {
    const { session, pages, store } = setup()
    store.putPoints.mockRejectedValueOnce(new Error('Offline'))
    const next = moved(pages['page_001.png'])
    session.commit('page_001.png', next)
    await vi.waitFor(() => expect(session.errors.get('page_001.png')).toBe('Offline'))
    expect(session.pending).toBe(true)
    expect(session.pages['page_001.png'].file).toBe(next)
    expect(session.undoFilename).toBe('page_001.png')
    session.retry()
    await saved(session)
    expect(session.errors.size).toBe(0)
    expect(store.putPoints).toHaveBeenLastCalledWith('page_001.png', next)
  })

  it('rewrites original metadata on Undo after an uncertain metadata save', async () => {
    const { session, pages, store } = setup()
    const original = pages['page_001.png']
    store.putMetadata.mockRejectedValueOnce(new Error('Connection lost after write'))
    session.commit('page_001.png', { ...original.file, crops: original.file.crops.slice(1) }, 'c1')
    await vi.waitFor(() => expect(session.errors.size).toBe(1))
    session.undo()
    await saved(session)
    expect(store.putMetadata).toHaveBeenLastCalledWith('page_001.png', original.metadata)
    expect(session.errors.size).toBe(0)
  })

  it('does not remove crops when their descriptions cannot be safely edited', () => {
    const original = { ...page(), metadata: 'unreadable document' }
    const store = { putPoints: vi.fn(), putMetadata: vi.fn() }
    const session = new CropReviewSession({ 'page_001.png': original }, 'Solo', store, vi.fn())
    expect(() => session.commit('page_001.png', {
      ...original.file, crops: original.file.crops.slice(1)
    }, 'c1')).toThrow('metadata could not be read')
    expect(session.pages['page_001.png']).toBe(original)
    expect(store.putPoints).not.toHaveBeenCalled()
  })
})
