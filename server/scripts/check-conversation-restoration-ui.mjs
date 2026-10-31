// Synthetic original-phone grant fixture. No live relay/provider/phone traffic.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
const root=fileURLToPath(new URL('../../',import.meta.url)),require=createRequire(import.meta.url)
const {build}=require('esbuild'),{chromium}=require('playwright'),clientRequire=createRequire(path.join(root,'client/package.json'))
const component=path.join(root,'client/src/components/recovery/ManagedConversationRestoration.tsx')
const fence={unit:{workspaceId:'fixture',taskId:'task:sha256:'+'a'.repeat(64),attemptId:'original_attempt',generation:1,fingerprint:'b'.repeat(64)},deviceId:'original_phone',profileId:'original_profile',commandId:'original_command',context:{capturedAt:Date.now(),replySha256:'d'.repeat(64)},anchorSha256:'c'.repeat(64)}
const retainedFixture=process.env.MANAGED_RETAINED_RESTORATION_FIXTURE==='1'
if(retainedFixture)fence.retained={schema:'retained-restoration-binding/1',bindingActionId:'verified_binding',candidateId:'retained_candidate',bindingId:'retained_view'}
let view={pageLabel:'page_001.png',observedAt:Date.now(),globalEnabled:true,admissionReady:true,budget:{used:0,uiUsed:0,nextEligibleAt:0,pending:false,exhausted:false},record:{fence,revision:1,enabled:false,paused:false,cancelled:false,offer:{observedAt:Date.now()},actions:[]}},dropGrant=false
const calls=[]
const fixture=`import React from 'react';import{createRoot}from'react-dom/client';import Panel from ${JSON.stringify(component)};const r=createRoot(document.getElementById('root'));window.remount=()=>r.render(<Panel key={Date.now()} pageId="fixture_page"/>);window.remount();`
const bundle=await build({stdin:{contents:fixture,resolveDir:path.join(root,'client'),loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',alias:{'@':path.join(root,'client/src'),'react':path.join(root,'client/node_modules/react'),'react-dom':path.join(root,'client/node_modules/react-dom')},define:{'process.env.NODE_ENV':'"development"'}})
const postcss=clientRequire('postcss'),tailwind=clientRequire('tailwindcss'),configModule={exports:{}}
new Function('module','require',await fs.readFile(path.join(root,'client/tailwind.config.js'),'utf8'))(configModule,clientRequire)
const css=(await postcss([tailwind({...configModule.exports,content:[{raw:fixture+await fs.readFile(component,'utf8')+await fs.readFile(path.join(root,'client/src/components/ui/button.tsx'),'utf8'),extension:'tsx'}]})]).process(await fs.readFile(path.join(root,'client/src/index.css'),'utf8'),{from:undefined})).css
const server=http.createServer(async(req,res)=>{
 if(req.url==='/api/managed-pilot/pages/fixture_page/conversation-restoration'){
  let body='';for await(const bytes of req)body+=bytes
  const {action,fence:target,expectedRevision,actionId}=JSON.parse(body);calls.push(action);view.observedAt=Date.now()
  if(action!=='inspect'){assert.deepEqual(target,fence);assert.equal(expectedRevision,view.record?.revision??0)}
  if(action==='enable'){view.record.enabled=true;view.record.revision++}
  if(action==='reserve'){assert(view.record.enabled);assert.equal(view.record.actions.length,0);view.record.actions.push({id:actionId,phase:'reserved',at:Date.now(),auditId:null,checkedAt:null,result:null});view.record.revision++;view.budget.used=1;view.budget.pending=true;if(dropGrant){res.statusCode=503;res.end();return}}
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
 const android=process.env.MANAGED_ANDROID_ROOT??path.resolve(root,'../MAPI/Sleeper-cell-main')
 const probe=await fs.readFile(path.join(android,'app/src/main/assets/managed-conversation-probe.js'),'utf8'),open=await fs.readFile(path.join(android,'app/src/main/assets/managed-conversation-open.js'),'utf8'),homeProbe=await fs.readFile(path.join(android,'app/src/main/assets/managed-session-probe.js'),'utf8')
 const dom=await browser.newPage({viewport:{width:390,height:844}});await dom.route('**/*',route=>route.abort())
 const original='https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc',fakeLocation={origin:'https://chatgpt.com',pathname:'/c/12345678-1234-1234-1234-123456789abc',search:'',hash:''}
 const style='<style>body{margin:0}article{min-height:50px}textarea{position:fixed;left:20px;bottom:20px;width:320px;height:60px}button{height:44px}</style>'
 const legacy=()=>style+'<section data-testid="conversation-turn-0"><article data-message-author-role="user"><div class="whitespace-pre-wrap">PRIVATE ORIGINAL PROMPT</div></article></section><section data-testid="conversation-turn-1"><article data-message-author-role="assistant"><pre><code>PRIVATE COMPLETED REPLY</code></pre></article><button data-testid="copy-turn-action-button">Copy</button></section><textarea id="prompt-textarea"></textarea>'
 const sample=()=>dom.evaluate(({source,location})=>new Function('location','return ('+source+')')(location),{source:probe,location:fakeLocation})
 await dom.setContent(legacy());let captured=await sample();assert.equal(captured.prompt,'PRIVATE ORIGINAL PROMPT');assert.equal(captured.reply,'PRIVATE COMPLETED REPLY');assert.equal(captured.url,original)
 const modern=style+'<div data-turn-key="pair" data-talvt-turn-state="complete"><h3 data-conversation-role="user">You said:</h3><article data-content-search-unit-key="message:user"><div class="whitespace-pre-wrap">PRIVATE ORIGINAL PROMPT</div></article><h3 data-conversation-role="assistant">ChatGPT said:</h3><article data-content-search-unit-key="message:assistant"><div data-markdown-text-style="assistant-message"><pre><code>PRIVATE COMPLETED REPLY</code></pre></div></article><div class="turn-action-controls"><button aria-label="Copy">Copy</button></div></div><textarea id="prompt-textarea"></textarea>'
 await dom.setContent(modern);captured=await sample();assert.equal(captured.userKey,'message:user');assert.equal(captured.reply,'PRIVATE COMPLETED REPLY')
 for(const extra of ['<div role="dialog">blocking</div>','<button aria-label="Stop answering">Stop</button>','<input type="file" id="extra"><div data-testid="composer-attachment">draft</div>','<article data-message-author-role="user">Another message</article>']){await dom.setContent(legacy()+extra);assert.equal(await sample(),null)}
 await dom.setContent(legacy());await dom.locator('#prompt-textarea').fill('UNSENT PRIVATE DRAFT');assert.equal(await sample(),null)
 await dom.setContent(legacy());await dom.locator('section').last().locator('button').evaluate(e=>e.remove());assert.equal(await sample(),null)
 await dom.setContent(style+'<textarea id="prompt-textarea"></textarea>')
 const perform=()=>dom.evaluate(({source,probe,target})=>{const location={origin:'https://chatgpt.com',pathname:'/',search:'',hash:'',assign:url=>(window.effects??=[]).push(url)};const sample=new Function('location','return ('+probe+')')(location);return new Function('location','return ('+source+')(arguments[1],arguments[2],true)')(location,target,sample)},{source:open,probe:homeProbe,target:original})
 assert.equal(await perform(),true);assert.deepEqual(await dom.evaluate(()=>window.effects),[original])
 await dom.locator('#prompt-textarea').fill('late draft');assert.equal(await perform(),false);assert.deepEqual(await dom.evaluate(()=>window.effects),[original])
 await dom.locator('#prompt-textarea').fill('');await dom.evaluate(()=>{const e=document.createElement('div');e.setAttribute('role','dialog');e.textContent='overlay';document.body.append(e)});assert.equal(await perform(),false);assert.deepEqual(await dom.evaluate(()=>window.effects),[original]);await dom.close()
 const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors=[]
 page.on('pageerror',e=>errors.push(e.message));const base='http://127.0.0.1:'+server.address().port
 await page.route('**/*',route=>route.request().url().startsWith(base+'/')?route.continue():route.abort())
 await page.goto(base);await page.getByRole('button',{name:'Inspect original conversation restoration',exact:true}).waitFor();assert.deepEqual(calls,[])
 const inspect=()=>page.getByRole('button',{name:'Inspect original conversation restoration',exact:true}).click()
 await inspect();assert(await page.getByRole('button',{name:'Enable conversation restoration',exact:true}).isDisabled())
 await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Enable conversation restoration',exact:true}).click()
 await page.waitForFunction(()=>document.querySelector('input[type=checkbox]')?.checked===false)
 assert(await page.getByRole('button',{name:'Grant one conversation restoration',exact:true}).isDisabled())
 dropGrant=true;await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Grant one conversation restoration',exact:true}).click();await page.getByRole('alert').waitFor()
 await inspect();await page.getByText('Original restoration action: reserved.',{exact:true}).waitFor()
 assert(await page.getByRole('button',{name:'Grant one conversation restoration',exact:true}).isDisabled());assert.equal(calls.filter(c=>c==='reserve').length,1)
 if(retainedFixture)await page.getByText('Retained-view restoration. Candidate: retained_candidate. Binding: retained_view. This is a distinct associated view.',{exact:true}).waitFor()
 await page.screenshot({path:retainedFixture?'/tmp/phase6-retained-conversation-desktop.png':'/tmp/phase6-conversation-desktop.png',fullPage:true})
 await page.setViewportSize({width:390,height:844});view.globalEnabled=false;view.record.actions[0].phase='unknown';view.record.actions[0].effect='possible';await inspect()
 await page.getByText('Original conversation restoration is off.',{exact:true}).waitFor()
 await page.getByText(retainedFixture?'Original restoration action: unknown. Inspect the same retained view and receipt; do not repeat the navigation.':'Original restoration action: unknown. Inspect the same original view and receipt; do not repeat the navigation.',{exact:true}).waitFor()
 await page.getByRole('button',{name:'Cancel conversation restoration',exact:true}).click()
 assert(await page.getByRole('button',{name:'Grant one conversation restoration',exact:true}).isDisabled())
 assert(view.budget.pending);assert.equal(view.budget.used,1);assert.equal(view.record.actions[0].phase,'unknown')
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Mobile document overflow')
 await page.screenshot({path:retainedFixture?'/tmp/phase6-retained-conversation-mobile.png':'/tmp/phase6-conversation-mobile.png',fullPage:true});assert.deepEqual(errors,[])
 assert.equal(calls.filter(c=>c==='reserve').length,1);console.log('PASS: original-conversation DOM and desktop/mobile controls; private exact-turn capture, one guarded original URL navigation, no automatic calls, lost grant retained, unknown stop while off and no overflow.')
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
