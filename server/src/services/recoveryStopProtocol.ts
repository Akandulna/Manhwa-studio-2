import {recoveryUnitKey,type RecoveryUnit} from './automationRecoveryPolicy.js'
import {recoveryExact,recoveryId} from './managedSavedImportRecoveryProtocol.js'
import {TaskConflict} from './managedTaskProtocol.js'
export const RECOVERY_STOP_SCHEMA='recovery-stop/1'
export type RecoveryStopMode='pause'|'disable'|'cancel'|'reinspect'
export interface RecoveryStopIntent {schema:typeof RECOVERY_STOP_SCHEMA;unit:RecoveryUnit;eventId:string;sequence:number;mode:RecoveryStopMode}
export interface RecoveryStopReceipt extends RecoveryStopIntent {receivedAt:number}
export interface RecoveryStopRecord {intent:RecoveryStopIntent;receipt:RecoveryStopReceipt|null}
export function parseRecoveryStopIntent(raw:unknown):RecoveryStopIntent{
 recoveryExact(raw,['schema','unit','eventId','sequence','mode']);recoveryUnitKey(raw.unit)
 if(raw.schema!==RECOVERY_STOP_SCHEMA||!recoveryId(raw.eventId)||!Number.isSafeInteger(raw.sequence)||raw.sequence<1||raw.sequence>128||!['pause','disable','cancel','reinspect'].includes(raw.mode))throw new TaskConflict('Exact bounded recovery stop intent required')
 return structuredClone(raw) as RecoveryStopIntent
}
export function parseRecoveryStopReceipt(raw:unknown):RecoveryStopReceipt{
 recoveryExact(raw,['schema','unit','eventId','sequence','mode','receivedAt']);const {receivedAt,...intent}=raw;parseRecoveryStopIntent(intent)
 if(!Number.isSafeInteger(receivedAt)||receivedAt<=0)throw new TaskConflict('Original relay stop receipt required')
 return structuredClone(raw) as RecoveryStopReceipt
}
export function parseRecoveryStopRecord(raw:unknown):RecoveryStopRecord{
 recoveryExact(raw,['intent','receipt']);const intent=parseRecoveryStopIntent(raw.intent),receipt=raw.receipt===null?null:parseRecoveryStopReceipt(raw.receipt)
 if(receipt&&(receipt.eventId!==intent.eventId||receipt.sequence!==intent.sequence||receipt.mode!==intent.mode||recoveryUnitKey(receipt.unit)!==recoveryUnitKey(intent.unit)))throw new TaskConflict('Original stop intent/receipt mismatch')
 return {intent,receipt}
}
