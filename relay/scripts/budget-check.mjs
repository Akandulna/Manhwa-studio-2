// Local-only cutoff and restart check. Run with RELAY_DAILY_OPERATIONS=3 in an isolated store.
import assert from 'node:assert/strict'
const base=process.env.MANAGER_TEST_URL??'http://127.0.0.1:8795'
assert.equal(new URL(base).hostname,'127.0.0.1')
const headers={Authorization:'Bearer manager-local-check','Content-Type':'application/json'}
async function usage(){return (await fetch(base+'/usage',{headers})).json()}
if(!process.argv.includes('--replay-only')) {
 for(let i=0;i<3;i++) assert.equal((await fetch(base+'/request',{method:'POST',headers,body:JSON.stringify({id:'budget-'+i,requestedAt:new Date().toISOString()})})).status,200)
}
const before=await usage()
assert.equal(before.operations,3)
const rejected=await fetch(base+'/request',{method:'POST',headers,body:JSON.stringify({id:'must-not-store'})})
assert.equal(rejected.status,429)
assert(Number(rejected.headers.get('Retry-After'))>0)
const after=await usage()
assert.equal(after.operations,before.operations)
assert.equal(after.rowsWritten,before.rowsWritten,'Rejected retries must not keep writing the budget row')
assert(after.rowsWritten<60000 && after.rowsRead<3000000)
console.log(JSON.stringify({pass:true,restart:process.argv.includes('--replay-only'),usage:after}))
