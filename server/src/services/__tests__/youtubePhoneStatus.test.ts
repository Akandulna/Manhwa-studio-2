import {describe,it,expect} from 'vitest'
import {youtubePhoneStatus} from '../youtubePhoneStatus.js'
describe('YouTube phone activity',()=>{
 it('recognizes active older betas without progress details',()=>{expect(youtubePhoneStatus({youtube:{active:true}})).toMatchObject({active:true,paused:false,label:'YouTube',step:'Working in ChatGPT'})})
 it('reads paused progress and keeps idle authoritative after completion',()=>{const raw={youtube:{active:true,current:{paused:true,label:'YouTube thumbnail',step:'Returning the thumbnail to Studio',seriesId:'series',jobId:'job'}}};expect(youtubePhoneStatus(raw)).toMatchObject({active:true,paused:true,label:'YouTube thumbnail',seriesId:'series'});raw.youtube.active=false;expect(youtubePhoneStatus(raw)?.active).toBe(false)})
 it('does not invent active work from malformed or missing reports',()=>{expect(youtubePhoneStatus(null)).toBeUndefined();expect(youtubePhoneStatus({})).toBeUndefined();expect(youtubePhoneStatus({youtube:{active:'true',current:{step:55}}})).toMatchObject({active:false,step:'Working in ChatGPT'})})
 it('bounds phone-supplied display strings',()=>{const y=youtubePhoneStatus({youtube:{active:true,current:{label:'a'.repeat(100),step:'b'.repeat(500)}}})!;expect(y.label).toHaveLength(80);expect(y.step).toHaveLength(240)})
})
