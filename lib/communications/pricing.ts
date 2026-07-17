// Communication channel pricing — the SINGLE source of truth for what each
// outbound message costs. All billing (lib/communications/billing.ts) and any
// cost display must read from here; never hard-code paise anywhere else.

import type { CommChannel } from '@/lib/wallet/types'

export type BroadcastChannel = CommChannel   // 'email' | 'sms' | 'whatsapp'

// Per-unit cost in paise. Email is free for now; SMS/WhatsApp are billed.
export const COMM_PRICING = {
  email: 0,
  sms:      { domestic: 25 },   // 25 paise per domestic SMS
  whatsapp: { utility:  50 },   // 50 paise per utility WhatsApp message
} as const

/** Per-message cost in paise for a channel. */
export function unitCostPaise(channel: BroadcastChannel): number {
  switch (channel) {
    case 'sms':      return COMM_PRICING.sms.domestic
    case 'whatsapp': return COMM_PRICING.whatsapp.utility
    case 'email':    return COMM_PRICING.email
    default:         return 0
  }
}

/** Total cost in paise to send to `units` recipients on `channel`. */
export function computeBroadcastCost(channel: BroadcastChannel, units: number): number {
  const n = Number.isFinite(units) && units > 0 ? Math.floor(units) : 0
  return Math.max(0, Math.round(unitCostPaise(channel) * n))
}

/** True when the channel debits the wallet (cost > 0). */
export function isPaidChannel(channel: BroadcastChannel): boolean {
  return unitCostPaise(channel) > 0
}
