// Isolated synthetic UI QA. Serves a temporary bundle on an OS-assigned loopback port; no live API or provider calls.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
const root=fileURLToPath(new URL('../../',import.meta.url)),require=createRequire(import.meta.url)
const {build}=require('esbuild'),{chromium}=require('playwright')
const clientRequire=createRequire(path.join(root,'client/package.json'))
const postcss=clientRequire('postcss'),tailwind=clientRequire('tailwindcss')
const panel=path.join(root,'client/src/components/recovery/SavedCropRecoveryPanel.tsx')
const wrapper=path.join(root,'client/src/components/recovery/ManagedSavedCropRecovery.tsx')
const target={workspaceId:'fixture',taskId:'task:sha256:'+'a'.repeat(64),attemptId:'fixture_attempt',generation:1,fingerprint:'b'.repeat(64),artifactId:'fixture_crop',sha256:'c'.repeat(64),destinationId:'d'.repeat(64),chapterLabel:'Synthetic Chapter 1',pageLabel:'page_001.png',destinationLabel:'Private local crop store'}
let view={target,observedAt:Date.now(),globalEnabled:true,canonical:true,sourceMatches:true,localState:'missing',episode:{revision:1,enabled:false,paused:false,cancelled:false,nextEligibleAt:0,actions:[]}}
const calls=[],automationCalls=[]
let diagnosis={revision:1,enabled:false,paused:false,cancelled:false,evidence:{observedAt:Date.now(),failure:'local_import'},budget:{used:0,uiUsed:0,pending:false},decision:{state:'held',reason:'Recovery is disabled',requiredPostcondition:'Exact canonical artifact, source and local publication readback',recheckAt:null},history:[]}

const fixture=`import React from 'react';import{createRoot}from'react-dom/client';import Panel from ${JSON.stringify(wrapper)};
const root=createRoot(document.getElementById('root'));window.remount=()=>root.render(<Panel key={Date.now()} pageId="fixture_page"/>);window.remount();`

const bundle=await build({stdin:{contents:fixture,resolveDir:path.join(root,'client'),loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',alias:{'@':path.join(root,'client/src'),'react':path.join(root,'client/node_modules/react'),'react-dom':path.join(root,'client/node_modules/react-dom')},define:{'process.env.NODE_ENV':'"development"'}})
const configText=await fs.readFile(path.join(root,'client/tailwind.config.js'),'utf8')
const configModule={exports:{}};new Function('module','require',configText)(configModule,clientRequire)
const config={...configModule.exports,content:[{raw:fixture+'\n'+await fs.readFile(panel,'utf8')+'\n'+await fs.readFile(wrapper,'utf8')+'\n'+await fs.readFile(path.join(root,'client/src/components/ui/button.tsx'),'utf8')+'\n'+await fs.readFile(path.join(root,'client/src/components/ui/card.tsx'),'utf8'),extension:'tsx'}]}
const css=(await postcss([tailwind(config)]).process(await fs.readFile(path.join(root,'client/src/index.css'),'utf8'),{from:undefined})).css
const requests=[];const server=http.createServer(async(req,res)=>{
 requests.push(req.url)
 if(req.url==='/api/managed-pilot/pages/fixture_page/automation-recovery'){
  let text='';for await(const bytes of req)text+=bytes
  const {action,target:chosen,expectedRevision}=JSON.parse(text);assert.deepEqual(chosen,target);automationCalls.push(action)
  if(action!=='inspect'){assert.equal(expectedRevision,diagnosis.revision);diagnosis.revision++;diagnosis.enabled=action==='enable';diagnosis.paused=action==='pause';diagnosis.cancelled=action==='cancel';diagnosis.decision={...diagnosis.decision,state:action==='enable'?'ready':'held',reason:action==='enable'?'Restore the original saved crop':'Recovery is '+action+'d'}}
  diagnosis.history.push({at:Date.now(),state:diagnosis.decision.state,reason:diagnosis.decision.reason})
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({diagnosis,globalEnabled:view.globalEnabled}));return
 }
 if(req.url==='/api/managed-pilot/pages/fixture_page/recovery'){
  res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store')
  if(req.method==='GET'){calls.push('targets');res.end(JSON.stringify({targets:[target]}));return}
  let text='';for await(const bytes of req)text+=bytes
  const {action,target:chosen,expectedRevision,actionId}=JSON.parse(text)
  assert.deepEqual(chosen,target);calls.push(action)
  view.observedAt=Date.now()
  if(action==='enable'){assert.equal(expectedRevision,view.episode.revision);view.episode.enabled=true;view.episode.revision++}
  if(action==='run'){assert.equal(expectedRevision,view.episode.revision);assert.equal(view.episode.enabled,true);assert.equal(view.episode.actions.length,0);view.localState='verified';view.episode.revision++;view.episode.actions.push({id:actionId,phase:'verified',at:Date.now(),finishedAt:Date.now()})}
  res.end(JSON.stringify(view));return
 }
 if(req.url==='/bundle.js'){res.setHeader('Content-Type','application/javascript');res.end(bundle.outputFiles[0].text)}
 else if(req.url==='/styles.css'){res.setHeader('Content-Type','text/css');res.end(css)}
 else if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><main style="max-width:1000px;margin:20px auto;padding:16px"><div id="root"></div></main><script src="/bundle.js"></script>')}
 else{res.statusCode=404;res.end()}
})

let browser
try{
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1280,height:1000}})
 const errors=[];page.on('pageerror',e=>errors.push(e.message));const base='http://127.0.0.1:'+server.address().port
 await page.route('**/*',route=>route.request().url().startsWith(base+'/')?route.continue():route.abort())
 await page.goto(base);await page.getByRole('button',{name:'Open saved crop recovery'}).waitFor()
 assert.deepEqual(calls,[])
 await page.getByRole('button',{name:'Open saved crop recovery'}).click()
 await page.getByRole('heading',{name:'Restore a saved crop result'}).waitFor()
 assert.deepEqual(calls,['targets'])
 await page.getByRole('combobox').selectOption({index:1});assert.deepEqual(calls,['targets'])
 await page.getByRole('button',{name:'Inspect saved result',exact:true}).click()
 await page.getByText('Disabled for this scope. Attempts used: 0/3.').waitFor()
 assert(await page.getByRole('button',{name:'Restore local copy',exact:true}).isDisabled())
 await page.getByRole('checkbox').first().check();await page.getByRole('button',{name:'Enable this recovery',exact:true}).click()
 await page.getByText('Enabled for this scope. Attempts used: 0/3.').waitFor()
 assert(await page.getByRole('button',{name:'Restore local copy',exact:true}).isDisabled())
 const auto=page.getByRole('region',{name:'Automation recovery'})
 assert.deepEqual(automationCalls,[])
 await auto.getByRole('button',{name:'Inspect automation recovery',exact:true}).click()
 await auto.getByText('held: Recovery is disabled',{exact:true}).waitFor()
 assert(await auto.getByRole('button',{name:'Allow automatic restore',exact:true}).isDisabled())
 await auto.getByRole('checkbox').check();await auto.getByRole('button',{name:'Allow automatic restore',exact:true}).click()
 await auto.getByText('ready: Restore the original saved crop',{exact:true}).waitFor()
 assert(!(await auto.getByRole('checkbox').isChecked()))
 await auto.getByRole('button',{name:'Pause automation recovery',exact:true}).click()
 await auto.getByText('held: Recovery is paused',{exact:true}).waitFor()
 assert.deepEqual(automationCalls,['inspect','enable','pause'])
 await page.getByRole('checkbox').first().check();await page.getByRole('button',{name:'Restore local copy',exact:true}).click()
 await page.getByText('Local copy verified',{exact:true}).first().waitFor()
 assert.deepEqual(calls,['targets','inspect','enable','run'])
 assert(await page.getByRole('button',{name:'Restore local copy',exact:true}).isDisabled())
 assert(await page.getByRole('button',{name:'Pause recovery',exact:true}).isDisabled())
 await page.screenshot({path:'/tmp/phase6-recovery-bridge-desktop.png',fullPage:true})
 await page.setViewportSize({width:390,height:844});view={...view,localState:'missing',globalEnabled:false,episode:{...view.episode,actions:[{id:'retained_action',phase:'unknown',at:Date.now(),finishedAt:Date.now()}]}};await page.evaluate(()=>window.remount());await page.getByRole('button',{name:'Open saved crop recovery'}).click();await page.getByRole('combobox').selectOption({index:1});await page.getByRole('button',{name:'Inspect saved result',exact:true}).click()
 await page.getByText('Recovery is off. Pending outcomes can still be checked.',{exact:true}).first().waitFor()
 assert(await page.getByRole('button',{name:'Check saved outcome',exact:true}).isEnabled());assert(await page.getByRole('button',{name:'Restore local copy',exact:true}).isDisabled())
 await page.getByText('Saved result identity',{exact:true}).click()
 await page.getByRole('button',{name:'Inspect automation recovery',exact:true}).click();await page.getByText('Automatic recovery is globally disabled.',{exact:true}).waitFor()
 assert(await page.getByRole('button',{name:'Allow automatic restore',exact:true}).isDisabled())
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Mobile document overflow')
 await page.screenshot({path:'/tmp/phase6-recovery-bridge-mobile.png',fullPage:true})
 assert.deepEqual(errors,[]);assert.deepEqual(calls,['targets','inspect','enable','run','targets','inspect']);assert(requests.every(url=>!url.startsWith('/api')||['/api/managed-pilot/pages/fixture_page/recovery','/api/managed-pilot/pages/fixture_page/automation-recovery'].includes(url)))
 console.log('PASS: mounted recovery entry point and HTTP gateway on desktop/mobile; explicit discovery/inspection, confirmation, one-shot restore, durable automation enrollment/pause controls, off-switch unknown hold, no automatic API calls, overflow or runtime errors.')
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
