// RD-FIN-02 · which ledger rows were reversed IN PLACE — pure, no Admin SDK.
//
// Two reversal shapes coexist in platformTransactions:
//   • a REGISTRATION refund / dispute flips the original row's status to 'refunded' / 'disputed' and
//     debits its full netSettlementPaise from the wallet in the same transaction
//     (reversePlatformTransactionAndDebit) — NO negative row is written;
//   • a DONATION refund writes a separate NEGATIVE reversal row (parentTransactionId, sourceType
//     'donation'), and may also flip the original — that money is already netted by the negative row.
// Σ net over every row is therefore right for donations and wrong for registrations. A figure that
// claims to be what the organizer is still owed subtracts exactly the in-place reversals.

export const IN_PLACE_REVERSAL_STATUSES = ['refunded', 'disputed'] as const

export function isInPlaceReversal(r: { status?: unknown; sourceType?: unknown; parentTransactionId?: unknown }): boolean {
  if (r.status !== 'refunded' && r.status !== 'disputed') return false
  if (r.sourceType === 'donation') return false
  if (typeof r.parentTransactionId === 'string' && r.parentTransactionId) return false
  return true
}
