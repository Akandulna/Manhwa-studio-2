import fs from 'node:fs';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import sharp from 'sharp';
import os from 'node:os';
import path from 'node:path';
const crops=Array.from({length:5},(_,i)=>({id:`crop-${i+1}`,reason:`Fixture panel ${i+1}`,crop:{points:[{x:0,y:i/5},{x:1,y:i/5},{x:1,y:(i+1)/5},{x:0,y:(i+1)/5}]}}));
const original={revision:'c'.repeat(64),taskId:'task:sha256:'+'a'.repeat(64),fingerprint:'b'.repeat(64),reviewed:false,reviewedAt:null,chapterId:'fixture-chapter',filename:'fixture.png',pointers:{image:{filename:'fixture.png',width:800,height:1200},crops},metadata:{crops:crops.map((c,i)=>({id:c.id,description:`Fixture description ${i+1}`,exportedFilename:`fixture_panel_${i+1}.png`}))},cut:{complete:false,files:[]}};
const source=await sharp({create:{width:800,height:1200,channels:3,background:'white'}}).png().toBuffer();
const artifacts=process.env.MANAGED_REVIEW_UI_ARTIFACTS||path.join(os.tmpdir(),'managed-review-ui');fs.mkdirSync(artifacts,{recursive:true});
let current=structuredClone(original),rejectNext=false;const writes=[];
const executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||(fs.existsSync(chromium.executablePath())?chromium.executablePath():(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined));
const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
try {
 const context=await browser.newContext({viewport:{width:1200,height:900},serviceWorkers:'block'});const page=await context.newPage();page.setDefaultTimeout(8000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',async route=>{
  const r=route.request(),u=new URL(r.url());let result={};
  if(u.pathname.includes('/clipper3/chapters/')&&u.pathname.includes('/image/'))return route.fulfill({status:200,contentType:'image/png',body:source});
  if(r.method()!=='GET') {
   assert.match(u.pathname,/^\/api\/managed-pilot\/pages\/page\/(review|cut)$/);writes.push({path:u.pathname,body:r.postDataJSON()});
   if(rejectNext){rejectNext=false;return route.fulfill({status:409,json:{error:'Crop input changed; reopen its preview before reviewing or cutting'}})}
   if(u.pathname.endsWith('/review')){current.reviewed=r.postDataJSON().reviewed;current.reviewedAt=current.reviewed?new Date().toISOString():null;if(!current.reviewed)current.cut={complete:false,files:[]}}
   else {assert.equal(current.reviewed,true);current.cut={complete:true,files:current.metadata.crops.map(m=>({filename:m.exportedFilename,width:800,height:100,bytes:1,sha256:'a'.repeat(64)}))}}
   return route.fulfill({status:200,json:current});
  }
  if(u.pathname==='/api/managed-pilot/options')result={enabled:true,workspaceId:'fixture',series:[{id:'series',title:'Review fixture'}],profiles:[]};
  else if(u.pathname==='/api/series/series')result={chapters:[{id:'chapter',number:1}]};
  else if(u.pathname==='/api/chapters/chapter')result={pages:[{id:'page',index:8,status:'done'}]};
  else if(u.pathname.startsWith('/api/managed-pilot/tasks/'))result={task:{id:original.taskId,state:'verified_complete',generation:1,canonical:'fixture'},attempt:{phase:'published',submission:'saved',deviceId:'fixture',profileId:'fixture'},commands:[]};
  else if(u.pathname==='/api/managed-pilot/pages/page/review')result=current;
  else if(u.pathname==='/api/clipper3/chapters/chapter/images')result={chapterId:'chapter',number:1,title:'Managed review fixture',seriesId:'series',seriesTitle:'Review fixture',images:[{filename:'fixture.png',width:800,height:1200,hasPoints:true,hasMetadata:true,metadataValid:true,metadataErrors:[],cropCount:5,status:'done',managed:{pageId:'page',taskId:original.taskId}}],cropOutputs:{complete:false,files:0,missing:0,extra:0,changed:1},review:{reviewed:false,reviewedAt:null,by:null,cropped:false,croppedAt:null},neighbours:{previous:null,next:null}};
  else if(u.pathname==='/api/clipper3/chapters/chapter/review')result={reviewed:current.reviewed&&current.cut.complete,reviewedAt:current.reviewedAt,by:current.cut.complete?'cropped':null,cropped:current.cut.complete,croppedAt:null};

  else return route.continue();
  return route.fulfill({status:200,json:result});
 });
 await page.goto(new URL('/sleeper-cells/managed',process.env.MANAGED_REVIEW_UI_BASE_URL||'http://localhost:5173').href);
 await page.screenshot({path:path.join(artifacts,'initial.png')});
 await page.getByRole('combobox',{name:/^Series/}).selectOption('series');
 await page.getByRole('combobox',{name:/^Chapter/}).selectOption('chapter');
 await page.getByRole('combobox',{name:/^Page/}).selectOption('page');
 await page.getByLabel('Task ID from phone inspection').fill(original.taskId);
 await page.getByRole('button',{name:'Open retained task',exact:true}).click();
 await page.getByRole('button',{name:'Open or refresh crop preview',exact:true}).click();
 await page.getByRole('button',{name:'Mark this page reviewed',exact:true}).waitFor();
 assert.equal(await page.locator('polygon').count(),5);
 assert.equal(await page.getByRole('button',{name:'Cut reviewed page',exact:true}).isDisabled(),true);
 const img=page.locator('section img');await img.evaluate(img=>img.decode());
 const imageBox=await img.boundingBox(),overlay=await page.locator('section svg').boundingBox();assert.ok(Math.abs(imageBox.height-overlay.height)<1&&Math.abs(imageBox.width-overlay.width)<1);
 await page.getByRole('heading',{name:'Review published page',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(artifacts,'preview.png')});
 await page.getByRole('button',{name:'Mark this page reviewed',exact:true}).click();
 await page.getByRole('button',{name:'Cut reviewed page',exact:true}).click();
 await page.getByText('5 verified cut files',{exact:false}).waitFor();assert.equal(await page.locator('section a[target="_blank"]').count(),5);
 await page.getByRole('button',{name:'Unmark page review',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(artifacts,'cut.png')});
 await page.getByRole('button',{name:'Unmark page review',exact:true}).click();await page.getByText('Page cut is incomplete',{exact:false}).waitFor();assert.equal(await page.locator('section a[target="_blank"]').count(),0);
 rejectNext=true;await page.getByRole('button',{name:'Mark this page reviewed',exact:true}).click();await page.getByRole('alert').filter({hasText:'Crop input changed'}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Cut reviewed page',exact:true}).count(),0);assert.deepEqual(errors,[]);
 assert.equal(writes.length,4);
 current=structuredClone(original);
 await page.goto(new URL('/clipper3/chapter/chapter/preview',process.env.MANAGED_REVIEW_UI_BASE_URL||'http://localhost:5173').href);
 await page.getByRole('heading',{name:'Review published page',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Mark reviewed',exact:true}).count(),0);
 assert.equal(await page.getByText('Autosave on',{exact:true}).count(),0);
 await page.getByRole('button',{name:'Open or refresh crop preview',exact:true}).click();
 await page.getByRole('button',{name:'Mark this page reviewed',exact:true}).click();
 await page.getByRole('button',{name:'Cut reviewed page',exact:true}).click();
 await page.getByText('5 verified cut files',{exact:false}).waitFor();
 await page.getByRole('heading',{name:'Review published page',exact:true}).scrollIntoViewIfNeeded();
 await page.screenshot({path:path.join(artifacts,'chapter-preview-managed-review.png')});
 assert.equal(writes.length,6);assert.deepEqual(errors,[]);
 const summary={chapterPreviewUsesManagedControls:true,chapterPreviewNoLegacyApproval:true,previewRendered:true,normalizedOverlayMatchesImage:true,crops:5,unreviewedCutDisabled:true,mockedReviewAndCut:true,mockedOutputLinks:5,revocationHidesLinks:true,staleApprovalClearsControls:true,consoleErrors:errors,allWritesInterceptedInIsolatedBrowser:writes.length};fs.writeFileSync(path.join(artifacts,'results.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
}finally{await browser.close()}
