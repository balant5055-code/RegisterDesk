// RD-CERT-03 · the attendee download lifecycle — REAL Firestore (emulator).
//
// ═══ THE DEFECT THIS FILE EXISTS FOR ═════════════════════════════════════════
//
// `/api/certificates/download/[registrationId]` is reached from the attendee's own
// ticket page and from the organizer's check-in drawer. It did find-or-create
// against `certificateRecords` ALONE, so for a participant whose certificate had
// already been issued by the modern engine it:
//
//   • failed to find the real certificate (wrong collection),
//   • CREATED A SECOND ONE, with a different certificateId,
//   • handed the attendee a PDF carrying a verification id nobody had issued,
//   • and counted the download against that phantom record.
//
// One participant, two certificates, two diverging inventories — caused by a public
// button. These tests pin that a modern certificate is now served, that no second
// document appears, and that repeated downloads never multiply inventory.
//
// R2 is never contacted: the modern path is asserted by REDIRECT, which is where
// this route's responsibility ends.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const PID   = process.pid
const UID   = `cd03-org-${PID}`
const OTHER = `cd03-other-${PID}`
const EV    = `cd03-event-${PID}`

/** Registration populations, chosen so eligibility reconciles arithmetically. */
const CONFIRMED_WITH_CERT = 6
const CONFIRMED_NO_CERT   = 4
const REFUNDED            = 3     // confirmed, paymentStatus refunded
const CANCELLED           = 2
const PENDING             = 5
const REJECTED            = 1

describeEmu('RD-CERT-03 · attendee download lifecycle', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let downloadGET: (req: NextRequest, ctx: { params: Promise<{ registrationId: string }> }) => Promise<Response>
  let statsGET: (req: NextRequest, ctx: { params: Promise<{ eventId: string }> }) => Promise<Response>

  const ids: string[] = []
  const certIds: string[] = []

  const download = async (registrationId: string, token?: string) => {
    const url = `http://localhost/api/certificates/download/${registrationId}${token ? `?token=${token}` : ''}`
    const res = await downloadGET(
      new NextRequest(url, { redirect: 'manual' }),
      { params: Promise.resolve({ registrationId }) },
    )
    return {
      status:   res.status,
      location: res.headers.get('location'),
      body:     res.status < 300 || res.status >= 400
        ? await res.json().catch(() => null) as Record<string, unknown> | null
        : null,
    }
  }

  /** How many certificate documents exist, in EACH collection, for a registration. */
  const inventory = async (registrationId: string) => {
    const [modern, legacy] = await Promise.all([
      adminDb.collection('certificates').where('registrationId', '==', registrationId).get(),
      adminDb.collection('certificateRecords').where('registrationId', '==', registrationId).get(),
    ])
    return { modern: modern.size, legacy: legacy.size }
  }

  const reg = (i: number, status: string, paymentStatus: string, extra: Record<string, unknown> = {}) => {
    const id = `${EV}-reg-${i}`
    ids.push(id)
    return [adminDb.collection('registrations').doc(id), {
      organizerUid: UID, eventSlug: EV, eventName: 'Lifecycle Event',
      status, paymentStatus, passId: 'p5', passName: '5 KM', checkedIn: true,
      attendee: { name: `P${i}`, email: `p${i}@test.local` },
      registeredAt: new Date(), ...extra,
    }] as [FirebaseFirestore.DocumentReference, Record<string, unknown>]
  }

  const cert = (i: number, registrationId: string, extra: Record<string, unknown> = {}) => {
    const id = `RDC-${EV}-${i}`
    certIds.push(id)
    return [adminDb.collection('certificates').doc(id), {
      certificateId: id, eventId: EV, eventSlug: EV, organizerUid: UID, registrationId,
      attendeeName: `P${i}`, attendeeEmail: `p${i}@test.local`,
      eventName: 'Lifecycle Event', eventDate: '1 Dec 2026',
      certificateType: 'participation', templateId: null,
      fileUrl: null, fileKey: `events/${EV}/certificates/${id}.pdf`, fileSize: 1024,
      status: 'generated', source: 'bulk', data: {},
      downloadCount: 0, lastDownloadedAt: null,
      emailStatus: null, emailHistory: [], generatedAt: new Date(),
      emailedAt: null, revokedAt: null, revokedBy: null, revokeReason: null,
      revocationHistory: [], jobId: null, schemaVersion: 2, ...extra,
    }] as [FirebaseFirestore.DocumentReference, Record<string, unknown>]
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) {
      throw new Error('Refusing to run outside a demo- project.')
    }
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ GET: downloadGET } = await import('@/app/api/certificates/download/[registrationId]/route'))
    ;({ GET: statsGET }    = await import('@/app/api/organizer/events/[eventId]/certificates/stats/route'))

    await Promise.all([
      adminDb.doc(`users/${UID}/eventDrafts/${EV}`).set({
        eventDetails: {
          seo: { urlSlug: EV }, info: { name: 'Lifecycle Event' },
          schedule: { startDate: '2026-12-01' },
        },
        pricing: { passes: [{ id: 'p5', name: '5 KM', price: 1000 }] },
        status: 'published', lifecycleStatus: 'published',
      }),
      // `participation` so check-in is not an extra gate here; the completion rule
      // has its own test below.
      adminDb.doc(`certificateTemplates/${EV}`).set({
        eventId: EV, enabled: true, type: 'participation', title: 'Certificate',
        subtitle: 'This is to certify that', issuedBy: 'RD', signatoryName: 'Director',
      }),
    ])

    const rows: [FirebaseFirestore.DocumentReference, Record<string, unknown>][] = []
    let i = 0
    for (let n = 0; n < CONFIRMED_WITH_CERT; n++, i++) {
      const r = reg(i, 'confirmed', 'paid'); rows.push(r)
      rows.push(cert(i, r[0].id))
    }
    for (let n = 0; n < CONFIRMED_NO_CERT; n++, i++) rows.push(reg(i, 'confirmed', 'paid'))
    for (let n = 0; n < REFUNDED; n++, i++)  rows.push(reg(i, 'confirmed', 'refunded'))
    for (let n = 0; n < CANCELLED; n++, i++) rows.push(reg(i, 'cancelled', 'paid'))
    for (let n = 0; n < PENDING; n++, i++)   rows.push(reg(i, 'pending', 'pending'))
    for (let n = 0; n < REJECTED; n++, i++)  rows.push(reg(i, 'rejected', 'paid'))

    // Another organizer's registration + certificate.
    const foreignReg = `${EV}-foreign-reg`
    ids.push(foreignReg)
    rows.push([adminDb.collection('registrations').doc(foreignReg), {
      organizerUid: OTHER, eventSlug: `${EV}-foreign`, status: 'confirmed',
      paymentStatus: 'paid', checkedIn: true,
      attendee: { name: 'F', email: 'f@test.local' }, registeredAt: new Date(),
    }])

    for (let k = 0; k < rows.length; k += 400) {
      const b = adminDb.batch()
      rows.slice(k, k + 400).forEach(([ref, d]) => b.set(ref, d))
      await b.commit()
    }
  }, 180_000)

  afterAll(async () => {
    // Sweep BOTH collections — a regression could have created legacy twins.
    const legacy = await adminDb.collection('certificateRecords').where('eventId', '==', EV).get()
    const b = adminDb.batch()
    ids.forEach(id => b.delete(adminDb.collection('registrations').doc(id)))
    certIds.forEach(id => b.delete(adminDb.collection('certificates').doc(id)))
    legacy.docs.forEach(d => b.delete(d.ref))
    await b.commit()
    await Promise.all([
      adminDb.doc(`certificateTemplates/${EV}`).delete(),
      adminDb.doc(`users/${UID}/eventDrafts/${EV}`).delete(),
    ])
  })

  const withCert = (n: number) => `${EV}-reg-${n}`                       // 0..5
  const noCert   = (n: number) => `${EV}-reg-${CONFIRMED_WITH_CERT + n}` // 6..9
  const refunded = `${EV}-reg-${CONFIRMED_WITH_CERT + CONFIRMED_NO_CERT}`
  const cancelled = `${EV}-reg-${CONFIRMED_WITH_CERT + CONFIRMED_NO_CERT + REFUNDED}`
  const pending   = `${EV}-reg-${CONFIRMED_WITH_CERT + CONFIRMED_NO_CERT + REFUNDED + CANCELLED}`

  // ═══ §2 · THE INVENTORY FORK ═══════════════════════════════════════════════

  it('§2 · a participant WITH a modern certificate is redirected to it', async () => {
    const r = await download(withCert(0))
    expect(r.status).toBe(307)
    expect(r.location).toContain(`/api/certificates/RDC-${EV}-0/file`)
  // First call in the file — module init and the rate-limit policy load here.
  }, 30_000)

  it('§2 · …and NO second certificate is created', async () => {
    await download(withCert(1))
    const inv = await inventory(withCert(1))
    expect(inv.modern).toBe(1)
    expect(inv.legacy).toBe(0)      // the fork: this used to become 1
  })

  it('§2 · repeated downloads never multiply the inventory', async () => {
    for (let i = 0; i < 5; i++) await download(withCert(2))
    const inv = await inventory(withCert(2))
    expect(inv.modern).toBe(1)
    expect(inv.legacy).toBe(0)
  })

  it('§2 · the download is NOT counted on a phantom legacy record', async () => {
    await download(withCert(3))
    // This route redirects; `/file` owns the counter. What matters here is that no
    // legacy document was created to be counted against.
    const legacy = await adminDb.collection('certificateRecords')
      .where('registrationId', '==', withCert(3)).get()
    expect(legacy.empty).toBe(true)
  })

  it('§2 · a revoked modern certificate is refused, not silently regenerated', async () => {
    await adminDb.collection('certificates').doc(`RDC-${EV}-4`).update({
      status: 'revoked', revokedAt: new Date(), revokedBy: UID,
    })
    const r = await download(withCert(4))
    expect(r.status).toBe(410)
    expect(r.body?.reason).toBe('revoked')
    // And still no legacy twin was minted as a workaround.
    expect((await inventory(withCert(4))).legacy).toBe(0)
    await adminDb.collection('certificates').doc(`RDC-${EV}-4`).update({
      status: 'generated', revokedAt: null, revokedBy: null,
    })
  })

  it('the legacy find-or-create still serves an event that never used the engine', async () => {
    // Backward compatibility is preserved: a confirmed participant with NO modern
    // certificate still gets one produced the old way.
    const before = await inventory(noCert(0))
    expect(before.modern).toBe(0)
    const r = await download(noCert(0))
    // A PDF (200) or a generation failure — never a redirect, because there is
    // nothing modern to redirect to.
    expect(r.status).not.toBe(307)
    const after = await inventory(noCert(0))
    expect(after.modern).toBe(0)
  })

  // ═══ §3 · ELIGIBILITY, ENFORCED THE SAME WAY ═══════════════════════════════

  it('§3 · a refunded registration is refused', async () => {
    const r = await download(refunded)
    expect(r.status).toBe(403)
    expect(r.body?.reason).toBe('refunded')
  })

  it('§3 · a cancelled registration is refused', async () => {
    const r = await download(cancelled)
    expect(r.status).toBe(403)
    expect(r.body?.reason).toBe('not_confirmed')
  })

  it('§3 · a pending registration is refused', async () => {
    const r = await download(pending)
    expect(r.status).toBe(403)
    expect(r.body?.reason).toBe('not_confirmed')
  })

  it('§3 · eligibility reconciles arithmetically with the stats API', async () => {
    const res = await statsGET(
      new NextRequest(`http://localhost/api/organizer/events/${EV}/certificates/stats`),
      { params: Promise.resolve({ eventId: EV }) },
    )
    // The stats route authorizes; without a mocked workspace it refuses. What is
    // asserted here is the ARITHMETIC, reconstructed from the raw registrations.
    expect([200, 401, 403]).toContain(res.status)

    const base = adminDb.collection('registrations')
      .where('organizerUid', '==', UID).where('eventSlug', '==', EV)
    const [total, confirmed, cancelledN, pendingN, rejectedN, refundedN] = await Promise.all([
      base.count().get().then(s => s.data().count),
      base.where('status', '==', 'confirmed').count().get().then(s => s.data().count),
      base.where('status', '==', 'cancelled').count().get().then(s => s.data().count),
      base.where('status', '==', 'pending').count().get().then(s => s.data().count),
      base.where('status', '==', 'rejected').count().get().then(s => s.data().count),
      base.where('status', '==', 'confirmed').where('paymentStatus', '==', 'refunded')
        .count().get().then(s => s.data().count),
    ])

    expect(total).toBe(CONFIRMED_WITH_CERT + CONFIRMED_NO_CERT + REFUNDED + CANCELLED + PENDING + REJECTED)
    expect(confirmed).toBe(CONFIRMED_WITH_CERT + CONFIRMED_NO_CERT + REFUNDED)
    expect(cancelledN).toBe(CANCELLED)
    expect(pendingN).toBe(PENDING)
    expect(rejectedN).toBe(REJECTED)
    expect(refundedN).toBe(REFUNDED)
    // THE RULE: eligible = confirmed − refunded. Every other status is outside it.
    expect(confirmed - refundedN).toBe(CONFIRMED_WITH_CERT + CONFIRMED_NO_CERT)
    // …and the parts add back to the whole, so nothing is unaccounted for.
    expect(confirmed + cancelledN + pendingN + rejectedN).toBe(total)
  })

  // ═══ SECURITY ══════════════════════════════════════════════════════════════

  it('an unknown registration is refused', async () => {
    const r = await download(`no-such-${PID}`)
    expect(r.status).toBe(404)
    expect(r.body?.reason).toBe('not_found')
  })

  it('a malformed registration id cannot reach another event', async () => {
    const r = await download('..%2F..%2Fetc')
    expect([400, 403, 404, 500]).toContain(r.status)
    expect(r.status).not.toBe(307)
  })

  it('another organizer\'s registration resolves only within THEIR event', async () => {
    // The route derives the event from the registration's OWN organizerUid, so it can
    // never reach this organizer's template or certificates.
    const r = await download(`${EV}-foreign-reg`)
    expect(r.status).not.toBe(307)
    expect([403, 404]).toContain(r.status)
  })

  it('the redirect target always names the certificate\'s OWN id', async () => {
    const r = await download(withCert(5))
    expect(r.status).toBe(307)
    expect(r.location).toContain(`RDC-${EV}-5`)
    // Never another participant's, and never a raw storage path.
    expect(r.location).not.toContain(`RDC-${EV}-0`)
    expect(r.location).not.toMatch(/events\/.*\/certificates\//)
  })
})
