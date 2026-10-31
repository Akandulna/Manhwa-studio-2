import {afterEach,describe,expect,it,vi} from 'vitest'
import http from 'node:http'
import {EventEmitter} from 'node:events'
import {Readable} from 'node:stream'
import {promises as fs} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {downloadImage} from '../src/services/imageDownload.js'
const directories:string[]=[],servers:http.Server[]=[]
afterEach(async()=>{
 vi.restoreAllMocks()
 for(const s of servers.splice(0)){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()))}
 for(const d of directories.splice(0))await fs.rm(d,{recursive:true,force:true})
})
async function fixture(handler:http.RequestListener){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'image-download-owner-'));directories.push(directory)
 const server=http.createServer(handler);servers.push(server)
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 const address=server.address() as {port:number}
 return {directory,destination:path.join(directory,'page.part'),url:`http://127.0.0.1:${address.port}`}
}
const timing={timeoutMs:1000,retryDelayMs:0,rateLimitDelayMs:0}
const referer='https://fixture.invalid/chapter'
async function clean(directory:string){expect((await fs.readdir(directory)).filter(n=>n.startsWith('.page-download-'))).toEqual([])}
function timeoutTransport(){
 const responses:Readable[]=[];let count=0
 vi.spyOn(http,'request').mockImplementation(((_url:unknown,_options:unknown,onResponse:(r:any)=>void)=>{
  count++;const req=new EventEmitter() as any;let timeout:(()=>void)|undefined
  req.setTimeout=(_ms:number,callback?:()=>void)=>{if(callback)timeout=callback;return req}
  req.destroy=()=>{req.emit('error',new Error('socket error after timeout'));return req}
  req.end=()=>queueMicrotask(()=>{
   timeout?.();req.emit('error',new Error('late second socket error'))
   const late=Readable.from(['late response']) as any;late.statusCode=200;late.headers={};responses.push(late);onResponse(late)
  })
  return req
 }) as any)
 return {count:()=>count,responses}
}
describe('one image download retry owner',()=>{
 it('keeps headers and commits only the complete response to the staging destination',async()=>{
  let headers:http.IncomingHttpHeaders|undefined
  const e=await fixture((req,res)=>{headers=req.headers;res.end('complete-image')})
  await fs.writeFile(e.destination,'old staging bytes')
  expect(await downloadImage(e.url+'/page',e.destination,referer,timing)).toBe(14)
  expect(await fs.readFile(e.destination,'utf8')).toBe('complete-image')
  expect(headers?.referer).toBe(referer);expect(headers?.['user-agent']).toContain('Mozilla');expect(headers?.accept).toContain('image/')
  await clean(e.directory)
 })
 it('has one successor for each retryable response and keeps the original headers',async()=>{
  let requests=0;const refs:string[]=[]
  const e=await fixture((req,res)=>{refs.push(req.headers.referer!);requests++;res.statusCode=requests===1?429:requests===2?503:200;res.end(requests===3?'image':'failed')})
  expect(await downloadImage(e.url,e.destination,referer,timing)).toBe(5)
  expect(requests).toBe(3);expect(refs).toEqual([referer,referer,referer]);await clean(e.directory)
 })
 it('never exceeds four ordinary attempts on repeated server errors or touches old staging bytes',async()=>{
  let requests=0;const e=await fixture((_req,res)=>{requests++;res.statusCode=503;res.end('failed')})
  await fs.writeFile(e.destination,'original')
  await expect(downloadImage(e.url,e.destination,referer,timing)).rejects.toThrow('HTTP 503')
  expect(requests).toBe(4);expect(await fs.readFile(e.destination,'utf8')).toBe('original');await clean(e.directory)
 })
 it.each([302,429,503])('single-request mode sends once for HTTP %i without following or retrying',async status=>{
  let requests=0;const e=await fixture((_req,res)=>{requests++;res.statusCode=status;res.setHeader('Location','/other');res.end()})
  await expect(downloadImage(e.url,e.destination,referer,{...timing,mode:'single-request'})).rejects.toThrow()
  expect(requests).toBe(1);await clean(e.directory)
 })
 it('resolves relative redirects and preserves request headers',async()=>{
  const paths:string[]=[];const e=await fixture((req,res)=>{paths.push(req.url!);if(req.url==='/nested/start'){res.statusCode=302;res.setHeader('Location','../image');res.end()}else res.end('image')})
  await downloadImage(e.url+'/nested/start',e.destination,referer,timing)
  expect(paths).toEqual(['/nested/start','/image']);await clean(e.directory)
 })
 it('bounds a redirect loop at six requests with no retry budget reset',async()=>{
  let requests=0;const e=await fixture((_req,res)=>{requests++;res.statusCode=302;res.setHeader('Location','/again');res.end()})
  await expect(downloadImage(e.url,e.destination,referer,timing)).rejects.toThrow('redirect limit')
  expect(requests).toBe(6);await clean(e.directory)
 })
 it('bounds combined redirects and retries at nine physical requests',async()=>{
  let requests=0;const e=await fixture((_req,res)=>{requests++;res.statusCode=requests<=5?302:requests<=8?503:200;if(requests<=5)res.setHeader('Location','/again');res.end('image')})
  await downloadImage(e.url,e.destination,referer,timing);expect(requests).toBe(9);await clean(e.directory)
 })
 it('settles timeout/error overlap once and discards late responses before another writer can open',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'image-download-owner-'));directories.push(directory)
  const control=timeoutTransport(),destination=path.join(directory,'page.part');await fs.writeFile(destination,'original')
  await expect(downloadImage('http://fixture.invalid/image',destination,referer,timing)).rejects.toThrow('timeout')
  await new Promise(r=>setTimeout(r,10));expect(control.count()).toBe(4)
  expect(control.responses.every(r=>r.destroyed)).toBe(true);expect(await fs.readFile(destination,'utf8')).toBe('original');await clean(directory)
 })
 it('single-request mode does not replay timeout/error overlap',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'image-download-owner-'));directories.push(directory)
  const control=timeoutTransport()
  await expect(downloadImage('http://fixture.invalid/image',path.join(directory,'page.part'),referer,{...timing,mode:'single-request'})).rejects.toThrow('timeout')
  await new Promise(r=>setTimeout(r,10));expect(control.count()).toBe(1);await clean(directory)
 })
 it('cancels before admission without issuing a request or creating a staging directory',async()=>{
  let requests=0;const e=await fixture((_req,res)=>{requests++;res.end('image')});const controller=new AbortController();controller.abort()
  await expect(downloadImage(e.url,e.destination,referer,{...timing,signal:controller.signal})).rejects.toMatchObject({name:'AbortError'})
  expect(requests).toBe(0);await clean(e.directory)
 })
 it('cancels retry backoff without a delayed successor',async()=>{
  let requests=0;const controller=new AbortController()
  const e=await fixture((_req,res)=>{requests++;res.statusCode=503;res.end();setTimeout(()=>controller.abort(),20)})
  await expect(downloadImage(e.url,e.destination,referer,{...timing,retryDelayMs:2000,signal:controller.signal})).rejects.toMatchObject({name:'AbortError'})
  expect(requests).toBe(1);await clean(e.directory)
 })
 it('cancels an active response and closes its partial staging writer without replay',async()=>{
  let requests=0;const controller=new AbortController()
  const e=await fixture((_req,res)=>{requests++;res.writeHead(200);res.write('partial');setTimeout(()=>controller.abort(),20)})
  await fs.writeFile(e.destination,'original')
  await expect(downloadImage(e.url,e.destination,referer,{...timing,signal:controller.signal})).rejects.toMatchObject({name:'AbortError'})
  expect(requests).toBe(1);expect(await fs.readFile(e.destination,'utf8')).toBe('original');await clean(e.directory)
 })
 it('rejects a truncated response in single-request mode without committing partial bytes',async()=>{
  let requests=0;const e=await fixture((_req,res)=>{requests++;res.writeHead(200,{'Content-Length':'100'});res.write('short');res.flushHeaders();setTimeout(()=>res.destroy(),5)})
  await expect(downloadImage(e.url,e.destination,referer,{...timing,mode:'single-request'})).rejects.toThrow()
  expect(requests).toBe(1);expect(await fs.readdir(e.directory)).toEqual([])
 })
 it('retries an interrupted response through the same ordinary owner and commits only the later complete bytes',async()=>{
  let requests=0;const e=await fixture((_req,res)=>{requests++;if(requests===1){res.writeHead(200,{'Content-Length':'100'});res.write('short');res.flushHeaders();setTimeout(()=>res.destroy(),5)}else res.end('complete')})
  expect(await downloadImage(e.url,e.destination,referer,timing)).toBe(8)
  expect(requests).toBe(2);expect(await fs.readFile(e.destination,'utf8')).toBe('complete');await clean(e.directory)
 })
 it('bounds a request with no response using the one shared timeout result',async()=>{
  let requests=0;const e=await fixture(()=>{requests++})
  await expect(downloadImage(e.url,e.destination,referer,{...timing,timeoutMs:20,mode:'single-request'})).rejects.toThrow('timeout')
  expect(requests).toBe(1);await clean(e.directory)
 })
 it.each(['file:///private/file','ftp://fixture.invalid/image','http://user:password@fixture.invalid/image'])('rejects unsupported target %s before a request',async target=>{
  let requests=0;const e=await fixture((_req,res)=>{requests++;res.end()})
  await expect(downloadImage(target,e.destination,referer,timing)).rejects.toThrow('HTTP image')
  expect(requests).toBe(0);await clean(e.directory)
 })
 it('rejects an invalid redirect target without retrying it',async()=>{
  let requests=0;const e=await fixture((_req,res)=>{requests++;res.writeHead(302,{Location:'file:///private/file'});res.end()})
  await expect(downloadImage(e.url,e.destination,referer,timing)).rejects.toThrow('HTTP image')
  expect(requests).toBe(1);await clean(e.directory)
 })
 it('does not retry local final-staging failures',async()=>{
  let requests=0;const e=await fixture((_req,res)=>{requests++;res.end('image')})
  await fs.mkdir(e.destination)
  await expect(downloadImage(e.url,e.destination,referer,timing)).rejects.toThrow()
  expect(requests).toBe(1);await clean(e.directory)
 })
 it.each([{timeoutMs:0},{timeoutMs:Infinity},{retryDelayMs:-1},{rateLimitDelayMs:3000},{mode:'other'}])('refuses invalid policy options %j before sending',async options=>{
  let requests=0;const e=await fixture((_req,res)=>{requests++;res.end()})
  await expect(downloadImage(e.url,e.destination,referer,options as any)).rejects.toThrow()
  expect(requests).toBe(0);await clean(e.directory)
 })
})
