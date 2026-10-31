import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe,expect,it } from 'vitest'
const script=readFileSync(new URL('../../../../docs/manager-agents/website-ui/probe.js',import.meta.url),'utf8')
function probe(host:string,options:{reason?:string;privateText?:string;ready?:boolean;upload?:boolean;icon?:string;expectedWorkflow?:string;menu?:boolean;composerPlaceholder?:string;uploadLabel?:string}={}) {
  const button=(label:string,tagName='BUTTON'):any=>({
    tagName,children:[],value:options.ready?'private prompt':'',textContent:options.ready?'private prompt':'',innerText:label,
    getAttribute:(key:string)=>key==='aria-label'?label:null,
    getBoundingClientRect:()=>({x:40,y:600,width:100,height:40}),contains:()=>false,closest:()=>null,
    querySelector:()=>tagName==='TEXTAREA'?null:({tagName:'svg',children:[],getAttribute:()=>'',querySelectorAll:()=>[{getAttribute:()=>options.icon??'M 1 2'}]}),querySelectorAll:()=>[]
  })
  const input=button('','TEXTAREA'),upload=button(options.uploadLabel??'Add files'),send=button('Send'),nav=button('New chat')
  const query=(selector:string):any[]=>{
    if(selector.includes('contenteditable') || selector.includes('textarea[aria-label="Enter a prompt"]')) return options.composerPlaceholder ? (selector.includes(`textarea[placeholder="${options.composerPlaceholder}"]`) ? [input] : []) : [input]
    if(selector==='button, [role="button"]') return [nav,...(options.upload===false?[]:[upload]),send]
    if(selector.includes('role="alertdialog"')) return ['quota_overlay','session_overlay','dialog'].includes(options.reason??'')?[button(options.reason==='quota_overlay'?'Quota limit':options.reason==='session_overlay'?'Sign in':'Unknown dialog')]:[]
    if(selector.includes('data-talvt-turn-state')) return options.reason==='streaming'?[button('Stop streaming')]:[]
    if(selector==='[role="menu"], [role="listbox"], .cdk-overlay-pane') return options.menu?[button('Upload menu')]:[]
    if(selector==='ms-run-button button') return [send]
    return []
  }
  const document={readyState:options.reason==='loading'?'loading':'complete',documentElement:{lang:'en',classList:{contains:()=>false},getAttribute:()=>null},querySelectorAll:query,body:{innerText:options.privateText??'private response and private@example.test'}}
  return runInNewContext(script,{__websiteUiExpected:options.expectedWorkflow??null,location:{hostname:host},document,innerWidth:480,innerHeight:800,visualViewport:{height:options.reason==='keyboard'?300:800},getComputedStyle:()=>({visibility:'visible',borderRadius:'4px',fontSize:'14px',fontWeight:'400',color:'white',backgroundColor:'black'})})
}
describe('read-only redacted website probe',()=>{
  it('reads all three provider surfaces without exporting page text',()=>{
    for(const host of ['chatgpt.com','gemini.google.com','aistudio.google.com']) {
      const value=probe(host,{ready:true,privateText:'secret conversation account@example.test'})
      expect(value.controls.find((c:any)=>c.id==='composer').count).toBe(1)
      expect(value.controls.find((c:any)=>c.id==='upload').count).toBe(1)
      expect(value.workflow).toBe('composer_ready')
      expect(JSON.stringify(value)).not.toMatch(/secret|private|example|hostname|prompt-textarea/)
    }
    expect(probe('unrelated.example')).toBeNull()
  })
  it('recognizes the ChatGPT textarea variants supported by the clipping adapter',()=>{
    for (const composerPlaceholder of ['Work with ChatGPT','Ask ChatGPT']) {
      const value=probe('chatgpt.com',{composerPlaceholder})
      expect(value.controls.find((c:any)=>c.id==='composer').count).toBe(1)
      expect(value.workflow).toBe('composer_empty')
      expect(JSON.stringify(value)).not.toContain(composerPlaceholder)
    }
  })
  it('recognizes current clipping adapter attachment labels without exporting them',()=>{
    for (const uploadLabel of ['Add photos and files','Add files and more','Upload photos & files']) {
      const value=probe('chatgpt.com',{uploadLabel})
      const control=value.controls.find((c:any)=>c.id==='upload')
      expect(control.count).toBe(1)
      expect(['attach','upload']).toContain(control.label)
      expect(JSON.stringify(value)).not.toContain(uploadLabel)
    }
  })
  it('ignores conversation contents and recognizes transient states',()=>{
    expect(JSON.stringify(probe('chatgpt.com',{privateText:'first'}))).toBe(JSON.stringify(probe('chatgpt.com',{privateText:'different stream'})))
    for(const reason of ['loading','streaming','quota_overlay','session_overlay','dialog','keyboard']) expect(probe('chatgpt.com',{reason}).reason).toBe(reason)
  })
  it('retains missing-control and icon changes as comparable evidence',()=>{
    const before=probe('chatgpt.com'),after=probe('chatgpt.com',{upload:false})
    expect(after.reason).toBe('stable');expect(after.controls.find((c:any)=>c.id==='upload').count).toBe(0)
    expect(probe('chatgpt.com',{icon:'M 5 8'}).controls.find((c:any)=>c.id==='upload').icon).not.toBe(before.controls.find((c:any)=>c.id==='upload').icon)
  })
  it('keeps a failed upload lookup in its expected workflow without treating a closed menu as a redesign',()=>{
    const open=probe('chatgpt.com',{expectedWorkflow:'upload_menu',menu:true})
    expect(open.workflow).toBe('upload_menu');expect(open.reason).toBe('stable')
    expect(open.controls.find((c:any)=>c.id==='upload').count).toBe(0)
    expect(probe('chatgpt.com',{expectedWorkflow:'upload_menu'}).reason).toBe('unsupported')
  })
  it('contains no interaction, observer, upload or navigation primitives',()=>{
    expect(script).not.toMatch(/\.click\(|\.focus\(|\.scrollIntoView\(|dispatchEvent\(|new MutationObserver|\bfetch\(|XMLHttpRequest|location\.(?:href|assign|replace)\s*[=(]/)
  })
})
