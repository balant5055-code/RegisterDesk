// RD-CERT-02 · certificate counting at PRODUCTION SCALE — REAL Firestore (emulator).
//
// ═══ WHY 2,395 AND NOT 200 ═══════════════════════════════════════════════════
//
// Every certificate counting defect found so far had the same shape: a paginated
// array treated as a complete dataset. Those bugs are INVISIBLE below the page size,
// so a fixture of 200 cannot catch them. This one deliberately exceeds:
//
//     the event page      /certificates/records   default 200
//     the workspace page  /organizer/certificates        100
//
// It also seeds a CONFLICTING legacy `certificateRecords` set. If any surface still
// reads the legacy collection it produces a visibly wrong number rather than a
// coincidentally right one.
//
// ═══ R2 ══════════════════════════════════════════════════════════════════════
// Firestore is the certificate inventory; R2 holds the files. A certificate whose
// artifact is absent is still a certificate — the total must not move. Nothing here
// lists or counts R2 objects, and no storage call is made.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const PID  = process.pid
const UID  = `cs02-org-${PID}`
const EV   = `cs02-event-${PID}`
const OTHER = `cs02-other-${PID}`

/** Above BOTH page sizes, and not a round number. */
const TOTAL     = 2395
const REVOKED   = 40
const FAILED    = 25
const STANDING  = TOTAL - REVOKED - FAILED        // 2,330
const SENT      = 1900
const DELIVERED = 120
const EMAILED   = SENT + DELIVERED                // 2,020
const REGENERATED = 310
/** Certificates with NO R2 artifact. Must NOT reduce the total. */
const NO_ARTIFACT = 5
/** A different number, so a legacy read is unmistakable. */
const LEGACY_CONFLICT = 777

vi.mock('@/lib/team/workspace', () => ({
  authorizeWorkspace: async () => ({
    ok: true, status: 200, error: '', workspaceUid: UID, callerUid: UID,
    role: 'owner', permissions: ['certificates', 'events'],
  }),
  authorizeWorkspaceDownload: async () => ({
    ok: true, status: 200, error: '', workspaceUid: UID, callerUid: UID,
    role: 'owner', permissions: ['certificates', 'events'],
  }),
}))

describeEmu('RD-CERT-02 · certificate counting at 2,395', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let statsGET: (req: NextRequest, ctx: { params: Promise<{ eventId: string }> }) => Promise<Response>
  let orgGET:   (req: NextRequest) => Promise<Response>
  let signalsGET: (req: NextRequest, ctx: { params: Promise<{ eventId: string }> }) => Promise<Response>
  let buildCertificateOverview: typeof import('@/lib/certificates/report').buildCertificateOverview
  let buildCertificateReport:   typeof import('@/lib/certificates/report').buildCertificateReport
  let cellText: typeof import('@/lib/certificates/report').cellText

  const certIds: string[] = []
  const regIds:  string[] = []
  const legacyIds: string[] = []

  let downloadEvents = 0
  let downloadedCerts = 0

  const stats = async (eventId = EV) => {
    const res = await statsGET(
      new NextRequest(`http://localhost/api/organizer/events/${eventId}/certificates/stats`),
      { params: Promise.resolve({ eventId }) },
    )
    return { status: res.status, body: await res.json() as Record<string, never> }
  }
  const orgWide = async () => {
    const res = await orgGET(new NextRequest('http://localhost/api/organizer/certificates'))
    return { status: res.status, body: await res.json() as Record<string, never> }
  }
  const signals = async (eventId = EV) => {
    const res = await signalsGET(
      new NextRequest(`http://localhost/api/organizer/events/${eventId}/setup-signals`),
      { params: Promise.resolve({ eventId }) },
    )
    return { status: res.status, body: await res.json() as Record<string, never> }
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) {
      throw new Error('Refusing to run outside a demo- project.')
    }
    ;({ adminDb }    = await import('@/lib/firebase/admin'))
    ;({ GET: statsGET }   = await import('@/app/api/organizer/events/[eventId]/certificates/stats/route'))
    ;({ GET: orgGET }     = await import('@/app/api/organizer/certificates/route'))
    ;({ GET: signalsGET } = await import('@/app/api/organizer/events/[eventId]/setup-signals/route'))
    ;({ buildCertificateOverview, buildCertificateReport, cellText } =
      await import('@/lib/certificates/report'))

    await Promise.all([
      adminDb.doc(`users/${UID}/eventDrafts/${EV}`).set({
        eventDetails: { seo: { urlSlug: EV }, info: { name: 'Scale Event' } },
        pricing: { passes: [{ id: 'p5', name: '5 KM', price: 1000 }] },
        status: 'published', lifecycleStatus: 'published',
      }),
      adminDb.doc(`users/${OTHER}/eventDrafts/${EV}-foreign`).set({
        eventDetails: { seo: { urlSlug: `${EV}-foreign` }, info: { name: 'Foreign' } },
        status: 'published', lifecycleStatus: 'published',
      }),
      adminDb.doc(`certificateTemplates/${EV}`).set({ eventId: EV, enabled: true, title: 'C' }),
      // RD-CE-FIX C1 — the live documents as publish writes them (owner + draft stamps).
      adminDb.doc(`events/${EV}`).set({ lifecycleStatus: 'published', uid: UID, draftId: EV }),
      adminDb.doc(`events/${EV}-foreign`).set({ lifecycleStatus: 'published', uid: OTHER, draftId: `${EV}-foreign` }),
    ])

    const rows: [FirebaseFirestore.DocumentReference, Record<string, unknown>][] = []

    for (let i = 0; i < TOTAL; i++) {
      const regId = `${EV}-reg-${i}`
      regIds.push(regId)
      rows.push([adminDb.collection('registrations').doc(regId), {
        organizerUid: UID, eventSlug: EV, status: 'confirmed', paymentStatus: 'paid',
        passId: 'p5', attendee: { name: `P${i}`, email: `p${i}@test.local` },
        registeredAt: new Date(),
      }])

      const id = `RDC-${EV}-${i}`
      certIds.push(id)
      const status = i < STANDING ? 'generated' : i < STANDING + REVOKED ? 'revoked' : 'failed'
      const emailStatus = i < SENT ? 'sent' : i < SENT + DELIVERED ? 'delivered' : null
      // Every 3rd downloaded; every 10th three times, so Σ ≠ COUNT(>0).
      const downloadCount = i % 3 === 0 ? (i % 10 === 0 ? 3 : 1) : 0
      downloadEvents += downloadCount
      if (downloadCount > 0) downloadedCerts++
      const hasArtifact = status !== 'failed' && i >= NO_ARTIFACT

      rows.push([adminDb.collection('certificates').doc(id), {
        certificateId: id, eventId: EV, eventSlug: EV, organizerUid: UID,
        registrationId: regId, attendeeName: `P${i}`, attendeeEmail: `p${i}@test.local`,
        eventName: 'Scale Event', eventDate: '1 Dec 2026', certificateType: 'participation',
        templateId: null, fileUrl: null,
        fileKey: hasArtifact ? `events/${EV}/certificates/${id}.pdf` : null,
        fileSize: hasArtifact ? 1024 : null,
        status, source: 'bulk', data: {}, downloadCount,
        lastDownloadedAt: downloadCount ? new Date() : null,
        emailStatus, emailHistory: [], generatedAt: new Date(Date.now() - i * 1000),
        emailedAt: emailStatus ? new Date() : null,
        revokedAt: status === 'revoked' ? new Date() : null,
        revokedBy: null, revokeReason: null, revocationHistory: [], jobId: null, schemaVersion: 2,
        ...(i < REGENERATED ? { regeneratedAt: new Date(), regenerationCount: 2 } : {}),
      }])
    }

    // Conflicting legacy rows — a different count, on the same event.
    for (let i = 0; i < LEGACY_CONFLICT; i++) {
      const id = `LEG-${EV}-${i}`
      legacyIds.push(id)
      rows.push([adminDb.collection('certificateRecords').doc(id), {
        certificateId: id, eventId: EV, eventSlug: EV, organizerUid: UID,
        registrationId: `${EV}-reg-0`, attendeeName: `L${i}`, attendeeEmail: `l${i}@test.local`,
        eventName: 'Scale Event', eventDate: '1 Dec 2026',
        issuedAt: new Date(), status: 'generated', downloadCount: 9, emailStatus: 'sent',
      }])
    }

    // Another organizer's certificates, on their own event.
    for (let i = 0; i < 13; i++) {
      const id = `RDC-${EV}-foreign-${i}`
      certIds.push(id)
      rows.push([adminDb.collection('certificates').doc(id), {
        certificateId: id, eventId: `${EV}-foreign`, eventSlug: `${EV}-foreign`,
        organizerUid: OTHER, registrationId: 'x', attendeeName: 'F', attendeeEmail: 'f@test.local',
        eventName: 'Foreign', eventDate: '1 Dec 2026', certificateType: 'participation',
        templateId: null, fileUrl: null, fileKey: null, fileSize: null,
        status: 'generated', source: 'bulk', data: {}, downloadCount: 5,
        lastDownloadedAt: null, emailStatus: 'sent', emailHistory: [],
        generatedAt: new Date(), emailedAt: new Date(), revokedAt: null, revokedBy: null,
        revokeReason: null, revocationHistory: [], jobId: null, schemaVersion: 2,
      }])
    }

    for (let i = 0; i < rows.length; i += 400) {
      const b = adminDb.batch()
      rows.slice(i, i + 400).forEach(([ref, d]) => b.set(ref, d))
      await b.commit()
    }
  }, 600_000)

  afterAll(async () => {
    const del = async (coll: string, list: string[]) => {
      for (let i = 0; i < list.length; i += 400) {
        const b = adminDb.batch()
        list.slice(i, i + 400).forEach(id => b.delete(adminDb.collection(coll).doc(id)))
        await b.commit()
      }
    }
    await del('certificates', certIds)
    await del('registrations', regIds)
    await del('certificateRecords', legacyIds)
    await Promise.all([
      adminDb.doc(`certificateTemplates/${EV}`).delete(),
      adminDb.doc(`users/${UID}/eventDrafts/${EV}`).delete(),
      adminDb.doc(`users/${OTHER}/eventDrafts/${EV}-foreign`).delete(),
      adminDb.doc(`events/${EV}`).delete(),
      adminDb.doc(`events/${EV}-foreign`).delete(),
    ])
  }, 600_000)

  // ═══ §29 · THE REGRESSION ══════════════════════════════════════════════════

  it('§29 · Total is 2,395 — not the 200-row page size', async () => {
    const { body } = await stats()
    const c = body.current as unknown as { total: number }
    expect(c.total).toBe(TOTAL)
    expect(c.total).not.toBe(200)
    expect(TOTAL).toBeGreaterThan(200)
  })

  it('§29 · conflicting legacy rows do not alter the modern result', async () => {
    const { body } = await stats()
    // The legacy field counts the conflicting set, proving it is populated…
    expect(body.generated as unknown as number).toBe(LEGACY_CONFLICT)
    // …and the authoritative figures are untouched by it.
    const c = body.current as unknown as { total: number; generated: number }
    expect(c.total).toBe(TOTAL)
    expect(c.generated).toBe(STANDING)
  })

  it('§29 · the workspace-wide page reports counts, not its 100 rows', async () => {
    const { body } = await orgWide()
    const counts = body.counts as unknown as { total: number; generated: number; emailed: number; downloads: number }
    const rows = body.certificates as unknown as unknown[]
    expect(rows).toHaveLength(100)
    expect(body.hasMore as unknown as boolean).toBe(true)
    expect(counts.total).toBe(TOTAL)
    expect(counts.generated).toBe(STANDING)
    expect(counts.emailed).toBe(EMAILED)
    expect(counts.downloads).toBe(downloadEvents)
  })

  // ═══ §30 · R2 INTEGRITY MUST NOT MOVE THE TOTAL ════════════════════════════

  it('§30 · a missing artifact is reported, and the total stays 2,395', async () => {
    const { body } = await stats()
    const c = body.current as unknown as { total: number; withoutArtifact: number; generated: number }
    // 5 deliberate + 25 failed (which never produce one).
    expect(c.withoutArtifact).toBe(NO_ARTIFACT + FAILED)
    // THE POINT: the inventory is Firestore. R2 health never subtracts from it.
    expect(c.total).toBe(TOTAL)
    expect(c.generated).toBe(STANDING)
  })

  it('§30 · certificates WITH an artifact carry their own event\'s key', async () => {
    // A key pointing at another event cannot occur: it is built server-side from
    // (eventSlug, certificateId) and never accepted from a client.
    const snap = await adminDb.collection('certificates')
      .where('eventId', '==', EV).where('status', '==', 'generated').limit(200).get()
    const withKey = snap.docs.filter(d => typeof d.data().fileKey === 'string')
    expect(withKey.length).toBeGreaterThan(0)
    expect(withKey.every(d => (d.data().fileKey as string).startsWith(`events/${EV}/certificates/`))).toBe(true)
    expect(withKey.every(d => (d.data().fileKey as string).includes(d.id))).toBe(true)
  })

  // ═══ §6 · RECONCILIATION ═══════════════════════════════════════════════════

  it('§6 · every metric reconciles with the seeded truth', async () => {
    const { body } = await stats()
    const c = body.current as unknown as Record<string, number>
    expect(c.total).toBe(TOTAL)
    expect(c.generated).toBe(STANDING)
    expect(c.revoked).toBe(REVOKED)
    expect(c.failed).toBe(FAILED)
    expect(c.emailedSent).toBe(SENT)
    expect(c.emailedDelivered).toBe(DELIVERED)
    expect(c.emailed).toBe(0)                       // legacy-shaped status, none here
    expect(c.downloadsTotal).toBe(downloadEvents)
    expect(c.downloaded).toBe(downloadedCerts)
    expect(c.downloadsTotal).not.toBe(c.downloaded) // events ≠ certificates
  })

  it('§6 · Overview and Reports agree, from the one payload', async () => {
    const { body } = await stats()
    const ov = buildCertificateOverview(body.current as never)
    const rp = buildCertificateReport(body.current as never)
    if (!rp.applicable) throw new Error('expected applicable')
    expect(cellText(ov.total)).toBe(TOTAL.toLocaleString('en-IN'))
    expect(cellText(ov.generated)).toBe(STANDING.toLocaleString('en-IN'))
    expect(cellText(ov.emailed)).toBe(EMAILED.toLocaleString('en-IN'))
    expect(cellText(rp.issuedTotal)).toBe(cellText(ov.generated))
    expect(cellText(rp.emailed)).toBe(cellText(ov.emailed))
    expect(cellText(rp.revoked)).toBe(cellText(ov.revoked))
  })

  it('§21 · the setup signal reads the modern store, not the legacy one', async () => {
    const { body } = await signals()
    const cert = body.certificates as unknown as { generated: number; pending: number }
    expect(cert.generated).toBe(TOTAL)
    expect(cert.generated).not.toBe(LEGACY_CONFLICT)
  })

  // ═══ §4 / §9 · REGENERATION AND STATE ══════════════════════════════════════

  it('§4 · regeneration is in place — 310 regenerated, still 2,395 documents', async () => {
    const snap = await adminDb.collection('certificates').where('eventId', '==', EV).count().get()
    expect(snap.data().count).toBe(TOTAL)
    const regen = await adminDb.collection('certificates')
      .where('eventId', '==', EV).where('regenerationCount', '==', 2).count().get()
    expect(regen.data().count).toBe(REGENERATED)
  })

  it('§9 · failed and revoked are documents but not standing certificates', async () => {
    const { body } = await stats()
    const c = body.current as unknown as Record<string, number>
    expect(c.total).toBe(c.generated + c.revoked + c.failed)
  })

  it('one participant holds at most one certificate', async () => {
    const snap = await adminDb.collection('certificates')
      .where('eventId', '==', EV).select('registrationId').get()
    const ids = snap.docs.map(d => d.data().registrationId as string)
    expect(new Set(ids).size).toBe(ids.length)
  })

  // ═══ §22 · ISOLATION ═══════════════════════════════════════════════════════

  it('another organizer\'s certificates are in no figure', async () => {
    const { body } = await stats()
    const c = body.current as unknown as { total: number }
    expect(c.total).toBe(TOTAL)          // the 13 foreign certificates are excluded
    const { body: org } = await orgWide()
    expect((org.counts as unknown as { total: number }).total).toBe(TOTAL)
  })

  it('a foreign or unknown event is refused', async () => {
    expect((await stats(`${EV}-foreign`)).status).toBe(404)
    expect((await stats(`no-such-${PID}`)).status).toBe(404)
    expect((await signals(`no-such-${PID}`)).status).toBe(404)
  })

  // ═══ §23 · SCALE ═══════════════════════════════════════════════════════════

  it('the aggregate payloads carry no certificate documents', async () => {
    const { body } = await stats()
    // `recent` is the pre-existing bounded legacy preview, capped at 20.
    expect((body.recent as unknown as unknown[]).length).toBeLessThanOrEqual(20)
    expect(body.current).not.toHaveProperty('items')
    const { body: org } = await orgWide()
    // A table page, and it says so.
    expect((org.certificates as unknown as unknown[]).length).toBe(100)
    expect(org.hasMore as unknown as boolean).toBe(true)
  })
})
