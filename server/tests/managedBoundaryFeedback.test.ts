import {describe,it,expect,afterEach} from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {cropBounds,boundaryChanges,saveBoundaryFeedback,readBoundaryFeedback,assertNoBoundaryChanges} from '../src/services/managedBoundaryFeedback.js'
const pointers={image:{width:709,height:12876},crops:[{id:'crop-01',crop:{points:[{x:0,y:0.1},{x:1,y:0.1},{x:1,y:0.3},{x:0,y:0.3}]}},{id:'crop-02',crop:{points:[{x:0,y:0.4},{x:1,y:0.4},{x:1,y:0.8},{x:0,y:0.8}]}}]}
const input={taskId:'task:sha256:'+'a'.repeat(64),revision:'b'.repeat(64),pointers}
const dirs:string[]=[];async function dir(){const d=await fs.mkdtemp(path.join(os.tmpdir(),'boundary-feedback-test-'));dirs.push(d);return d}
afterEach(async()=>{await Promise.all(dirs.splice(0).map(d=>fs.rm(d,{recursive:true,force:true})))})
describe('manual boundary feedback',()=>{
 it('records changed and removed crops against the original, preserving order',()=>{const b=cropBounds(pointers);b[0].top=0.05;const v=boundaryChanges(pointers,[b[0]]);expect(v.changes).toEqual([{cropId:'crop-01',before:cropBounds(pointers)[0],after:b[0]},{cropId:'crop-02',before:cropBounds(pointers)[1],after:null}]);expect(boundaryChanges(pointers,cropBounds(pointers).reverse()).changes).toEqual([])})
 it.each([NaN,Infinity,-0.1,1.1])('rejects out-of-source coordinate %s',n=>{const b=cropBounds(pointers);b[0].top=n;expect(()=>boundaryChanges(pointers,b)).toThrow()})
 it('rejects unknown IDs, duplicate IDs and pixel-empty rectangles',()=>{const b=cropBounds(pointers);expect(()=>boundaryChanges(pointers,[{...b[0],id:'other'}])).toThrow();expect(()=>boundaryChanges(pointers,[b[0],b[0]])).toThrow();expect(()=>boundaryChanges(pointers,[{...b[0],left:0.2,right:0.20000001}])).toThrow()})
 it('retains versions and notes across restart and refuses lost-update writes',async()=>{const d=await dir(),b=cropBounds(pointers);b[0].top=0.05;const first=await saveBoundaryFeedback(d,input,null,b,'Keep entire bubble');expect(await readBoundaryFeedback(d)).toEqual(first);await expect(saveBoundaryFeedback(d,input,null,b,'stale tab')).rejects.toThrow('changed');const second=await saveBoundaryFeedback(d,input,first.id,cropBounds(pointers),'Reset after comparison');expect(second.previousId).toBe(first.id);expect(second.changes).toEqual([]);expect(JSON.parse(await fs.readFile(path.join(d,'boundary-feedback-'+first.id+'.json'),'utf8')).note).toBe('Keep entire bubble');expect(await readBoundaryFeedback(d)).toEqual(second)})
 it('blocks approval/cut while corrections are pending and permits a saved reset',async()=>{const d=await dir(),b=cropBounds(pointers);b[0].bottom=0.35;const f=await saveBoundaryFeedback(d,input,null,b,'');await expect(assertNoBoundaryChanges(d,input.revision)).rejects.toThrow('pending');await assertNoBoundaryChanges(d,'c'.repeat(64));await saveBoundaryFeedback(d,input,f.id,cropBounds(pointers),'reset');await assertNoBoundaryChanges(d,input.revision)})
 it('does not follow feedback symlinks or overwrite their targets',async()=>{const d=await dir(),target=path.join(d,'untouched');await fs.writeFile(target,'private');await fs.symlink(target,path.join(d,'boundary-feedback-v1.json'));await expect(saveBoundaryFeedback(d,input,null,cropBounds(pointers),'')).rejects.toThrow();expect(await fs.readFile(target,'utf8')).toBe('private')})
})
