import{readFileSync}from'node:fs'
import{describe,it,expect}from'vitest'
import{canonicalJson,cropTaskIdentity,parseManagedOperation}from'../src/services/managedTaskProtocol.js'
const root=new URL('../../docs/manager-agents/phase3/',import.meta.url)
const assignment=JSON.parse(readFileSync(new URL('command-fixture.json',root),'utf8'))
const output=process.env.MANAGED_JOURNAL_FIXTURE_OUTPUT
const kotlin=JSON.parse(readFileSync(output??new URL('kotlin-accepted.json',root),'utf8'))
describe('native managed command interoperability',()=>{
 it('parses the actual Kotlin-emitted correlated acknowledgment',()=>{
  const op=parseManagedOperation(kotlin)
  expect(op.action).toBe('checkpoint')
  if(op.action!=='checkpoint')throw Error('Wrong fixture')
  expect(op.taskId).toBe(assignment.task.id)
  expect(op.fingerprint).toBe(assignment.task.fingerprint)
  expect(op.commandId).toBe(assignment.command.id)
  expect(op.attemptId).toBe(assignment.attempt.id)
  expect(op.generation).toBe(1)
 })
 it('keeps the shared task identity and canonical spec hash reproducible',async()=>{
  const t=assignment.task
  const result=await cropTaskIdentity({workspaceId:t.workspaceId,seriesId:t.seriesId,chapterId:t.chapterId,pageId:t.pageId},t.spec)
  expect(result).toEqual({taskId:t.id,fingerprint:t.fingerprint})
  expect(canonicalJson(JSON.parse(canonicalJson(t.spec)))).toBe(canonicalJson(t.spec))
 })
 it('keeps the generated Kotlin snapshot equal to the emitted artifact when supplied',()=>{
  expect(kotlin).toEqual(JSON.parse(readFileSync(new URL('kotlin-accepted.json',root),'utf8')))
 })
})
