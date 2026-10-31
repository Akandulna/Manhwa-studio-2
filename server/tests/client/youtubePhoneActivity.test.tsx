import {describe,it,expect} from 'vitest'
import {phoneActivity} from '../../../client/src/pages/sleeper/sleeperShared'
import {stopChoice} from '../../../client/src/pages/sleeper/StopRun'
import type {PhoneOverview,PhoneOverviewPhone} from '../../../client/src/lib/api'
const phone=(active:boolean,paused=false)=>({id:'note',automation:{youtube:{active,paused,label:'YouTube thumbnail',step:'Returning image'}}}) as PhoneOverviewPhone
const overview={working:[],runs:[]} as unknown as PhoneOverview
describe('YouTube in Phone Status and Live Progress',()=>{
 it('reports active YouTube work as busy instead of Nothing running',()=>{const a=phoneActivity(overview,phone(true),true);expect(a.busy).toBe(true);expect(a.title).toBe('YouTube thumbnail');expect(a.going).toEqual(['YouTube thumbnail']);expect(a.youtube?.step).toBe('Returning image')})
 it('keeps paused work visible and clears completed work',()=>{const a=phoneActivity(overview,phone(true,true),true);expect(a.busy).toBe(true);expect(a.title).toBe('Paused');expect(a.going).toEqual([]);expect(phoneActivity(overview,phone(false),true).busy).toBe(false)})
 it('offers response completion wording for the YouTube stop dialog',()=>{const s=stopChoice(0,[],false,true)!;expect(s.after).toBe('Finish this response, then stop');expect(s.message).toContain('will not be sent again');expect(stopChoice(0,[],false)).toBeNull()})
})
