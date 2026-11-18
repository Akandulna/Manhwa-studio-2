import { hasRelayFeature } from './relayTraffic.js'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import type { YouTubeTransport, YouTubePhone, YouTubePhoneJobStatus } from './youtubeAutomation.js'
function youtubeReceipt(relayReceipts: typeof import('./phoneRelay.js')['relayReceipts'], device: string) {
 const automation=relayReceipts<Record<string,unknown>>('crops')?.find(r=>r.device===device)?.body?.automation as Record<string,unknown>|undefined
 return { automation, youtube: automation?.youtube as Record<string,unknown>|undefined }
}
export const youtubePhoneTransport: YouTubeTransport = {
 async phones() {
  const [{ relayReceipts, relayStatus }, { getPhoneOverview }] = await Promise.all([import('./phoneRelay.js'),import('./r2Service.js')])
  const status=relayStatus(); const overview=await getPhoneOverview(null)
  return status.devices.map(phone => {
   const { automation, youtube }=youtubeReceipt(relayReceipts,phone.id)
   const summary=overview.phones.find(p=>p.id===phone.id)
   const prefix=typeof youtube?.prefix==='string'?youtube.prefix:''
   const reason=!hasRelayFeature('youtube-automation/1')?'Update the phone relay for YouTube automation':!phone.connected?'Phone is offline':youtube?.protocol!=='youtube-automation/1'?'Update Sleeper Cell beta for YouTube automation':!automation?.remoteStart?'Enable Start from Manhwa Studio on this phone':summary?.runs || summary?.working || automation?.resume || youtube?.active?'Phone is busy':''
   return {id:phone.id,name:phone.name,ready:!reason,reason,prefix,thumbnailPreparation:youtube?.thumbnailPreparation==='youtube-thumbnail-prepare/1',thumbnailGeneration:youtube?.thumbnailGeneration==='youtube-thumbnail-generate/1',aiStudioText:youtube?.textProvider==='aistudio/1'} satisfies YouTubePhone
  })
 },
 async put(key,body) { const {getR2Config,createClient}=await import('./r2Service.js');const config=getR2Config();if(!config)throw new Error('Configure Cloudflare R2 first.');await createClient(config).send(new PutObjectCommand({Bucket:config.bucket,Key:key,Body:JSON.stringify(body),ContentType:'application/json',IfNoneMatch:'*'})) },
 async putImage(key,bytes){const {getR2Config,createClient}=await import('./r2Service.js');const config=getR2Config();if(!config)throw new Error('Configure Cloudflare R2 first.');await createClient(config).send(new PutObjectCommand({Bucket:config.bucket,Key:key,Body:bytes,ContentType:'image/png',IfNoneMatch:'*'}))},
 async get(key) { const {getR2Config,createClient,isNotFound}=await import('./r2Service.js');const config=getR2Config();if(!config)throw new Error('Configure Cloudflare R2 first.');try{const result=await createClient(config).send(new GetObjectCommand({Bucket:config.bucket,Key:key}));if((result.ContentLength??0)>250000)throw new Error('Phone result exceeds the size limit.');return JSON.parse(await result.Body!.transformToString())}catch(e){if(isNotFound(e))return null;throw e} },
 async getImage(key,maxBytes) { const {getR2Config,createClient}=await import('./r2Service.js');const config=getR2Config();if(!config)throw new Error('Configure Cloudflare R2 first.');const response=await createClient(config).send(new GetObjectCommand({Bucket:config.bucket,Key:key}));if((response.ContentLength??0)>maxBytes)throw new Error('Generated image exceeds its declared size.');const chunks:Buffer[]=[];let size=0;for await(const part of response.Body as AsyncIterable<Uint8Array>){size+=part.length;if(size>maxBytes){(response.Body as {destroy?:()=>void}).destroy?.();throw new Error('Generated image exceeds its declared size.')}chunks.push(Buffer.from(part))}return Buffer.concat(chunks) },
 async jobStatus(device,jobId) {
  const { relayReceipts }=await import('./phoneRelay.js')
  const { automation, youtube }=youtubeReceipt(relayReceipts,device)
  const current=youtube?.current as Record<string,unknown>|null|undefined
  const running=youtube?.active===true&&current?.jobId===jobId
  const last=automation?.lastStart as Record<string,unknown>|null|undefined
  const start=last?.kind==='youtube'&&last.series===jobId&&typeof last.state==='string'?{state:last.state,...(typeof last.reason==='string'&&last.reason?{reason:last.reason}:{})}:undefined
  return { running, ...(running&&typeof current?.step==='string'?{step:current.step}:{}), ...(start?{start}:{}) } satisfies YouTubePhoneJobStatus
 },
 async stop(device) { const {sendPhoneRequest}=await import('./phoneRelay.js');await sendPhoneRequest('run_stop',{device}) },
 async start(device,jobId) { const {sendPhoneRequest}=await import('./phoneRelay.js');const result=await sendPhoneRequest('youtube_start',{device,series:jobId});if(!result.phones)throw new Error('The phone disconnected before delivery.') }
}
