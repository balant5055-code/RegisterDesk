// RD-COMMS-P2-F · Communication Center › Usage — the words on the screen. Client-safe, pure.
//
// No storage, ledger or hold vocabulary reaches the organizer.

import type { UsageBroadcastRow } from './usage'
import { CAPACITY_FIGURE_LABELS, CAPACITY_FIGURE_HELP, CAPACITY_PRIMARY, CAPACITY_SECONDARY, type CapacityFigure } from './capacityFigures'

// RD-COMMS-L2 — the figures are the ONE organizer definition (capacityFigures.ts), shared with
// License & Services. Kept under these names for the Usage screen.
export type UsageFigure = CapacityFigure
export const USAGE_FIGURE_LABELS = CAPACITY_FIGURE_LABELS
export const USAGE_FIGURE_HELP = CAPACITY_FIGURE_HELP
/** Display order: Purchased · Used · Available first, then the breakdown. */
export const USAGE_FIGURE_ORDER: UsageFigure[] = [...CAPACITY_PRIMARY, ...CAPACITY_SECONDARY]

export const USAGE_FUNDED_LABELS: Record<UsageBroadcastRow['fundedBy'], string> = {
  event_capacity: 'Event capacity',
  legacy_balance: 'Legacy balance',
  free:           'Included (email)',
  none:           '—',
}

/** Email is included — and is NOT a statement about WhatsApp. */
export const EMAIL_INCLUDED_NOTE =
  'Email is included at no charge. It never uses this event’s WhatsApp capacity or any communication balance.'

export const LEGACY_BALANCE_NOTE =
  'Balance added before capacity-based pricing. It only covers WhatsApp messages an event’s capacity does not, until it reaches ₹0. It cannot be topped up.'
