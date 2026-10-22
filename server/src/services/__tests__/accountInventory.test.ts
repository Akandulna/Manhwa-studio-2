import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { parseAccountInventory } from '../accountInventory.js'

vi.mock('../r2Usage.js', () => ({ FREE_PLAN: {}, attachUsageCounter: () => {}, getMonthUsage: () => ({}), monthKey: () => '' }))
vi.mock('../../index.js', () => ({ prisma: {} }))
const { parseUploadProfiles } = await import('../r2Service.js')

const now = 1_792_000_000_000
const stamp = (at = now) => new Date(at).toISOString().replace('.000Z', 'Z')
function facts(provider: string, at = now, login: string | null = 'signed_in') {
  const fact = (value: string | null) => ({ value, evidence: value === null ? 'unknown' : 'observed', observedAt: stamp(at) })
  const email = login === 'signed_in' ? 'Person@example.com' : null
  return { login: fact(login), identity: fact(email), plan: fact(email ? 'plus' : null),
    candidateAccountKey: email ? `${provider}:${createHash('sha256').update(`${provider}\n${email.toLowerCase()}`).digest('hex')}` : null,
    confirmedAccountId: null }
}
function fixture() {
  const site = (provider: string, product: string) => ({ provider, product, current: facts(provider),
    lastSuccessfulCheck: { checkedAt: now, facts: facts(provider) }, auditDueAt: now + 86_400_000, quotaEvidence: [] })
  return { schema: 'sleeper-cell-account-inventory/1', profileId: 'local-profile', checkedAt: now, auditCadenceHours: 24,
    sites: { chatGpt: site('openai', 'chatgpt'), gemini: site('google', 'gemini_apps') } }
}
const parse = (raw: unknown, profile = 'local-profile', at = stamp()) => parseAccountInventory(raw, profile, at, now)

describe('phone account evidence decoder', () => {
  it('round trips phone wire evidence with scoped candidates and no confirmed identity', () => {
    const wire = fixture()
    expect(parse(JSON.parse(JSON.stringify(wire)))).toEqual(wire)
    expect(parse(wire)?.sites.chatGpt.current.candidateAccountKey).not.toBe(parse(wire)?.sites.gemini.current.candidateAccountKey)
    expect(parse(wire)?.sites.chatGpt.current.confirmedAccountId).toBeNull()
  })
  it('preserves failed current checks as unknown and retains the original audit due time', () => {
    const wire = fixture()
    wire.checkedAt = now + 1000
    wire.sites.chatGpt.current = facts('openai', now + 1000, null)
    wire.sites.gemini.current = facts('google', now + 1000, null)
    const result = parse(wire, 'local-profile', stamp(now + 1000))!
    expect(result.sites.chatGpt.current.login.evidence).toBe('unknown')
    expect(result.sites.chatGpt.lastSuccessfulCheck?.checkedAt).toBe(now)
    expect(result.sites.chatGpt.auditDueAt).toBe(now + 86_400_000)
  })
  it('accepts observed sign-out without inferring a plan or identity', () => {
    const wire = fixture()
    wire.sites.chatGpt.current = facts('openai', now, 'signed_out')
    wire.sites.chatGpt.lastSuccessfulCheck.facts = facts('openai', now, 'signed_out')
    expect(parse(wire)?.sites.chatGpt.current.login.value).toBe('signed_out')
  })
  it('accepts missing plan as unknown and a never-successful provider as unaudited', () => {
    const wire = fixture()
    wire.sites.chatGpt.current.plan = { value: null, evidence: 'unknown', observedAt: stamp() }
    wire.sites.chatGpt.lastSuccessfulCheck.facts.plan = { ...wire.sites.chatGpt.current.plan }
    const raw = JSON.parse(JSON.stringify(wire))
    raw.sites.gemini.current = facts('google', now, null)
    raw.sites.gemini.lastSuccessfulCheck = null
    raw.sites.gemini.auditDueAt = null
    expect(parse(raw)?.sites.gemini.auditDueAt).toBeNull()
    expect(parse(raw)?.sites.chatGpt.current.plan.evidence).toBe('unknown')
  })
  it.each([undefined, null, [], {}, { schema: 'future-version' }])('ignores legacy or invalid envelopes: %s', raw => expect(parse(raw)).toBeNull())
  it('rejects a different profile, enclosing timestamp, or far future observation', () => {
    expect(parse(fixture(), 'another-profile')).toBeNull()
    expect(parse(fixture(), 'local-profile', stamp(now - 1))).toBeNull()
    expect(parseAccountInventory(fixture(), 'local-profile', stamp(), now - 300_001)).toBeNull()
  })
  it.each([
    (v: any) => { v.sites.gemini.product = 'aistudio' },
    (v: any) => { v.sites.chatGpt.current.confirmedAccountId = 'shared' },
    (v: any) => { v.sites.chatGpt.current.candidateAccountKey = 'openai:forged' },
    (v: any) => { v.sites.chatGpt.current.plan.value = 'x'.repeat(101) },
    (v: any) => { v.sites.chatGpt.current.login.value = 'free' },
    (v: any) => { v.sites.chatGpt.current.login.evidence = 'estimated' },
    (v: any) => { v.sites.chatGpt.current.identity.observedAt = stamp(now - 1) },
    (v: any) => { v.sites.chatGpt.lastSuccessfulCheck.checkedAt++ },
    (v: any) => { v.sites.chatGpt.lastSuccessfulCheck.facts.plan.value = 'free' },
    (v: any) => { v.sites.chatGpt.auditDueAt++ },
    (v: any) => { v.sites.chatGpt.quotaEvidence = [{ remaining: 100 }] },
    (v: any) => { v.auditCadenceHours = 48 },
  ])('rejects unsupported or contradictory evidence %#', mutate => {
    const wire = fixture(); mutate(wire); expect(parse(wire)).toBeNull()
  })
  it('whitelists fields without copying secrets or arbitrary nested data', () => {
    const wire: any = fixture()
    wire.token = 'secret'; wire.sites.chatGpt.cookies = ['secret']; wire.sites.chatGpt.current.plan.rawPage = 'secret'
    expect(JSON.stringify(parse(wire))).not.toContain('secret')
  })
})


describe('profile receipt read projection', () => {
  const receipt = (inventory?: unknown) => ({ id: 'phone:local-profile', profileId: 'local-profile',
    check: { checkedAt: stamp(), chatGpt: { signedIn: true, email: 'Person@example.com', plan: 'plus', error: null }, accountInventory: inventory } })
  it('uses the local profile identity after multi-phone receipt merging', () => {
    const profiles = parseUploadProfiles([receipt(fixture())])
    expect(profiles[0].check?.accountInventory?.profileId).toBe('local-profile')
    expect(profiles[0].check?.accountInventory?.sites.chatGpt.current.confirmedAccountId).toBeNull()
  })
  it('keeps legacy check data when an inventory is missing or malformed', () => {
    for (const inventory of [undefined, { ...fixture(), profileId: 'another-profile' }]) {
      const check = parseUploadProfiles([receipt(inventory)])[0].check!
      expect(check.chatGpt?.plan).toBe('plus')
      expect(check.accountInventory).toBeUndefined()
    }
  })
  it('uses entry id for receipts predating merged profileId metadata', () => {
    const entry: any = receipt(fixture()); entry.id = 'local-profile'; delete entry.profileId
    expect(parseUploadProfiles([entry])[0].check?.accountInventory?.profileId).toBe('local-profile')
  })
})
