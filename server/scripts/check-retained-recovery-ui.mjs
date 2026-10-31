// Synthetic original-phone grant fixture. No live relay/provider/phone traffic.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
const root=fileURLToPath(new URL('../../',import.meta.url)),require=createRequire(import.meta.url)
const {build}=require('esbuild'),{chromium}=require('playwright'),clientRequire=createRequire(path.join(root,'client/package.json'))
const component=path.join(root,'client/src/components/recovery/RetainedRecoveryControls.tsx')
const sourceTime=Date.now()-300000,unit={workspaceId:'fixture',taskId:'task:sha256:'+'a'.repeat(64),attemptId:'original_attempt',generation:1,fingerprint:'b'.repeat(64)}
let item={diagnosis:{unit,revision:1,enabled:true,paused:false,cancelled:false,evidence:{observedAt:sourceTime,failure:'missing_control'},budget:{used:1,pending:true},decision:{state:'held',reason:'Original action retained'}},stop:null},drop=true,remote=null
const calls=[]
const fixture=`import React from 'react';import{createRoot}from'react-dom/client';import Panel from ${JSON.stringify(component)};const r=createRoot(document.getElementById('root'));window.remount=()=>r.render(<Panel key={Date.now()} />);window.remount();`
const bundle=await build({stdin:{contents:fixture,resolveDir:path.join(root,'client'),loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',alias:{'@':path.join(root,'client/src'),'react':path.join(root,'client/node_modules/react'),'react-dom':path.join(root,'client/node_modules/react-dom')},define:{'process.env.NODE_ENV':'"development"'}})
const postcss=clientRequire('postcss'),tailwind=clientRequire('tailwindcss'),configModule={exports:{}}
new Function('module','require',await fs.readFile(path.join(root,'client/tailwind.config.js'),'utf8'))(configModule,clientRequire)
const css=(await postcss([tailwind({...configModule.exports,content:[{raw:fixture+await fs.readFile(component,'utf8')+await fs.readFile(path.join(root,'client/src/components/ui/button.tsx'),'utf8'),extension:'tsx'}]})]).process(await fs.readFile(path.join(root,'client/src/index.css'),'utf8'),{from:undefined})).css
const server=http.createServer(async(req,res)=>{
 if(req.url==='/api/managed-pilot/recovery-retained'){
  let body='';for await(const bytes of req)body+=bytes
  if(req.method==='GET')calls.push('list')
  else {const {action,unit:target,expectedRevision}=JSON.parse(body);assert.deepEqual(target,unit);assert.equal(expectedRevision,item.diagnosis.revision);calls.push(action)
   if(['pause','cancel','disable','reinspect'].includes(action)){item.diagnosis.revision++;item.diagnosis.enabled=false;item.diagnosis.paused=true;item.diagnosis.cancelled=action==='cancel';item.stop={intent:{sequence:(item.stop?.intent.sequence??0)+1,mode:action},receipt:null}}
   if(action==='sync'){remote??={receivedAt:Date.now()};if(drop){drop=false;res.statusCode=503;res.end();return}item.stop.receipt=remote;if(item.stop.intent.mode==='reinspect')item.diagnosis.paused=false}
  }
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({items:[item]}));return
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
 await page.goto(base);await page.getByRole('button',{name:'Refresh retained recovery controls',exact:true}).waitFor();assert.deepEqual(calls,[])
 const refresh=()=>page.getByRole('button',{name:'Refresh retained recovery controls',exact:true}).click()
 const idle=()=>page.waitForFunction(()=>!document.querySelector('button').disabled)
 await refresh();await idle();await page.getByRole('button',{name:'Save local recovery pause',exact:true}).click();await idle()
 await page.getByText('Local recovery hold saved.',{exact:true}).waitFor();await page.getByText('Relay confirmation pending. Remote work has not been confirmed stopped.',{exact:true}).waitFor()
 assert.deepEqual(calls,['list','pause']);assert(await page.getByRole('button',{name:'Prepare fresh inspection',exact:true}).isDisabled())
 await page.getByRole('button',{name:'Cancel recovery for this unit',exact:true}).click();await idle()
 await page.getByRole('button',{name:'Send saved intent to relay',exact:true}).click();await page.getByRole('alert').waitFor();await refresh();await idle()
 await page.getByText('Relay confirmation pending. Remote work has not been confirmed stopped.',{exact:true}).waitFor()
 await page.getByRole('button',{name:'Send saved intent to relay',exact:true}).click();await idle()
 await page.getByText('Relay confirmed recovery cancellation at ',{exact:false}).waitFor();assert(await page.getByRole('button',{name:'Prepare fresh inspection',exact:true}).isDisabled())
 await page.screenshot({path:'/tmp/phase6-retained-recovery-desktop.png',fullPage:true})
 item.diagnosis.cancelled=false;item.stop.intent.mode='pause';remote=null;drop=false
 await page.setViewportSize({width:390,height:844});await refresh();await idle();await page.getByRole('button',{name:'Prepare fresh inspection',exact:true}).click();await idle()
 await page.getByText('Preparation never resumes an action. Relay confirmation, fresh evidence and explicit playbook admission are still required.',{exact:true}).waitFor()
 await page.getByRole('button',{name:'Send saved intent to relay',exact:true}).click();await idle()
 assert.equal(item.diagnosis.enabled,false);assert.equal(item.diagnosis.budget.used,1);assert.equal(item.diagnosis.budget.pending,true)
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Mobile document overflow')
 await page.screenshot({path:'/tmp/phase6-retained-recovery-mobile.png',fullPage:true});assert.deepEqual(errors,[])
 assert.deepEqual(calls,['list','pause','cancel','sync','list','sync','list','reinspect','sync']);console.log('PASS: retained recovery desktop/mobile; no automatic calls, local stop before delivery, lost receipt remains pending, cancellation stays sticky and preparation enables no action.')
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
