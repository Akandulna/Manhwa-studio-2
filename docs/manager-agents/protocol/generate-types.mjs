import { readFileSync, writeFileSync } from 'node:fs'
const schema = JSON.parse(readFileSync(new URL('records.schema.json', import.meta.url), 'utf8'))
function type(s) {
  if ('const' in s) return JSON.stringify(s.const)
  if (s.enum) return s.enum.map(v => JSON.stringify(v)).join(' | ')
  if (s.anyOf) return s.anyOf.map(type).join(' | ')
  if (Array.isArray(s.type)) return s.type.map(t => type({ type: t })).join(' | ')
  if (s.type === 'object') return '{ ' + Object.entries(s.properties).map(([k, v]) => `${JSON.stringify(k)}${s.required.includes(k) ? '' : '?'}: ${type(v)}`).join('; ') + ' }'
  if (s.type === 'array') return `Array<${type(s.items)}>`
  return ({ integer: 'number', number: 'number', string: 'string', boolean: 'boolean', null: 'null' })[s.type] ?? 'unknown'
}
const types = schema.oneOf.map(s => `export type ${s.properties.kind.const.split('_').map(v => v[0].toUpperCase() + v.slice(1)).join('')}Record = ${type(s)}`)
const names = schema.oneOf.map(s => s.properties.kind.const.split('_').map(v => v[0].toUpperCase() + v.slice(1)).join('') + 'Record')
writeFileSync(new URL('contracts.ts', import.meta.url), '// Generated from records.schema.json by generate-types.mjs. Specification only.\n' + types.join('\n\n') + '\n\nexport type ManagerRecord = ' + names.join(' | ') + '\n')
