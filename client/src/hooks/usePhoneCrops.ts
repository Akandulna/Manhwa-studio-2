/**
 * usePhoneCrops — which pages have their crop JSON on the Sleeper-Cell phone,
 * and which page its Auto-run is on, read on demand (see usePhoneReceipt).
 * With `chapterId`, also that chapter's pages.
 */

import { r2Api, PhoneCropsStatus } from '@/lib/api'
import { usePhoneReceipt, type PhoneReceipt } from './usePhoneReceipt'

export function usePhoneCrops(seriesId?: string, chapterId?: string): PhoneReceipt<PhoneCropsStatus> {
  return usePhoneReceipt(fresh => r2Api.getPhoneCrops(seriesId, chapterId, fresh), `${seriesId ?? ''}/${chapterId ?? ''}`)
}
