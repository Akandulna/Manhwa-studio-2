/** YouTube has its own job-start flow; it is status, not a chapter automation kind. */
export interface YouTubePhoneActivity { active:boolean; paused:boolean; label:string; step:string; seriesId:string|null; jobId:string|null }
export function youtubePhoneStatus(raw:unknown):YouTubePhoneActivity|undefined {
 if(!raw||typeof raw!=='object')return
 const y=(raw as Record<string,unknown>).youtube
 if(!y||typeof y!=='object')return
 const value=y as Record<string,unknown>;const current=value.current&&typeof value.current==='object'?value.current as Record<string,unknown>:{}
 const text=(v:unknown,max:number)=>typeof v==='string'?v.slice(0,max):''
 return {active:value.active===true,paused:current.paused===true,label:text(current.label,80)||'YouTube',step:text(current.step,240)||'Working in ChatGPT',seriesId:text(current.seriesId,200)||null,jobId:text(current.jobId,80)||null}
}
