/**
 * usePhoneScripts — which chapters have a narration script on the Sleeper-Cell
 * phone, live through the phone relay or on demand (see usePhoneReceipt).
 */

import { r2Api, PhoneScriptsStatus } from '@/lib/api'
import { usePhoneReceipt, type PhoneReceipt } from './usePhoneReceipt'

export function usePhoneScripts(seriesId?: string): PhoneReceipt<PhoneScriptsStatus> {
  return usePhoneReceipt('scripts', fresh => r2Api.getPhoneScripts(seriesId, fresh), seriesId ?? '')
}
