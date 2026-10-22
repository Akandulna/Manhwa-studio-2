import fs from 'node:fs/promises'
import {expect,it} from 'vitest'
import {artifactHash,artifactRef,validateManagedCrop} from '../src/services/managedCropArtifact.js'
import {parseManagedOperation,cropTaskIdentity} from '../src/services/managedTaskProtocol.js'
it('accepts the actual Kotlin saved-artifact packet, exact bytes and shared task identity',async()=>{
 const fixture=JSON.parse(await fs.readFile(new URL('../../docs/manager-agents/phase3/artifact-command-fixture.json',import.meta.url),'utf8'))
 const packet=JSON.parse(await fs.readFile(new URL('../../docs/manager-agents/phase3/kotlin-artifact.json',import.meta.url),'utf8'))
 const op=parseManagedOperation(packet.operation);expect(op.action).toBe('stage');if(op.action!=='stage')throw new Error('Expected stage')
 const {workspaceId,seriesId,chapterId,pageId}=fixture.task
 expect(await cropTaskIdentity({workspaceId,seriesId,chapterId,pageId},fixture.task.spec)).toEqual({taskId:op.taskId,fingerprint:op.fingerprint})
 const bytes=new TextEncoder().encode(packet.document)
 expect(await artifactHash(bytes)).toBe(op.contentHash)
 expect(op.ref).toBe(artifactRef(fixture.task,fixture.attempt.id,op.artifactId))
 expect(validateManagedCrop(bytes,fixture.task,{...fixture.attempt,phase:'result_saved',submission:'saved',checkpointRef:'checkpoint/crop-output'}).validatorVersion).toBe('managed-crop-validator/1')
})
