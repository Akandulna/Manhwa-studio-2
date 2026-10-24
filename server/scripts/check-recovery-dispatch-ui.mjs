// Synthetic original-phone grant fixture. No live relay/provider/phone traffic.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
const root=fileURLToPath(new URL('../../',import.meta.url)),require=createRequire(import.meta.url)
const {build}=require('esbuild'),{chromium}=require('playwright'),clientRequire=createRequire(path.join(root,'client/package.json'))
const component=path.join(root,'client/src/components/recovery/ManagedRecoveryDispatch.tsx')
const grant={kind:'restore_conversation',actionId:'original_approved',grantRevision:3,fenceSha256:'a'.repeat(64),deviceId:'original_phone',profileId:'original_profile'}
let view={globalEnabled:true,pageLabel:'page_001.png',grants:[grant],tickets:[]},dropQueue=false
const calls=[]
const fixture=`import React from 'react';import{createRoot}from'react-dom/client';import Panel from ${JSON.stringify(component)};const r=createRoot(document.getElementById('root'));window.remount=()=>r.render(<Panel key={Date.now()} pageId="fixture_page"/>);window.remount();`
const bundle=await build({stdin:{contents:fixture,resolveDir:path.join(root,'client'),loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',alias:{'@':path.join(root,'client/src'),'react':path.join(root,'client/node_modules/react'),'react-dom':path.join(root,'client/node_modules/react-dom')},define:{'process.env.NODE_ENV':'"development"'}})
const postcss=clientRequire('postcss'),tailwind=clientRequire('tailwindcss'),configModule={exports:{}}
new Function('module','require',await fs.readFile(path.join(root,'client/tailwind.config.js'),'utf8'))(configModule,clientRequire)
const css=(await postcss([tailwind({...configModule.exports,content:[{raw:fixture+await fs.readFile(component,'utf8')+await fs.readFile(path.join(root,'client/src/components/ui/button.tsx'),'utf8'),extension:'tsx'}]})]).process(await fs.readFile(path.join(root,'client/src/index.css'),'utf8'),{from:undefined})).css

const server=http.createServer(async(req,res)=>{
 if(req.url==='/api/managed-pilot/pages/fixture_page/recovery-dispatch'){
  let body='';for await(const bytes of req)body+=bytes
  const input=JSON.parse(body);calls.push(input)
  if(input.action==='queue'){
   assert.deepEqual(input,{action:'queue',kind:grant.kind,actionId:grant.actionId,grantRevision:grant.grantRevision,fenceSha256:grant.fenceSha256})
   assert.equal(view.tickets.length,0);view.tickets.push({id:'original_delivery',kind:grant.kind,revision:1,phase:'queued',expiresAt:Date.now()+120000,deviceId:grant.deviceId,profileId:grant.profileId})
   if(dropQueue){res.statusCode=503;res.end();return}
  }
  if(input.action==='cancel'){assert.equal(input.ticketId,'original_delivery');assert.equal(input.revision,1);view.tickets[0].phase='cancelled';view.tickets[0].revision++}
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
 await page.goto(base);await page.getByRole('button',{name:'Inspect original phone delivery',exact:true}).waitFor();assert.deepEqual(calls,[])
 const inspect=()=>page.getByRole('button',{name:'Inspect original phone delivery',exact:true}).click()
 const queue=()=>page.getByRole('button',{name:'Queue original phone delivery',exact:true})
 await inspect();await page.getByRole('combobox').waitFor();assert(await queue().isDisabled())
 await page.getByRole('combobox').selectOption(grant.kind+':'+grant.actionId);assert(await queue().isDisabled())
 await page.getByRole('checkbox').check();assert(!(await queue().isDisabled()))
 await page.screenshot({path:'/tmp/phase6-dispatch-desktop.png',fullPage:true})
 dropQueue=true;await queue().click();await page.getByRole('alert').waitFor();await inspect()
 await page.getByText('restore_conversation: queued.',{exact:false}).waitFor();assert.equal(calls.filter(c=>c.action==='queue').length,1);assert(await queue().isDisabled())
 await page.setViewportSize({width:390,height:844});view.globalEnabled=false;await inspect();await page.getByText('page_001.png. Delivery is off.',{exact:true}).waitFor()
 assert(await page.getByRole('combobox').isDisabled());assert(await queue().isDisabled())
 await page.getByRole('button',{name:'Cancel this delivery',exact:true}).click();await page.getByText('restore_conversation: cancelled.',{exact:false}).waitFor()
 assert(await page.getByRole('button',{name:'Cancel this delivery',exact:true}).isDisabled())
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Mobile document overflow')
 await page.screenshot({path:'/tmp/phase6-dispatch-mobile.png',fullPage:true});assert.deepEqual(errors,[]);assert.equal(calls.filter(c=>c.action==='queue').length,1)
 console.log('PASS: desktop/mobile exact original grant delivery; no automatic fetch; separate confirmation; lost queue ack retained; stop while off; no overflow.')
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
