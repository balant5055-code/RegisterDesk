// RD-NOTIFY-01 — every organizer action that needs a Super Admin, and every Super Admin decision an
// organizer must hear about, stages its notification INSIDE the commit that persists it (so no alert
// for a failed action, and none lost for a successful one), then schedules delivery after the commit.
// Behaviour on real Firestore: tests/emulator/notificationOutbox.emu.test.ts.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')
/** The staging call appears between `start` and the commit/transaction end `end`, and delivery after it. */
function stagedBefore(src: string, stage: string, commitMarker: string, schedule: string) {
  const s = src.indexOf(stage), c = src.indexOf(commitMarker, s), d = src.indexOf(schedule, s)
  expect(s, stage).toBeGreaterThan(-1)
  expect(c, commitMarker).toBeGreaterThan(s)
  expect(d, schedule).toBeGreaterThan(c)
}

describe('RD-NOTIFY-01 · Super Admin alerts are staged with the action', () => {
  it('first submission for review (publish transaction, manual approval only)', () => {
    const s = read('app/api/events/publish/route.ts')
    expect(s).toContain("const reviewAlert = terminalStatus === 'pending_review'")
    stagedBefore(s, 'if (reviewAlert) stageOutboxMessage(txn, reviewAlert)', '  } catch (err) {', 'scheduleOutboxDelivery(reviewAlert.id)')
  })
  it('resubmission / republish (the shared lifecycle transaction)', () => {
    const s = read('lib/events/lifecycle.ts')
    expect(s).toContain("const reviewAlert = action === 'resubmit' || action === 'republish'")
    stagedBefore(s, 'if (reviewAlert) stageOutboxMessage(txn, reviewAlert)', 'if (txnFailure) return txnFailure', 'if (reviewAlert) scheduleOutboxDelivery(reviewAlert.id)')
  })
  it('payout profile save (same batch as the profile + history)', () => {
    const s = read('app/api/organizer/payout-profile/route.ts')
    stagedBefore(s, 'stageOutboxMessage(batch, profileAlert)', 'await batch.commit()', 'scheduleOutboxDelivery(profileAlert.id)')
    expect(s).not.toMatch(/payoutProfileAlert\(\{[^}]*accountNumber/)          // no payout values passed in
  })
  it('wallet refund / carry-forward request (submit transaction)', () => {
    const s = read('lib/wallet/serviceRequests.ts')
    stagedBefore(s, 'stageOutboxMessage(txn, alert)', '  })\n  scheduleOutboxDelivery(alert.id)', 'scheduleOutboxDelivery(alert.id)')
  })
  it('payout (settlement) request (reserve transaction)', () => {
    const s = read('app/api/organizer/settlements/route.ts')
    stagedBefore(s, 'stageOutboxMessage(tx, payoutAlert)', 'if (!result.ok)', 'scheduleOutboxDelivery(payoutAlert.id)')
  })
  it('refunds needing a human: webhook review/failure (deduped per refund + reason) and queue escalation (in its transaction)', () => {
    const w = read('app/api/webhooks/razorpay/route.ts')
    expect(w.match(/await alertRefundAttention\('review'/g)).toHaveLength(2)
    expect(w).toContain("await alertRefundAttention('failed'")
    expect(w).toContain("if (await enqueueOutboxMessage(m) === 'queued') scheduleOutboxDelivery(m.id)")
    const q = read('lib/payments/registrationReconciliation.ts')
    stagedBefore(q, 'stageOutboxMessage(tx, m)', "if (out === 'needs_review')", 'if (alertId) scheduleOutboxDelivery(alertId)')
  })
})

describe('RD-NOTIFY-01 · organizer notices for Super Admin decisions', () => {
  it('wallet request decisions: every branch stages its notice as its last write', () => {
    const s = read('lib/wallet/serviceRequests.ts')
    for (const d of ["notify('rejected', reason)", "notify('processed'", "notify('approved'"]) expect(s, d).toContain(d)
    expect(s).toContain('if (!already && noticeId) scheduleOutboxDelivery(noticeId)')
  })
  it('payout profile: changes requested → notice in the batch; verify/reject → inbox in the transaction, email via after()', () => {
    const s = read('app/api/admin/payout-profiles/[uid]/route.ts')
    stagedBefore(s, 'if (changesNotice) stageOutboxMessage(batch, changesNotice)', 'await batch.commit()', 'if (changesNotice) scheduleOutboxDelivery(changesNotice.id)')
    expect(s).toContain('if (inbox) tx.set(inbox.ref, inbox.data)')
    expect(s).toContain('try { after(sendDecisionEmail) } catch { void sendDecisionEmail() }')
    expect(s).not.toContain('  })()\n')                                       // no dangling void IIFE left
  })
})

describe('RD-NOTIFY-01 · delivery plumbing', () => {
  it('the ops-alerts cron also drains the outbox, isolated from the ops alert', () => {
    const c = read('app/api/cron/ops-alerts/route.ts')
    expect(c).toContain('const outbox = await drainOutbox(50, start).catch(')
  })
  it('Super Admin recipients come from existing config only (support inbox + ADMIN_UIDS accounts)', () => {
    const r = read('lib/notifications/superAdminRecipients.ts')
    expect(r).toContain('getBrandingConfig()')
    expect(r).toContain("process.env.ADMIN_UIDS ?? ''")
    expect(read('lib/notifications/outbox.ts')).not.toMatch(/['"][^'"\s]+@[^'"\s]+\.[a-z]{2,}['"]/)   // no hardcoded address
  })
  it('the drain query needs no composite index (single-field range on nextAttemptAt)', () => {
    const o = read('lib/notifications/outbox.ts')
    expect(o).toContain(".where('nextAttemptAt', '<=', Timestamp.fromMillis(now)).limit(limit)")
  })
})
