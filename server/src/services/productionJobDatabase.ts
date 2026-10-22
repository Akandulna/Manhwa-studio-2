import type {PrismaClient} from '@prisma/client'
import {ProductionOwnershipConflict,type ProductionStoreDatabase} from './productionJobStore.js'
/** SQLite transactions and exact prior JSON comparisons; no schema migration or unconditional upsert. */
export function productionJobDatabase(prisma:()=>PrismaClient):ProductionStoreDatabase {
 return {transaction:work=>prisma().$transaction(async tx=>work({
  get:async key=>(await tx.setting.findUnique({where:{key}}))?.value??null,
  list:prefix=>tx.setting.findMany({where:{key:{startsWith:prefix}},select:{key:true,value:true}}),
  insert:async(key,value)=>{await tx.setting.create({data:{key,value}})},
  replace:async(key,previous,value)=>(await tx.setting.updateMany({where:{key,value:previous},data:{value}})).count===1
 })).catch(error=>{
  if(['P2002','P2034','P1008','P2028'].includes(error?.code))throw new ProductionOwnershipConflict('Production storage changed or is busy. Reconcile current scheduler ownership before retrying')
  throw error
 })}
}
