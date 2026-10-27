// WhatsApp webhook subscription health — server-only, READ-ONLY.
//
// Meta delivers a WhatsApp Business Account's webhooks (inbound replies, delivery/read statuses,
// template review outcomes) ONLY to apps listed in GET /{WABA_ID}/subscribed_apps. The app-level
// webhook subscription alone is not enough: until 2026-10-26 production's list was empty, so no
// webhook of any kind ever arrived while every other check looked healthy. This reads that list
// and classifies it. It never subscribes, never writes, and never exposes the token.

import { getMetaConfig } from './config'
import { MetaGraphClient, type GraphResult } from './client'

export type WabaSubscriptionState = 'subscribed' | 'missing' | 'unavailable'

export interface WabaSubscriptionHealth {
  state:   WabaSubscriptionState
  /** Why the check is unavailable — never a raw Graph payload. */
  reason?: 'not_configured' | 'api_error'
}

export interface SubscribedAppsNode {
  data?: Array<{ whatsapp_business_api_data?: { id?: string; name?: string } }>
}

/** Pure: is the configured app in the WABA's subscribed apps? */
export function classifyWabaSubscription(appId: string, res: GraphResult<SubscribedAppsNode>): WabaSubscriptionHealth {
  if (!res.ok) return { state: 'unavailable', reason: 'api_error' }
  const ids = (res.data?.data ?? []).map(a => a.whatsapp_business_api_data?.id)
  return { state: ids.includes(appId) ? 'subscribed' : 'missing' }
}

/** One Graph read. Never throws. */
export async function checkWabaSubscription(): Promise<WabaSubscriptionHealth> {
  try {
    const config = await getMetaConfig()
    if (!config) return { state: 'unavailable', reason: 'not_configured' }
    const res = await new MetaGraphClient(config).get<SubscribedAppsNode>(`${config.businessAccountId}/subscribed_apps`)
    return classifyWabaSubscription(config.appId, res)
  } catch {
    return { state: 'unavailable', reason: 'api_error' }
  }
}
