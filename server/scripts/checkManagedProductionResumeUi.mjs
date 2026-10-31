// Synthetic browser fixture only. Every API request is intercepted; no phone/provider work.
import {chromium} from 'playwright'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
const taskId='task:sha256:'+'a'.repeat(64),requests=[],errors=[]
let job={id:'retained-job',revision:7,seriesId:'fixture-series',status:'interrupted',step:'clipping',message:'Retained original work',config:{managedCrop:true,device:'phone',profileId:'profile',clipper:{ai:'chatgpt',flow:'classic',tabs:1,chatGpt:{mode:null,model:null,effort:null}}},createdAt:'fixture',updatedAt:'fixture',command:{kind:'clipper',sentAt:'fixture',managedTaskIds:[taskId]}}
let revision=7,attention=true
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'})
try {
 const page=await browser.newPage({viewport:{width:1280,height:1100}});page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message))
 await page.route('**/api/**',async route=>{
  const request=route.request(),url=new URL(request.url());let result={enabled:false,managers:[],incidents:[]}
  if(request.method()!=='GET'){
   assert.ok(['/api/series/fixture-series/automation/reconcile','/api/series/fixture-series/automation/resume'].includes(url.pathname))
   const body=request.postDataJSON();requests.push({path:url.pathname,body})
   if(url.pathname.endsWith('/resume')){
    assert.deepEqual(body,{jobId:job.id,revision,scopeDigest:'c'.repeat(64)})
    job={...job,id:'resumed-job',revision:9,status:'running',resumedFrom:{...body,checkedAt:'2026-10-22T00:00:00Z'}};revision=9
    return route.fulfill({status:200,json:job})
   }
   assert.deepEqual(body,{jobId:job.id,revision})
   result={schema:'managed-production-reconciliation/1',jobId:job.id,revision,seriesId:job.seriesId,checkedAt:'2026-10-22T00:00:00Z',scopeDigest:'c'.repeat(64),observations:[{taskId,claimEventId:'original-claim',state:attention?'obsolete_claim':'current_unsent',message:'The original claim no longer matches current ownership. This run cannot adopt the current attempt.',owner:{attemptId:'new-owner',generation:2,deviceId:'second-phone',profileId:'profile',phase:'assigned',submission:'unsent',leaseExpiresAt:'2026-10-22T01:00:00Z'}}],unassignedPages:2,requiresAttention:attention,readOnly:true}
  }else if(url.pathname==='/api/managed-pilot/options')result={enabled:true,workspaceId:'fixture',series:[{id:job.seriesId,title:'Diagnostic fixture'}],profiles:[{device:'phone',deviceName:'Fixture phone',id:'profile',name:'Default'}]}
  else if(url.pathname==='/api/series/fixture-series/automation')result={job:{...job,revision},nextStep:'clipping'}
  await route.fulfill({status:200,json:result})
 })
 await page.goto(process.env.MANAGED_RECONCILIATION_UI_URL??'http://127.0.0.1:5174/sleeper-cells/managed',{waitUntil:'domcontentloaded'})
 await page.getByRole('combobox',{name:/^Production series/}).selectOption(job.seriesId)
 const inspect=page.getByRole('button',{name:'Inspect saved run (no provider work)',exact:true})
 await inspect.waitFor();await inspect.click()
 const observation=page.getByLabel('Saved run reconciliation',{exact:true});await observation.waitFor()
 assert.equal(await page.getByRole('button',{name:'Resume inspected run',exact:true}).isDisabled(),true);
 assert.match(await observation.innerText(),/obsolete claim/);assert.match(await observation.innerText(),/cannot adopt/)
 assert.match(await observation.innerText(),/Resume and handoff recheck/);assert.match(await observation.innerText(),/second-phone/)
 revision=8
 await page.getByRole('button',{name:'Refresh production',exact:true}).click()
 await observation.waitFor({state:'detached'})
 await inspect.click();await observation.waitFor();assert.equal(requests[1].body.revision,8)
 attention=false
 await inspect.click();await observation.waitFor()
 const resume=page.getByRole('button',{name:'Resume inspected run',exact:true})
 await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Resume inspected run'&&!b.disabled))
 await resume.click()
 await page.getByText(/Original managed run resumed after fresh ownership checks/).waitFor()
 await observation.waitFor({state:'detached'})
 await page.getByText(/Resumed from saved revision 8/).waitFor()
 assert.equal(await page.getByRole('button',{name:'Run managed crop pages',exact:true}).isDisabled(),true)
 assert.equal(requests.length,4);assert.deepEqual(errors,[])
 await fs.mkdir('/tmp/managed-phase4-resume-ui',{recursive:true});await page.screenshot({path:'/tmp/managed-phase4-resume-ui/inspected.png',fullPage:true})
 console.log(JSON.stringify({exactSavedJobRevisionAndDigest:true,unsafeResumeDisabled:true,explicitResumeVisible:true,durableDecisionShown:true,staleReportCleared:true,requestsIntercepted:requests.length,providerRequests:0,pageErrors:errors}))
}finally{await Promise.race([browser.close(),new Promise(resolve=>setTimeout(resolve,5000))])}
