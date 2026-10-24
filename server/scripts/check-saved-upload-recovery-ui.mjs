// Synthetic original-phone grant fixture. No live relay/provider/phone traffic.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
const root=fileURLToPath(new URL('../../',import.meta.url)),require=createRequire(import.meta.url)
const {build}=require('esbuild'),{chromium}=require('playwright'),clientRequire=createRequire(path.join(root,'client/package.json'))
const component=path.join(root,'client/src/components/recovery/ManagedSavedUploadRecovery.tsx')
const fence={workspaceId:'fixture',taskId:'task:sha256:'+'a'.repeat(64),attemptId:'original_attempt',generation:1,fingerprint:'b'.repeat(64),artifactId:'original_saved_crop',sha256:'c'.repeat(64),commandId:'original_command',checkpointRef:'checkpoint/original'}
let view={pageLabel:'page_001.png',observedAt:Date.now(),globalEnabled:true,budget:{used:0,nextEligibleAt:0,pending:false,exhausted:false},episode:{fence,revision:1,enabled:false,paused:false,cancelled:false,actions:[]},diagnosis:{decision:{state:'held',reason:'Saved upload is disabled'}}},dropGrant=false
const calls=[]
const fixture=`import React from 'react';import{createRoot}from'react-dom/client';import Panel from ${JSON.stringify(component)};const r=createRoot(document.getElementById('root'));window.remount=()=>r.render(<Panel key={Date.now()} pageId="fixture_page"/>);window.remount();`
const bundle=await build({stdin:{contents:fixture,resolveDir:path.join(root,'client'),loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',alias:{'@':path.join(root,'client/src'),'react':path.join(root,'client/node_modules/react'),'react-dom':path.join(root,'client/node_modules/react-dom')},define:{'process.env.NODE_ENV':'"development"'}})
const postcss=clientRequire('postcss'),tailwind=clientRequire('tailwindcss'),configModule={exports:{}}
new Function('module','require',await fs.readFile(path.join(root,'client/tailwind.config.js'),'utf8'))(configModule,clientRequire)
const css=(await postcss([tailwind({...configModule.exports,content:[{raw:fixture+await fs.readFile(component,'utf8')+await fs.readFile(path.join(root,'client/src/components/ui/button.tsx'),'utf8'),extension:'tsx'}]})]).process(await fs.readFile(path.join(root,'client/src/index.css'),'utf8'),{from:undefined})).css
const server=http.createServer(async(req,res)=>{
 if(req.url==='/api/managed-pilot/pages/fixture_page/upload-recovery'){
  let body='';for await(const bytes of req)body+=bytes
  const {action,fence:target,expectedRevision,actionId}=JSON.parse(body);calls.push(action);view.observedAt=Date.now()
  if(action!=='inspect'){assert.deepEqual(target,fence);assert.equal(expectedRevision,view.episode.revision)}
  if(action==='enable'){view.episode.enabled=true;view.episode.revision++;view.diagnosis.decision={state:'ready',reason:'Original saved packet is eligible'}}
  if(action==='reserve'){assert(view.episode.enabled);assert.equal(view.episode.actions.length,0);view.episode.actions.push({id:actionId,phase:'reserved',at:Date.now()});view.episode.revision++;view.budget.used=1;view.budget.pending=true;view.diagnosis.decision={state:'held',reason:'Original recovery action needs reconciliation'};if(dropGrant){res.statusCode=503;res.end();return}}
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
 await page.goto(base);await page.getByRole('button',{name:'Inspect saved upload recovery',exact:true}).waitFor();assert.deepEqual(calls,[])
 await page.getByRole('button',{name:'Inspect saved upload recovery',exact:true}).click();await page.getByText('Last inspected shared attempts: 0/3. Upload: not started.',{exact:true}).waitFor()
 assert(await page.getByRole('button',{name:'Enable saved upload',exact:true}).isDisabled())
 await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Enable saved upload',exact:true}).click();await page.getByText('ready: Original saved packet is eligible',{exact:true}).waitFor()
 assert(!(await page.getByRole('checkbox').isChecked()));assert(await page.getByRole('button',{name:'Grant one saved upload',exact:true}).isDisabled())
 // Losing a grant acknowledgment cannot result in another grant or any upload call.
 dropGrant=true;await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Grant one saved upload',exact:true}).click();await page.getByRole('alert').waitFor()
 await page.getByRole('button',{name:'Inspect saved upload recovery',exact:true}).click();await page.getByText('Grant retained.',{exact:false}).waitFor()
 assert(await page.getByRole('button',{name:'Grant one saved upload',exact:true}).isDisabled());assert.deepEqual(calls,['inspect','enable','reserve','inspect'])
 await page.screenshot({path:'/tmp/phase6-saved-upload-desktop.png',fullPage:true})
 await page.setViewportSize({width:390,height:844});view.globalEnabled=false;view.episode.actions[0].phase='unknown';await page.evaluate(()=>window.remount());await page.getByRole('button',{name:'Inspect saved upload recovery',exact:true}).click()
 await page.getByText('Saved-upload recovery is off. Retained outcomes can still be inspected.',{exact:true}).waitFor()
 assert(await page.getByRole('button',{name:'Check original cloud upload',exact:true}).isEnabled());assert(await page.getByRole('button',{name:'Grant one saved upload',exact:true}).isDisabled())
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Mobile document overflow')
 await page.screenshot({path:'/tmp/phase6-saved-upload-mobile.png',fullPage:true});assert.deepEqual(errors,[])
 assert(!calls.includes('upload'));console.log('PASS: saved-upload desktop/mobile controls; no automatic calls, exact confirmation, lost-grant hold without duplicate reservation, off-switch reconciliation and no browser upload/provider dispatch.')
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
