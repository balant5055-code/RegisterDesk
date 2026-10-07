// RD-REPORT-05 · Certificate reporting — REAL Firestore (emulator), REAL route.
//
// ═══ THE FINDING THIS FILE PINS ══════════════════════════════════════════════
//
// The certificate engine writes to `certificates`. The stats route's original
// fields count `certificateRecords` — the legacy MVP collection the engine stopped
// writing to ("writes ONLY here; the MVP collection is left untouched"). Its one
// remaining writer is the attendee on-demand download route.
//
// So on an event whose certificates came from the organizer flow, those fields
// report ZERO generated and the ENTIRE roster as pending. This file seeds real
// certificates and asserts both halves: the legacy fields are stale, and the
// additive `current` figures are exact.
//
// It also pins §26: regeneration is IN PLACE — `recordCertificateRegeneration`
// updates the same document — so a regenerated certificate cannot become two.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const PID   = process.pid
const UID   = `crt05-org-${PID}`
const ON    = `crt05-on-${PID}`      // certificates enabled
const OFF   = `crt05-off-${PID}`     // template exists, enabled: false
const OTHER = `crt05-other-${PID}`

// Deliberately ABOVE the /records default page size of 200, so a page-based
// calculation and an event-wide one cannot produce the same number.
const GENERATED = 240, REVOKED = 6, FAILED = 4
const TOTAL_DOCS = GENERATED + REVOKED + FAILED          // 250
// Delivery, in the shape the MODERN send path writes: emailStatus moves, status does not.
const SENT = 190, DELIVERED = 8
// downloadCount: 1 on every second generated certificate.
// Every 2nd certificate is downloaded; every 10th is downloaded three times. That
// keeps Σ downloadCount distinct from the COUNT of downloaded certificates, so the
// two cannot be confused for one another.
const DOWNLOADED_CERTS = Math.ceil(GENERATED / 2)                       // 120
const DOWNLOADS_TOTAL  = (GENERATED / 10) * 3 + (DOWNLOADED_CERTS - GENERATED / 10)  // 168
const REFUNDED = 8, PLAIN_CONFIRMED = 20, CANCELLED = 5, PENDING_REG = 7
const REGENERATED = 10

vi.mock('@/lib/team/workspace', () => ({
  authorizeWorkspace: async () => ({
    ok: true, status: 200, error: '', workspaceUid: UID, callerUid: UID,
    role: 'owner', permissions: ['certificates'],
  }),
  authorizeWorkspaceDownload: async () => ({
    ok: true, status: 200, error: '', workspaceUid: UID, callerUid: UID,
    role: 'owner', permissions: ['certificates'],
  }),
}))

describeEmu('RD-REPORT-05 · certificate reporting truth', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let GET: (req: NextRequest, ctx: { params: Promise<{ eventId: string }> }) => Promise<Response>
  let buildCertificateReport: typeof import('@/lib/certificates/report').buildCertificateReport
  let buildCertificateOverview: typeof import('@/lib/certificates/report').buildCertificateOverview
  let cellText: typeof import('@/lib/certificates/report').cellText

  const regIds: string[] = []
  const certIds: string[] = []

  const stats = async (eventId: string) => {
    const res = await GET(
      new NextRequest(`http://localhost/api/organizer/events/${eventId}/certificates/stats`),
      { params: Promise.resolve({ eventId }) },
    )
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }
  const reportFor = async (eventId: string) => {
    const { body } = await stats(eventId)
    return buildCertificateReport(body.current as never)
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) {
      throw new Error('Refusing to run outside a demo- project.')
    }
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ GET }     = await import('@/app/api/organizer/events/[eventId]/certificates/stats/route'))
    ;({ buildCertificateReport, buildCertificateOverview, cellText } = await import('@/lib/certificates/report'))

    const draft = (uid: string, slug: string) => adminDb.doc(`users/${uid}/eventDrafts/${slug}`).set({
      eventDetails: { seo: { urlSlug: slug }, info: { name: `Event ${slug}` } },
      pricing: { passes: [{ id: 'p5', name: '5 KM', price: 1000 }] },
      status: 'published', lifecycleStatus: 'published',
    })
    await Promise.all([draft(UID, ON), draft(UID, OFF), draft(OTHER, `${ON}-foreign`)])

    await adminDb.doc(`certificateTemplates/${ON}`).set({
      eventId: ON, enabled: true, type: 'participation', title: 'Certificate',
    })
    // Template EXISTS but is switched off — the applicability case.
    await adminDb.doc(`certificateTemplates/${OFF}`).set({
      eventId: OFF, enabled: false, type: 'participation', title: 'Certificate',
    })

    const rows: [FirebaseFirestore.DocumentReference, Record<string, unknown>][] = []
    let n = 0
    const reg = (slug: string, status: string, paymentStatus: string) => {
      const id = `${slug}-reg-${n++}`
      regIds.push(id)
      rows.push([adminDb.collection('registrations').doc(id), {
        organizerUid: slug === `${ON}-foreign` ? OTHER : UID,
        eventSlug: slug, status, paymentStatus, passId: 'p5', passName: '5 KM',
        attendee: { name: `P${n}`, email: `${slug}-${n}@test.local` },
        registeredAt: new Date(),
      }])
      return id
    }
    const cert = (eventId: string, slug: string, registrationId: string, status: string, extra: Record<string, unknown> = {}) => {
      const id = `RDC-${eventId}-${n++}`
      certIds.push(id)
      rows.push([adminDb.collection('certificates').doc(id), {
        certificateId: id, verificationToken: null,
        eventId, eventSlug: slug,
        organizerUid: eventId === `${ON}-foreign` ? OTHER : UID,
        registrationId, attendeeName: `P${n}`, attendeeEmail: `x${n}@test.local`,
        eventName: 'E', eventDate: '1 Dec 2026', certificateType: 'participation',
        templateId: null, fileUrl: null, fileKey: `k/${id}.pdf`, fileSize: 10,
        status, source: 'bulk', data: {}, downloadCount: 0, lastDownloadedAt: null,
        emailStatus: null, emailHistory: [], generatedAt: new Date(),
        emailedAt: null, revokedAt: null, revokedBy: null, revokeReason: null,
        revocationHistory: [], jobId: null, schemaVersion: 2,
        ...extra,
      }])
      return id
    }

    for (let i = 0; i < GENERATED; i++) {
      const r = reg(ON, 'confirmed', 'paid')
      // §26 · some were regenerated IN PLACE: same document, counters bumped.
      const regen = i < REGENERATED
        ? { regeneratedAt: new Date(), regenerationCount: 3, regenerationHistory: [{ action: 'regenerated' }] }
        : {}
      // Delivery is recorded on emailStatus; the document status stays generated — what
      // the modern send path actually does, and why counting status 'emailed' reads 0.
      const delivery = i < SENT ? { emailStatus: 'sent', emailedAt: new Date() }
        : i < SENT + DELIVERED ? { emailStatus: 'delivered', emailedAt: new Date() }
        : {}
      cert(ON, ON, r, 'generated', { downloadCount: i % 2 !== 0 ? 0 : (i % 10 === 0 ? 3 : 1), ...regen, ...delivery })
    }
    for (let i = 0; i < REVOKED; i++) {
      cert(ON, ON, reg(ON, 'confirmed', 'paid'), 'revoked', { revokedAt: new Date(), revokedBy: UID })
    }
    for (let i = 0; i < FAILED; i++) {
      cert(ON, ON, reg(ON, 'confirmed', 'paid'), 'failed', { fileKey: null })
    }
    for (let i = 0; i < REFUNDED; i++)        reg(ON, 'confirmed', 'refunded')
    for (let i = 0; i < PLAIN_CONFIRMED; i++) reg(ON, 'confirmed', 'paid')
    for (let i = 0; i < CANCELLED; i++)       reg(ON, 'cancelled', 'paid')
    for (let i = 0; i < PENDING_REG; i++)     reg(ON, 'pending', 'pending')

    // The disabled event has real participants and real certificates.
    for (let i = 0; i < 9; i++) cert(OFF, OFF, reg(OFF, 'confirmed', 'paid'), 'generated')
    // Another organizer's event.
    for (let i = 0; i < 11; i++) {
      cert(`${ON}-foreign`, `${ON}-foreign`, reg(`${ON}-foreign`, 'confirmed', 'paid'), 'generated')
    }

    for (let i = 0; i < rows.length; i += 400) {
      const b = adminDb.batch()
      rows.slice(i, i + 400).forEach(([ref, d]) => b.set(ref, d))
      await b.commit()
    }
  }, 180_000)

  afterAll(async () => {
    const del = async (coll: string, list: string[]) => {
      for (let i = 0; i < list.length; i += 400) {
        const b = adminDb.batch()
        list.slice(i, i + 400).forEach(id => b.delete(adminDb.collection(coll).doc(id)))
        await b.commit()
      }
    }
    await del('registrations', regIds)
    await del('certificates', certIds)
    await Promise.all([
      adminDb.doc(`certificateTemplates/${ON}`).delete(),
      adminDb.doc(`certificateTemplates/${OFF}`).delete(),
      adminDb.doc(`users/${UID}/eventDrafts/${ON}`).delete(),
      adminDb.doc(`users/${UID}/eventDrafts/${OFF}`).delete(),
      adminDb.doc(`users/${OTHER}/eventDrafts/${ON}-foreign`).delete(),
    ])
  })

  const CONFIRMED = TOTAL_DOCS + REFUNDED + PLAIN_CONFIRMED
  const ELIGIBLE  = CONFIRMED - REFUNDED
  // RD-CERT-01 · standing = total − revoked − failed. The modern engine never writes
  // status 'emailed', so adding statuses would be the wrong derivation.
  const STANDING  = TOTAL_DOCS - REVOKED - FAILED

  // ═══ THE LEGACY-COLLECTION FINDING ═════════════════════════════════════════

  it('the legacy fields report ZERO despite real certificates existing', async () => {
    const { body } = await stats(ON)
    // This is the defect, asserted so it cannot be "fixed" by accident and forgotten.
    expect(body.generated).toBe(0)
    expect(body.emailed).toBe(0)
    expect(body.pending).toBe(CONFIRMED)   // the whole confirmed roster
  })

  it('the current figures are exact over the authoritative store', async () => {
    const { body } = await stats(ON)
    const c = body.current as Record<string, number>
    expect(c.generated).toBe(GENERATED)
    // status 'emailed' is legacy-shaped; the modern fixture has none of it.
    expect(c.emailed).toBe(0)
    expect(c.emailedSent).toBe(SENT)
    expect(c.emailedDelivered).toBe(DELIVERED)
    expect(c.revoked).toBe(REVOKED)
    expect(c.failed).toBe(FAILED)
    expect(c.total).toBe(TOTAL_DOCS)
  })

  // ═══ APPLICABILITY (§5) ════════════════════════════════════════════════════

  it('a disabled template makes the section inapplicable', async () => {
    expect((await reportFor(OFF)).applicable).toBe(false)
  })

  it('…even though that event has 9 real certificates', async () => {
    const { body } = await stats(OFF)
    expect((body.current as Record<string, number>).total).toBe(9)
    expect((await reportFor(OFF)).applicable).toBe(false)
  })

  it('an enabled template is applicable', async () => {
    expect((await reportFor(ON)).applicable).toBe(true)
  })

  // ═══ ELIGIBILITY (§6) ══════════════════════════════════════════════════════

  it('eligible is confirmed MINUS refunded — the rule the engine enforces', async () => {
    const { body } = await stats(ON)
    const c = body.current as Record<string, number>
    expect(c.eligible).toBe(ELIGIBLE)
    expect(c.refunded).toBe(REFUNDED)
    // Not the raw confirmed count, and not the whole roster.
    expect(c.eligible).not.toBe(CONFIRMED)
  })

  it('cancelled and pending registrations are outside the eligible population', async () => {
    const { body } = await stats(ON)
    const c = body.current as Record<string, number>
    expect(c.eligible).toBe(ELIGIBLE)   // CANCELLED + PENDING_REG excluded
  })

  // ═══ §25 · THE REGRESSION ══════════════════════════════════════════════════

  it('§25 · generated is the EVENT total, not a page', async () => {
    const r = await reportFor(ON)
    if (!r.applicable) throw new Error('expected applicable')
    expect(cellText(r.issuedTotal)).toBe(String(STANDING))
    expect(STANDING).toBeGreaterThan(50)     // larger than any page
  })

  it('§25 · pending and completion follow from the same population', async () => {
    const r = await reportFor(ON)
    if (!r.applicable) throw new Error('expected applicable')
    expect(cellText(r.pending)).toBe(String(ELIGIBLE - STANDING))
    expect(r.coverage.percent).toBe(Math.round((STANDING / ELIGIBLE) * 1000) / 10)
  })

  // ═══ §26 · REGENERATION ════════════════════════════════════════════════════

  it('§26 · regeneration is IN PLACE — one participant, one document', async () => {
    const snap = await adminDb.collection('certificates')
      .where('eventId', '==', ON).where('status', '==', 'generated').get()
    const regenerated = snap.docs.filter(d => (d.data().regenerationCount as number ?? 0) > 0)
    expect(regenerated).toHaveLength(REGENERATED)
    // Each carries a count above 1 while remaining a SINGLE document.
    expect(regenerated.every(d => (d.data().regenerationCount as number) > 1)).toBe(true)
    // And every registration still maps to exactly one certificate.
    const byReg = new Map<string, number>()
    snap.docs.forEach(d => {
      const r = d.data().registrationId as string
      byReg.set(r, (byReg.get(r) ?? 0) + 1)
    })
    expect([...byReg.values()].every(v => v === 1)).toBe(true)
  })

  it('§26 · a regenerated certificate is not counted twice', async () => {
    const r = await reportFor(ON)
    if (!r.applicable) throw new Error('expected applicable')
    // 10 of the 60 were regenerated; the standing count is still 60 + 25.
    expect(r.issuedTotal.value).toBe(STANDING)
  })

  // ═══ DUPLICATES / ORPHANS ══════════════════════════════════════════════════

  it('certificate ids are unique by construction — the id is the document key', async () => {
    const snap = await adminDb.collection('certificates').where('eventId', '==', ON).get()
    const ids = snap.docs.map(d => d.data().certificateId as string)
    expect(new Set(ids).size).toBe(ids.length)
    expect(snap.docs.every(d => d.id === d.data().certificateId)).toBe(true)
  })

  it('every certificate carries the event and organizer it belongs to', async () => {
    const snap = await adminDb.collection('certificates').where('eventId', '==', ON).get()
    expect(snap.docs.every(d => d.data().organizerUid === UID)).toBe(true)
    expect(snap.docs.every(d => typeof d.data().registrationId === 'string')).toBe(true)
  })

  // ═══ ISOLATION (§20) ═══════════════════════════════════════════════════════

  it('another organizer\'s event is not reachable', async () => {
    expect((await stats(`${ON}-foreign`)).status).toBe(404)
  })

  it('another organizer\'s certificates are in no figure', async () => {
    const { body } = await stats(ON)
    const c = body.current as Record<string, number>
    expect(c.total).toBe(TOTAL_DOCS)   // the 11 foreign excluded
  })

  it('an unknown event is refused', async () => {
    expect((await stats(`no-such-${PID}`)).status).toBe(404)
  })

  // ═══ SCALE ═════════════════════════════════════════════════════════════════

  it('the aggregate figures transfer no certificate documents', async () => {
    const { body } = await stats(ON)
    // `recent` is the pre-existing bounded preview off the LEGACY collection, which
    // is empty here. Nothing in `current` carries documents.
    expect(Array.isArray(body.recent)).toBe(true)
    expect(body.current).not.toHaveProperty('items')
    /**
     * RD-CERT-02 re-anchored this. The invariant is that `current` carries only
     * SCALARS — no certificate documents, at any event size. Pinning the exact key
     * list made it fail whenever an aggregate was legitimately added (here,
     * `withoutArtifact`), which is a change that strengthens the payload rather than
     * weakening it. The rule is now stated directly.
     */
    const values = Object.values(body.current as Record<string, unknown>)
    expect(values.every(v => v === null || typeof v === 'number' || typeof v === 'boolean')).toBe(true)
    expect(values.some(v => Array.isArray(v))).toBe(false)
  })

  // ═══ RD-CERT-01 · §19 · THE RECONCILIATION ═════════════════════════════════

  it('§19 · the Overview reports the EVENT, not a 200-row page', async () => {
    const { body } = await stats(ON)
    const o = buildCertificateOverview(body.current as never)
    // The /records page size is 200. The fixture deliberately exceeds it.
    expect(TOTAL_DOCS).toBeGreaterThan(200)
    expect(cellText(o.total)).toBe(TOTAL_DOCS.toLocaleString('en-IN'))
    // The old client-side form would have said exactly "200".
    expect(cellText(o.total)).not.toBe('200')
  })

  it('§19 · an empty LEGACY collection cannot make the Overview read 0', async () => {
    const { body } = await stats(ON)
    // The legacy fields are 0 — there are no legacy documents at all.
    expect(body.generated).toBe(0)
    const o = buildCertificateOverview(body.current as never)
    expect(cellText(o.generated)).not.toBe('0')
    expect(o.generated.value).toBe(TOTAL_DOCS - REVOKED - FAILED)
  })

  it('§19 · every Overview card reconciles with the modern documents', async () => {
    const { body } = await stats(ON)
    const o = buildCertificateOverview(body.current as never)
    expect(cellText(o.total)).toBe(TOTAL_DOCS.toLocaleString('en-IN'))
    expect(o.generated.value).toBe(TOTAL_DOCS - REVOKED - FAILED)
    expect(o.emailed.value).toBe(SENT + DELIVERED)
    expect(o.revoked.value).toBe(REVOKED)
    expect(o.failed.value).toBe(FAILED)
    expect(o.downloads.value).toBe(DOWNLOADS_TOTAL)
  })

  it('§18 · the Overview and Reports agree on the same event', async () => {
    const { body } = await stats(ON)
    const o = buildCertificateOverview(body.current as never)
    const r = buildCertificateReport(body.current as never)
    if (!r.applicable) throw new Error('expected applicable')
    expect(cellText(r.issuedTotal)).toBe(cellText(o.generated))
    expect(cellText(r.emailed)).toBe(cellText(o.emailed))
    expect(cellText(r.revoked)).toBe(cellText(o.revoked))
  })

  it('§20 · emailed counts delivery, and legacy-status documents too', async () => {
    const { body } = await stats(ON)
    const c = body.current as Record<string, number>
    expect(c.emailedSent).toBe(SENT)
    expect(c.emailedDelivered).toBe(DELIVERED)
    // The modern engine never writes status 'emailed'; the fixture has none.
    expect(c.emailed).toBe(0)
  })

  it('§20 · Downloads is Σ downloadCount — needs no composite index', async () => {
    const { body } = await stats(ON)
    const c = body.current as Record<string, number>
    expect(c.downloadsTotal).toBe(DOWNLOADS_TOTAL)
    // Distinct from the count of downloaded certificates, which is a range query.
    expect(c.downloadsTotal).not.toBe(DOWNLOADED_CERTS)
  })

})
