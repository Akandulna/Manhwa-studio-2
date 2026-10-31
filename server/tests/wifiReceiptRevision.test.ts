import {describe,it,expect} from 'vitest'
import {staleReceipt} from '../../relay/src/receiptState'
describe('source revision ordering',()=>{
 it('refuses late older source snapshots including explicit answers',()=>{expect(staleReceipt({wifiRevision:3},{wifiRevision:2})).toBe(true);expect(staleReceipt({wifiRevision:3},{wifiRevision:2,answers:'request'})).toBe(true)})
 it('accepts newer and same-revision replay',()=>{expect(staleReceipt({wifiRevision:3},{wifiRevision:4})).toBe(false);expect(staleReceipt({wifiRevision:3},{wifiRevision:3})).toBe(false)})
 it('retains compatibility for legacy and invalid revision fields',()=>{for(const value of [undefined,null,-1,0,'2',NaN]){expect(staleReceipt({wifiRevision:3},{wifiRevision:value})).toBe(false);expect(staleReceipt({wifiRevision:value},{wifiRevision:1})).toBe(false)}})
})
