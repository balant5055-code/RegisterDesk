// Centralised status badge color maps.
// Use these instead of inline color strings to keep status styling consistent.

// RD-EVENT-12 · Text darkened one step. Measured in the rendered DOM, every one of
// these pills failed AA at its real size: emerald-700 on emerald-100 is 3.65:1 and
// red-600 on red-100 is 3.91:1, against the 4.5:1 a 12–13px badge needs. The hues and
// the pill shape are unchanged, so every surface reading this map keeps its colour
// language and simply becomes legible. Status is never colour ALONE here — each pill
// carries its word — but a word nobody can read is not a mitigation.
// RD-THEME-01 · every map below now draws from the CLOSED semantic accent set in
// styles/tokens.css (--accent-{people,money,event,verify,pending,critical,neutral}).
// Two reasons, both defects the raw palette weights caused:
//   1. no dark override — an emerald-100/emerald-800 pill kept its light-mode tint
//      under the .dark class, which the organizer header's theme toggle sets globally;
//   2. the same meaning wore three hues across surfaces (red vs rose vs orange for
//      "stopped"), because each map picked its own weight.
// The accent set is smaller than the status taxonomy, so two colour distinctions
// collapse on purpose: cancelled/rejected/changes_requested all read critical, and
// pending_review/registration_closed both read pending. No information is lost —
// every pill carries its WORD, and colour was never the only signal here.
export const registrationStatusCls: Record<string, string> = {
  confirmed:  'bg-accent-money-bg    text-accent-money-fg',
  pending:    'bg-accent-pending-bg  text-accent-pending-fg',
  cancelled:  'bg-accent-critical-bg text-accent-critical-fg',
  // GA-7D S2: waitlisted reconciled to amber (a "waiting" state) so it matches the
  // attendee dashboard — it previously rendered sky here and amber there, changing
  // the same person's status colour between surfaces. sky is reserved for 'completed'.
  waitlisted: 'bg-accent-pending-bg  text-accent-pending-fg',
  rejected:   'bg-accent-critical-bg text-accent-critical-fg',
}

// Ring-style status tone map (bg-50 + ring) used by the attendee-facing StatusBadge.
// GA-7D S2: centralised here (was a divergent copy in components/attendee/ui.tsx) so
// there is ONE source of truth for status hues; it also covers payment statuses that
// the registration map above does not. Same hues as above — only the pill STYLE
// (subtle ring vs solid-100) differs by surface, never the colour meaning.
export const statusToneCls: Record<string, string> = {
  confirmed:  'bg-accent-money-bg    text-accent-money-fg    ring-accent-money-fg/20',
  successful: 'bg-accent-money-bg    text-accent-money-fg    ring-accent-money-fg/20',
  paid:       'bg-accent-money-bg    text-accent-money-fg    ring-accent-money-fg/20',
  pending:    'bg-accent-pending-bg  text-accent-pending-fg  ring-accent-pending-fg/20',
  waitlisted: 'bg-accent-pending-bg  text-accent-pending-fg  ring-accent-pending-fg/20',
  refunded:   'bg-accent-critical-bg text-accent-critical-fg ring-accent-critical-fg/20',
  cancelled:  'bg-accent-critical-bg text-accent-critical-fg ring-accent-critical-fg/20',
  rejected:   'bg-accent-critical-bg text-accent-critical-fg ring-accent-critical-fg/20',
  failed:     'bg-accent-critical-bg text-accent-critical-fg ring-accent-critical-fg/20',
}

export const eventLifecycleMeta: Record<string, { label: string; cls: string }> = {
  draft:               { label: 'Draft',            cls: 'bg-muted text-muted-foreground'  },
  pending_review:      { label: 'Pending Approval',  cls: 'bg-accent-pending-bg  text-accent-pending-fg'  },
  changes_requested:   { label: 'Changes Requested', cls: 'bg-accent-critical-bg text-accent-critical-fg' },
  published:           { label: 'Published',         cls: 'bg-accent-money-bg    text-accent-money-fg'    },
  registration_closed: { label: 'Reg. Closed', cls: 'bg-accent-pending-bg  text-accent-pending-fg'  },
  completed:           { label: 'Completed',   cls: 'bg-accent-people-bg   text-accent-people-fg'   },
  cancelled:           { label: 'Cancelled',   cls: 'bg-accent-critical-bg text-accent-critical-fg' },
  archived:            { label: 'Archived',    cls: 'bg-muted text-muted-foreground'  },
  // Recognition only (Phase L2) — distinct from Draft so it never falls back to it.
  unpublished:         { label: 'Unpublished', cls: 'bg-accent-neutral-bg  text-accent-neutral-fg'  },
}

export const broadcastStatusCls: Record<string, string> = {
  draft:     'bg-accent-neutral-bg  text-accent-neutral-fg',
  scheduled: 'bg-accent-event-bg    text-accent-event-fg',
  sending:   'bg-accent-pending-bg  text-accent-pending-fg',
  sent:      'bg-accent-money-bg    text-accent-money-fg',
  partial:   'bg-accent-pending-bg  text-accent-pending-fg',
  failed:    'bg-accent-critical-bg text-accent-critical-fg',
  cancelled: 'bg-accent-neutral-bg  text-accent-neutral-fg',
}

export const emailLogStatusCls: Record<string, string> = {
  queued:    'bg-accent-pending-bg  text-accent-pending-fg',
  sent:      'bg-accent-money-bg    text-accent-money-fg',
  delivered: 'bg-accent-verify-bg   text-accent-verify-fg',
  failed:    'bg-accent-critical-bg text-accent-critical-fg',
}

export const walletTxnStatusCls: Record<string, string> = {
  completed: 'bg-accent-money-bg    text-accent-money-fg    border-accent-money-fg/20',
  pending:   'bg-accent-pending-bg  text-accent-pending-fg  border-accent-pending-fg/20',
  failed:    'bg-accent-critical-bg text-accent-critical-fg border-accent-critical-fg/20',
}
