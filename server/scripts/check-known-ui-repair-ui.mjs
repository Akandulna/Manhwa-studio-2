// Synthetic original-phone grant fixture. No live relay/provider/phone traffic.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
const root=fileURLToPath(new URL('../../',import.meta.url)),require=createRequire(import.meta.url)
const {build}=require('esbuild'),{chromium}=require('playwright'),clientRequire=createRequire(path.join(root,'client/package.json'))
const component=path.join(root,'client/src/components/recovery/ManagedKnownUiRepair.tsx')
const fence={unit:{workspaceId:'fixture',taskId:'task:sha256:'+'a'.repeat(64),attemptId:'original_attempt',generation:1,fingerprint:'b'.repeat(64)},deviceId:'original_phone',profileId:'original_profile',bindingId:'original_view',commandId:'original_command',accountId:'confirmed',sourceSha256:'a'.repeat(64),policyRevision:1}
let view={pageLabel:'page_001.png',observedAt:Date.now(),globalEnabled:true,admissionReady:true,budget:{used:0,uiUsed:0,nextEligibleAt:0,pending:false,exhausted:false},record:{fence,revision:1,enabled:false,paused:false,cancelled:false,offer:{observedAt:Date.now()},actions:[]}},dropGrant=false
const calls=[]
const fixture=`import React from 'react';import{createRoot}from'react-dom/client';import Panel from ${JSON.stringify(component)};const r=createRoot(document.getElementById('root'));window.remount=()=>r.render(<Panel key={Date.now()} pageId="fixture_page"/>);window.remount();`
const bundle=await build({stdin:{contents:fixture,resolveDir:path.join(root,'client'),loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',alias:{'@':path.join(root,'client/src'),'react':path.join(root,'client/node_modules/react'),'react-dom':path.join(root,'client/node_modules/react-dom')},define:{'process.env.NODE_ENV':'"development"'}})
const postcss=clientRequire('postcss'),tailwind=clientRequire('tailwindcss'),configModule={exports:{}}
new Function('module','require',await fs.readFile(path.join(root,'client/tailwind.config.js'),'utf8'))(configModule,clientRequire)
const css=(await postcss([tailwind({...configModule.exports,content:[{raw:fixture+await fs.readFile(component,'utf8')+await fs.readFile(path.join(root,'client/src/components/ui/button.tsx'),'utf8'),extension:'tsx'}]})]).process(await fs.readFile(path.join(root,'client/src/index.css'),'utf8'),{from:undefined})).css
const server=http.createServer(async(req,res)=>{
 if(req.url==='/api/managed-pilot/pages/fixture_page/ui-repair'){
  let body='';for await(const bytes of req)body+=bytes
  const {action,fence:target,expectedRevision,actionId}=JSON.parse(body);calls.push(action);view.observedAt=Date.now()
  if(action!=='inspect'){assert.deepEqual(target,fence);assert.equal(expectedRevision,view.record?.revision??0)}
  if(action==='enable'){view.record.enabled=true;view.record.revision++}
  if(action==='reserve'){assert(view.record.enabled);assert.equal(view.record.actions.length,0);view.record.actions.push({id:actionId,phase:'reserved',at:Date.now(),auditId:null,checkedAt:null,result:null});view.record.revision++;view.budget.used=1;view.budget.uiUsed=1;view.budget.pending=true;if(dropGrant){res.statusCode=503;res.end();return}}
  if(action==='cancel'){view.record.cancelled=true;view.record.revision++;view.record.paused=true}
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
 browser=await chromium.launch({headless:true})
 const repairSource=await fs.readFile(path.join(process.env.MANAGED_ANDROID_ROOT??path.resolve(root,'../MAPI/Sleeper-cell-main'),'app/src/main/assets/managed-known-ui-repair.js'),'utf8')
 const dom=await browser.newPage({viewport:{width:390,height:844}});await dom.route('**/*',route=>route.abort())
 const html=(heading='ChatGPT can help with email',label='Not now',extra='')=>`<style>body{margin:0}textarea{position:absolute;left:20px;top:150px;width:320px;height:100px}section{position:fixed;inset:0;background:#eee}button{height:44px}</style><textarea id="prompt-textarea"></textarea><section role="dialog" aria-modal="true"><h2>${heading}</h2><button type="button" onclick="window.clicks++;this.parentElement.remove()">${label}</button>${extra}</section><script>window.clicks=0</script>`
 const probe=perform=>dom.evaluate(({source,perform})=>new Function('location','return ('+source+')('+perform+')')({origin:'https://chatgpt.com',pathname:'/',search:'',hash:''}),{source:repairSource,perform})
 await dom.setContent(html());assert.equal((await probe(false)).overlay,'present');assert.equal(await dom.evaluate(()=>window.clicks),0)
 assert.equal((await probe(true)).performed,true);assert.equal((await probe(false)).composerAccessible,true);assert.equal((await probe(true)).performed,false);assert.equal(await dom.evaluate(()=>window.clicks),1)
 for(const args of [['Sign in','Not now'],['ChatGPT can help with email','Connect Gmail'],['ChatGPT can help with email','Not now','<button type="button">Not now</button>'],['ChatGPT can help with email','Not now','<input value="private">']]){await dom.setContent(html(...args));assert.equal((await probe(true)).performed,false);assert.equal(await dom.evaluate(()=>window.clicks),0)}
 await dom.close()
 const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors=[]
 page.on('pageerror',e=>errors.push(e.message));const base='http://127.0.0.1:'+server.address().port
 await page.route('**/*',route=>route.request().url().startsWith(base+'/')?route.continue():route.abort())
 await page.goto(base);await page.getByRole('button',{name:'Inspect known promotion repair',exact:true}).waitFor();assert.deepEqual(calls,[])
 const inspect=()=>page.getByRole('button',{name:'Inspect known promotion repair',exact:true}).click()
 await inspect();assert(await page.getByRole('button',{name:'Enable known promotion repair',exact:true}).isDisabled())
 await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Enable known promotion repair',exact:true}).click()
 await page.waitForFunction(()=>document.querySelector('input[type=checkbox]')?.checked===false)
 assert(await page.getByRole('button',{name:'Grant one promotion dismissal',exact:true}).isDisabled())
 dropGrant=true;await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Grant one promotion dismissal',exact:true}).click();await page.getByRole('alert').waitFor()
 await inspect();await page.getByText('Original action: reserved.',{exact:true}).waitFor()
 assert(await page.getByRole('button',{name:'Grant one promotion dismissal',exact:true}).isDisabled());assert.equal(calls.filter(c=>c==='reserve').length,1)
 await page.screenshot({path:'/tmp/phase6-known-ui-desktop.png',fullPage:true})
 await page.setViewportSize({width:390,height:844});view.globalEnabled=false;view.record.actions[0].phase='unknown';view.record.actions[0].effect='possible';await inspect()
 await page.getByText('Known promotion repair is off.',{exact:true}).waitFor()
 await page.getByText('Original action: unknown. A dismissal may have happened; never repeat it.',{exact:true}).waitFor()
 await page.getByRole('button',{name:'Cancel promotion repair',exact:true}).click()
 assert(await page.getByRole('button',{name:'Grant one promotion dismissal',exact:true}).isDisabled())
 assert(view.budget.pending);assert.equal(view.budget.used,1);assert.equal(view.record.actions[0].phase,'unknown')
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Mobile document overflow')
 await page.screenshot({path:'/tmp/phase6-known-ui-mobile.png',fullPage:true});assert.deepEqual(errors,[])
 assert.equal(calls.filter(c=>c==='reserve').length,1);console.log('PASS: known promotion desktop/mobile; no automatic calls, separate confirmations, lost grant retained, unknown cancellation while off and no overflow.')
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
