// Pure function — runs on both client (display) and server (authoritative calculation).
// The server always recalculates; client values are display-only.

import type { CommunicationCostResult } from '@/types/events'

// Per-message rates in paise (₹1 = 100 paise)
const WHATSAPP_RATE_PAISE = 10   // ₹0.10
const SMS_RATE_PAISE      = 15   // ₹0.15

// Confirmation + reminder = 2 messages per attendee per channel
const MESSAGES_PER_ATTENDEE = 2

interface CommunicationCostInput {
  estimatedCapacity: number
  whatsappEnabled:   boolean
  smsEnabled:        boolean
}

export function calculateCommunicationCost(
  input: CommunicationCostInput,
): CommunicationCostResult {
  const { estimatedCapacity, whatsappEnabled, smsEnabled } = input
  const capacity = Math.max(0, Math.round(estimatedCapacity))

  const whatsappMessages   = whatsappEnabled ? capacity * MESSAGES_PER_ATTENDEE : 0
  const smsMessages        = smsEnabled      ? capacity * MESSAGES_PER_ATTENDEE : 0
  const estimatedMessages  = whatsappMessages + smsMessages

  const whatsappCostPaise  = whatsappMessages * WHATSAPP_RATE_PAISE
  const smsCostPaise       = smsMessages      * SMS_RATE_PAISE
  const totalPaise         = whatsappCostPaise + smsCostPaise

  return {
    estimatedMessages,
    whatsappCost: whatsappCostPaise / 100,
    smsCost:      smsCostPaise      / 100,
    totalCost:    totalPaise        / 100,
    totalPaise,
  }
}
