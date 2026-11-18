import { createHash } from 'crypto'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearFileHashCache, fileSha256 } from '../fileHashCache.js'

const reads = vi.hoisted(() => ({ count: 0 }))
vi.mock('fs', async importOriginal => {
  const real = await importOriginal<typeof import('fs')>()
  return { ...real, createReadStream: ((...args: Parameters<typeof real.createReadStream>) => { reads.count++; return real.createReadStream(...args) }) as typeof real.createReadStream }
})

const hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')

describe('fileSha256', () => {
  let dir: string
  beforeEach(async () => {
    clearFileHashCache()
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-hash-'))
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('hashes a multi-chunk file exactly', async () => {
    const bytes = Buffer.alloc(3 * (1 << 20) + 17, 7)
    const file = path.join(dir, 'big.bin')
    await fs.writeFile(file, bytes)
    expect(await fileSha256(file)).toEqual({ sha256: hex(bytes), bytes: bytes.length })
  })

  it('reuses the hash while the file is unchanged', async () => {
    const file = path.join(dir, 'a.png')
    await fs.writeFile(file, 'first')
    const first = await fileSha256(file)
    const before = reads.count
    expect(before).toBeGreaterThan(0)
    expect(await fileSha256(file)).toEqual(first)
    expect(reads.count).toBe(before)
  })

  it('re-hashes after a same-size rewrite', async () => {
    const file = path.join(dir, 'a.png')
    await fs.writeFile(file, 'aaaa')
    expect((await fileSha256(file)).sha256).toBe(hex('aaaa'))
    await fs.writeFile(file, 'bbbb')
    expect((await fileSha256(file)).sha256).toBe(hex('bbbb'))
  })

  it('re-hashes a file replaced by rename', async () => {
    const file = path.join(dir, 'a.png'), tmp = path.join(dir, 'a.tmp')
    await fs.writeFile(file, 'old!')
    await fileSha256(file)
    await fs.writeFile(tmp, 'new!')
    await fs.rename(tmp, file)
    expect((await fileSha256(file)).sha256).toBe(hex('new!'))
  })

  it('throws for a missing file', async () => {
    await expect(fileSha256(path.join(dir, 'gone.png'))).rejects.toThrow()
  })
})
