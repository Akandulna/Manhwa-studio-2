import { describe, expect, it } from 'vitest'
import archiver from 'archiver'
import { PassThrough } from 'stream'
import { readZip } from '../zipReader.js'

async function zipOf(entries: Record<string, Buffer>, store: boolean): Promise<Buffer> {
  const archive = archiver('zip', { store })
  const out = new PassThrough()
  const chunks: Buffer[] = []
  out.on('data', chunk => chunks.push(chunk))
  const done = new Promise(resolve => out.on('end', resolve))
  archive.pipe(out)
  for (const [name, data] of Object.entries(entries)) archive.append(data, { name })
  await archive.finalize()
  await done
  return Buffer.concat(chunks)
}

describe.each([true, false])('ZIP size limits (stored=%s)', store => {
  it('accepts the exact entry/total boundary and rejects either limit being exceeded', async () => {
    const zip = await zipOf({ 'one.wav': Buffer.alloc(80), 'two.wav': Buffer.alloc(80) }, store)
    expect(readZip(zip, { maxEntryBytes: 80, maxTotalBytes: 160 }).map(e => e.data.length)).toEqual([80, 80])
    expect(() => readZip(zip, { maxEntryBytes: 79 })).toThrow(/one.wav is too large/)
    expect(() => readZip(zip, { maxEntryBytes: 80, maxTotalBytes: 159 })).toThrow(/expanded zip is too large/)
  })

  it('keeps the default 32 MiB limit for other importers', async () => {
    const zip = await zipOf({ 'one.wav': Buffer.alloc(80) }, store)
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    zip.writeUInt32LE(32 * 1024 * 1024 + 1, central + 24)
    expect(() => readZip(zip)).toThrow(/one.wav is too large/)
  })

  it('rejects entries whose expanded bytes exceed the declared size', async () => {
    const zip = await zipOf({ 'one.wav': Buffer.alloc(80) }, store)
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    zip.writeUInt32LE(1, central + 24)
    expect(() => readZip(zip, { maxEntryBytes: 1, maxTotalBytes: 1 })).toThrow()
  })
})
