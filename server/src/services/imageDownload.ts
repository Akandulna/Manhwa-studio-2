import http, {type ClientRequest, type IncomingMessage} from 'node:http'
import https from 'node:https'
import {createWriteStream, promises as fs, type WriteStream} from 'node:fs'
import path from 'node:path'
import {pipeline} from 'node:stream/promises'

const USER_AGENT='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
const MAX_ATTEMPTS=4,MAX_REDIRECTS=5
export interface ImageDownloadOptions {
 signal?:AbortSignal
 /** This mode owns no retry or redirect allowance; it does not establish managed task authority. */
 mode?:'legacy'|'single-request'
 timeoutMs?:number
 retryDelayMs?:number
 rateLimitDelayMs?:number
}
class DownloadFailure extends Error {
 constructor(message:string,readonly retryable=false,readonly rateLimited=false){super(message);this.name='ImageDownloadError'}
}
function cancelled(){const error=new Error('Image download cancelled');error.name='AbortError';return error}
function checkCancelled(signal?:AbortSignal){if(signal?.aborted)throw cancelled()}
function imageUrl(raw:string,base?:URL):URL {
 let url:URL
 try{url=new URL(raw,base)}catch{throw new DownloadFailure('Invalid image download address')}
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new DownloadFailure('Expected an HTTP image download address without credentials')
 return url
}
function duration(value:number|undefined,fallback:number,maximum:number){
 const result=value??fallback
 if(!Number.isSafeInteger(result)||result<0||result>maximum)throw new DownloadFailure('Invalid image download timing')
 return result
}
async function wait(ms:number,signal?:AbortSignal):Promise<void>{
 checkCancelled(signal)
 await new Promise<void>((resolve,reject)=>{
  const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(cancelled())}
  const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve()},ms)
  signal?.addEventListener('abort',abort,{once:true})
  if(signal?.aborted)abort()
 })
}
type ResponseFact={kind:'saved';bytes:number}|{kind:'redirect';location:string}

/** One Node HTTP request, one terminal result, and closed output streams before any successor. */
function requestOnce(url:URL,temporary:string,referer:string,timeoutMs:number,signal?:AbortSignal):Promise<ResponseFact>{
 checkCancelled(signal)
 return new Promise((resolve,reject)=>{
  let settled=false,request:ClientRequest|undefined,response:IncomingMessage|undefined,file:WriteStream|undefined
  let transfer:Promise<void>|undefined,bytes=0,timer:ReturnType<typeof setTimeout>|undefined
  const abort=()=>finish(undefined,cancelled())
  function finish(fact?:ResponseFact,error?:Error){
   if(settled)return
   settled=true
   clearTimeout(timer);signal?.removeEventListener('abort',abort);request?.setTimeout(0)
   if(error||fact?.kind==='redirect'){file?.destroy();response?.destroy();request?.destroy()}
   // Pipeline owns stream closure; no previous attempt can still write when a retry starts.
   void Promise.resolve(transfer?.catch(()=>{})).then(()=>{if(error)reject(error);else resolve(fact!)})
  }
  const timeout=()=>finish(undefined,new DownloadFailure('Image download timeout',true))
  signal?.addEventListener('abort',abort,{once:true})
  if(signal?.aborted){abort();return}
  timer=setTimeout(timeout,timeoutMs)
  try{
   const client=url.protocol==='https:'?https:http
   request=client.request(url,{method:'GET',agent:false,headers:{
    'User-Agent':USER_AGENT,'Referer':referer,'Accept':'image/webp,image/apng,image/*,*/*;q=0.8',
    'Accept-Language':'en-US,en;q=0.9','Cache-Control':'no-cache',
   }},res=>{
    if(settled){res.destroy();return}
    response=res
    const status=res.statusCode??0
    if([301,302,303,307,308].includes(status)&&res.headers.location){finish({kind:'redirect',location:res.headers.location});return}
    if(status!==200){finish(undefined,new DownloadFailure(status===403?'403 Forbidden - CDN may be blocking requests. Check Referer/User-Agent settings.':`HTTP ${status}`,status===429||status>=500,status===429));return}
    file=createWriteStream(temporary,{flags:'wx'})
    file.once('error',()=>{if(!res.aborted&&!res.errored)finish(undefined,new DownloadFailure('Image staging write failed'))})
    res.on('data',(chunk:Buffer)=>{bytes+=chunk.length})
    transfer=pipeline(res,file)
    void transfer.then(()=>finish({kind:'saved',bytes}),()=>finish(undefined,new DownloadFailure('Image response interrupted',true)))
   })
   request.on('error',()=>finish(undefined,new DownloadFailure('Image download transport failed',true)))
   request.setTimeout(timeoutMs,timeout)
   if(signal?.aborted){abort();return}
   request.end()
  }catch{
   finish(undefined,new DownloadFailure('Image request could not start'))
  }
 })
}

/**
 * Sole retry owner for ordinary page GETs. At most four attempts plus five redirects per operation.
 * Single-request mode issues at most one request, including redirects/status/body failures.
 * Only a complete response is renamed to the caller's staging destination. This is not publication.
 */
export async function downloadImage(url:string,destPath:string,referer:string,options:ImageDownloadOptions={}):Promise<number>{
 if(options.mode!==undefined&&!['legacy','single-request'].includes(options.mode))throw new DownloadFailure('Unknown image download mode')
 const timeout=duration(options.timeoutMs,30000,30000)
 if(timeout===0)throw new DownloadFailure('Expected a positive image download timeout')
 const retryDelay=duration(options.retryDelayMs,1000,2000),rateDelay=duration(options.rateLimitDelayMs,2000,2000)
 let current=imageUrl(url),redirects=0,failures=0,requests=0
 const single=options.mode==='single-request',attemptLimit=single?1:MAX_ATTEMPTS,redirectLimit=single?0:MAX_REDIRECTS
 checkCancelled(options.signal)
 const directory=await fs.mkdtemp(path.join(path.dirname(destPath),'.page-download-'))
 try{
  while(true){
   checkCancelled(options.signal)
   const temporary=path.join(directory,'body-'+(++requests))
   let fact:ResponseFact
   try{fact=await requestOnce(current,temporary,referer,timeout,options.signal)}catch(error){
    checkCancelled(options.signal)
    if(!(error instanceof DownloadFailure)||!error.retryable||++failures>=attemptLimit)throw error
    await wait(error.rateLimited?rateDelay:retryDelay,options.signal)
    continue
   }
   if(fact.kind==='redirect'){
    if(redirects++>=redirectLimit)throw new DownloadFailure('Image redirect limit reached')
    current=imageUrl(fact.location,current)
    continue
   }
   checkCancelled(options.signal)
   await fs.rename(temporary,destPath)
   checkCancelled(options.signal)
   return fact.bytes
  }
 }finally{await fs.rm(directory,{recursive:true,force:true})}
}
