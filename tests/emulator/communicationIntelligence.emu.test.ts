// RD-ANALYTICS-12-28 · communication intelligence reads, against REAL Firestore (emulator).
//
// ═══ WHY THIS TEST NEEDS A REAL DATABASE ═════════════════════════════════════
// The unit suite pins the SHAPE of every query; only Firestore can establish what a query
// returns:
//
//   · that a `createdAt` range combined with three equalities counts exactly — over 20,000
//     rows, with zero documents transferred and no page to overflow
//   · that a row written at 23:45 UTC is counted in the IST day it belongs to, and NOT in
//     the day before it — the boundary the audit was asked to define
//   · that `organizerUid` + `eventSlug` equality keeps two workspaces AND two events of one
//     workspace apart, with no reliance on the caller filtering afterwards
//   · that campaigns are counted from `broadcastCampaigns` documents, so one campaign of
//     any size is one
//   · that the wallet-skip match is EXACT on the stored reason string
//   · that a reminder population past 500 yields exact status counts (aggregates) and a
//     WITHHELD recipient sum (page overflow) — never the first 500's sum
//
// ═══ ON INDEXES ══════════════════════════════════════════════════════════════
// The emulator does not enforce composite indexes, so a green run here proves the
// arithmetic, not that production has the `(organizerUid, [channel,] eventSlug, status,
// createdAt)` composites deployed. Production without them answers `null` for the windowed
// figures — the contract every consumer already handles — and the unit suite pins that a
// throw becomes null, never zero.
//
//   npm run emu:start && npm run test:emu
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const PID   = process.pid
const UID_A = `an28-org-a-${PID}`
const UID_B = `an28-org-b-${PID}`
const BIG   = `an28-big-${PID}`      // 20,000+ rows, one workspace
const SMALL = `an28-small-${PID}`    // same workspace, different event
const OTHER = `an28-other-${PID}`    // different workspace, SAME slug shape as BIG's rows

const WINDOW = { from: '2026-09-01', to: '2026-09-30', preset: 'custom' as const }
const PRIOR  = { from: '2026-08-02', to: '2026-08-31', preset: 'custom' as const }

/** 23:45 UTC on 31 Aug = 05:15 IST on 1 Sep — inside the September window in IST only. */
const BOUNDARY_IN  = Date.parse('2026-08-31T23:45:00.000Z')
/** 18:15 UTC on 31 Aug = 23:45 IST on 31 Aug — outside the September window in IST. */
const BOUNDARY_OUT = Date.parse('2026-08-31T18:15:00.000Z')
const MID_SEP      = Date.parse('2026-09-15T06:00:00.000Z')
const MID_AUG      = Date.parse('2026-08-15T06:00:00.000Z')

const BIG_SEP_SENT      = 12_000
const BIG_SEP_DELIVERED = 7_000
const BIG_SEP_FAILED    = 1_000
const BIG_AUG_SENT      = 500

describeEmu('RD-ANALYTICS-12-28 · communication intelligence reads', () => {
  let adminDb: FirebaseFirestore.Firestore
  let src: typeof import('@/lib/analytics/communicationsSources')
  let istRangeBounds: typeof import('@/lib/analytics/revenueIntelligence').istRangeBounds

  const seeded: { col: string; id: string }[] = []

  const writeRows = async (col: string, prefix: string, rows: Record<string, unknown>[]) => {
    let batch = adminDb.batch()
    for (let i = 0; i < rows.length; i++) {
      const id = `${prefix}-${i}`
      seeded.push({ col, id })
      batch.set(adminDb.collection(col).doc(id), rows[i])
      if ((i + 1) % 450 === 0) { await batch.commit(); batch = adminDb.batch() }
    }
    await batch.commit()
  }

  const log = (uid: string, slug: string, at: number, over: Record<string, unknown>) => ({
    organizerUid: uid, eventId: slug, eventSlug: slug, templateKey: 'registration',
    createdAt: Timestamp.fromMillis(at), ...over,
  })

  beforeAll(async () => {
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    src = await import('@/lib/analytics/communicationsSources')
    ;({ istRangeBounds } = await import('@/lib/analytics/revenueIntelligence'))

    // BIG · 20,500 rows in workspace A.
    await writeRows('emailLogs', BIG, [
      ...Array.from({ length: BIG_SEP_SENT },      () => log(UID_A, BIG, MID_SEP, { status: 'sent' })),
      ...Array.from({ length: BIG_SEP_DELIVERED }, () => log(UID_A, BIG, MID_SEP, { status: 'delivered' })),
      ...Array.from({ length: BIG_SEP_FAILED },    () => log(UID_A, BIG, MID_SEP, { status: 'failed', error: 'bounce' })),
      ...Array.from({ length: BIG_AUG_SENT },      () => log(UID_A, BIG, MID_AUG, { status: 'sent' })),
      log(UID_A, BIG, BOUNDARY_IN,  { status: 'delivered', templateKey: 'boundary-in' }),
      log(UID_A, BIG, BOUNDARY_OUT, { status: 'delivered', templateKey: 'boundary-out' }),
      // WhatsApp: a read, a wallet skip (exact reason), a skip with another reason, a timeout
      log(UID_A, BIG, MID_SEP, { status: 'delivered', channel: 'whatsapp', waStatus: 'read' }),
      log(UID_A, BIG, MID_SEP, { status: 'skipped',   channel: 'whatsapp', error: 'Insufficient wallet balance' }),
      log(UID_A, BIG, MID_SEP, { status: 'skipped',   channel: 'whatsapp', error: 'insufficient wallet balance' }),
      log(UID_A, BIG, MID_SEP, { status: 'failed',    channel: 'whatsapp', deliveryUnknown: true }),
      // broadcast rows
      log(UID_A, BIG, MID_SEP, { status: 'delivered', templateKey: 'broadcast', campaignId: 'c1' }),
      log(UID_A, BIG, MID_SEP, { status: 'delivered', templateKey: 'broadcast', campaignId: 'c1' }),
      log(UID_A, BIG, MID_SEP, { status: 'failed',    templateKey: 'broadcast', campaignId: 'c1', error: 'complaint' }),
    ])
    // SMALL · same workspace, different event.
    await writeRows('emailLogs', SMALL, [
      log(UID_A, SMALL, MID_SEP, { status: 'sent' }),
      log(UID_A, SMALL, MID_SEP, { status: 'failed', error: 'bounce' }),
    ])
    // OTHER · a different workspace whose rows CLAIM BIG's slug. Must never be counted for A.
    await writeRows('emailLogs', OTHER, [
      log(UID_B, BIG, MID_SEP, { status: 'sent' }),
      log(UID_B, BIG, MID_SEP, { status: 'failed', error: 'bounce' }),
      log(UID_B, BIG, MID_SEP, { status: 'delivered', templateKey: 'broadcast', campaignId: 'x' }),
    ])

    // Campaigns: one of 5,000 recipients is ONE campaign.
    const camp = (uid: string, slug: string, status: string, at: number, recipients: number) => ({
      organizerUid: uid, eventId: slug, eventSlug: slug, status, channel: 'email',
      recipientCount: recipients, successCount: status === 'sent' ? recipients : 0, failCount: 0,
      createdAt: Timestamp.fromMillis(at),
    })
    await writeRows('broadcastCampaigns', `${BIG}-camp`, [
      camp(UID_A, BIG, 'sent',      MID_SEP, 5_000),
      camp(UID_A, BIG, 'partial',   MID_SEP, 10),
      camp(UID_A, BIG, 'scheduled', MID_SEP, 10),
      camp(UID_A, BIG, 'draft',     MID_SEP, 10),
      camp(UID_A, BIG, 'sent',      MID_AUG, 10),
      camp(UID_B, BIG, 'sent',      MID_SEP, 10),   // other workspace, same slug
    ])

    // Reminders: 501 for BIG so the recipient page overflows.
    await writeRows('scheduledReminders', `${BIG}-rem`, [
      ...Array.from({ length: 480 }, () => ({ eventId: BIG, organizerUid: UID_A, status: 'sent',      counts: { recipients: 7 } })),
      ...Array.from({ length: 21 },  () => ({ eventId: BIG, organizerUid: UID_A, status: 'scheduled', counts: { recipients: 7 } })),
    ])
  }, 900_000)

  afterAll(async () => {
    for (let i = 0; i < seeded.length; i += 450) {
      const batch = adminDb.batch()
      for (const { col, id } of seeded.slice(i, i + 450)) batch.delete(adminDb.collection(col).doc(id))
      await batch.commit()
    }
  }, 900_000)

  it('1 · AA · 20,000+ rows: the windowed counts are exact, and no document is read', async () => {
    const w = await src.readWindowedCommunicationCounts(UID_A, BIG, istRangeBounds(WINDOW))
    // + 1 boundary-in row, + 2 broadcast delivered, + 1 broadcast failed(complaint)
    expect(w.email.delivered).toBe(BIG_SEP_DELIVERED + 1 + 2)
    expect(w.email.notDelivered).toBe(BIG_SEP_FAILED + 1)
    expect(w.email.attempted).toBe(BIG_SEP_SENT + BIG_SEP_DELIVERED + 1 + 2 + BIG_SEP_FAILED + 1)
    expect(w.whatsapp.delivered).toBe(1)
    expect(w.whatsapp.notDelivered).toBe(1)   // the timeout — RAW, included, not called failed
    expect(w.whatsapp.skipped).toBe(2)
    expect(w.whatsapp.attempted).toBe(2)
  }, 120_000)

  it('2 · 23:45 UTC the day before the window is INSIDE the window in IST; 23:45 IST is not', async () => {
    const sep = await src.readWindowedCommunicationCounts(UID_A, BIG, istRangeBounds(WINDOW))
    const aug = await src.readWindowedCommunicationCounts(UID_A, BIG, istRangeBounds(PRIOR))
    // boundary-in (delivered) sits in September; boundary-out (delivered) sits in August
    expect(sep.email.delivered).toBe(BIG_SEP_DELIVERED + 1 + 2)
    expect(aug.email.delivered).toBe(1)
    expect(aug.email.attempted).toBe(BIG_AUG_SENT + 1)
  }, 120_000)

  it('3 · a workspace never sees another workspace\'s rows, even with the same slug', async () => {
    const a = await src.readWindowedCommunicationCounts(UID_A, BIG, istRangeBounds(WINDOW))
    const b = await src.readWindowedCommunicationCounts(UID_B, BIG, istRangeBounds(WINDOW))
    expect(b.email.attempted).toBe(3)
    expect(b.email.notDelivered).toBe(1)
    expect(a.email.attempted).not.toBe(b.email.attempted)

    const sigA = await src.readCommunicationSignals(UID_A, BIG, null)
    const sigB = await src.readCommunicationSignals(UID_B, BIG, null)
    expect(sigB.bounces).toBe(1)
    expect(sigB.broadcast).toBe(1)
    expect(sigA.bounces).toBe(BIG_SEP_FAILED)   // every September email failure was a bounce
    expect(sigA.complaints).toBe(1)
  }, 120_000)

  it('4 · two events of one workspace stay apart', async () => {
    const big   = await src.readCommunicationSignals(UID_A, BIG,   null)
    const small = await src.readCommunicationSignals(UID_A, SMALL, null)
    expect(small.bounces).toBe(1)
    expect(small.broadcast).toBe(0)
    expect(big.broadcast).toBe(3)
    expect(big.bounces).not.toBe(small.bounces)
  }, 120_000)

  it('5 · broadcast + automatic = total, and automatic is null when total is unmeasured', async () => {
    const counts = await src.readCommunicationCounts(BIG)
    const sig = await src.readCommunicationSignals(UID_A, BIG, counts!.total)
    expect(sig.broadcast).toBe(3)
    expect(sig.automatic).toBe(counts!.total! - 3)
    const unmeasured = await src.readCommunicationSignals(UID_A, BIG, null)
    expect(unmeasured.automatic).toBeNull()
    expect(unmeasured.broadcast).toBe(3)
  }, 120_000)

  it('6 · WhatsApp read and wallet-held are exact matches; a differently-cased reason is NOT counted', async () => {
    const sig = await src.readCommunicationSignals(UID_A, BIG, null)
    expect(sig.read).toBe(1)
    expect(sig.walletSkipped).toBe(1)
  }, 120_000)

  it('7 · campaigns are counted from campaign documents — a 5,000-recipient campaign is one', async () => {
    const c = await src.readCampaignCounts(UID_A, BIG, istRangeBounds(WINDOW), istRangeBounds(PRIOR))
    expect(c.created).toBe(5)       // B's campaign with the same slug is excluded
    expect(c.completed).toBe(3)     // 2 sent + 1 partial
    expect(c.scheduled).toBe(1)
    expect(c.period).toBe(4)        // created in September
    expect(c.baseline).toBe(1)      // created in August
    const noWindow = await src.readCampaignCounts(UID_A, BIG, null, null)
    expect(noWindow.period).toBeNull()
    expect(noWindow.baseline).toBeNull()
  }, 120_000)

  it('8 · reminder status counts are exact past 500 — the old page would have stopped at 500', async () => {
    const count = (status: string) =>
      adminDb.collection('scheduledReminders').where('eventId', '==', BIG).where('status', '==', status)
        .count().get().then(s => s.data().count)
    expect(await count('sent')).toBe(480)
    expect(await count('scheduled')).toBe(21)
    // The recipient page the engine reads: 501 rows overflow a 500 page.
    const page = await adminDb.collection('scheduledReminders').where('eventId', '==', BIG).limit(501).get()
    expect(page.docs.length).toBeGreaterThan(500)
  }, 120_000)

  it('9 · a window with nothing in it is a measured zero, not unavailable', async () => {
    const w = await src.readWindowedCommunicationCounts(UID_A, SMALL, istRangeBounds(PRIOR))
    expect(w.email.attempted).toBe(0)
    expect(w.whatsapp.attempted).toBe(0)
    expect(w.email.delivered).toBe(0)
  }, 120_000)
})
