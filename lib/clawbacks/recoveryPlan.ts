// Phase 3 (Option C) · the PURE plan of a release-time clawback recovery — no Firestore, no I/O.
//
// A settlement release moves a transaction's whole net out of pendingPaise. Before the remainder is
// credited to availablePaise, the organizer's outstanding clawback debt is paid from that amount,
// oldest debt first. Pending therefore always equals the nets of the unreleased transactions (recovery
// never touches pending), and money already available — or promised to a payout (inTransitPaise) —
// is never taken. This function only decides the split; lib/settlements/releaseFunds.ts applies it
// inside the release transaction.

export interface RecoverableClawback {
  id:               string
  outstandingPaise: number
  /** Creation time (ms) — the oldest debt is paid first; ties by id for determinism. */
  createdAtMs:      number
}

export interface ClawbackRecoveryPlan {
  /** Paise of this release that pay debt (never more than the release, never more than the debt). */
  recoveredPaise: number
  /** Paise of this release credited to availablePaise. */
  creditedPaise:  number
  takes: Array<{ id: string; takePaise: number; remainingPaise: number }>
}

/** Throws CLAWBACK_INVALID on a value that cannot be accounted (fail closed — the release is refused). */
export function planClawbackRecovery(releasePaise: number, debts: RecoverableClawback[]): ClawbackRecoveryPlan {
  if (!Number.isInteger(releasePaise) || releasePaise < 0) throw new Error(`CLAWBACK_INVALID:release:${releasePaise}`)
  for (const d of debts) {
    if (!Number.isInteger(d.outstandingPaise) || d.outstandingPaise < 0) throw new Error(`CLAWBACK_INVALID:${d.id}`)
  }
  const ordered = [...debts].sort((a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  let budget = releasePaise
  const takes: ClawbackRecoveryPlan['takes'] = []
  for (const d of ordered) {
    if (budget <= 0) break
    if (d.outstandingPaise === 0) continue
    const take = Math.min(d.outstandingPaise, budget)
    budget -= take
    takes.push({ id: d.id, takePaise: take, remainingPaise: d.outstandingPaise - take })
  }
  const recoveredPaise = releasePaise - budget
  return { recoveredPaise, creditedPaise: releasePaise - recoveredPaise, takes }
}
