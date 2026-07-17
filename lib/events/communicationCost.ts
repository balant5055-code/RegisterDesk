// Pure function — display-only estimate of communication cost for the event wizard.
// It is NOT a charging path: actual charges are billed pay-as-you-use at send time.
//
// LS1: rates come from the SINGLE pricing source of truth (lib/communications/pricing.ts)
// so the wizard estimate can never diverge from what is actually charged. Previously
// this file hard-coded its own (cheaper) rates — the duplicate-rate-table bug.

import type { CommunicationCostResult } from '@/types/events'
import { unitCostPaise } from '@/lib/communications/pricing'

// Per-message rates in paise — derived from the single pricing source.
const WHATSAPP_RATE_PAISE = unitCostPaise('whatsapp')
const SMS_RATE_PAISE      = unitCostPaise('sms')

// Confirmation + reminder = 2 messages per attendee per channel
const MESSAGES_PER_ATTENDEE = 2

interface CommunicationCostInput {
  estimatedCapacity: number
  whatsappEnabled:   boolean
  smsEnabled:        boolean
  // Effective per-message rates (paise) from Business Configuration. Optional so
  // existing callers keep the code-default rates; the wizard passes the resolved
  // config rates so the estimate matches what is actually charged.
  whatsappRatePaise?: number
  smsRatePaise?:      number
}

export function calculateCommunicationCost(
  input: CommunicationCostInput,
): CommunicationCostResult {
  const { estimatedCapacity, whatsappEnabled, smsEnabled } = input
  const capacity = Math.max(0, Math.round(estimatedCapacity))
  const whatsappRate = input.whatsappRatePaise ?? WHATSAPP_RATE_PAISE
  const smsRate      = input.smsRatePaise      ?? SMS_RATE_PAISE

  const whatsappMessages   = whatsappEnabled ? capacity * MESSAGES_PER_ATTENDEE : 0
  const smsMessages        = smsEnabled      ? capacity * MESSAGES_PER_ATTENDEE : 0
  const estimatedMessages  = whatsappMessages + smsMessages

  const whatsappCostPaise  = whatsappMessages * whatsappRate
  const smsCostPaise       = smsMessages      * smsRate
  const totalPaise         = whatsappCostPaise + smsCostPaise

  return {
    estimatedMessages,
    whatsappCost: whatsappCostPaise / 100,
    smsCost:      smsCostPaise      / 100,
    totalCost:    totalPaise        / 100,
    totalPaise,
  }
}
