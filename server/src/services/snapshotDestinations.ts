import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import type { PrismaClient } from '@prisma/client'
import type { SnapshotDestination, SnapshotJournal } from './snapshotDelivery.js'

export function snapshotJournal(db:PrismaClient):SnapshotJournal {
  return {
    load:async key=>(await db.setting.findUnique({where:{key}}))?.value??null,
    save:async(key,value)=>{await db.setting.upsert({where:{key},create:{key,value},update:{value}})}
  }
}
export function r2Snapshot(id:string,client:()=>S3Client,bucket:string,key:string,before?:()=>Promise<void>):SnapshotDestination {
  return {
    id,
    send:async body=>{
      await before?.()
      const c=client()
      try {await c.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:body,ContentType:'application/json'}))}finally{c.destroy()}
    },
    reconcile:async body=>{
      const c=client()
      try {const response=await c.send(new GetObjectCommand({Bucket:bucket,Key:key}));return await response.Body?.transformToString()===body}
      catch(error:any){if(error?.name==='NoSuchKey'||error?.$metadata?.httpStatusCode===404)return false;throw error}
      finally{c.destroy()}
    }
  }
}
