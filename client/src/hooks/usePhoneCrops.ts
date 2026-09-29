/**
 * usePhoneCrops — which pages have their crop JSON on the Sleeper-Cell phone,
 * and which page its Auto-run is on, kept live while the page is open (see
 * usePhoneReceipt). With `chapterId`, also that chapter's pages.
 */

import { r2Api, PhoneCropsStatus } from '@/lib/api'
import { usePhoneReceipt } from './usePhoneReceipt'

export function usePhoneCrops(seriesId?: string, chapterId?: string): PhoneCropsStatus | null {
  return usePhoneReceipt(() => r2Api.getPhoneCrops(seriesId, chapterId), `${seriesId ?? ''}/${chapterId ?? ''}`)
}
