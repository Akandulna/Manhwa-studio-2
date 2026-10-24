// Synthetic original-phone grant fixture. No live relay/provider/phone traffic.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
const root=fileURLToPath(new URL('../../',import.meta.url)),require=createRequire(import.meta.url)
const {build}=require('esbuild'),{chromium}=require('playwright'),clientRequire=createRequire(path.join(root,'client/package.json'))
const component=path.join(root,'client/src/components/recovery/ManagedExecutorEvidence.tsx')
const sourceTime=Date.now()-300000
let view={evidence:[{observation:{id:'original',failure:'missing_control',observedAt:sourceTime,outcome:'unknown',uiChangeId:'a'.repeat(64),session:{observedAt:sourceTime-500,context:'held',documentKind:'chatgpt_home',composer:'nonempty',attachments:'none',response:'none',cachedSourceVerified:true,login:'unknown'}},receivedAt:Date.now()}],outcome:'unknown',budget:{used:1},stale:true,diagnosis:null},fail=false
view.evidence.push({observation:{id:'original_context',failure:'malformed_output',observedAt:sourceTime-1000,outcome:'submitted',uiChangeId:null,correctionContext:{capturedAt:sourceTime-600000,state:'scoped',lockedCandidates:1,failedCandidates:1,executable:false,portable:false,liveConversationVerified:false}},receivedAt:Date.now()})
const calls=[]
const fixture=`import React from 'react';import{createRoot}from'react-dom/client';import Panel from ${JSON.stringify(component)};const r=createRoot(document.getElementById('root'));window.remount=()=>r.render(<Panel key={Date.now()} pageId="fixture_page"/>);window.remount();`
const bundle=await build({stdin:{contents:fixture,resolveDir:path.join(root,'client'),loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',alias:{'@':path.join(root,'client/src'),'react':path.join(root,'client/node_modules/react'),'react-dom':path.join(root,'client/node_modules/react-dom')},define:{'process.env.NODE_ENV':'"development"'}})
const postcss=clientRequire('postcss'),tailwind=clientRequire('tailwindcss'),configModule={exports:{}}
new Function('module','require',await fs.readFile(path.join(root,'client/tailwind.config.js'),'utf8'))(configModule,clientRequire)
const css=(await postcss([tailwind({...configModule.exports,content:[{raw:fixture+await fs.readFile(component,'utf8')+await fs.readFile(path.join(root,'client/src/components/ui/button.tsx'),'utf8'),extension:'tsx'}]})]).process(await fs.readFile(path.join(root,'client/src/index.css'),'utf8'),{from:undefined})).css
const server=http.createServer(async(req,res)=>{
 if(req.url==='/api/managed-pilot/pages/fixture_page/executor-evidence'){
  let body='';for await(const bytes of req)body+=bytes
  assert.deepEqual(JSON.parse(body),{});calls.push('inspect');if(fail){res.statusCode=503;res.end();return}
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
 await page.goto(base);await page.getByRole('button',{name:'Inspect phone failure observations',exact:true}).waitFor();assert.deepEqual(calls,[])
 const inspect=()=>page.getByRole('button',{name:'Inspect phone failure observations',exact:true}).click()
 await inspect();await page.getByText('Source evidence is stale or superseded. Its source time is retained; a newer observation is required.',{exact:true}).waitFor()
 assert(await page.getByText('Observed '+new Date(sourceTime).toISOString()+'. Received ',{exact:false}).count()===1)
 await page.getByText('This observation grants no navigation or resend. Login and quota readiness require separate verification.',{exact:true}).waitFor()
 await page.getByText('Original private correction context: failed fields scoped; captured '+new Date(sourceTime-600000).toISOString()+'.',{exact:true}).waitFor()
 await page.getByText('Validator-valid candidates locked: 1. Candidates with failed fields: 1.',{exact:true}).waitFor()
 assert(await page.getByRole('button').count()===1);assert.deepEqual(calls,['inspect'])
 await page.screenshot({path:'/tmp/phase6-executor-evidence-desktop.png',fullPage:true})
 await page.setViewportSize({width:390,height:844});await inspect();await page.waitForFunction(()=>!document.querySelector('button').disabled);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Mobile document overflow')
 await page.screenshot({path:'/tmp/phase6-executor-evidence-mobile.png',fullPage:true})
 fail=true;await inspect();await page.getByRole('alert').waitFor();assert(await page.getByRole('listitem').count()===0);assert.deepEqual(errors,[])
 assert.deepEqual(calls,['inspect','inspect','inspect']);console.log('PASS: executor observations desktop/mobile; manual inspection only, true stale session/context source times, private correction scope with no execution permission, retained uncertainty, no execution controls, unavailable authority holds and no overflow.')
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
