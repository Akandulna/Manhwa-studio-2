/**
 * usePhoneOverview — everything Sleeper-Cell has reported, across every
 * series, for the Sleeper Cells page: live through the phone relay or on
 * demand (see usePhoneReceipt). Reloads on a push of any of the three receipts.
 */

import { r2Api, PhoneOverview } from '@/lib/api'
import { usePhoneReceipt, type PhoneReceipt } from './usePhoneReceipt'

export function usePhoneOverview(): PhoneReceipt<PhoneOverview> {
  return usePhoneReceipt('all', fresh => r2Api.getPhoneOverview(fresh), 'overview')
}
