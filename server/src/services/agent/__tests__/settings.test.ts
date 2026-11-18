import { describe, expect, it } from 'vitest'
import { SETTINGS, SettingError, decimal, effortLevel, findSetting, modelId, oneOf, sameValue, switchValue, text, whole } from '../settingsTools.js'
import { TOOLS } from '../agentTools.js'

describe('value checks', () => {
  it('accepts whole numbers in range, also as text', () => {
    expect(whole('x', 1, 10)('4')).toBe(4)
    expect(whole('x', 1, 10)(10)).toBe(10)
  })
  it('rejects out of range, fractions and non-numbers', () => {
    for (const bad of [0, 11, 2.5, 'abc', '', true, null]) expect(() => whole('x', 1, 10)(bad)).toThrow(SettingError)
  })
  it('decimals are range checked and rounded', () => {
    expect(decimal('x', 0.1, 3)('0.85')).toBe(0.85)
    expect(() => decimal('x', 0.1, 3)(4)).toThrow(SettingError)
  })
  it('on/off accepts booleans and words', () => {
    expect(switchValue('x')('off')).toBe(false)
    expect(switchValue('x')(true)).toBe(true)
    expect(() => switchValue('x')('maybe')).toThrow(SettingError)
  })
  it('choices are limited to the list', () => {
    expect(oneOf('x', ['a', 'b'])(' B ')).toBe('b')
    expect(() => oneOf('x', ['a'])('z')).toThrow(SettingError)
  })
  it('"default" resets a model or effort to null; bad ids and levels fail', () => {
    expect(modelId('default')).toBeNull()
    expect(effortLevel('Default')).toBeNull()
    expect(effortLevel('high')).toBe('high')
    expect(() => effortLevel('extreme')).toThrow(SettingError)
    expect(() => modelId('bad model!')).toThrow(SettingError)
  })
  it('text is trimmed, length-limited and has no control characters', () => {
    expect(text('x', 1, 20)('  hi   there ')).toBe('hi there')
    expect(() => text('x', 1, 5)('toolongvalue')).toThrow(SettingError)
    expect(() => text('x', 1, 5)('   ')).toThrow(SettingError)
  })
  it('stored text and numbers compare equal', () => {
    expect(sameValue('3', 3)).toBe(true)
    expect(sameValue('1.0', 1)).toBe(true)
    expect(sameValue('3', 4)).toBe(false)
    expect(sameValue(null, null)).toBe(true)
    expect(sameValue(null, 'x')).toBe(false)
  })
})

describe('setting list', () => {
  it('has unique ids and none of them is a secret or path', () => {
    const ids = SETTINGS.map(s => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.join(' ')).not.toMatch(/token|secret|api_?key|password|path|r2|relay/i)
    expect(ids.some(i => /executable|path/.test(i))).toBe(false)
  })
  it('finds a setting by id or by a unique part', () => {
    expect(findSetting('downloads.concurrency').id).toBe('downloads.concurrency')
    expect(findSetting('page_timeout_minutes').id).toBe('ai.antigravity.page_timeout_minutes')
    expect(findSetting('Request delay ms').id).toBe('downloads.request_delay_ms')
  })
  it('refuses ambiguous or unknown names', () => {
    expect(() => findSetting('model')).toThrow(/several/)
    expect(() => findSetting('theme')).toThrow(/No setting/)
    expect(() => findSetting('')).toThrow(SettingError)
  })
  it('risky changes ask for approval, plain ones do not', () => {
    const risk = (id: string, value: any, cur: any = 'x') => findSetting(id).risk?.(value, cur) ?? null
    expect(risk('downloads.folder', '/new/place', '/old')).toMatch(/NOT moved/)
    expect(risk('ai.engine', 'claude', 'antigravity')).toMatch(/Switch the engine/)
    expect(risk('ai.antigravity.sandbox', false)).toMatch(/OFF/)
    expect(risk('ai.antigravity.sandbox', true)).toBeNull()
    expect(risk('agent.enabled', false)).toMatch(/OFF/)
    expect(risk('agent.enabled', true)).toBeNull()
    expect(risk('downloads.concurrency', 5, 3)).toBeNull()
  })
})

describe('registered as agent tools', () => {
  it('settings_list and settings_change are available', () => {
    const names = TOOLS.map(t => t.name)
    expect(names).toContain('settings_list')
    expect(names).toContain('settings_change')
    expect(TOOLS.find(t => t.name === 'settings_change')?.approval).toBeTypeOf('function')
  })
})
