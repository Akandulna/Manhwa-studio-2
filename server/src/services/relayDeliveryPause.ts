import type {PrismaClient} from '@prisma/client'
import { createHash } from 'node:crypto'
const sharedPauses=new WeakMap<PrismaClient,Map<string,RelayDeliveryPause>>()
/** Reporting and managed calls share one durable pause and write queue. */
export function relayPauseForDatabase(db:PrismaClient, socketRole?:'desktop'):RelayDeliveryPause {
  const identity=(process.env.RELAY_URL??'').trim().replace(/\/+$/,'')
  const scope=createHash('sha256').update(identity+(socketRole?'|socket:'+socketRole:'')).digest('hex')
  let pauses=sharedPauses.get(db)
  if(!pauses){pauses=new Map();sharedPauses.set(db,pauses)}
  let pause=pauses.get(scope)
  if(!pause){const key='managerReporting.relayPauseUntil/'+scope;pause=new RelayDeliveryPause({
    load:async()=>{
      const existing=await db.setting.findUnique({where:{key}})
      if(existing)return existing.value
      if(socketRole)return null
      // Import the old singleton only for the first configured authority.
      const migration='managerReporting.relayPauseScope'
      const marker=await db.setting.findUnique({where:{key:migration}})
      if(marker&&marker.value!==scope)return null
      if(!marker)await db.setting.upsert({where:{key:migration},create:{key:migration,value:scope},update:{}})
      return (await db.setting.findUnique({where:{key:'managerReporting.relayPauseUntil'}}))?.value??null
    },
    save:async value=>{await db.setting.upsert({where:{key},create:{key,value},update:{value}})}
  });pauses.set(scope,pause)}
  return pause
}
/** Durable HTTP Retry-After gate. Shared by every source in a reporting drain. */
export function relayRetryDeadline(header: string | null, now: number): number {
  const value = header?.trim() ?? ''
  const seconds = /^\d+$/.test(value) ? Number(value) : NaN
  const date = /^[A-Za-z]{3}, /.test(value) ? Date.parse(value) : NaN
  const requested = Number.isSafeInteger(seconds) && seconds > 0 ? now + seconds * 1000 : date
  // Never shorten a valid server delay, including delays longer than one day.
  return Math.max(now + 300_000, Number.isSafeInteger(requested) && requested > now ? requested : now + 900_000)
}

export class RelayDeliveryPaused extends Error {
  constructor() { super('Relay safety budget paused delivery; durable events retained until retry.') }
}
export class RelayDeliveryPause {
  private until = 0
  private ready: Promise<void>
  private writes = Promise.resolve()
  constructor(private persistence: { load(): Promise<string | null>; save(value: string): Promise<void> }, private now = Date.now) {
    this.ready = persistence.load().then(value => {
      if (value === null) return
      const parsed = Number(value)
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Invalid persisted relay pause; delivery blocked.')
      this.until = parsed
    })
  }
  async remainingMs(): Promise<number> { await this.ready; await this.writes; return Math.max(0,this.until-this.now()) }
  async isPaused(): Promise<boolean> { await this.ready; await this.writes; return this.now() < this.until }
  async beforeSend(): Promise<void> { if (await this.isPaused()) throw new RelayDeliveryPaused() }
  async record(header: string | null): Promise<void> {
    await this.ready
    this.until = Math.max(this.until, relayRetryDeadline(header, this.now()))
    // Serial writes prevent a later, shorter concurrent response from overwriting the longest pause.
    this.writes = this.writes.then(() => this.persistence.save(String(this.until)))
    await this.writes
  }
}
