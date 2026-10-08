// RD-COMMS-CAPACITY-UX (M2) — why a broadcast campaign failed, in the organizer's words. Client-safe.
//
// A campaign can end 'failed' without the organizer watching — most importantly a SCHEDULED one
// whose capacity ran short between scheduling and its send time. The stored `failReason` is a
// machine code; this turns it into the line shown under "Failed", and says whether the fix is to
// buy capacity (so the history row can offer License & Services). An unknown code never echoes.

const CAPACITY_REASONS = new Set(['allowance_required', 'allowance_exhausted', 'insufficient_balance'])

const LABELS: Record<string, string> = {
  allowance_required:   'Failed — Insufficient WhatsApp capacity',
  allowance_exhausted:  'Failed — Insufficient WhatsApp capacity',
  insufficient_balance: 'Failed — Insufficient WhatsApp capacity',
  no_recipients:        'Failed — No eligible recipients',
  organizer_suspended:  'Failed — Account suspended',
  broadcasts_disabled:  'Failed — Broadcasts are switched off',
  event_unavailable:    'Failed — Event no longer available',
  event_cancelled:      'Failed — Event cancelled',
  event_not_live:       'Failed — Event not live',
  whatsapp_disabled:    'Failed — WhatsApp switched off for this event',
  email_disabled:       'Failed — Email switched off',
  template_not_allowed: 'Failed — Template not allowed',
}

/** True when buying WhatsApp capacity is what would let this campaign send. */
export function isCapacityFailure(failReason: string | null | undefined): boolean {
  return typeof failReason === 'string' && CAPACITY_REASONS.has(failReason)
}

/** The organizer-facing line for a failed campaign, or null when there is no stored reason. */
export function campaignFailureLabel(failReason: string | null | undefined): string | null {
  if (typeof failReason !== 'string' || !failReason) return null
  return LABELS[failReason] ?? 'Failed — The broadcast could not be sent'
}
