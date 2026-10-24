// Phase 3 (G9) · PURE classification of Razorpay's refund list for ONE unresolved refund attempt.
// No I/O. The list is the read-only `payments.fetchMultipleRefund(paymentId)` response.
//
//   linked        — exactly one refund carries this attempt's id in its notes: the attempt created it
//                   (whatever its status — a failed refund is linked as failed, never "no refund")
//   none          — the list is well-formed, nothing carries the attempt id, and every refund on the
//                   payment is already recorded by RegisterDesk (belongs to a known, other refund)
//   contradictory — more than one refund carries the attempt id, or the payment has a refund
//                   RegisterDesk has not recorded (it could be this attempt's, notes missing)
//   inconclusive  — the response cannot be read as a complete list
// Age (PD-2) is checked by the caller and is necessary, never sufficient: `none` is required too.

export type AttemptEvidence =
  | { kind: 'linked'; refundId: string; status: string; amountPaise: number | null }
  | { kind: 'none'; listedRefunds: number }
  | { kind: 'contradictory'; why: 'multiple_refunds_for_attempt' | 'unrecorded_refund_on_payment'; refundIds: string[] }
  | { kind: 'inconclusive'; why: 'lookup_malformed' | 'refund_entry_malformed' }

export function evaluateAttemptEvidence(lookup: unknown, attemptId: string, recordedRefundIds: ReadonlySet<string>): AttemptEvidence {
  const items = (lookup as { items?: unknown } | null | undefined)?.items
  if (!Array.isArray(items)) return { kind: 'inconclusive', why: 'lookup_malformed' }
  const entries: Array<{ id: string; status: string; amount: number | null; attemptId: unknown }> = []
  for (const raw of items) {
    const r = raw as { id?: unknown; status?: unknown; amount?: unknown; notes?: unknown } | null
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id || typeof r.status !== 'string' || !r.status) {
      return { kind: 'inconclusive', why: 'refund_entry_malformed' }
    }
    const notes = r.notes && typeof r.notes === 'object' ? r.notes as { attemptId?: unknown } : {}
    entries.push({ id: r.id, status: r.status, amount: typeof r.amount === 'number' ? r.amount : null, attemptId: notes.attemptId })
  }
  const mine = entries.filter(e => e.attemptId === attemptId)
  if (mine.length > 1) return { kind: 'contradictory', why: 'multiple_refunds_for_attempt', refundIds: mine.map(e => e.id) }
  if (mine.length === 1) return { kind: 'linked', refundId: mine[0].id, status: mine[0].status, amountPaise: mine[0].amount }
  const unrecorded = entries.filter(e => !recordedRefundIds.has(e.id))
  if (unrecorded.length) return { kind: 'contradictory', why: 'unrecorded_refund_on_payment', refundIds: unrecorded.map(e => e.id) }
  return { kind: 'none', listedRefunds: entries.length }
}
