// MC-06D · Structured operational logging — SERVER ONLY. PURE apart from the write to stdout.
//
// One shape for every scheduled-cleanup event, so a log aggregator can filter and chart them
// without parsing prose. Free-text `console.log` is fine for a one-off; a recurring financial
// sweep needs fields.
//
// ═══ WHAT MUST NEVER APPEAR HERE ═════════════════════════════════════════════
// No organizer uid, no email, no event name, no wallet balance, no credit total belonging to
// an identifiable workspace. Cleanup logs are operational telemetry, read by whoever is on
// call — they answer "is the sweep healthy", never "what does this customer have".
//
// Session ids ARE logged: they are opaque server-generated identifiers, and without them a
// failure cannot be traced to the record that caused it. That is the deliberate line.

/** Every event this module can emit. A closed set so dashboards can enumerate them. */
export type OpsEvent =
  | 'cleanup.started'
  | 'cleanup.completed'
  | 'cleanup.failed'
  | 'cleanup.budget_exhausted'
  | 'cleanup.sessions_sealed'
  | 'cleanup.sessions_settled'
  | 'cleanup.session_failed'
  | 'cleanup.replay'
  /** MC-06E: a session whose stored numbers are unusable. Needs a human. */
  | 'session.corrupt'
  /** MC-06F: removed from the settlement queue after repeated failures. Needs a human. */
  | 'session.quarantined'
  /**
   * RD-MC-REFUND-V2-P1: consumption the wallet covered but no credit lot did. The balance is
   * still correct — attribution is not — so the figure an organizer sees is unaffected and
   * the drift is the thing to investigate. Needs a human.
   */
  | 'lots.unattributed'
  /**
   * RD-MC-REFUND-V2-P1: a refund larger than its purchase's lot still held. Eligibility is
   * meant to make this unreachable, so it means eligibility and the lots disagree.
   */
  | 'lots.refund_shortfall'
  /**
   * RD-MC-REFUND-V2-P2: an approval refused because the purchase's lot drained after the
   * request was quoted. Not a defect — the guard working — but worth a record: a workspace
   * hitting it often is being shown refund terms it cannot act on quickly enough.
   */
  | 'lots.refund_stale'

export interface OpsFields {
  /** Opaque, server-generated. Safe to log; needed to trace a failure. */
  sessionId?: string
  stage?:     'seal' | 'settle' | 'reservations'
  /** MC-06E: which field failed validation. A field NAME, never its value. */
  field?:     string
  scanned?:   number
  processed?: number
  skipped?:   number
  failed?:    number
  durationMs?: number
  budgetMs?:   number
  /** An error's message only — never a stack containing paths or payloads. */
  reason?:    string
  [key: string]: unknown
}

/**
 * Emits one structured line.
 *
 * `console` rather than a logging library because that is what every other server module here
 * uses, and Vercel already ships stdout to the log drain. Failures route to `console.error`
 * so alerting can key on level without inspecting the payload.
 */
export function opsLog(event: OpsEvent, fields: OpsFields = {}): void {
  const line = JSON.stringify({
    scope: 'media-credits.sessions',
    event,
    ...fields,
  })
  // Anything an operator must act on goes to error level so alerting can key on it without
  // parsing the payload. `session.corrupt` belongs here despite its name: unusable stored
  // data needs a human exactly as much as a failed sweep does.
  const needsAttention = event.endsWith('failed')
    || event === 'session.corrupt' || event === 'session.quarantined'
    // Both lot events are accounting drift. Nothing an organizer sees is wrong, which is
    // exactly why they must not be quiet — nobody would report them.
    || event.startsWith('lots.')
  if (needsAttention) console.error(line)
  else console.log(line)
}
