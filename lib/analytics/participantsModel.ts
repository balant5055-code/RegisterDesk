// RD-ANALYTICS-12-29 · the Participants module's derivations. PURE — no Firestore, no React.
//
// ═══ THE ONE RULE THIS MODULE EXISTS TO ENFORCE ══════════════════════════════
// A REGISTRATION IS A SEAT, NOT A PERSON. Every label produced here says "registrations";
// nothing here is called a participant count, a unique count, a returning count or a
// demographic. The module is named Participants because that is the Analytics IA; its
// content is precise about what the platform can actually count.
//
// ═══ SHARES ══════════════════════════════════════════════════════════════════
// A share is only offered over a measured, non-zero denominator. Two zeros are not a mix,
// and an unmeasured side yields no percentage rather than a percentage of an unknown.

import type {
  Count, ParticipantAnalytics, RegistrationAnalytics, RegistrationComposition,
  RegistrationSourceCounts,
} from '@/lib/analytics/contract'

const STATUS_LABELS = {
  confirmed:  'Confirmed',
  pending:    'Pending approval',
  cancelled:  'Cancelled',
  rejected:   'Rejected',
  waitlisted: 'Waitlisted',
} as const

const pct = (n: number, d: number) => Math.round((n / d) * 100)

/**
 * Pass mix from the payload's own `byPass` (counter-backed, confirmed registrations).
 *
 * ═══ THE DENOMINATOR IS THE CONFIRMED TOTAL, NOT THE LIST ════════════════════
 * `byPass` is the producer's TOP EIGHT passes. A share taken over the list would sum to
 * 100% on an event with twelve passes and silently hide a third of its seats. The share is
 * therefore over `confirmed` — the same status aggregate every module uses — and whatever
 * the listed passes do not account for is published as its own "Other passes" row rather
 * than dropped. If the list somehow exceeds the total (counter drift), no mix is offered.
 */
export function passMix(r: RegistrationAnalytics): RegistrationComposition['passMix'] {
  if (r.byPassBasis !== 'lifetime_confirmed' || r.confirmed === null || r.byPass.length === 0) return null
  const listed = r.byPass.reduce((s, p) => s + p.value, 0)
  const total  = r.confirmed
  if (total <= 0 || listed > total) return null
  const rows = r.byPass.map(p => ({ label: p.label, value: p.value, sharePct: pct(p.value, total) }))
  const rest = total - listed
  if (rest > 0) rows.push({ label: 'Other passes', value: rest, sharePct: pct(rest, total) })
  return rows
}

/** Status mix over every registration. Null when any status is unmeasured. */
export function statusMix(r: RegistrationAnalytics): RegistrationComposition['statusMix'] {
  const keys = ['confirmed', 'pending', 'cancelled', 'rejected', 'waitlisted'] as const
  const values = keys.map(k => r[k])
  if (values.some(v => v === null)) return null
  const total = (values as number[]).reduce((s, v) => s + v, 0)
  if (total <= 0) return null
  return keys.map((k, i) => ({
    key: k, label: STATUS_LABELS[k], value: values[i] as number, sharePct: pct(values[i] as number, total),
  }))
}

/** One share line: "n of total (pct%)" or null when either side is unmeasured or total is 0. */
export function share(n: Count, total: Count): { pct: number; of: number } | null {
  if (n === null || total === null || total <= 0) return null
  return { pct: pct(n, total), of: total }
}

export interface SourceRow {
  key:        'online' | 'walkin' | 'unrecorded'
  label:      string
  definition: string
  value:      Count
  share:      { pct: number; of: number } | null
}

/** The three source rows, each with its share of the lifetime total. */
export function sourceRows(c: RegistrationComposition): SourceRow[] {
  const s = c.source
  const total = s.online === null || s.walkin === null || s.unrecorded === null
    ? null : s.online + s.walkin + s.unrecorded
  return [
    { key: 'online', label: 'Online', value: s.online, share: share(s.online, total),
      definition: 'Registered through the event page' },
    { key: 'walkin', label: 'Walk-in', value: s.walkin, share: share(s.walkin, total),
      definition: 'Created at the gate on the day' },
    { key: 'unrecorded', label: 'Source not recorded', value: s.unrecorded, share: share(s.unrecorded, total),
      definition: 'Registered before the platform recorded a source — not assumed online' },
  ]
}

/** Which source columns to draw in the status table — `unrecorded` only when it is non-zero somewhere. */
export function sourceColumns(c: RegistrationComposition): ('online' | 'walkin' | 'unrecorded')[] {
  const anyUnrecorded = Object.values(c.sourceByStatus).some(s => s.unrecorded === null || (s.unrecorded ?? 0) > 0)
    || c.source.unrecorded === null || (c.source.unrecorded ?? 0) > 0
  return anyUnrecorded ? ['online', 'walkin', 'unrecorded'] : ['online', 'walkin']
}

export interface StatusSourceRow {
  key:   keyof RegistrationComposition['sourceByStatus']
  label: string
  counts: RegistrationSourceCounts
}

/** The status × source table, statuses in the contract's order, never merged. */
export function statusSourceRows(c: RegistrationComposition): StatusSourceRow[] {
  return (['confirmed', 'pending', 'cancelled', 'rejected', 'waitlisted'] as const).map(k => ({
    key: k, label: STATUS_LABELS[k], counts: c.sourceByStatus[k],
  }))
}

/**
 * What the identity-rule panel says, as sentences the reader can act on.
 *
 * These are statements about the event's GATE, and the copy keeps them there: a rule that
 * refuses a second registration per email does not make the count a count of people —
 * imports and walk-ins predate the rule, and the check itself is best-effort.
 */
export function identityRuleRows(c: RegistrationComposition): { key: string; label: string; state: string }[] | null {
  const r = c.identityRules
  if (!r) return null
  return [
    { key: 'email',  label: 'One registration per email',  state: r.limitPerEmail  ? 'On' : 'Off' },
    { key: 'mobile', label: 'One registration per mobile', state: r.limitPerMobile ? 'On' : 'Off' },
  ]
}

/** The sentence at the top of the module. Fixed, because the fact it states does not vary by event. */
export const SEATS_NOT_PEOPLE =
  'Every figure counts registrations — one person may hold several. This platform does not identify unique participants.'

/** True when the block carries any measured figure at all. */
export function compositionMeasured(p: ParticipantAnalytics | undefined): boolean {
  if (!p) return false
  const s = p.composition.source
  return s.online !== null || s.walkin !== null
}
