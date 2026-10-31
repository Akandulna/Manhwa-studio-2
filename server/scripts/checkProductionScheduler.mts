// Isolated local SQLite only. No Studio database, credentials, phones or provider requests.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {PrismaClient} from '@prisma/client'
import {ProductionJobStore} from '../src/services/productionJobStore.js'
import {productionJobDatabase} from '../src/services/productionJobDatabase.js'
const mode=process.argv[2]
if(mode==='--fixture-owner'||mode==='--fixture-restart') {
 const root=process.argv[3]
 assert(root&&path.resolve(root).startsWith(path.join(os.tmpdir(),'production-scheduler-process-')))
 const prisma=new PrismaClient({datasources:{db:{url:'file:'+path.join(root,'fixture.db')}}})
 const recovering=mode==='--fixture-restart'
 // Advance the fixture clock only; production still requires a real expired lease.
 const store=new ProductionJobStore(productionJobDatabase(()=>prisma),()=>Date.now()+(recovering?60_000:0),45_000,0)
 await store.activate()
 if(!recovering)await store.save({id:'original-job',seriesId:'diagnostic-series',revision:1,config:{managedCrop:true,device:'synthetic-phone',profileId:'profile',clipper:{ai:'chatgpt',flow:'classic',tabs:1,chatGpt:{mode:null,model:null,effort:null}}},status:'running',step:'clipping',message:'persisted original claim',createdAt:'fixture',updatedAt:'fixture',command:{kind:'clipper',sentAt:'fixture',managedTaskIds:['synthetic-task'],managedClaims:[{taskId:'synthetic-task',claimEventId:'original-claim',deviceId:'synthetic-phone',profileId:'profile'}]}},null)
 process.send?.({jobs:await store.load()})
 if(recovering){store.close();await prisma.$disconnect();process.disconnect?.()}
 else setInterval(()=>{},1000) // Parent deliberately kills this process without a graceful close.
} else {
 assert.equal(process.argv.length,2,'No production database argument is accepted')
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'production-scheduler-process-'))
 const prisma=new PrismaClient({datasources:{db:{url:'file:'+path.join(root,'fixture.db')}}})
 const children:ReturnType<typeof spawn>[]=[]
 try {
  await prisma.$executeRawUnsafe('CREATE TABLE Setting (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)')
  await prisma.$disconnect()
  const start=(flag:string)=>{
   const child=spawn(process.execPath,['--import','tsx',fileURLToPath(import.meta.url),flag,root],{stdio:['ignore','ignore','pipe','ipc']});children.push(child)
   const exited=new Promise<void>((resolve,reject)=>{child.once('exit',()=>resolve());child.once('error',reject)})
   const ready=new Promise<any>((resolve,reject)=>{
    let stderr='';child.stderr!.on('data',chunk=>{stderr+=chunk.toString()})
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Fixture child timed out: '+stderr))},15_000)
    child.once('message',message=>{clearTimeout(timer);resolve(message)})
    child.once('exit',()=>{clearTimeout(timer);reject(new Error('Fixture exited before state: '+stderr))});child.once('error',reject)
   })
   return {child,ready,exited}
  }
  const first=start('--fixture-owner'),before=await first.ready
  assert.equal(before.jobs[0].status,'running')
  first.child.kill('SIGKILL');await first.exited
  const second=start('--fixture-restart'),after=await second.ready;await second.exited
  assert.equal(after.jobs[0].status,'interrupted');assert.equal(after.jobs[0].revision,2)
  assert.equal(after.jobs[0].id,before.jobs[0].id);assert.deepEqual(after.jobs[0].command,before.jobs[0].command)
  console.log('PASS: actual process death/restart preserved SQLite job and exact claim receipts; new owner recovered after synthetic lease expiry. Zero provider requests.')
 } finally {
  for(const child of children)if(child.exitCode===null&&!child.killed)child.kill('SIGKILL')
  await prisma.$disconnect();await fs.rm(root,{recursive:true,force:true})
 }
}
