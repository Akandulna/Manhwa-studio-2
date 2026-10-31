import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import os from 'node:os'
import {S3Client,PutObjectCommand} from '@aws-sdk/client-s3'
import {Upload} from '@aws-sdk/lib-storage'
const usage=vi.hoisted(()=>vi.fn(async(_operation:string)=>{}))
vi.mock('../src/services/r2Usage.js',()=>({recordOp:usage}))
import {createLegacyR2S3Client} from '../src/services/r2S3Client.js'
import {prepareSavedS3Create,prepareSavedS3Read,SavedS3Failure} from '../src/services/savedS3SingleAttempt.js'
const config={accountId:'fixture-account',bucket:'fixture-bucket',accessKeyId:'fixture-key',secretAccessKey:'fixture-secret'}
const original=Buffer.from('private saved bytes नमस्ते'),key='saved/exact %2F object.json'
const servers:http.Server[]=[],clients:S3Client[]=[]
beforeEach(()=>{usage.mockClear();usage.mockImplementation(async()=>{});vi.stubEnv('AWS_MAX_ATTEMPTS',undefined);vi.stubEnv('AWS_RETRY_MODE','standard');vi.stubEnv('AWS_CONFIG_FILE',path.join(os.tmpdir(),'codex-s3-fixture-no-config'));vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE',path.join(os.tmpdir(),'codex-s3-fixture-no-credentials'))})
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();for(const c of clients.splice(0))c.destroy();for(const s of servers.splice(0)){s.closeAllConnections();await new Promise<void>(resolve=>s.close(()=>resolve()))}})
async function fixture(handler:(req:http.IncomingMessage,res:http.ServerResponse,bytes:Buffer)=>void){
 let requests=0;const paths:string[]=[],methods:string[]=[],bodies:Buffer[]=[],headers:http.IncomingHttpHeaders[]=[]
 const server=http.createServer((req,res)=>{requests++;paths.push(req.url!);methods.push(req.method!);headers.push(req.headers);const chunks:Buffer[]=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{const body=Buffer.concat(chunks);bodies.push(body);handler(req,res,body)})});servers.push(server)
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as {port:number}).port
 // Keep the SDK's real serializer/signer/retry/Node handler; route only its HTTPS socket to a fake loopback service.
 const actual=http.request.bind(http)
 vi.spyOn(https,'request').mockImplementation(((options:any,callback:any)=>actual({...options,protocol:'http:',hostname:'127.0.0.1',port,agent:false},callback)) as any)
 return {requests:()=>requests,paths,methods,bodies,headers}
}
function failure(res:http.ServerResponse,status=503,code='ServiceUnavailable'){res.writeHead(status,{'Content-Type':'application/xml'});res.end(`<Error><Code>${code}</Code><Message>synthetic</Message></Error>`)}
function legacy(){const c=createLegacyR2S3Client(config);clients.push(c);return c}
describe('installed SDK retry/multipart controls',()=>{
 it('resolves the ordinary default to three attempts and reproduces three PUT transmissions',async()=>{
  const e=await fixture((_q,r)=>failure(r)),client=legacy()
  expect(await client.config.maxAttempts()).toBe(3)
  await expect(client.send(new PutObjectCommand({Bucket:config.bucket,Key:'ordinary',Body:Buffer.from('fixture')}))).rejects.toThrow()
  expect(e.requests()).toBe(3);expect(e.methods).toEqual(['PUT','PUT','PUT'])
 })
 it('demonstrates multipart command fanout, per-part SDK retries and independent abort cleanup',async()=>{
  const operations:string[]=[]
  await fixture((req,res)=>{
   const u=new URL(req.url!,'http://fixture'),part=u.searchParams.get('partNumber')
   if(req.method==='POST'&&u.searchParams.has('uploads')){operations.push('create');res.setHeader('Content-Type','application/xml');res.end('<InitiateMultipartUploadResult><Bucket>fixture-bucket</Bucket><Key>ordinary.zip</Key><UploadId>original</UploadId></InitiateMultipartUploadResult>')}
   else if(req.method==='PUT'&&part==='1'){operations.push('part1');res.setHeader('ETag','"part-one"');res.end()}
   else if(req.method==='PUT'){operations.push('part2');failure(res)}
   else if(req.method==='DELETE'){operations.push('abort');res.writeHead(204);res.end()}
   else{operations.push('unexpected');failure(res,400,'InvalidRequest')}
  })
  const upload=new Upload({client:legacy(),params:{Bucket:config.bucket,Key:'ordinary.zip',Body:Buffer.alloc(5*1024*1024+1,1)},partSize:5*1024*1024,queueSize:1})
  await expect(upload.done()).rejects.toThrow()
  expect(operations).toEqual(['create','part1','part2','part2','part2','abort'])
 })
})
describe('separately prepared one-use S3 saved operations',()=>{
 it('snapshots bytes/target/credentials and signs a create-only PUT without multipart',async()=>{
  const e=await fixture((_q,r)=>{r.setHeader('ETag','"ack-only"');r.end()})
  const input=Buffer.from(original),mutable={...config},action=prepareSavedS3Create(mutable,key,input,'application/json')
  input.fill(0);mutable.accountId='changed';mutable.bucket='changed-bucket';mutable.accessKeyId='changed-key'
  const receipt=await action.send()
  expect(receipt).toMatchObject({acknowledged:true,sha256:action.sha256,byteLength:original.length})
  expect(e.requests()).toBe(1);expect(e.methods).toEqual(['PUT']);expect(e.bodies[0]).toEqual(original)
  expect(decodeURIComponent(e.paths[0].split('?')[0])).toBe('/fixture-bucket/'+key)
  expect(e.headers[0]['if-none-match']).toBe('*');expect(e.headers[0].authorization).toContain('fixture-key/');expect(e.headers[0].authorization).toContain('if-none-match')
  expect(usage).toHaveBeenCalledTimes(1);expect(usage).toHaveBeenCalledWith('PutObjectCommand')
  await expect(action.send()).rejects.toBeInstanceOf(SavedS3Failure);expect(e.requests()).toBe(1)
 })
 it.each([301,307,401,403,412,429,500,503])('never follows or retries HTTP %i, even with a larger environment allowance',async status=>{
  vi.stubEnv('AWS_MAX_ATTEMPTS','9')
  const e=await fixture((_q,r)=>{r.setHeader('Location','https://foreign.invalid/replacement');r.setHeader('x-amz-bucket-region','foreign-region');failure(r,status,status===412?'PreconditionFailed':'ServiceUnavailable')})
  const action=prepareSavedS3Create(config,key,original,'application/json')
  await expect(action.send()).rejects.toBeInstanceOf(SavedS3Failure)
  await expect(action.send()).rejects.toBeInstanceOf(SavedS3Failure)
  expect(e.requests()).toBe(1);expect(e.methods).toEqual(['PUT']);expect(usage).toHaveBeenCalledTimes(1)
 })
 it('blocks a second physical SDK send even if a caller mutates its private retry config',async()=>{
  const e=await fixture((_q,r)=>failure(r)),strategy=await legacy().config.retryStrategy()
  const send=S3Client.prototype.send
  vi.spyOn(S3Client.prototype,'send').mockImplementation(function(this:S3Client,...args:any[]){
   this.config.maxAttempts=async()=>3;this.config.retryStrategy=async()=>strategy
   return (send as any).apply(this,args)
  } as any)
  await expect(prepareSavedS3Create(config,key,original,'application/json').send()).rejects.toMatchObject({name:'SavedS3Failure',statusCode:undefined})
  expect(e.requests()).toBe(1);expect(usage).toHaveBeenCalledTimes(1)
 })
 it('retains a lost write acknowledgment and permits only a separately prepared explicit readback',async()=>{
  let saved:Buffer|undefined
  const e=await fixture((req,res,bytes)=>{if(req.method==='PUT'){saved=Buffer.from(bytes);req.socket.destroy()}else res.end(saved)})
  const create=prepareSavedS3Create(config,key,original,'application/json')
  await expect(create.send()).rejects.toBeInstanceOf(SavedS3Failure)
  await expect(create.send()).rejects.toBeInstanceOf(SavedS3Failure)
  expect(e.methods).toEqual(['PUT'])
  const read=prepareSavedS3Read(config,key,original)
  expect(await read.verify()).toBe('MATCH');await expect(read.verify()).rejects.toBeInstanceOf(SavedS3Failure)
  expect(e.methods).toEqual(['PUT','GET']);expect(e.headers[1]['accept-encoding']).toBe('identity')
 })
 it.each(['same','different','shorter','longer','missing'] as const)('records only the exact-byte read fact for %s without any write',async variant=>{
  const e=await fixture((_q,r)=>{r.setHeader('ETag','"not-a-validator"');if(variant==='missing'){failure(r,404,'NoSuchKey');return}r.end(variant==='same'?original:variant==='different'?Buffer.alloc(original.length,1):variant==='shorter'?original.subarray(1):Buffer.concat([original,Buffer.from('x')]))})
  expect(await prepareSavedS3Read(config,key,original).verify()).toBe(variant==='same'?'MATCH':variant==='missing'?'ABSENT':'DIFFERENT')
  expect(e.methods).toEqual(['GET']);expect(usage).toHaveBeenCalledWith('GetObjectCommand')
 })
 it.each(['shorter','longer'] as const)('stops chunked %s readback without a write or second GET',async variant=>{
  const e=await fixture((_q,r)=>{r.writeHead(200);r.write(variant==='shorter'?original.subarray(1):Buffer.concat([original,Buffer.from('x')]));r.end()})
  expect(await prepareSavedS3Read(config,key,original).verify()).toBe('DIFFERENT');expect(e.methods).toEqual(['GET'])
 })
 it('keeps expected bytes immutable after read preparation',async()=>{
  await fixture((_q,r)=>r.end(original));const expected=Buffer.from(original),read=prepareSavedS3Read(config,key,expected);expected.fill(0)
  expect(await read.verify()).toBe('MATCH')
 })
 it.each([206,302,403,503])('keeps read HTTP %i unresolved without retry or PUT',async status=>{
  const e=await fixture((_q,r)=>{if(status===206){r.writeHead(206,{'Content-Range':'bytes 0-3/99'});r.end('part')}else failure(r,status)})
  await expect(prepareSavedS3Read(config,key,original).verify()).rejects.toBeInstanceOf(SavedS3Failure)
  expect(e.methods).toEqual(['GET'])
 })
 it('holds an encoded representation instead of treating it as an exact saved artifact',async()=>{
  const e=await fixture((_q,r)=>{r.setHeader('Content-Encoding','gzip');r.end(original)})
  await expect(prepareSavedS3Read(config,key,original).verify()).rejects.toBeInstanceOf(SavedS3Failure);expect(e.requests()).toBe(1)
 })
 it('holds an interrupted exact-length stream and never fabricates a mismatch or another request',async()=>{
  const e=await fixture((_q,r)=>{r.writeHead(200,{'Content-Length':original.length});r.write(original.subarray(0,2));r.flushHeaders();setTimeout(()=>r.destroy(),5)})
  await expect(prepareSavedS3Read(config,key,original).verify()).rejects.toBeInstanceOf(SavedS3Failure);expect(e.methods).toEqual(['GET'])
 })
 it('cancels before transmission without usage or network and consumes its local object',async()=>{
  const e=await fixture((_q,r)=>r.end()),controller=new AbortController();controller.abort()
  const action=prepareSavedS3Create(config,key,original,'application/json')
  await expect(action.send({signal:controller.signal})).rejects.toMatchObject({name:'AbortError'})
  await expect(action.send()).rejects.toBeInstanceOf(SavedS3Failure)
  expect(e.requests()).toBe(0);expect(usage).not.toHaveBeenCalled()
 })
 it('cancels during usage bookkeeping without issuing an HTTP request',async()=>{
  const e=await fixture((_q,r)=>r.end()),controller=new AbortController()
  usage.mockImplementation(async()=>{controller.abort()})
  await expect(prepareSavedS3Create(config,key,original,'application/json').send({signal:controller.signal})).rejects.toMatchObject({name:'AbortError'})
  expect(e.requests()).toBe(0)
 })
 it('retains a usage-journal failure before HTTP without permitting another call',async()=>{
  const e=await fixture((_q,r)=>r.end()),action=prepareSavedS3Create(config,key,original,'application/json')
  usage.mockRejectedValueOnce(new Error('fixture journal unavailable'))
  await expect(action.send()).rejects.toBeInstanceOf(SavedS3Failure)
  await expect(action.send()).rejects.toBeInstanceOf(SavedS3Failure)
  expect(e.requests()).toBe(0);expect(usage).toHaveBeenCalledTimes(1)
 })
 it('cancellation settles stalled bookkeeping and its later completion cannot start a PUT',async()=>{
  const e=await fixture((_q,r)=>r.end()),controller=new AbortController();let finish!:()=>void
  usage.mockImplementationOnce(()=>new Promise<void>(resolve=>finish=resolve))
  const action=prepareSavedS3Create(config,key,original,'application/json'),pending=action.send({signal:controller.signal})
  const rejected=expect(pending).rejects.toMatchObject({name:'AbortError'})
  await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));controller.abort();await rejected
  finish();await new Promise(resolve=>setTimeout(resolve,10))
  expect(e.requests()).toBe(0);await expect(action.send()).rejects.toBeInstanceOf(SavedS3Failure)
 })
 it('the operation deadline also settles stalled bookkeeping without a request',async()=>{
  const e=await fixture((_q,r)=>r.end())
  usage.mockImplementationOnce(()=>new Promise<void>(()=>{}))
  await expect(prepareSavedS3Create(config,key,original,'application/json').send({timeoutMs:100})).rejects.toMatchObject({name:'TimeoutError'})
  expect(e.requests()).toBe(0)
 })
 it('cancels an in-flight PUT without retrying after the remote service has accepted bytes',async()=>{
  const controller=new AbortController(),e=await fixture(()=>{setTimeout(()=>controller.abort(),10)})
  await expect(prepareSavedS3Create(config,key,original,'application/json').send({signal:controller.signal})).rejects.toMatchObject({name:'AbortError'})
  expect(e.requests()).toBe(1)
 })
 it('cancels a streaming GET after headers and preserves cancellation rather than returning a fact',async()=>{
  const controller=new AbortController(),e=await fixture((_q,r)=>{r.writeHead(200);r.write(original.subarray(0,2));setTimeout(()=>controller.abort(),10)})
  await expect(prepareSavedS3Read(config,key,original).verify({signal:controller.signal})).rejects.toMatchObject({name:'AbortError'})
  expect(e.methods).toEqual(['GET'])
 })
 it.each(['write','read'] as const)('bounds %s stalls without a successor',async kind=>{
  const e=await fixture((_q,r)=>{if(kind==='read'){r.writeHead(200);r.write(original.subarray(0,2))}})
  const action=kind==='write'?prepareSavedS3Create(config,key,original,'application/json').send({timeoutMs:100}):prepareSavedS3Read(config,key,original).verify({timeoutMs:100})
  await expect(action).rejects.toMatchObject({name:'TimeoutError'});expect(e.requests()).toBe(1)
 })
 it('uses independent permits for concurrent separately prepared operations',async()=>{
  const e=await fixture((_q,r)=>r.end())
  await Promise.all([prepareSavedS3Create(config,'saved/one',original,'application/json').send(),prepareSavedS3Create(config,'saved/two',original,'application/json').send()])
  expect(e.requests()).toBe(2);expect(usage).toHaveBeenCalledTimes(2)
 })
 it('admits only one concurrent call on the same prepared action',async()=>{
  const e=await fixture((_q,r)=>r.end()),action=prepareSavedS3Create(config,key,original,'application/json')
  const results=await Promise.allSettled([action.send(),action.send()])
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(e.requests()).toBe(1)
 })
 it.each(['','/leading','a//b','a/../b','a/./b','a/','bad\u0000key'])('refuses a normalized or unsafe key %j before HTTP',async bad=>{
  const e=await fixture((_q,r)=>r.end())
  expect(()=>prepareSavedS3Create(config,bad,original,'application/json')).toThrow(SavedS3Failure);expect(e.requests()).toBe(0)
 })
 it('refuses multipart-sized buffers, empty artifacts, unsupported types and target changes at preparation',async()=>{
  const e=await fixture((_q,r)=>r.end())
  for(const bytes of [Buffer.alloc(0),Buffer.alloc(1_000_001)])expect(()=>prepareSavedS3Create(config,key,bytes,'application/json')).toThrow(SavedS3Failure)
  expect(()=>prepareSavedS3Create(config,key,original,'text/html')).toThrow(SavedS3Failure)
  expect(()=>prepareSavedS3Read({...config,accountId:'foreign/account'},key,original)).toThrow(SavedS3Failure)
  expect(()=>prepareSavedS3Read({...config,bucket:'../foreign'},key,original)).toThrow(SavedS3Failure)
  expect(e.requests()).toBe(0)
 })
})
