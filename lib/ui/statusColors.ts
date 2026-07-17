// Centralised status badge color maps.
// Use these instead of inline color strings to keep status styling consistent.

export const registrationStatusCls: Record<string, string> = {
  confirmed:  'bg-emerald-100 text-emerald-700',
  pending:    'bg-amber-100   text-amber-700',
  cancelled:  'bg-red-100     text-red-600',
  // GA-7D S2: waitlisted reconciled to amber (a "waiting" state) so it matches the
  // attendee dashboard — it previously rendered sky here and amber there, changing
  // the same person's status colour between surfaces. sky is reserved for 'completed'.
  waitlisted: 'bg-amber-100   text-amber-700',
  rejected:   'bg-rose-100    text-rose-700',
}

// Ring-style status tone map (bg-50 + ring) used by the attendee-facing StatusBadge.
// GA-7D S2: centralised here (was a divergent copy in components/attendee/ui.tsx) so
// there is ONE source of truth for status hues; it also covers payment statuses that
// the registration map above does not. Same hues as above — only the pill STYLE
// (subtle ring vs solid-100) differs by surface, never the colour meaning.
export const statusToneCls: Record<string, string> = {
  confirmed:  'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  successful: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  paid:       'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  pending:    'bg-amber-50 text-amber-700 ring-amber-600/20',
  waitlisted: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  refunded:   'bg-red-50 text-red-700 ring-red-600/20',
  cancelled:  'bg-red-50 text-red-700 ring-red-600/20',
  rejected:   'bg-red-50 text-red-700 ring-red-600/20',
  failed:     'bg-red-50 text-red-700 ring-red-600/20',
}

export const eventLifecycleMeta: Record<string, { label: string; cls: string }> = {
  draft:               { label: 'Draft',            cls: 'bg-muted text-muted-foreground'  },
  pending_review:      { label: 'Pending Approval',  cls: 'bg-amber-100 text-amber-700'     },
  changes_requested:   { label: 'Changes Requested', cls: 'bg-orange-100 text-orange-700'   },
  published:           { label: 'Published',         cls: 'bg-emerald-100 text-emerald-700' },
  registration_closed: { label: 'Reg. Closed', cls: 'bg-amber-100 text-amber-700'    },
  completed:           { label: 'Completed',   cls: 'bg-sky-100 text-sky-700'         },
  cancelled:           { label: 'Cancelled',   cls: 'bg-red-100 text-red-600'         },
  archived:            { label: 'Archived',    cls: 'bg-muted text-muted-foreground'  },
  // Recognition only (Phase L2) — distinct from Draft so it never falls back to it.
  unpublished:         { label: 'Unpublished', cls: 'bg-slate-100 text-slate-600'     },
}

export const broadcastStatusCls: Record<string, string> = {
  draft:     'bg-slate-100  text-slate-600',
  scheduled: 'bg-indigo-100 text-indigo-700',
  sending:   'bg-amber-100  text-amber-700',
  sent:      'bg-emerald-100 text-emerald-700',
  partial:   'bg-yellow-100 text-yellow-700',
  failed:    'bg-rose-100   text-rose-700',
  cancelled: 'bg-slate-100  text-slate-500',
}

export const emailLogStatusCls: Record<string, string> = {
  queued:    'bg-amber-100  text-amber-700',
  sent:      'bg-emerald-100 text-emerald-700',
  delivered: 'bg-teal-100   text-teal-700',
  failed:    'bg-rose-100   text-rose-700',
}

export const walletTxnStatusCls: Record<string, string> = {
  completed: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  pending:   'bg-amber-50   text-amber-700   border-amber-200',
  failed:    'bg-red-50     text-red-700     border-red-200',
}
