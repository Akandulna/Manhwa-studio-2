import {createRequire} from 'node:module'
import {afterEach,describe,expect,it} from 'vitest'
import {legacyRequestBlocked,LEGACY_BROWSER_ACTIONS} from '../../relay/src/managedLegacyFence.js'
import type {TaskSql} from '../../relay/src/taskAuthority.js'
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite')
const opened:InstanceType<typeof DatabaseSync>[]=[]
afterEach(()=>{for(const db of opened.splice(0))db.close()})
function setup(enrolled=false) {
 const db=new DatabaseSync(':memory:');opened.push(db)
 const sql:TaskSql={exec(q,...args){return {toArray:()=>db.prepare(q).all(...args)}}}
 if(enrolled) {db.exec('CREATE TABLE managed_enrollment (id TEXT PRIMARY KEY, body TEXT NOT NULL)');db.prepare('INSERT INTO managed_enrollment VALUES (?,?)').run('enrolled-phone','{}')}
 return {db,sql}
}
describe('managed enrollment fences legacy browser controls',()=>{
 it('preserves existing installations without creating managed schema',()=>{
  const {db,sql}=setup()
  for(const action of LEGACY_BROWSER_ACTIONS)expect(legacyRequestBlocked(sql,action,'legacy-phone')).toBe(false)
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'managed_%'").all()).toHaveLength(0)
 })
 it('blocks every legacy run/profile mutation for enrolled phones, even with no task or flag',()=>{
  const {sql}=setup(true)
  for(const action of LEGACY_BROWSER_ACTIONS) {
   expect(legacyRequestBlocked(sql,action,'enrolled-phone')).toBe(true)
   expect(legacyRequestBlocked(sql,action,'')).toBe(true)
   expect(legacyRequestBlocked(sql,action,'legacy-phone')).toBe(false)
  }
 })
 it('retains receipt, sync and screen observation access during reconciliation',()=>{
  const {sql}=setup(true)
  for(const action of [undefined,'sync','screen_on','screen_off','screenshot']) {
   expect(legacyRequestBlocked(sql,action,'enrolled-phone')).toBe(false)
   expect(legacyRequestBlocked(sql,action,'')).toBe(false)
  }
 })
 it('observes newly committed enrollment and never caches a permissive admission',()=>{
  const {db,sql}=setup()
  expect(legacyRequestBlocked(sql,'clipper_start','enrolled-phone')).toBe(false)
  db.exec('CREATE TABLE managed_enrollment (id TEXT PRIMARY KEY, body TEXT NOT NULL)')
  expect(legacyRequestBlocked(sql,'clipper_start','enrolled-phone')).toBe(false)
  db.prepare('INSERT INTO managed_enrollment VALUES (?,?)').run('enrolled-phone','{}')
  expect(legacyRequestBlocked(sql,'clipper_start','enrolled-phone')).toBe(true)
 })
})
