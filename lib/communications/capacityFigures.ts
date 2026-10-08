// RD-COMMS-L2 · ONE organizer-facing definition of an event's communication capacity figures.
// Client-safe, pure. Used by Communications › Usage AND License & Services, so both say the same
// thing; the Event Wallet keeps its own refund-oriented figures but its labels follow these words.
//
// Display only — every input is an existing record, nothing here changes accounting:
//
//   purchased  = ledger `purchased`             bought for THIS event
//   carriedIn  = ledger `carriedIn`             moved in from another event (usable, never paid here)
//   inProgress = units held by this event's broadcasts that are still sending, or whose outcome
//                WhatsApp has not confirmed — inside the ledger's `consumed` until they settle
//   used       = ledger `consumed` − inProgress  settled, accepted use
//   returned   = units given back to this event by settled broadcasts (not accepted by WhatsApp).
//                Already part of Available — shown for understanding, never subtracted again.
//   refunded   = ledger `refunded`              unused capacity refunded through an approved request
//   carriedOut = ledger `carriedOut`            unused capacity moved to another event
//   available  = the ledger's own available figure (availableUnits) — AUTHORITATIVE, never
//                recomputed here (in particular never Purchased − Used)
//
// so available = purchased + carriedIn − used − inProgress − refunded − carriedOut (floored at 0).

export interface CapacityLedgerFigures {
  purchased:  number
  consumed:   number
  carriedIn:  number
  carriedOut: number
  refunded:   number
  /** The ledger's available figure (serviceAllowanceLedger.availableUnits). */
  remaining:  number
}

/** What the event's broadcasts currently hold / have given back. null ⇒ could not be read. */
export interface CapacityActivity {
  inProgress: number
  /** null ⇒ not tracked for this service (e.g. certificates). */
  returned:   number | null
}

export interface CommunicationCapacityFigures {
  purchased:  number
  /** null ⇒ the in-progress share could not be read, so settled use is unknown. */
  used:       number | null
  inProgress: number | null
  returned:   number | null
  refunded:   number
  carriedIn:  number
  carriedOut: number
  available:  number
}

const whole = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0)

export function communicationCapacityFigures(line: CapacityLedgerFigures, activity: CapacityActivity | null): CommunicationCapacityFigures {
  const consumed = whole(line.consumed)
  const inProgress = activity ? Math.min(whole(activity.inProgress), consumed) : null
  return {
    purchased:  whole(line.purchased),
    used:       inProgress === null ? null : consumed - inProgress,
    inProgress,
    returned:   activity && activity.returned !== null ? whole(activity.returned) : null,
    refunded:   whole(line.refunded),
    carriedIn:  whole(line.carriedIn),
    carriedOut: whole(line.carriedOut),
    available:  whole(line.remaining),
  }
}

export type CapacityFigure = keyof CommunicationCapacityFigures

export const CAPACITY_FIGURE_LABELS: Record<CapacityFigure, string> = {
  purchased:  'Purchased',
  used:       'Used',
  available:  'Available',
  inProgress: 'In progress',
  returned:   'Returned',
  refunded:   'Refunded',
  carriedIn:  'Carried in',
  carriedOut: 'Carried out',
}

/** The three an organizer reads first. */
export const CAPACITY_PRIMARY: CapacityFigure[] = ['purchased', 'used', 'available']
/** The breakdown. Carried in / out are shown only when non-zero (capacityBreakdown). */
export const CAPACITY_SECONDARY: CapacityFigure[] = ['inProgress', 'returned', 'refunded', 'carriedIn', 'carriedOut']

export const CAPACITY_FIGURE_HELP: Record<CapacityFigure, string> = {
  purchased:  'Capacity bought for this event.',
  used:       'Messages WhatsApp accepted that are settled and counted against this event.',
  available:  'What this event can use right now: Purchased plus Carried in, minus Used, In progress, Refunded and Carried out.',
  inProgress: 'Set aside for broadcasts that are still sending, or whose delivery outcome is not confirmed yet. It becomes Used, or goes back to Available, once the outcome is known.',
  returned:   'Broadcast messages WhatsApp did not accept, given back to this event. They are already included in Available.',
  refunded:   'Unused capacity refunded to you through an approved refund request. It can no longer be used.',
  carriedIn:  'Unused capacity moved into this event from another of your events.',
  carriedOut: 'Unused capacity moved from this event to another of your events.',
}

/** The secondary figures worth showing: known ones, with Carried in / out only when non-zero. */
export function capacityBreakdown(f: CommunicationCapacityFigures): { key: CapacityFigure; value: number | null }[] {
  return CAPACITY_SECONDARY
    .filter(k => (k === 'carriedIn' || k === 'carriedOut' ? f[k] > 0 : k === 'returned' ? f.returned !== null : true))
    .map(k => ({ key: k, value: f[k] }))
}
