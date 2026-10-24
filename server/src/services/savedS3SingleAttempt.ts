import {createHash} from 'node:crypto'
import {S3Client,PutObjectCommand,GetObjectCommand} from '@aws-sdk/client-s3'
import type {S3StorageConfig} from './r2S3Client.js'
import {recordOp} from './r2Usage.js'

export type SavedS3ReadFact='MATCH'|'ABSENT'|'DIFFERENT'
export interface SavedS3Options {signal?:AbortSignal;timeoutMs?:number}
export class SavedS3Failure extends Error {
 constructor(readonly statusCode?:number){super('Saved storage operation is unverified; retain the original action and inspect its outcome');this.name='SavedS3Failure'}
}
function cancelError(timeout=false){const e=new Error(timeout?'Saved storage deadline reached':'Saved storage operation cancelled');e.name=timeout?'TimeoutError':'AbortError';return e}
function check(signal:AbortSignal){if(signal.aborted)throw signal.reason}
/** Cancellation must settle even if local bookkeeping has not completed. Late work stays fenced. */
function untilAbort<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
 return new Promise((resolve,reject)=>{
  const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason)}
  signal.addEventListener('abort',abort,{once:true})
  void work.then(value=>{signal.removeEventListener('abort',abort);if(signal.aborted)reject(signal.reason);else resolve(value)},error=>{signal.removeEventListener('abort',abort);reject(error)})
  if(signal.aborted)abort()
 })
}
function snapshot(config:S3StorageConfig,key:string,bytes:Uint8Array){
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(config.accountId)||!config.accessKeyId.trim()||!config.secretAccessKey.trim()||!(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/).test(config.bucket))throw new SavedS3Failure()
 if(!key||Buffer.byteLength(key)>1024||/[\x00-\x1f\x7f]/.test(key)||key.split('/').some(p=>!p||p==='.'||p==='..')||bytes.byteLength<1||bytes.byteLength>1_000_000)throw new SavedS3Failure()
 const saved=Buffer.from(bytes),pinned=Object.freeze({...config}),sha256=createHash('sha256').update(saved).digest('hex')
 return {config:pinned,key,bytes:saved,sha256}
}
type Snapshot=ReturnType<typeof snapshot>
type Body={destroy?:(error?:Error)=>unknown;[Symbol.asyncIterator]?:()=>AsyncIterator<Uint8Array>}

/** A private client per command; never exported to multipart Upload or an ordinary resend loop. */
async function run<T>(saved:Snapshot,operation:'PutObjectCommand'|'GetObjectCommand',options:SavedS3Options,execute:(client:S3Client,signal:AbortSignal,retainBody:(body:Body)=>void)=>Promise<T>):Promise<T>{
 const timeout=options.timeoutMs??20000
 if(!Number.isSafeInteger(timeout)||timeout<1||timeout>20000)throw new SavedS3Failure()
 const controller=new AbortController();let body:Body|undefined
 const client=new S3Client({
  region:'auto',endpoint:`https://${saved.config.accountId}.r2.cloudflarestorage.com`,forcePathStyle:true,
  credentials:{accessKeyId:saved.config.accessKeyId,secretAccessKey:saved.config.secretAccessKey},maxAttempts:1,followRegionRedirects:false,
  requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED',
  requestHandler:{connectionTimeout:Math.min(timeout,5000),requestTimeout:timeout,throwOnRequestTimeout:true,httpAgent:{keepAlive:false,maxSockets:1},httpsAgent:{keepAlive:false,maxSockets:1}},
 })
 const abort=()=>{controller.abort(cancelError());body?.destroy?.();client.destroy()}
 options.signal?.addEventListener('abort',abort,{once:true})
 const timer=setTimeout(()=>{controller.abort(cancelError(true));body?.destroy?.();client.destroy()},timeout)
 let transmitted=false
 const handler=client.config.requestHandler,handle=handler.handle.bind(handler)
 handler.handle=async(request,requestOptions)=>{
  check(controller.signal)
  if(transmitted)throw new SavedS3Failure()
  const expectedMethod=operation==='PutObjectCommand'?'PUT':'GET'
  let wireKey:string
  try{wireKey=decodeURIComponent(request.path.slice(saved.config.bucket.length+2))}catch{throw new SavedS3Failure()}
  if(request.protocol!=='https:'||request.port!==undefined&&request.port!==443||request.hostname!==`${saved.config.accountId}.r2.cloudflarestorage.com`||request.method!==expectedMethod||!request.path.startsWith('/'+saved.config.bucket+'/')||wireKey!==saved.key||request.query?.uploadId!==undefined||request.query?.uploads!==undefined)throw new SavedS3Failure()
  if(expectedMethod==='PUT'&&request.headers['if-none-match']!=='*')throw new SavedS3Failure()
  // Irreversible per-command permit before any async usage bookkeeping or transmission.
  transmitted=true
  await recordOp(operation)
  check(controller.signal)
  return handle(request,requestOptions)
 }
 client.middlewareStack.add(next=>async args=>{
  if(operation==='GetObjectCommand')(args.request as {headers:Record<string,string>}).headers['accept-encoding']='identity'
  return next(args)
 },{step:'build',name:'savedS3IdentityEncoding'})
 try{
  if(options.signal?.aborted)abort()
  check(controller.signal)
  return await untilAbort(execute(client,controller.signal,value=>{if(controller.signal.aborted){value.destroy?.();check(controller.signal)}body=value}),controller.signal)
 }catch(error:any){
  if(controller.signal.aborted)throw controller.signal.reason
  if(error instanceof SavedS3Failure)throw error
  const status=error?.$metadata?.httpStatusCode
  throw new SavedS3Failure(Number.isInteger(status)?status:undefined)
 }finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);body?.destroy?.();client.destroy()}
}

/** One-use saved-byte primitive only. The caller still needs durable task/grant/budget ownership. */
export function prepareSavedS3Create(config:S3StorageConfig,key:string,bytes:Uint8Array,contentType:string){
 const saved=snapshot(config,key,bytes)
 if(!['application/json','application/zip','application/octet-stream'].includes(contentType))throw new SavedS3Failure()
 let used=false
 return Object.freeze({sha256:saved.sha256,byteLength:saved.bytes.length,async send(options:SavedS3Options={}){
  if(used)throw new SavedS3Failure();used=true
  return run(saved,'PutObjectCommand',options,async(client,signal)=>{
   await client.send(new PutObjectCommand({Bucket:saved.config.bucket,Key:saved.key,Body:saved.bytes,ContentLength:saved.bytes.length,ContentType:contentType,IfNoneMatch:'*'}),{abortSignal:signal})
   check(signal)
   // Acknowledgment is not byte verification, publication or task completion.
   return {acknowledged:true as const,sha256:saved.sha256,byteLength:saved.bytes.length}
  })
 }})
}

/** A separately prepared one-use GET. ABSENT/DIFFERENT never grants another write. */
export function prepareSavedS3Read(config:S3StorageConfig,key:string,expected:Uint8Array){
 const saved=snapshot(config,key,expected);let used=false
 return Object.freeze({sha256:saved.sha256,byteLength:saved.bytes.length,async verify(options:SavedS3Options={}):Promise<SavedS3ReadFact>{
  if(used)throw new SavedS3Failure();used=true
  try{return await run(saved,'GetObjectCommand',options,async(client,signal,retainBody)=>{
   const result=await client.send(new GetObjectCommand({Bucket:saved.config.bucket,Key:saved.key}),{abortSignal:signal})
   const body=result.Body as Body|undefined
   if(!body)throw new SavedS3Failure()
   retainBody(body)
   if(result.$metadata.httpStatusCode!==200||result.ContentRange||result.ContentEncoding&&result.ContentEncoding!=='identity')throw new SavedS3Failure(result.$metadata.httpStatusCode)
   if(result.ContentLength!==undefined&&result.ContentLength!==saved.bytes.length)return 'DIFFERENT'
   if(!body[Symbol.asyncIterator])throw new SavedS3Failure()
   const hash=createHash('sha256');let length=0
   for await(const raw of body as AsyncIterable<Uint8Array>){
    check(signal);const chunk=Buffer.from(raw)
    if(length+chunk.length>saved.bytes.length)return 'DIFFERENT'
    length+=chunk.length;hash.update(chunk)
   }
   check(signal)
   return length===saved.bytes.length&&hash.digest('hex')===saved.sha256?'MATCH':'DIFFERENT'
  })}catch(error){if(error instanceof SavedS3Failure&&error.statusCode===404)return 'ABSENT';throw error}
 }})
}
