import { TaskConflict, type CropTask, type CropAttempt } from '../../server/src/services/managedTaskProtocol'
import { artifactHash, validateManagedCrop, MAX_MANAGED_ARTIFACT_BYTES, type ManagedArtifactRecord } from '../../server/src/services/managedCropArtifact'
export interface ManagedArtifactBucket {
 get(key:string):Promise<{size:number;arrayBuffer():Promise<ArrayBuffer>}|null>
 put(key:string,value:Uint8Array,options:{onlyIf:{etagDoesNotMatch:string};httpMetadata:{contentType:string}}):Promise<unknown>
}
export async function boundedBody(body:ReadableStream<Uint8Array>|null,max:number):Promise<Uint8Array> {
 if(!body)throw new TaskConflict('Artifact body required')
 const reader=body.getReader(),chunks:Uint8Array[]=[];let length=0,oversized=false
 try {
  while(true){const part=await reader.read();if(part.done)break;length+=part.value.byteLength
   if(length>max){oversized=true;chunks.length=0}else if(!oversized)chunks.push(part.value)
  }
 }finally{reader.releaseLock()}
 if(oversized)throw new TaskConflict('Artifact body size limit exceeded')
 const bytes=new Uint8Array(length);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length}return bytes
}
export async function readManagedArtifact(bucket:ManagedArtifactBucket,record:ManagedArtifactRecord,task:CropTask,attempt:CropAttempt):Promise<Uint8Array> {
 const object=await bucket.get(record.ref)
 if(!object||object.size>MAX_MANAGED_ARTIFACT_BYTES)throw new TaskConflict('Staged artifact missing or too large')
 const bytes=new Uint8Array(await object.arrayBuffer())
 if(await artifactHash(bytes)!==record.sha256)throw new TaskConflict('Staged artifact checksum mismatch')
 validateManagedCrop(bytes,task,attempt)
 return bytes
}
/** Conditional creation prevents an overlapping request or a retry from overwriting attempt bytes. */
export async function storeManagedArtifact(bucket:ManagedArtifactBucket,record:ManagedArtifactRecord,bytes:Uint8Array):Promise<void> {
 const existing=await bucket.get(record.ref)
 if(!existing)await bucket.put(record.ref,bytes,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}})
 const readback=await bucket.get(record.ref)
 if(!readback||readback.size>MAX_MANAGED_ARTIFACT_BYTES||await artifactHash(new Uint8Array(await readback.arrayBuffer()))!==record.sha256)throw new TaskConflict('Immutable artifact bytes conflict or failed readback')
}
