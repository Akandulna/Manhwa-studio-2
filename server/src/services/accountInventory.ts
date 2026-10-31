import { createHash } from 'node:crypto'

/** Passive phone evidence only. Candidate keys do not authorize account merging or routing. */
export interface PhoneAccountFact {
  value: string | null
  evidence: 'observed' | 'unknown'
  observedAt: string
}
export interface PhoneAccountFacts {
  login: PhoneAccountFact
  identity: PhoneAccountFact
  plan: PhoneAccountFact
  candidateAccountKey: string | null
  confirmedAccountId: null
}
export interface PhoneAccountSite {
  provider: 'openai' | 'google'
  product: 'chatgpt' | 'gemini_apps'
  current: PhoneAccountFacts
  lastSuccessfulCheck: { checkedAt: number; facts: PhoneAccountFacts } | null
  auditDueAt: number | null
  quotaEvidence: never[]
}
export interface PhoneAccountInventory {
  schema: 'sleeper-cell-account-inventory/1'
  profileId: string
  checkedAt: number
  auditCadenceHours: 24
  sites: { chatGpt: PhoneAccountSite; gemini: PhoneAccountSite }
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const time = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= 8_640_000_000_000_000

/** Whitelist version 1; reject contradictions instead of upgrading history to current readiness. */
export function parseAccountInventory(raw: unknown, profileId: string, checkedAt: string, now = Date.now()): PhoneAccountInventory | null {
  if (!object(raw) || raw.schema !== 'sleeper-cell-account-inventory/1' ||
      !profileId.trim() || profileId.length > 128 || raw.profileId !== profileId ||
      !time(raw.checkedAt) || raw.checkedAt !== Date.parse(checkedAt) || raw.checkedAt > now + 300_000 ||
      raw.auditCadenceHours !== 24 || !object(raw.sites)) return null
  const at = raw.checkedAt
  function facts(value: unknown, timestamp: number, provider: string): PhoneAccountFacts | null {
    if (!object(value) || value.confirmedAccountId !== null) return null
    const fact = (v: unknown, max: number): PhoneAccountFact | null => {
      if (!object(v) || typeof v.observedAt !== 'string' || v.observedAt.length > 30 ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(v.observedAt) || Date.parse(v.observedAt) !== timestamp) return null
      if (v.value === null && v.evidence === 'unknown') return { value: null, evidence: 'unknown', observedAt: v.observedAt }
      if (typeof v.value !== 'string' || !v.value.trim() || v.value.length > max || v.evidence !== 'observed') return null
      return { value: v.value, evidence: 'observed', observedAt: v.observedAt }
    }
    const login = fact(value.login, 10), identity = fact(value.identity, 320), plan = fact(value.plan, 100)
    if (!login || !identity || !plan || (login.value !== null && !['signed_in', 'signed_out'].includes(login.value))) return null
    if (login.value !== 'signed_in' && (identity.value !== null || plan.value !== null)) return null
    if (identity.value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity.value)) return null
    const candidateAccountKey = identity.value ? `${provider}:${createHash('sha256').update(`${provider}\n${identity.value.toLowerCase()}`).digest('hex')}` : null
    if (value.candidateAccountKey !== candidateAccountKey) return null
    return { login, identity, plan, candidateAccountKey, confirmedAccountId: null }
  }
  function site(value: unknown, provider: PhoneAccountSite['provider'], product: PhoneAccountSite['product']): PhoneAccountSite | null {
    if (!object(value) || value.provider !== provider || value.product !== product || !Array.isArray(value.quotaEvidence) || value.quotaEvidence.length !== 0) return null
    const current = facts(value.current, at, provider)
    if (!current) return null
    let lastSuccessfulCheck: PhoneAccountSite['lastSuccessfulCheck'] = null
    if (value.lastSuccessfulCheck !== null) {
      const previous = value.lastSuccessfulCheck
      if (!object(previous) || !time(previous.checkedAt) || previous.checkedAt > at) return null
      const history = facts(previous.facts, previous.checkedAt, provider)
      if (!history || history.login.value === null) return null
      lastSuccessfulCheck = { checkedAt: previous.checkedAt, facts: history }
    }
    if (current.login.value !== null && (!lastSuccessfulCheck || lastSuccessfulCheck.checkedAt !== at ||
        JSON.stringify(lastSuccessfulCheck.facts) !== JSON.stringify(current))) return null
    if (current.login.value === null && lastSuccessfulCheck?.checkedAt === at) return null
    const auditDueAt = lastSuccessfulCheck ? lastSuccessfulCheck.checkedAt + 86_400_000 : null
    if (value.auditDueAt !== auditDueAt || (auditDueAt !== null && !time(auditDueAt))) return null
    return { provider, product, current, lastSuccessfulCheck, auditDueAt, quotaEvidence: [] }
  }
  const chatGpt = site(raw.sites.chatGpt, 'openai', 'chatgpt'), gemini = site(raw.sites.gemini, 'google', 'gemini_apps')
  return chatGpt && gemini ? { schema: 'sleeper-cell-account-inventory/1', profileId, checkedAt: at, auditCadenceHours: 24, sites: { chatGpt, gemini } } : null
}
