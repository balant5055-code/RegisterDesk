// RD-NOTIFY-DEDUP-02 · three duplicate-email causes, on REAL Firestore (private emulator). The email
// engine is a recording stub — no provider is contacted and every address is a test address.
//
//   1. critical ops alert — a transactional claim before sending:
//        concurrent runs → one email · a repeated run in the window → none · a changed alert set → one
//        · the next reminder window → one · the cron's retry of a run cut off mid-send → none
//        · a run that died BEFORE sending → retried (no loss) · both channels failed → retried
//   2. service-purchase admin email — one copy per MAILBOX (case, +tag, Gmail dots / googlemail),
//        distinct mailboxes all still emailed
//   3. outbox — "already delivered" keyed by MAILBOX: a retry that resolves a mailbox under another
//        spelling or order does not send it again; legacy raw-address records still count; a recipient
//        that really failed is still retried

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = process.pid

const h = vi.hoisted(() => ({
  sent: [] as { type: string; to: string }[],
  failFor: new Set<string>(),
  throwAll: false,
  admins: [] as string[],
  alerts: [] as { id: string; severity: string; message: string }[],
}))

vi.mock('next/server', async orig => ({ ...(await orig<typeof import('next/server')>()), after: () => undefined }))
vi.mock('@/lib/env', async orig => ({ ...(await orig<typeof import('@/lib/env')>()), OPS_ALERT_WEBHOOK_URL: '' }))
vi.mock('@/lib/config/resolveBrandingConfig', async orig => ({
  ...(await orig<typeof import('@/lib/config/resolveBrandingConfig')>()),
  getBrandingConfig: async () => ({ platformName: 'RegisterDesk QA', supportEmail: 'support@rd.test' }),
}))
vi.mock('@/lib/notifications/superAdminRecipients', () => ({ superAdminRecipients: async () => [...h.admins] }))
vi.mock('@/lib/operations/healthMetrics', async orig => ({
  ...(await orig<typeof import('@/lib/operations/healthMetrics')>()),
  getOperationsHealth: async () => ({ generatedAt: '2026-10-28T00:00:00Z' }),
  evaluateAlerts: () => [...h.alerts],
}))
vi.mock('@/lib/notifications', async orig => {
  const real = await orig<typeof import('@/lib/notifications')>()
  return {
    ...real,
    notificationEngine: {
      ...real.notificationEngine,
      isAvailable: () => true,
      send: async (type: string, p: { to: string }) => {
        if (h.throwAll) throw new Error('provider down')
        if (h.failFor.has(p.to.toLowerCase())) return { success: false, error: 'rejected' }
        h.sent.push({ type, to: p.to })
        return { success: true, messageId: `m-${h.sent.length}` }
      },
    },
  }
})

const HOUR = 60 * 60 * 1000
const crit = (...ids: string[]) => ids.map(id => ({ id, severity: 'critical', message: `${id} is down` }))

describeEmu('RD-NOTIFY-DEDUP-02 · duplicate-email fixes (real Firestore)', () => {
  let db: import('firebase-admin/firestore').Firestore
  let ops: typeof import('@/lib/operations/alertDelivery')
  const STATE = 'operationsMetrics/_alertState'
  const cleanup = new Set<string>()
  const emails = (type = 'CUSTOM_EMAIL') => h.sent.filter(s => s.type === type).map(s => s.to)

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    ops = await import('@/lib/operations/alertDelivery')
  }, T)
  beforeEach(async () => {
    h.sent = []; h.failFor = new Set(); h.throwAll = false; h.admins = []; h.alerts = []
    await db.doc(STATE).delete().catch(() => null)
  })
  afterAll(async () => {
    await db.doc(STATE).delete().catch(() => null)
    for (const p of cleanup) await db.recursiveDelete(db.doc(p)).catch(() => null)
  }, T)

  // ── 1 · critical operations alert ─────────────────────────────────────────
  describe('critical operations alert', () => {
    const t0 = Date.UTC(2026, 9, 28, 6, 0, 0)

    it('concurrent runs for one alert set send ONE email', async () => {
      h.alerts = crit('outbox_failed')
      const runs = await Promise.all(Array.from({ length: 5 }, () => ops.deliverCriticalAlerts(t0)))
      expect(emails()).toEqual(['support@rd.test'])
      expect(runs.filter(r => r.reason === 'sent')).toHaveLength(1)
      expect(runs.filter(r => r.reason === 'in_flight' || r.reason === 'deduped')).toHaveLength(4)
      expect((await db.doc(STATE).get()).data()).toMatchObject({ signature: 'outbox_failed', lastSentAt: t0 })
      expect((await db.doc(STATE).get()).data()?.claim).toBeUndefined()
    }, T)

    it('a repeated run in the window sends nothing; a changed set and the next reminder window each send once', async () => {
      h.alerts = crit('outbox_failed')
      await ops.deliverCriticalAlerts(t0)
      expect((await ops.deliverCriticalAlerts(t0 + 10 * 60_000)).reason).toBe('deduped')
      h.alerts = crit('outbox_failed', 'cron_stale')                       // set changed → alert at once
      expect((await ops.deliverCriticalAlerts(t0 + 20 * 60_000)).reason).toBe('sent')
      expect((await ops.deliverCriticalAlerts(t0 + 30 * 60_000)).reason).toBe('deduped')
      expect((await ops.deliverCriticalAlerts(t0 + 20 * 60_000 + 6 * HOUR)).reason).toBe('sent')   // 6-hour reminder
      expect(emails()).toHaveLength(3)
    }, T)

    it('the cron retry of a run cut off after sending finds the live claim and sends nothing', async () => {
      h.alerts = crit('outbox_failed')
      // the first attempt marked 'sending', emailed, and was killed before recording it (70 s ago)
      await db.doc(STATE).set({ claim: { id: 'dead-run', signature: 'outbox_failed', at: t0 - 70_000, phase: 'sending' } })
      expect((await ops.deliverCriticalAlerts(t0)).reason).toBe('in_flight')
      expect(emails()).toEqual([])
    }, T)

    it('an expired claim from a run that died MID-SEND is settled as sent (no duplicate) until the reminder', async () => {
      h.alerts = crit('outbox_failed')
      await db.doc(STATE).set({ claim: { id: 'dead-run', signature: 'outbox_failed', at: t0 - 10 * 60_000, phase: 'sending' } })
      expect((await ops.deliverCriticalAlerts(t0)).reason).toBe('deduped')
      expect(emails()).toEqual([])
      expect((await db.doc(STATE).get()).data()).toMatchObject({ signature: 'outbox_failed', lastSentAt: t0 - 10 * 60_000 })
      expect((await ops.deliverCriticalAlerts(t0 - 10 * 60_000 + 6 * HOUR)).reason).toBe('sent')
    }, T)

    it('an expired claim from a run that died BEFORE sending is retried (no lost alert)', async () => {
      h.alerts = crit('outbox_failed')
      await db.doc(STATE).set({ claim: { id: 'dead-run', signature: 'outbox_failed', at: t0 - 10 * 60_000, phase: 'claimed' } })
      expect((await ops.deliverCriticalAlerts(t0)).reason).toBe('sent')
      expect(emails()).toEqual(['support@rd.test'])
    }, T)

    it('when every channel fails, the claim is released and the next run retries (legitimate retry kept)', async () => {
      h.alerts = crit('outbox_failed')
      h.throwAll = true
      expect((await ops.deliverCriticalAlerts(t0)).delivered).toBe(false)
      expect((await db.doc(STATE).get()).data()?.claim).toBeUndefined()
      h.throwAll = false
      expect((await ops.deliverCriticalAlerts(t0 + 10 * 60_000)).reason).toBe('sent')
      expect(emails()).toHaveLength(1)
    }, T)

    it('planAlertDelivery: live claim → in_flight; expired claimed → drop; expired sending → settle as sent', () => {
      expect(ops.planAlertDelivery({ claim: { id: 'x', signature: 's', at: 0, phase: 'sending' } }, 's', 60_000)).toEqual({ action: 'in_flight' })
      expect(ops.planAlertDelivery({ claim: { id: 'x', signature: 's', at: 0, phase: 'claimed' } }, 's', ops.ALERT_CLAIM_TTL_MS)).toEqual({ action: 'claim', settle: {} })
      expect(ops.planAlertDelivery({ claim: { id: 'x', signature: 's', at: 0, phase: 'sending' } }, 's', ops.ALERT_CLAIM_TTL_MS)).toEqual({ action: 'deduped', settle: { signature: 's', lastSentAt: 0 } })
    })
  })

  // ── 2 · service-purchase admin email ──────────────────────────────────────
  describe('service-purchase admin email', () => {
    async function paidOrder(tag: string) {
      const uid = `ndd-org-${P}-${tag}`, orderId = `lic_ndd${P}${tag}`
      cleanup.add(`users/${uid}`); cleanup.add(`licenseOrders/${orderId}`); cleanup.add(`purchaseNotifications/${orderId}`)
      for (const id of [`purchase-${orderId}`]) cleanup.add(`adminNotifications/${id}`)
      await db.doc(`users/${uid}`).set({ uid, name: 'Org', email: `org-${tag}@rd.test` })
      await db.doc(`licenseOrders/${orderId}`).set({
        status: 'paid', organizerUid: uid, eventId: `ndd-draft-${tag}`, amountPaise: 17700,
        capacityChange: { operation: 'activation', capacity: 200, previousCapacity: 0, basePaise: 15000, gstPaise: 2700, totalPaise: 17700 },
      })
      return orderId
    }

    it('equivalent spellings of one mailbox get ONE copy; distinct mailboxes each get theirs', async () => {
      // support@rd.test (branding) is added by superAdminRecipients in production; the stub returns the full list.
      h.admins = [
        'support@rd.test', 'SUPPORT@rd.test',                  // case
        'Bala.NT5055@gmail.com', 'balant5055+ops@googlemail.com', // Gmail dots / +tag / googlemail
        'ops@rd.test', 'ops@rd.test',                          // repeated
        'finance@rd.test',                                     // a different, legitimate mailbox
      ]
      const { notifyServicePurchase } = await import('@/lib/notifications/servicePurchase')
      expect(await notifyServicePurchase(await paidOrder('a'))).toBe('sent')
      const admin = emails('SERVICE_PURCHASE_ADMIN')
      expect(admin).toEqual(['support@rd.test', 'Bala.NT5055@gmail.com', 'ops@rd.test', 'finance@rd.test'])
      expect(emails('SERVICE_PURCHASED')).toEqual(['org-a@rd.test'])   // the organizer's own email is unchanged
    }, T)

    it('a second trigger for the same order sends nothing (existing per-order claim)', async () => {
      h.admins = ['support@rd.test']
      const { notifyServicePurchase } = await import('@/lib/notifications/servicePurchase')
      const orderId = await paidOrder('b')
      expect(await notifyServicePurchase(orderId)).toBe('sent')
      expect(await notifyServicePurchase(orderId)).toBe('duplicate')
      expect(emails('SERVICE_PURCHASE_ADMIN')).toEqual(['support@rd.test'])
    }, T)
  })

  // ── 3 · outbox delivered-check by mailbox ─────────────────────────────────
  describe('outbox delivery dedup by mailbox', () => {
    let ob: typeof import('@/lib/notifications/outbox')
    let n = 0
    beforeAll(async () => { ob = await import('@/lib/notifications/outbox') }, T)
    const msg = () => ({
      id: `ndd-${P}-${++n}`, audience: { kind: 'super_admins' as const }, adminKind: 'event_review' as const,
      subject: 'Event submitted', heading: 'h', intro: 'i', facts: [], path: '/admin', ctaLabel: 'Open',
    })
    const track = (id: string) => { cleanup.add(`notificationOutbox/${id}`); cleanup.add(`adminNotifications/${id}`) }

    it('a retry that resolves the same mailbox under another spelling / order does not send it again', async () => {
      const m = msg(); track(m.id)
      await ob.enqueueOutboxMessage(m)
      h.admins = ['Bala.NT5055@gmail.com', 'finance@rd.test']
      h.failFor = new Set(['finance@rd.test'])                         // a real failure → legitimate retry
      expect(await ob.deliverOutboxMessage(m.id)).toBe('retry')
      expect(emails()).toEqual(['Bala.NT5055@gmail.com'])

      h.admins = ['finance@rd.test', 'balant5055@gmail.com']          // order and spelling changed
      h.failFor = new Set()
      expect(await ob.deliverOutboxMessage(m.id)).toBe('sent')
      expect(emails()).toEqual(['Bala.NT5055@gmail.com', 'finance@rd.test'])   // no second copy to the gmail inbox
    }, T)

    it('a record written before the fix (raw-address key) still counts as delivered — no migration', async () => {
      const m = msg(); track(m.id)
      await ob.enqueueOutboxMessage(m)
      await db.doc(`notificationOutbox/${m.id}`).update({ [`delivered.${ob.recipientKey('Ops.Team@rd.test')}`]: true })
      h.admins = ['Ops.Team@rd.test', 'finance@rd.test']
      expect(await ob.deliverOutboxMessage(m.id)).toBe('sent')
      expect(emails()).toEqual(['finance@rd.test'])
    }, T)

    it('equivalent spellings in one recipient list are sent once; new deliveries are keyed by mailbox', async () => {
      const m = msg(); track(m.id)
      await ob.enqueueOutboxMessage(m)
      h.admins = ['ops@rd.test', 'OPS@rd.test', 'ops+alerts@rd.test']
      expect(await ob.deliverOutboxMessage(m.id)).toBe('sent')
      expect(emails()).toEqual(['ops@rd.test'])
      const d = (await db.doc(`notificationOutbox/${m.id}`).get()).data() as { delivered: Record<string, boolean> }
      expect(Object.keys(d.delivered)).toEqual([ob.mailboxKey('ops@rd.test')])
      expect(ob.mailboxKey('Bala.NT5055@googlemail.com')).toBe(ob.mailboxKey('balant5055@gmail.com'))
      expect(ob.mailboxKey('a@x.test')).not.toBe(ob.mailboxKey('b@x.test'))
    }, T)
  })
})
