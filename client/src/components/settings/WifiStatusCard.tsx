import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card,CardHeader,CardTitle,CardDescription,CardContent } from '@/components/ui/card'
export function WifiStatusCard(){
 const [state,setState]=useState<any>(null),[device,setDevice]=useState(''),[host,setHost]=useState(''),[master,setMaster]=useState(false),[pair,setPair]=useState(''),[error,setError]=useState('')
 async function reload(){const response=await fetch('/api/wifi-status');if(response.ok)setState(await response.json())}
 useEffect(()=>{void reload();const timer=setInterval(()=>void reload(),10_000);return()=>clearInterval(timer)},[])
 async function action(path:string,body:any={}){setError('');try{const res=await fetch('/api/wifi-status/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!res.ok)throw Error('Open Studio on this Mac and check the device ID and LAN address.');const value=await res.json();if(path==='pair')setPair(JSON.stringify(value));await reload()}catch(e){setError(String(e))}}
 return <Card><CardHeader><CardTitle>Wi-Fi status</CardTitle><CardDescription>Status and Refresh use the local network. Sync, other commands and managed coordination use Cloudflare. Files stay on R2.</CardDescription></CardHeader><CardContent className="space-y-3">
 <p>{state?.enabled?'Local status service is running':'Local status service is off'}. Connected: {state?.devices?.join(', ')||'none'}</p>
 {state?.addresses?.length>0&&<p>Mac addresses: {state.addresses.join(', ')}</p>}
 <label className="block">Phone device ID<Input value={device} onChange={e=>setDevice(e.target.value)} placeholder="Copy from phone Settings → Manhwa → Wi-Fi status"/></label>
 <label className="block">Mac Wi-Fi address<Input value={host} onChange={e=>setHost(e.target.value)} placeholder="192.168.1.10"/></label>
 <label className="flex gap-2"><input type="checkbox" checked={master} onChange={e=>setMaster(e.target.checked)}/>Allow this phone to view other phones and refresh their status</label>
 <div className="flex gap-2">{!state?.enabled&&<Button variant="outline" onClick={()=>void action('enable')}>Enable Wi-Fi status</Button>}<Button onClick={()=>void action('pair',{device,host,master})}>Create pairing</Button><Button variant="outline" onClick={()=>void action('revoke',{device})}>Revoke phone</Button><Button variant="outline" onClick={()=>void action('disable')}>Disable Wi-Fi status</Button></div>
 {pair&&<><p>Paste this private pairing into this phone within five minutes. It includes access credentials; do not share it.</p><textarea className="w-full h-24 border rounded p-2" readOnly value={pair}/><Button variant="outline" onClick={()=>void navigator.clipboard.writeText(pair)}>Copy pairing</Button></>}
 {state?.observations?.map((o:any)=><p className="text-sm" key={o.device}>{o.device}: {o.count} locally observed manager reports at {new Date(o.at).toLocaleTimeString()}. Cloud acceptance is tracked separately.</p>)}
 {error&&<p role="alert">{error}</p>}
 {state?.snapshots?.length>0&&<div className="text-sm">{state.snapshots.map((s:any)=><p key={s.device+'/'+s.kind}>{s.device}: {s.kind} observed {new Date(s.at).toLocaleTimeString()}</p>)}</div>}
 </CardContent></Card>
}
