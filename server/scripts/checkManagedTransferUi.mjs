// Isolated browser fixture; every API write is intercepted. Never dispatches real work.
import {chromium} from 'playwright'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
const taskId='task:sha256:'+'a'.repeat(64),fingerprint='b'.repeat(64)
let current={task:{id:taskId,state:'running',generation:1,fingerprint,canonical:null},attempt:{id:'attempt-one',activeCommandId:'start-one',phase:'started',submission:'unsent',checkpointRef:null,leaseExpiresAt:'2026-10-21T23:00:00Z',deviceId:'phone-1',profileId:'profile'},commands:[]}
const writes=[],errors=[]
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'})
try {
 const page=await browser.newPage({viewport:{width:1280,height:1000}});page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message))
 await page.route('**/api/**',async route=>{
  const req=route.request(),u=new URL(req.url());let result={}
  if(req.method()!=='GET'){
   assert.ok(['/api/managed-pilot/stop','/api/managed-pilot/pages/page/transfer-unsent'].includes(u.pathname));const body=req.postDataJSON();writes.push({path:u.pathname,body})
   if(u.pathname.endsWith('/stop')){assert.equal(body.cancel,false);current.task.state='paused';current.attempt.phase='stop_requested';current.attempt.activeCommandId='stop-one'}
   else {assert.deepEqual(body,{taskId,attemptId:'attempt-one',generation:1,fingerprint,stopCommandId:'stop-one',deviceId:'phone-2',profileId:'profile'});current.task.generation=2;current.task.state='assigned';current.attempt={...current.attempt,id:'attempt-two',activeCommandId:'start-two',deviceId:'phone-2',phase:'assigned'}}
   result=current
  }else if(u.pathname==='/api/managed-pilot/options')result={enabled:true,workspaceId:'fixture',series:[{id:'series',title:'Fixture'}],profiles:[{device:'phone-1',deviceName:'First fixture phone',id:'profile',name:'Default'},{device:'phone-2',deviceName:'Second fixture phone',id:'profile',name:'Default'}]}
  else if(u.pathname==='/api/series/series')result={chapters:[{id:'chapter',number:1}]}
  else if(u.pathname==='/api/chapters/chapter')result={pages:[{id:'page',index:0,status:'done'}]}
  else if(u.pathname.startsWith('/api/managed-pilot/tasks/'))result=current
  else return route.fulfill({status:200,json:{enabled:false,managers:[],incidents:[]}})
  return route.fulfill({status:200,json:result})
 })
 await page.goto(process.env.MANAGED_TRANSFER_UI_URL??'http://127.0.0.1:5174/sleeper-cells/managed',{waitUntil:'domcontentloaded'})
 await page.getByRole('combobox',{name:/^Series/}).selectOption('series');await page.getByRole('combobox',{name:/^Chapter/}).selectOption('chapter');await page.getByRole('combobox',{name:/^Page/}).selectOption('page')
 await page.getByLabel('Task ID from phone inspection').fill(taskId);await page.getByRole('button',{name:'Open retained task',exact:true}).click()
 await page.getByRole('combobox',{name:'Transfer target',exact:true}).selectOption('phone-2:profile')
 const transfer=page.getByRole('button',{name:'Transfer confirmed-unsent task',exact:true})
 const settled=()=>page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Refresh task'&&!b.disabled))
 assert.equal(await transfer.isDisabled(),true)
 await page.getByRole('button',{name:'Pause task for handoff',exact:true}).click();await settled();assert.equal(await transfer.isDisabled(),true)
 current.attempt.phase='stop_confirmed';await page.getByRole('button',{name:'Refresh task',exact:true}).click();await settled();assert.equal(await transfer.isEnabled(),true)
 for(const submission of ['unknown','submitted','saved']){current.attempt.submission=submission;await page.getByRole('button',{name:'Refresh task',exact:true}).click();await settled();assert.equal(await transfer.isDisabled(),true)}
 current.attempt.submission='unsent';current.task.state='cancelled';await page.getByRole('button',{name:'Refresh task',exact:true}).click();await settled();assert.equal(await transfer.isDisabled(),true)
 current.task.state='paused';await page.getByRole('button',{name:'Refresh task',exact:true}).click();await transfer.click()
 await page.getByText(/Unsent task transferred with a new generation/).waitFor()
 assert.equal(await transfer.isDisabled(),true);assert.equal(writes.length,2);assert.deepEqual(errors,[])
 await fs.mkdir('/tmp/managed-phase4-transfer-ui',{recursive:true});await page.screenshot({path:'/tmp/managed-phase4-transfer-ui/transferred.png',fullPage:true})
 console.log(JSON.stringify({pauseRequiresWorkerAck:true,unsafeStatesDisabled:true,exactFenceAndTarget:true,newOwnerShown:true,writesIntercepted:writes.length,consoleErrors:errors}))
}finally{await browser.close()}
