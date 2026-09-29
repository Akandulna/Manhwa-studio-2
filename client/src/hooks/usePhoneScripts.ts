/**
 * usePhoneScripts — which chapters have a narration script on the Sleeper-Cell
 * phone, kept live while the page is open (see usePhoneReceipt).
 */

import { r2Api, PhoneScriptsStatus } from '@/lib/api'
import { usePhoneReceipt } from './usePhoneReceipt'

export function usePhoneScripts(seriesId?: string): PhoneScriptsStatus | null {
  return usePhoneReceipt(() => r2Api.getPhoneScripts(seriesId), seriesId ?? '')
}
