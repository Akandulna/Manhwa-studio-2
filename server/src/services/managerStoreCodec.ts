import { gzip, gunzip } from 'node:zlib'
import { promisify } from 'node:util'
import type { ManagerState } from './managerStore.js'
const compress = promisify(gzip), decompress = promisify(gunzip)
/** Existing plain JSON journals remain readable; compression bounds SQLite write amplification. */
export async function encodeManagerState(state: ManagerState): Promise<string> {
  return JSON.stringify({ encoding:'gzip',version:1,body:(await compress(JSON.stringify(state))).toString('base64') })
}
export async function decodeManagerState(value: string): Promise<ManagerState> {
  const envelope = JSON.parse(value)
  if (envelope.encoding === undefined) return envelope as ManagerState
  if (envelope.encoding !== 'gzip' || envelope.version !== 1 || typeof envelope.body !== 'string') throw new Error('Unsupported manager journal encoding')
  return JSON.parse((await decompress(Buffer.from(envelope.body,'base64'))).toString('utf8')) as ManagerState
}
