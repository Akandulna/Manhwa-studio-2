// Synthetic original-phone grant fixture. No live relay/provider/phone traffic.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
const root=fileURLToPath(new URL('../../',import.meta.url)),require=createRequire(import.meta.url)
const {build}=require('esbuild'),{chromium}=require('playwright'),clientRequire=createRequire(path.join(root,'client/package.json'))
const component=path.join(root,'client/src/components/recovery/ManagedAccountRecheckRecovery.tsx')
const fence={unit:{workspaceId:'fixture',taskId:'task:sha256:'+'a'.repeat(64),attemptId:'original_attempt',generation:1,fingerprint:'b'.repeat(64)},deviceId:'original_phone',profileId:'original_profile',accountId:'confirmed_shared',scope:{product:'chatgpt',feature:'crop_json'},quotaObservedAt:Date.now()-2000,recheckAt:Date.now()-1000}
let view={targets:[fence],selected:null,pageLabel:'page_001.png',observedAt:Date.now(),globalEnabled:true,budget:{used:0,nextEligibleAt:0,pending:false,exhausted:false},record:null,profileAudit:{state:'due',reason:null},quotaState:'blocked'},dropGrant=false
const calls=[]
const fixture=`import React from 'react';import{createRoot}from'react-dom/client';import Panel from ${JSON.stringify(component)};const r=createRoot(document.getElementById('root'));window.remount=()=>r.render(<Panel key={Date.now()} pageId="fixture_page"/>);window.remount();`
const bundle=await build({stdin:{contents:fixture,resolveDir:path.join(root,'client'),loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',alias:{'@':path.join(root,'client/src'),'react':path.join(root,'client/node_modules/react'),'react-dom':path.join(root,'client/node_modules/react-dom')},define:{'process.env.NODE_ENV':'"development"'}})
const postcss=clientRequire('postcss'),tailwind=clientRequire('tailwindcss'),configModule={exports:{}}
new Function('module','require',await fs.readFile(path.join(root,'client/tailwind.config.js'),'utf8'))(configModule,clientRequire)
const css=(await postcss([tailwind({...configModule.exports,content:[{raw:fixture+await fs.readFile(component,'utf8')+await fs.readFile(path.join(root,'client/src/components/ui/button.tsx'),'utf8'),extension:'tsx'}]})]).process(await fs.readFile(path.join(root,'client/src/index.css'),'utf8'),{from:undefined})).css
const server=http.createServer(async(req,res)=>{
 if(req.url==='/api/managed-pilot/pages/fixture_page/account-recovery'){
  let body='';for await(const bytes of req)body+=bytes
  const {action,fence:target,expectedRevision,actionId}=JSON.parse(body);calls.push(action);view.observedAt=Date.now()
  view.selected=target
  if(action!=='inspect'){assert.deepEqual(target,fence);assert.equal(expectedRevision,view.record?.revision??0)}
  if(action==='enable')view.record={revision:1,enabled:true,paused:false,cancelled:false,actions:[]}
  if(action==='request'){assert(view.record.enabled);assert.equal(view.record.actions.length,0);view.record.actions.push({id:actionId,phase:'executing',at:Date.now(),auditId:null,checkedAt:null,result:null});view.record.revision++;view.budget.used=1;view.budget.pending=true;if(dropGrant){res.statusCode=503;res.end();return}}
  if(action==='cancel'){view.record.cancelled=true;view.record.revision++;view.record.actions[0].phase='safe_failure';view.record.actions[0].result='withdrawn';view.budget.pending=false}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(view));return
 }
 if(req.url==='/bundle.js'){res.setHeader('Content-Type','application/javascript');res.end(bundle.outputFiles[0].text)}
 else if(req.url==='/styles.css'){res.setHeader('Content-Type','text/css');res.end(css)}
 else if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><main style="max-width:900px;margin:20px auto;padding:16px"><div id="root"></div></main><script src="/bundle.js"></script>')}
 else{res.statusCode=404;res.end()}
})
let browser
try{
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors=[]
 page.on('pageerror',e=>errors.push(e.message));const base='http://127.0.0.1:'+server.address().port
 await page.route('**/*',route=>route.request().url().startsWith(base+'/')?route.continue():route.abort())
 await page.goto(base);await page.getByRole('button',{name:'Inspect account recheck recovery',exact:true}).waitFor();assert.deepEqual(calls,[])
 const inspect=()=>page.getByRole('button',{name:'Inspect account recheck recovery',exact:true}).click()
 await inspect();await page.getByRole('combobox').selectOption('1');await inspect()
 await page.getByText('Shared attempts: 0/3. Quota evidence: blocked.',{exact:true}).waitFor()
 assert(await page.getByRole('button',{name:'Enable this recheck',exact:true}).isDisabled())
 await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Enable this recheck',exact:true}).click()
 await page.waitForFunction(()=>document.querySelector('input[type=checkbox]')?.checked===false)
 assert(await page.getByRole('button',{name:'Request one idle recheck',exact:true}).isDisabled())
 dropGrant=true;await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Request one idle recheck',exact:true}).click();await page.getByRole('alert').waitFor()
 await inspect();await page.getByText('Request queued with the existing idle audit scheduler.',{exact:true}).waitFor()
 assert(await page.getByRole('button',{name:'Request one idle recheck',exact:true}).isDisabled());assert.equal(calls.filter(c=>c==='request').length,1)
 await page.screenshot({path:'/tmp/phase6-account-recheck-desktop.png',fullPage:true})
 await page.setViewportSize({width:390,height:844});view.globalEnabled=false;await inspect()
 await page.getByText('Account recovery admission is off. Normal account observations remain under the existing audit scheduler.',{exact:true}).waitFor()
 await page.getByRole('button',{name:'Cancel rechecks',exact:true}).click()
 await page.getByText('The queued request was withdrawn; newer owner edits and normal audit cadence are preserved.',{exact:true}).first().waitFor()
 assert(await page.getByRole('button',{name:'Request one idle recheck',exact:true}).isDisabled())
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Mobile document overflow')
 await page.screenshot({path:'/tmp/phase6-account-recheck-mobile.png',fullPage:true});assert.deepEqual(errors,[])
 assert.equal(calls.filter(c=>c==='request').length,1);console.log('PASS: account recheck desktop/mobile; no automatic calls, separate confirmation, lost acknowledgment retained, off-switch queued cancellation, shared-budget hold and no overflow.')
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
