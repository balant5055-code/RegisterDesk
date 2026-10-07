// GET /api/organizer/certificates
//
// Certificates across every event this organizer owns — a bounded ROW page for the
// Communications → Certificates table, plus SERVER-SIDE counts for its three cards.
//
// ═══ RD-CERT-02 · WHAT WAS WRONG ═════════════════════════════════════════════
//
// Two independent defects, compounding:
//
//   1. WRONG COLLECTION. It called `getCertificatesByOrganizerUid`, which reads
//      `certificateRecords` — the legacy MVP collection the engine stopped writing
//      to. Every certificate produced by the organizer flow lives in `certificates`,
//      so the page showed an empty table and "Total Generated 0" on a workspace with
//      thousands of them.
//
//   2. A PAGE PRESENTED AS A TOTAL. That helper caps at 100, and the route returned
//      `total: serialized.length` while the page computed all three cards with
//      `certs.length` / `certs.filter(...).length`. Even against the right collection
//      the cards could never exceed 100.
//
// Rows stay bounded — this is a table. The COUNTS are now `count()` aggregates over
// the whole workspace, so they describe every event regardless of the page size.

import { NextRequest, NextResponse }        from 'next/server'
import { adminDb }                          from '@/lib/firebase/admin'
import { AggregateField }                   from 'firebase-admin/firestore'
import { authorizeWorkspace }               from '@/lib/team/workspace'
import { COLLECTIONS }                      from '@/lib/certificates/constants'
import type { Certificate }                 from '@/lib/certificates/types'

/** Rows returned for the table. A page, and honest about being one. */
const ROW_LIMIT = 100

export interface OrganizerCertificateRow {
  certificateId:  string
  eventId:        string
  eventSlug:      string
  eventName:      string
  attendeeName:   string
  attendeeEmail:  string
  status:         string
  emailStatus:    string | null
  downloadCount:  number
  generatedAt:    string | null
}

export interface OrganizerCertificatesResponse {
  certificates: OrganizerCertificateRow[]
  /**
   * Whether more rows exist beyond this page. The table says so rather than
   * implying it is showing everything.
   */
  hasMore: boolean
  /**
   * Workspace-wide counts. Every figure is `number | null`; null means the
   * aggregate did not run and the card must render "—", never 0.
   */
  counts: {
    /** Every certificate document this organizer owns, in any state. */
    total:      number | null
    /** Produced and still standing: total − revoked − failed. */
    generated:  number | null
    revoked:    number | null
    failed:     number | null
    /** Successfully emailed: emailStatus sent or delivered. */
    emailed:    number | null
    /** Σ downloadCount — download EVENTS, matching the Certificate Overview card. */
    downloads:  number | null
  }
}

function toISO(val: unknown): string | null {
  if (!val) return null
  if (typeof (val as { toDate?: () => Date }).toDate === 'function') {
    return (val as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  // Scope is the authenticated workspace. Nothing here reads an organizer id from
  // the request, so a caller cannot widen the query.
  const base = adminDb.collection(COLLECTIONS.CERTIFICATES).where('organizerUid', '==', uid)

  const count = (q: FirebaseFirestore.Query) =>
    q.count().get().then(s => s.data().count as number).catch(() => null)

  const [snap, total, revoked, failed, sent, delivered, legacyEmailed, downloads] = await Promise.all([
    base.orderBy('generatedAt', 'desc').limit(ROW_LIMIT + 1).get(),
    count(base),
    count(base.where('status', '==', 'revoked')),
    count(base.where('status', '==', 'failed')),
    count(base.where('emailStatus', '==', 'sent')),
    count(base.where('emailStatus', '==', 'delivered')),
    // Legacy-shaped documents carry the delivery state on `status` instead.
    count(base.where('status', '==', 'emailed')),
    base.aggregate({ s: AggregateField.sum('downloadCount') }).get()
      .then(r => (r.data().s ?? 0) as number).catch(() => null),
  ])

  const hasMore = snap.size > ROW_LIMIT
  const docs    = hasMore ? snap.docs.slice(0, ROW_LIMIT) : snap.docs

  const certificates: OrganizerCertificateRow[] = docs.map(d => {
    const c = d.data() as Certificate
    return {
      certificateId: c.certificateId,
      eventId:       c.eventId,
      eventSlug:     c.eventSlug,
      eventName:     c.eventName,
      attendeeName:  c.attendeeName,
      attendeeEmail: c.attendeeEmail,
      status:        c.status,
      emailStatus:   c.emailStatus ?? null,
      downloadCount: typeof c.downloadCount === 'number' ? c.downloadCount : 0,
      generatedAt:   toISO(c.generatedAt),
    }
  })

  // A sum is only meaningful when every part was read; one unread part makes the
  // whole unknown rather than silently smaller.
  const known = (...n: (number | null)[]) => n.every(x => typeof x === 'number')
  const emailed   = known(sent, delivered, legacyEmailed)
    ? (sent as number) + (delivered as number) + (legacyEmailed as number) : null
  const generated = known(total, revoked, failed)
    ? Math.max(0, (total as number) - (revoked as number) - (failed as number)) : null

  return NextResponse.json({
    certificates, hasMore,
    counts: { total, generated, revoked, failed, emailed, downloads },
  } satisfies OrganizerCertificatesResponse)
}
