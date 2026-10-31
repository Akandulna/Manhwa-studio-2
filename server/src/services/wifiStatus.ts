/** Dedicated LAN interface. Never dispatches production or managed commands. */
import { createServer, type Server as HttpsServer } from 'node:https'
import { randomBytes, X509Certificate } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { networkInterfaces } from 'node:os'
import { WebSocketServer, WebSocket } from 'ws'
import type { Express } from 'express'
import { parseManagerReport } from './managerProtocol.js'
import { relayFetch } from './relayTraffic.js'

export const WIFI_KINDS = new Set(['sync','scripts','crops','process','screen','library'])
export function validRefresh(m:any, now=Date.now()):boolean {
 return !!m && m.type==='refresh_status' && Object.keys(m).every(k=>['type','id','device','requestedAt','deadline'].includes(k)) &&
 typeof m.id==='string' && /^[a-zA-Z0-9_-]{1,128}$/.test(m.id) && typeof m.device==='string' &&
 Number.isFinite(m.deadline) && m.deadline>now && m.deadline-Date.parse(m.requestedAt)>0 && m.deadline-Date.parse(m.requestedAt)<=60_000 &&
 Number.isFinite(Date.parse(m.requestedAt)) && Math.abs(now-Date.parse(m.requestedAt))<=60_000
}
type Credential={device:string;token:string;master:boolean;expires:number}
type Snapshot={type:'receipt';device:string;kind:string;at:number;body:any;revision:number}
type State={credentials:Credential[];snapshots:Record<string,Snapshot>;observations?:Record<string,{at:number;reports:any[]}>}
type Hooks={receipt:(m:Snapshot)=>void;cloudRefresh:(request:any)=>Promise<void>}
let active:WifiStatusHub|undefined
export class WifiStatusHub {
 private refreshResults:Record<string,{at:number;result:string}>={}; private state:State; private server?:HttpsServer; private advertiser?:ChildProcess
 private sockets=new Map<WebSocket,Credential>(); private waiters=new Map<string,{parts:Set<string>;resolve:(ok:boolean)=>void;timer:NodeJS.Timeout}>()
 private wss=new WebSocketServer({noServer:true,maxPayload:1_000_000}); private cert:Buffer; private key:Buffer
 private busy=new Map<WebSocket,number>(); private rate=new Map<WebSocket,{at:number;count:number}>(); private heartbeat?:NodeJS.Timeout; private heard=new Map<WebSocket,number>()
 constructor(private dir:string,private hooks:Hooks,private port=8847) {
  mkdirSync(dir,{recursive:true,mode:0o700})
  const certPath=resolve(dir,'certificate.pem'),keyPath=resolve(dir,'key.pem')
  if(!existsSync(certPath)||!existsSync(keyPath))execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyPath,'-out',certPath,'-days','365','-subj','/CN=SleeperCell-WiFi','-addext','subjectAltName=DNS:SleeperCell-WiFi,IP:127.0.0.1'],{stdio:'ignore'})
  this.cert=readFileSync(certPath);this.key=readFileSync(keyPath)
  this.state=existsSync(resolve(dir,'state.json'))?JSON.parse(readFileSync(resolve(dir,'state.json'),'utf8')):{credentials:[],snapshots:{}}
 }
 private presence(){const devices=[...new Set([...this.sockets.values()].map(c=>c.device))].map(id=>({id,name:Object.values(this.state.snapshots).find(s=>s.device===id)?.body?.device??id}));for(const[ws,c]of this.sockets)if(c.master&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'wifi_presence',devices}))}
 private save(){const p=resolve(this.dir,'state.json');writeFileSync(p+'.tmp',JSON.stringify(this.state),{mode:0o600});renameSync(p+'.tmp',p)}
 pairing(device:string,master:boolean,host:string){
  if(!/^[a-zA-Z0-9_-]{1,128}$/.test(device)||!host||host.includes('/'))throw Error('Enter the phone device ID and Mac LAN address')
  this.state.credentials=this.state.credentials.filter(c=>c.device!==device);if(this.state.credentials.length>=32)throw Error('Device limit reached')
  for(const [ws,c]of this.sockets)if(c.device===device)ws.close(1008,'Pairing replaced')
  const c={device,master,token:randomBytes(32).toString('hex'),expires:Date.now()+300_000};this.state.credentials.push(c);this.save()
  return {schema:'wifi-status/1',url:`https://${host}:${this.boundPort()}`,device,master,token:c.token,certificate:this.cert.toString('base64'),expires:c.expires}
 }
 forget(device:string){this.revoke(device);for(const key of Object.keys(this.state.snapshots))if(this.state.snapshots[key].device===device)delete this.state.snapshots[key];if(this.state.observations)delete this.state.observations[device];this.save()}
 revoke(device:string){this.state.credentials=this.state.credentials.filter(c=>c.device!==device);for(const[ws,c]of this.sockets)if(c.device===device)ws.close(1008,'Revoked');this.save()}
 status(){return{enabled:true,refreshResults:this.refreshResults,port:this.boundPort(),devices:[...this.sockets.values()].map(c=>c.device),observations:Object.entries(this.state.observations??{}).map(([device,o])=>({device,at:o.at,count:o.reports.length,provisional:true})),snapshots:Object.values(this.state.snapshots).map(s=>({device:s.device,kind:s.kind,at:s.at,revision:s.revision})),addresses:Object.values(networkInterfaces()).flat().filter(a=>a&&!a.internal&&a.family==='IPv4').map(a=>a!.address)}}
 boundPort(){const a=this.server?.address();return typeof a==='object'&&a?a.port:this.port}
 start(){
  this.server=createServer({key:this.key,cert:this.cert},(_req,res)=>{res.writeHead(404);res.end()})
  this.server.on('upgrade',(req,socket,head)=>{
   const token=req.headers.authorization?.replace(/^Bearer /,'');const c=this.state.credentials.find(c=>c.token===token)
   if(req.url!=='/status'||!c||c.expires&&c.expires<Date.now()){socket.destroy();return}
   this.wss.handleUpgrade(req,socket,head,ws=>{
    if(c.expires){c.expires=0;this.save()}
    for(const[old,credential]of this.sockets)if(credential.device===c.device)old.close(1000,'Reconnected')
    this.sockets.set(ws,c);this.heard.set(ws,Date.now());ws.on('pong',()=>this.heard.set(ws,Date.now()));ws.on('close',()=>this.heard.delete(ws));ws.on('error',()=>{});ws.on('close',()=>{this.sockets.delete(ws);this.presence()})
    ws.send(JSON.stringify({type:'hello',schema:'wifi-status/1',device:c.device,master:c.master}))
    if(c.master)for(const m of Object.values(this.state.snapshots))ws.send(JSON.stringify(m))
    this.presence()
    ws.on('message',data=>{
     const rate=this.rate.get(ws)??{at:Date.now(),count:0};if(Date.now()-rate.at>10_000){rate.at=Date.now();rate.count=0}rate.count++;this.rate.set(ws,rate)
     if((this.busy.get(ws)??0)>=8||rate.count>100){ws.close(1008,'Status rate exceeded');return}
     this.busy.set(ws,(this.busy.get(ws)??0)+1)
     void this.message(ws,c,data.toString()).catch(()=>ws.close(1008,'Invalid status message')).finally(()=>{this.busy.set(ws,Math.max(0,(this.busy.get(ws)??0)-1))})
    });ws.on('close',()=>{this.rate.delete(ws);this.busy.delete(ws)})
   })
  })
  this.server.listen(this.port,'0.0.0.0');this.server.on('error',()=>{this.close();if(active===this)active=undefined})
  if(process.platform==='darwin'){this.advertiser=spawn('dns-sd',['-R','SleeperCell Studio','_sleeperstatus._tcp','local',String(this.port),'id='+new X509Certificate(this.cert).fingerprint256.replace(/:/g,'').toLowerCase()],{stdio:'ignore'});this.advertiser.on('error',()=>{})}
  this.heartbeat=setInterval(()=>{for(const ws of this.sockets.keys()){if(Date.now()-(this.heard.get(ws)??0)>60_000)ws.terminate();else ws.ping()}},20_000);this.heartbeat.unref()
  return this
 }
 private async message(ws:WebSocket,c:Credential,text:string){
  const m=JSON.parse(text)
  if(m.type==='receipt'){
   if(!WIFI_KINDS.has(m.kind)||m.device!==c.device||(m.body?.deviceId!==undefined&&m.body.deviceId!==c.device)||!Number.isSafeInteger(m.revision)||m.revision<1||!m.body||typeof m.body!=='object'||Array.isArray(m.body))throw Error('Invalid receipt')
   const key=c.device+'/'+m.kind,previous=this.state.snapshots[key]
   if(!previous||m.revision>previous.revision||(m.revision===previous.revision&&typeof m.body.answers==='string')){const snapshot:Snapshot={type:'receipt',device:c.device,kind:m.kind,body:m.body,revision:m.revision,at:Date.now()};this.state.snapshots[key]=snapshot;this.save();this.hooks.receipt(snapshot);for(const[other,credential]of this.sockets)if(credential.master&&other.readyState===WebSocket.OPEN)other.send(JSON.stringify(snapshot))}
   ws.send(JSON.stringify({type:'stored',id:m.id,revision:m.revision}))
   const answer=m.body.answers;if(typeof answer==='string'){const w=this.waiters.get(answer+'/'+c.device);if(w){w.parts.add(m.kind);if(['sync','scripts','crops','process','screen'].every(k=>w.parts.has(k))){clearTimeout(w.timer);this.waiters.delete(answer+'/'+c.device);this.refreshResults[c.device]={at:Date.now(),result:'completed'};w.resolve(true)}}}
  }else if(m.type==='manager'||m.type==='manager_observe'){
   if(JSON.stringify(m.body).length>256_000||!Array.isArray(m.body?.reports)||m.body.reports.length<1||m.body.reports.length>16||m.body.reports.some((r:any)=>r.source?.deviceId!==c.device||!parseManagerReport(r)))throw Error('Invalid report batch')
   this.state.observations??={};this.state.observations[c.device]={at:Date.now(),reports:m.body.reports};this.save()
   if(m.type==='manager_observe'){ws.send(JSON.stringify({type:'stored',id:m.id}));return}
   const url=process.env.RELAY_URL?.replace(/\/+$/,''),token=process.env.RELAY_TOKEN;if(!url||!token)throw Error('Cloud reporting unavailable')
   try {
    const response=await relayFetch(`${url}/manager/batch?device=${encodeURIComponent(c.device)}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(m.body),signal:AbortSignal.timeout(15_000),redirect:'error'})
    if(!response.ok){await response.body?.cancel();throw Error('Cloud report not accepted')}
    const body=await response.json();if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'manager_ack',id:m.id,body}))
   }catch{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'delivery_unavailable',id:m.id}))}
  }else if(c.master&&validRefresh(m)){
   // The Master caller retains the original ID and owns cloud fallback; do not send a second copy here.
   const ok=await this.refresh(m)
   ws.send(JSON.stringify({type:'refresh_ack',id:m.id,device:m.device,phones:ok?1:0}))
  }else throw Error('LAN supports status and refresh_status only')
 }
 refresh(m:any):Promise<boolean>{
  if(!validRefresh(m)){this.refreshResults[m?.device??'unknown']={at:Date.now(),result:'invalid_request'};return Promise.resolve(false)}
  const phone=[...this.sockets].find(([,c])=>c.device===m.device)?.[0];if(!phone||phone.readyState!==WebSocket.OPEN){this.refreshResults[m.device]={at:Date.now(),result:'not_local'};return Promise.resolve(false)}
  const key=m.id+'/'+m.device;if(this.waiters.has(key))return Promise.resolve(false)
  return new Promise(resolve=>{const timer=setTimeout(()=>{this.waiters.delete(key);this.refreshResults[m.device]={at:Date.now(),result:'timeout'};resolve(false)},Math.min(50_000,m.deadline-Date.now()));this.waiters.set(key,{parts:new Set(),resolve,timer});phone.send(JSON.stringify(m))})
 }
 close(){for(const w of this.waiters.values()){clearTimeout(w.timer);w.resolve(false)}this.waiters.clear();for(const ws of this.sockets.keys())ws.terminate();this.sockets.clear();this.wss.close();this.server?.close();this.advertiser?.kill();clearInterval(this.heartbeat)}
}
export function wifiHub(){return active}
export function installWifiStatus(app:Express,hooks:Hooks){
 const dir=resolve(process.env.WIFI_STATUS_DIR||'.config/wifi-status')
 const enable=()=>active??(active=new WifiStatusHub(dir,hooks,Number(process.env.WIFI_STATUS_PORT)||8847).start())
 // Admin surface is loopback-only, including browser origin. The LAN port exposes no admin routes.
 app.use('/api/wifi-status',(req,res,next)=>{const ip=req.socket.remoteAddress;if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(ip||''))return res.sendStatus(403);if(req.headers.origin){try{if(!['localhost','127.0.0.1','[::1]'].includes(new URL(req.headers.origin).hostname))return res.sendStatus(403)}catch{return res.sendStatus(403)}}next()})
 app.get('/api/wifi-status',(_req,res)=>res.json(active?.status()??{enabled:false}))
 app.post('/api/wifi-status/pair',(req,res)=>{try{mkdirSync(dir,{recursive:true,mode:0o700});if(existsSync(resolve(dir,'disabled')))unlinkSync(resolve(dir,'disabled'));writeFileSync(resolve(dir,'enabled'),'1');res.json(enable().pairing(req.body.device,req.body.master===true,req.body.host))}catch{res.status(400).json({error:'Enter a valid phone device ID and Mac LAN address'})}})
 app.post('/api/wifi-status/enable',(_req,res)=>{try{mkdirSync(dir,{recursive:true,mode:0o700});if(existsSync(resolve(dir,'disabled')))unlinkSync(resolve(dir,'disabled'));writeFileSync(resolve(dir,'enabled'),'1');res.json(enable().status())}catch{res.status(503).json({error:'Local status service unavailable'})}})
 app.post('/api/wifi-status/revoke',(req,res)=>{active?.revoke(req.body.device);res.json({ok:true})})
 app.post('/api/wifi-status/disable',(_req,res)=>{active?.close();active=undefined;mkdirSync(dir,{recursive:true,mode:0o700});writeFileSync(resolve(dir,'disabled'),'1');res.json({ok:true})})
 if((process.env.WIFI_STATUS_ENABLED==='1'||existsSync(resolve(dir,'enabled')))&&!existsSync(resolve(dir,'disabled')))enable()
}
