// Synthetic UI only: every API request is intercepted. No phone or provider work.
import {chromium} from 'playwright'
import assert from 'node:assert/strict'
const taskId='task:sha256:'+'a'.repeat(64),requests=[],errors=[]
let job={id:'original',revision:3,seriesId:'source',status:'interrupted',step:'clipping',message:'retained',config:{device:'phone',profileId:'profile',managedCrop:true},command:{managedTaskIds:[taskId],managedClaims:[{taskId,claimEventId:'claim',deviceId:'phone',profileId:'profile'}]}}
let timeline={task:{id:taskId,state:'paused',generation:1,fingerprint:'b'.repeat(64)},attempt:{id:'attempt',deviceId:'phone',profileId:'profile',phase:'stop_requested',submission:'unsent',checkpointRef:null,activeCommandId:'stop'},commands:[]}
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'})
try{
 const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000)
 await page.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url());let result={enabled:false,managers:[],incidents:[]}
  if(req.method()!=='GET'){
   const body=req.postDataJSON();requests.push({path:url.pathname,body})
   if(url.pathname.endsWith('/export-run')){assert.deepEqual(body,{jobId:'original',revision:3});result={schema:'synthetic-bundle',bundleId:'bundle'}}
   else if(url.pathname.endsWith('/adopt-run')){assert.equal(body.bundleId,'bundle');result={...job,seriesId:'destination',id:'adopted'}}
   else if(url.pathname.endsWith('/handoff')){
    if(body.intentId){assert.deepEqual(body,{jobId:'original',revision:4,intentId:'persisted-transfer'});job={...job,id:'handed-off',revision:5,pendingHandoff:undefined};result=job}
    else{assert.deepEqual(body,{jobId:'original',revision:3,taskId,attemptId:'attempt',generation:1,fingerprint:'b'.repeat(64),stopCommandId:'stop',deviceId:'second',profileId:'profile'});job={...job,revision:4,pendingHandoff:{eventId:'persisted-transfer'}};return route.fulfill({status:409,json:{error:'Lost authority reply; retain intent'}})}
   }else throw new Error('Unexpected mutation '+url.pathname)
  }else if(url.pathname==='/api/managed-pilot/options')result={enabled:true,series:[{id:'source',title:'Source'},{id:'destination',title:'Destination'}],profiles:[{device:'phone',deviceName:'Original',id:'profile',name:'Default'},{device:'second',deviceName:'Second',id:'profile',name:'Default'}]}
  else if(url.pathname==='/api/series/source/automation')result={job}
  else if(url.pathname==='/api/series/destination/automation')result={job:null}
  else if(url.pathname.startsWith('/api/managed-pilot/tasks/'))result=timeline
  await route.fulfill({status:200,json:result})
 })
 await page.goto(process.env.MANAGED_HANDOFF_UI_URL??'http://127.0.0.1:5175/sleeper-cells/managed')
 await page.getByRole('combobox',{name:/^Production series/}).selectOption('source')
 await page.getByRole('button',{name:'Export original run',exact:true}).click()
 await page.waitForFunction(()=>document.querySelector('textarea')?.value.includes('synthetic-bundle'))
 await page.getByRole('button',{name:'Open task '+taskId.slice(-8),exact:true}).click()
 await page.getByRole('combobox',{name:'Production handoff target',exact:true}).selectOption('second:profile')
 const handoff=page.getByRole('button',{name:'Hand off confirmed-unsent production task',exact:true})
 assert.equal(await handoff.isDisabled(),true)
 timeline.attempt.phase='stop_confirmed'
 await page.getByRole('button',{name:'Refresh task',exact:true}).click()
 await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Hand off confirmed-unsent production task'&&!b.disabled))
 await handoff.click();await page.getByText('Lost authority reply; retain intent',{exact:true}).waitFor()
 await page.getByRole('button',{name:'Refresh production',exact:true}).click()
 await page.getByRole('button',{name:'Finish pending production handoff',exact:true}).click()
 await page.getByText(/Pending authority handoff reconciled/).waitFor()
 await page.getByRole('combobox',{name:/^Production series/}).selectOption('destination')
 await page.getByRole('button',{name:'Adopt original run without dispatch',exact:true}).click()
 await page.getByText(/Original run adopted without dispatch/).waitFor()
 assert.equal(requests.length,4);assert.deepEqual(errors,[])
 console.log(JSON.stringify({unsafeHandoffDisabled:true,exactOriginalFence:true,persistedIntentRetry:true,portableAdoptionNoDispatch:true,interceptedMutations:requests.length,providerRequests:0,pageErrors:errors}))
}finally{await browser.close()}
