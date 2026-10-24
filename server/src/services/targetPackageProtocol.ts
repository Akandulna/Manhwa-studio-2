import {recoveryUnitKey,type RecoveryUnit} from './automationRecoveryPolicy.js'
import {fallbackTargets,type FallbackTarget} from './fallbackPreflightProtocol.js'
import {TaskConflict,canonicalJson} from './managedTaskProtocol.js'
import {recoveryExact,recoveryHash,recoveryId} from './managedSavedImportRecoveryProtocol.js'
export const TARGET_PACKAGE_SCHEMA='managed-target-package-check/1'
export const TARGET_PACKAGE_CAPABILITY='target-package-check/1'
export const REVIEW_FLAGS=['seam_crossing','boundary_uncertain','possible_multiple_shots','tall_continuous_scene','small_detail_unreadable','clipped_subject','possible_duplicate','needs_closer_view']
export async function packageHash(value:string){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(v=>v.toString(16).padStart(2,'0')).join('')}
export interface PackageSource {filename:string;sha256:string;width:number;height:number}
/** Exactly the existing sliced crop prompt. No rule-library, earlier-message or provider-model claims. */
export function targetPackagePrompt(manifest:any):string {
 const s=manifest.source,source={pageStem:s.page_stem,seriesTitle:s.series_title,chapterFolder:s.chapter_folder,sha256:s.sha256,width:s.width,height:s.height},slices=manifest.slices,first=slices[0],handoff={jobId:manifest.job_id}
 const sliceLines=slices.map((s:any)=>`  ${s.id} = ${s.file} — ${s.width}×${s.height} px, page y ${s.y0}–${s.y1}`).join('\n')
 const count=slices.length,pageImages=`The ${count} image${count===1?' attached to this message is':'s attached to this message are'} losslessly cut, ordered, full-width vertical slices of that single page (${source.width}×${source.height} px). Attach order and file names:`
 const example={schema_version:'chatgpt-analysis/1.0',job_id:handoff.jobId,source_sha256:source.sha256,page_stem:source.pageStem,source_width:source.width,source_height:source.height,coordinate_system:'slice_local_pixels',page_inspection_complete:true,candidates:[{candidate_id:'candidate-01',reason:'framed_reaction',top_left:{slice_id:first.id,x:35,y:110},bottom_right:{slice_id:first.id,x:Math.min(1045,source.width),y:Math.min(810,first.height)},description:'A dark-haired character appears in a close reaction shot against a softly shaded background.',visual_evidence:'Distinct framed shot with one main reaction',review_flags:[]}],page_review_flags:[]}
 return [
  `You are analyzing ONE manhwa page: "${source.pageStem}" from ${source.seriesTitle}, ${source.chapterFolder}.`,
  ``,
  pageImages,
  sliceLines,
  ``,
  `HOW TO LOOK`,
  `- Inspect the whole page top to bottom, including both sides of every slice seam. A seam is NOT a panel boundary.`,
  `- Identify every independently readable illustrated moment: framed panels, distinct shots inside continuous artwork, small inserts, grayscale scenes, objects, landscapes and effects shots.`,
  `- Do not split continuous action just because it is tall. Do not merge different shots just because their backgrounds match.`,
  `- Speech bubbles, narration boxes and SFX never start or split a crop.`,
  `- Edges follow the artwork: a crop starts where its artwork starts and ends where it ends. A bubble, narration box or caption/system text window above or below the art stays outside the crop; keep only what overlaps the art.`,
  `- Between two unframed shots, end each crop at its own artwork. The plain, dark or textured background between them belongs to neither crop — do not share it out between them.`,
  `- A stretch holding only speech/thought/narration bubbles, caption boxes or SFX is NOT a crop. A plain, gradient, sky, sparkle, particle, glow or speed-line background behind them does not count as artwork — leave that stretch uncovered.`,
  `- Self-check every crop: if its honest description would be mainly bubbles, narration or lettering over a background (not a person, creature, object, place or action), drop it.`,
  `- Keep people, faces, hands, clothing, weapons and important effects whole.`,
  `- If crop rules were shared earlier in this conversation, apply them to decide WHAT to crop. The JSON contract below overrides any output format they describe.`,
  ``,
  `HOW TO MEASURE (important)`,
  `- Give each crop's top-left and bottom-right corner in the pixel grid of the SLICE that corner falls in: { "slice_id", "x", "y" }, with x from 0 to the slice width and y from 0 to that slice's height. Do NOT add slice offsets yourself.`,
  `- bottom_right is exclusive (the first pixel row/column outside the crop). A crop crossing a seam simply has its two corners in different slices.`,
  `- Use integers. If a boundary is uncertain, give your best estimate AND add the flag "boundary_uncertain" — never invent precision.`,
  ``,
  `WHAT TO WRITE PER CROP`,
  `- reason: a short factual snake_case label (e.g. framed_reaction, action_effects, wide_landscape).`,
  `- description: ONE plain sentence of 12–35 words ending in a period, describing only visible artwork. No character names, no plot, no dialogue transcription.`,
  `- visual_evidence: a short phrase saying why this is its own crop.`,
  `- review_flags: zero or more of ${REVIEW_FLAGS.map(v=>JSON.stringify(v)).join(", ")}.`,
  ``,
  `IDENTITY — copy these EXACTLY:`,
  `  job_id: ${handoff.jobId}`,
  `  source_sha256: ${source.sha256}`,
  `  page_stem: ${source.pageStem}`,
  `  source_width: ${source.width}`,
  `  source_height: ${source.height}`,
  ``,
  `If detail is too small to judge, set "page_inspection_complete" to false and say what needs a closer view in "page_review_flags" instead of guessing.`,
  ``,
  `Return ONE JSON object in exactly this shape (chatgpt-analysis/1.0), with no prose and no Markdown fences.`,
  `The identity fields below are real; the candidate is only an example of the shape — replace it with your own crops, one entry per crop:`,
  JSON.stringify(example,null,2),
  ``,
  `Handoff manifest for reference:`,
  JSON.stringify(manifest,null,2)
 ].join('\n')
}
export interface PackageEvidence {id:string;sourceCheckId:string;observedAt:number;manifest:any;promptSha256:string;attachmentBytes:number[]}
/** Strict, bounded layout and exact manifest/prompt hashes. Image-byte and pixel checks belong to native. */
export async function verifyTargetPackage(raw:unknown,attemptId:string,sourceSha256:string,pageId:string,scope:{seriesId:string;chapterId:string},now:number):Promise<{proof:PackageEvidence;source:PackageSource;manifestSha256:string;promptSha256:string;totalBytes:number}> {
 recoveryExact(raw,['id','sourceCheckId','observedAt','manifest','promptSha256','attachmentBytes'])
 if(!recoveryId(raw.id)||!recoveryId(raw.sourceCheckId)||!Number.isSafeInteger(raw.observedAt)||raw.observedAt<=0||raw.observedAt>now||!recoveryHash(raw.promptSha256)||new TextEncoder().encode(canonicalJson(raw)).length>64000)throw new TaskConflict('Bounded target package observation required')
 const m=raw.manifest
 recoveryExact(m,['schema_version','job_id','created_at','source','coordinate_system','slicing','slices','verification','manifest_sha256'])
 const s=m.source
 recoveryExact(s,['series_title','series_slug','chapter_folder','chapter_number','page_stem','original_filename','sha256','width','height','format','orientation'])
 const positive=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0
 if(m.schema_version!=='handoff/1.0'||m.coordinate_system!=='canonical_original_pixels'||s.series_title!=='Managed '+attemptId||s.series_slug!==('Managed '+attemptId).toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'').slice(0,40)||s.chapter_folder!=='Managed attempt'||s.chapter_number!==1||s.sha256!==sourceSha256||s.orientation!=='stored_pixels'||!positive(s.width)||!positive(s.height)||s.width>16383||s.width*s.height>100000000||!['png','jpeg','webp'].includes(s.format)||typeof s.original_filename!=='string'||!s.original_filename||s.original_filename.length>255||/[\\/\u0000-\u001f]/.test(s.original_filename)||s.page_stem!==s.original_filename.replace(/\.[^.]*$/,''))throw new TaskConflict('Exact isolated page source metadata required')
 if(pageId!=='page_'+await packageHash(canonicalJson([scope.seriesId,scope.chapterId,s.original_filename])))throw new TaskConflict('Filename is not the shared original page identity')
 const time=Date.parse(m.created_at)
 if(!Number.isSafeInteger(time)||time<=0||time>raw.observedAt||new Date(time).toISOString()!==m.created_at)throw new TaskConflict('Original package creation time required')
 const safe=(v:string)=>v.toLowerCase().replace(/[^a-z0-9._]+/g,'-').replace(/^-+|-+$/g,'')
 if(m.job_id!==[safe(s.series_slug),'ch001',safe(s.page_stem),s.sha256.slice(0,12)].join('-'))throw new TaskConflict('Package job identity mismatch')
 if(canonicalJson(m.slicing)!==canonicalJson({mode:'full_width_fixed_height',slice_height:2048,encoding:'webp_lossless'})||canonicalJson(m.verification)!==canonicalJson({tiling:'exact',pixels:'identical',verified_at:m.created_at}))throw new TaskConflict('Verified sliced package required')
 const count=Math.ceil(s.height/2048)
 if(!Array.isArray(m.slices)||count<1||count>64||m.slices.length!==count||!Array.isArray(raw.attachmentBytes)||raw.attachmentBytes.length!==count)throw new TaskConflict('Exact bounded attachment inventory required')
 const slices=m.slices.map((slice:any,i:number)=>{
  recoveryExact(slice,['id','file','x0','y0','x1','y1','width','height','sha256'])
  const id='slice-'+String(i+1).padStart(Math.max(2,String(count).length),'0'),top=i*2048,height=Math.min(2048,s.height-top)
  if(slice.id!==id||slice.file!==s.page_stem+'_'+id+'.webp'||slice.x0!==0||slice.y0!==top||slice.x1!==s.width||slice.y1!==top+height||slice.width!==s.width||slice.height!==height||!recoveryHash(slice.sha256)||!positive(raw.attachmentBytes[i])||raw.attachmentBytes[i]>64000000)throw new TaskConflict('Changed attachment layout, order or bytes')
  return {id:slice.id,file:slice.file,x0:0,y0:top,x1:s.width,y1:top+height,width:s.width,height,sha256:slice.sha256}
 })
 const totalBytes=raw.attachmentBytes.reduce((n:number,v:number)=>n+v,0);if(totalBytes>128000000)throw new TaskConflict('Target package exceeds byte budget')
 // Rebuild key order rather than hashing arbitrary incoming object order.
 const unsigned={schema_version:'handoff/1.0',job_id:m.job_id,created_at:m.created_at,source:{series_title:s.series_title,series_slug:s.series_slug,chapter_folder:s.chapter_folder,chapter_number:1,page_stem:s.page_stem,original_filename:s.original_filename,sha256:s.sha256,width:s.width,height:s.height,format:s.format,orientation:'stored_pixels'},coordinate_system:'canonical_original_pixels',slicing:{mode:'full_width_fixed_height',slice_height:2048,encoding:'webp_lossless'},slices,verification:{tiling:'exact',pixels:'identical',verified_at:m.created_at}}
 const manifestSha256=await packageHash(JSON.stringify(unsigned));if(m.manifest_sha256!==manifestSha256)throw new TaskConflict('Exact package manifest checksum required')
 const signed={...unsigned,manifest_sha256:manifestSha256},promptSha256=await packageHash(targetPackagePrompt(signed))
 if(raw.promptSha256!==promptSha256)throw new TaskConflict('Exact versioned target prompt required')
 return {proof:structuredClone(raw) as PackageEvidence,source:{filename:s.original_filename,sha256:s.sha256,width:s.width,height:s.height},manifestSha256,promptSha256,totalBytes}
}

export function parseTargetPackageReceipt(raw:unknown,unit:RecoveryUnit,target:FallbackTarget,now=Date.now()){
 recoveryExact(raw,['schema','id','sourceCheckId','unit','target','accountId','policyRevision','sourceObservedAt','source','manifestSha256','promptSha256','attachmentCount','totalBytes','observedAt','receivedAt','validUntil','packageVerified','executionAllowed','handoffAllowed','resendAllowed','portableInputVerified','contextVerified'])
 recoveryUnitKey(raw.unit);fallbackTargets([raw.target]);recoveryExact(raw.source,['filename','sha256','width','height'])
 const positive=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0
 if(raw.schema!==TARGET_PACKAGE_SCHEMA||!recoveryId(raw.id)||!recoveryId(raw.sourceCheckId)||recoveryUnitKey(raw.unit)!==recoveryUnitKey(unit)||canonicalJson(raw.target)!==canonicalJson(target)||!recoveryId(raw.accountId)||![raw.policyRevision,raw.sourceObservedAt,raw.attachmentCount,raw.totalBytes,raw.observedAt,raw.receivedAt,raw.validUntil,raw.source.width,raw.source.height].every(positive)||raw.attachmentCount>64||raw.totalBytes>128000000||raw.totalBytes<raw.attachmentCount||raw.source.width>16383||raw.source.width*raw.source.height>100000000||typeof raw.source.filename!=='string'||raw.source.filename.length<1||raw.source.filename.length>255||![raw.source.sha256,raw.manifestSha256,raw.promptSha256].every(recoveryHash)||raw.sourceObservedAt>raw.observedAt||raw.observedAt>raw.receivedAt||raw.receivedAt>now||raw.validUntil<=now||raw.validUntil>raw.observedAt+15000||raw.packageVerified!==true||['executionAllowed','handoffAllowed','resendAllowed','portableInputVerified','contextVerified'].some(k=>raw[k]!==false))throw new TaskConflict('Exact non-executable package receipt required')
 return structuredClone(raw)
}
export function parseTargetPackageStatus(raw:unknown,unit:RecoveryUnit,target:FallbackTarget,now=Date.now()){
 recoveryExact(raw,['schema','unit','target','checkedAt','state','receipt','executionAllowed','handoffAllowed','resendAllowed','portableInputVerified','contextVerified'])
 recoveryUnitKey(raw.unit);fallbackTargets([raw.target])
 if(raw.schema!==TARGET_PACKAGE_SCHEMA||recoveryUnitKey(raw.unit)!==recoveryUnitKey(unit)||canonicalJson(raw.target)!==canonicalJson(target)||!Number.isSafeInteger(raw.checkedAt)||raw.checkedAt<=0||raw.checkedAt>now||now-raw.checkedAt>=15000||!['missing','awaiting_package','verified_package_only','expired','blocked'].includes(raw.state)||['executionAllowed','handoffAllowed','resendAllowed','portableInputVerified','contextVerified'].some(k=>raw[k]!==false))throw new TaskConflict('Exact non-executable package status required')
 if(raw.receipt!==null){if(!Number.isSafeInteger(raw.receipt.receivedAt)||raw.receipt.receivedAt>raw.checkedAt)throw new TaskConflict('Future package receipt');parseTargetPackageReceipt(raw.receipt,unit,target,raw.state==='verified_package_only'?now:raw.receipt.receivedAt)}
 if(raw.state==='verified_package_only'&&raw.receipt===null||['missing','awaiting_package'].includes(raw.state)&&raw.receipt!==null)throw new TaskConflict('Contradictory package evidence')
 return structuredClone(raw)
}
