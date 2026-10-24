import type {TaskSql} from './taskAuthority'

/** Logical archive: keep immutable task/claim/lineage evidence accessible, free only active inventory. */
export function initTaskArchive(sql:TaskSql){
 sql.exec('CREATE TABLE IF NOT EXISTS managed_task_archive (id TEXT PRIMARY KEY, archived_at TEXT NOT NULL)')
 sql.exec('CREATE TABLE IF NOT EXISTS managed_released_uploads (id TEXT PRIMARY KEY, bytes INTEGER NOT NULL)')
}
const inventoryTaskId=`COALESCE(
 json_extract(body,'$.fence.unit.taskId'),json_extract(body,'$.fence.taskId'),
 json_extract(body,'$.unit.taskId'),json_extract(body,'$.challenge.unit.taskId'),
 json_extract(body,'$.intent.unit.taskId'),json_extract(body,'$.parent.taskId'),
 json_extract(body,'$.taskId'),json_extract(body,'$.root.taskId'),
 json_extract(body,'$.context.unit.taskId'))`
export const liveTaskInventory=`(
 EXISTS (SELECT 1 FROM json_each(body,'$.actions') action
   WHERE json_extract(action.value,'$.phase') IN ('reserved','executing','unknown','prepared'))
 OR json_extract(body,'$.phase') IN ('queued','claimed')
 OR NOT EXISTS (
   SELECT 1 FROM managed_task_archive archived WHERE archived.id = ${inventoryTaskId}
 )
)`
export function retainedInventory(sql:TaskSql,table:string,limit:number){
 if(!/^managed_[a-z_]+$/.test(table)||!Number.isSafeInteger(limit)||limit<1)throw new Error('Static managed inventory table and limit required')
 initTaskArchive(sql)
 return sql.exec(`SELECT id FROM ${table} WHERE ${liveTaskInventory} LIMIT ${limit+1}`).toArray().length
}
