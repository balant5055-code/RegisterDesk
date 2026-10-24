// GET /api/organizer/events/[eventId]/certificates/stats
//
// Returns certificate generation stats + recent certificate records for the
// organizer's event dashboard.

import { NextRequest, NextResponse }       from 'next/server'
import { adminDb }                         from '@/lib/firebase/admin'
import { AggregateField }                  from 'firebase-admin/firestore'
import { authorizeWorkspace }              from '@/lib/team/workspace'
import type { SerializedCertificateRecord, CertificateRecord } from '@/lib/certificates/types'
import { LEGACY_CERTIFICATE_RECORDS, COLLECTIONS } from '@/lib/certificates/constants'
import { readCertificateCapacity, type CertificateCapacityStatus } from '@/lib/certificates/capacity'

export type { CertificateCapacityStatus }

type Params = { params: Promise<{ eventId: string }> }

export interface CertificateStatsResponse {
  generated:  number
  downloaded: number
  emailed:    number
  pending:    number   // eligible registrations without a certificate
  recent:     SerializedCertificateRecord[]
  /**
   * RD-REPORT-05 · figures from the CURRENT certificate store.
   *
   * ═══ WHY THIS EXISTS ALONGSIDE THE FIELDS ABOVE ═════════════════════════════
   * Everything above is counted from `certificateRecords` — the legacy MVP
   * collection. The certificate engine stopped writing there: `createCertificate`
   * (lib/certificates/firestore) writes to `certificates` and its own comment says
   * "writes ONLY here; the MVP collection is left untouched (no migration)". The one
   * remaining legacy writer is the attendee on-demand download route.
   *
   * So for an event whose certificates were produced by the organizer flow — bulk
   * jobs or the issue route — `generated` above reads 0 and `pending` reads the whole
   * confirmed roster. Reports cannot be built on that.
   *
   * The existing fields are left EXACTLY as they were, values included, so the
   * Certificate workspace is untouched (RD-REPORT-05 §27). These additive figures
   * come from the authoritative store and are what Reports consumes.
   */
  current?: CurrentCertificateStats
  /**
   * RD-CERT-CAPACITY-UX-01 · can a NEW certificate be issued right now? `null` = the ledger could
   * not be read — unknown, never "available". Additive: older clients ignore it.
   */
  certificateCapacity?: CertificateCapacityStatus | null
}

// CertificateCapacityStatus — see lib/certificates/capacity.ts (shared with the bulk-job pre-check).

export interface CurrentCertificateStats {
  /** `certificateTemplates/{eventId}.enabled` — the ONLY applicability source. */
  enabled:   boolean
  /** Certificates that exist for this event, whatever their state. */
  total:     number | null
  /** `status == 'generated'` — produced, and not revoked or failed. */
  generated: number | null
  /**
   * `status == 'emailed'`.
   *
   * ⚠ RD-CERT-01 · this is a LEGACY-SHAPED state and is 0 on modern data. Only
   * `markCertificateEmailed` — the legacy MVP writer — ever sets it. The modern send
   * path (`recordCertificateEmail`) updates `emailStatus` and `emailedAt` and leaves
   * `status` alone, so a modern emailed certificate stays `generated`.
   *
   * Kept for events that still carry legacy-shaped documents. `emailedSent` below is
   * the figure to display.
   */
  emailed:   number | null
  /**
   * RD-CERT-01 · the AUTHORITATIVE "this certificate was emailed" signal:
   * `emailStatus == 'sent'`, plus `'delivered'` counted separately.
   *
   * `restoreCertificate` treats sent OR delivered as "had been emailed", so both are
   * successful delivery and the display adds them. Attempts, queue rows and
   * `emailHistory` entries are deliberately NOT counted — a history entry records that
   * a send was tried, not that it succeeded.
   */
  emailedSent:      number | null
  emailedDelivered: number | null
  revoked:   number | null
  failed:    number | null
  /**
   * RD-CERT-01 · Σ `downloadCount` — total download EVENTS, which is what the
   * Certificate Overview's "Downloads" card has always meant.
   *
   * Deliberately a SUM, not a count of distinct certificates: changing it to the
   * latter would silently redefine a number an organizer already reads. It is also a
   * `sum()` over equality-only filters, so unlike the `downloadCount > 0` count below
   * it needs NO composite index.
   */
  downloadsTotal: number | null
  /**
   * RD-CERT-02 · certificates with NO persisted R2 artifact (`fileKey == null`).
   *
   * ═══ THIS NEVER CHANGES THE TOTAL ═══════════════════════════════════════════
   * Firestore is the certificate inventory; R2 holds the files. A certificate whose
   * object is absent is still a certificate, so it stays in `total` and in
   * `generated`, and this reports the gap alongside them. Nothing here lists or
   * counts R2 objects — a report must never depend on scanning object storage.
   *
   * ⚠ `fileKey == null` is not automatically a fault: legacy and MVP-era records
   * never had one and remain downloadable through the on-demand render fallback. It
   * is a HEALTH SIGNAL, which is why it is reported separately and never subtracted.
   *
   * A certificate whose `fileKey` points at another event or organizer is NOT
   * counted here because it cannot occur: the key is built server-side by
   * `certificateObjectKey(eventSlug, certificateId)` and is never accepted from a
   * client. That guarantee is tested rather than assumed.
   */
  withoutArtifact: number | null
  /**
   * Certificates downloaded at least once. `downloadCount > 0` is a RANGE filter and
   * needs its own composite index; until that index exists this stays NULL and the
   * client renders "—". It is never reported as 0.
   */
  downloaded: number | null
  /** Confirmed registrations, minus those whose payment was refunded. See below. */
  eligible:  number | null
  /** Confirmed registrations whose payment was refunded — excluded from `eligible`. */
  refunded:  number | null
}

function toISO(val: unknown): string | null {
  if (!val) return null
  if (typeof (val as { toDate?: () => Date }).toDate === 'function') {
    return (val as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const { eventId } = await params

  // Verify ownership
  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) {
    return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  }

  const draft    = draftSnap.data() as Record<string, unknown>
  const details  = (draft.eventDetails  as Record<string, unknown>) ?? {}
  const seo      = (details.seo         as Record<string, unknown>) ?? {}
  const slug     = typeof seo.urlSlug === 'string' ? seo.urlSlug : null

  // RD-CERT-SCALE P2-3 — BOUNDED.
  //
  // This used to load EVERY certificateRecord for the event with an unbounded .get(), then
  // compute three numbers with .filter().length and discard the rest. At 10k that is 10,000
  // document reads to render four counters and twenty rows.
  //
  // Now: three count() aggregates (which transfer ZERO documents) plus one limit(20) query.
  // Cost is flat in the number of certificates. Same numbers, same rows, same order.
  const base = adminDb.collection(LEGACY_CERTIFICATE_RECORDS)
    .where('organizerUid', '==', uid)
    .where('eventId',      '==', eventId)

  const [generatedAgg, downloadedAgg, emailedAgg, recentSnap] = await Promise.all([
    base.count().get(),
    // `> 0` is a RANGE filter, so downloadCount must be the last field in its index.
    base.where('downloadCount', '>', 0).count().get(),
    base.where('emailStatus', '==', 'sent').count().get(),
    // Newest first — the sort key is issuedAt (CertificateRecord has no createdAt).
    base.orderBy('issuedAt', 'desc').limit(20).get(),
  ])

  const generated  = generatedAgg.data().count
  const downloaded = downloadedAgg.data().count
  const emailed    = emailedAgg.data().count

  // Compute pending: eligible registrations without certificates.
  // GA-7C P1-3: derive from a COUNT aggregation (no document reads) instead of the
  // former O(attendees) full scan of confirmed registrations — pending = confirmed −
  // generated, the standard scalable form for this KPI.
  let pending = 0
  if (slug) {
    const confirmedSnap = await adminDb
      .collection('registrations')
      .where('organizerUid', '==', uid)
      .where('eventSlug',    '==', slug)
      .where('status',       '==', 'confirmed')
      .count().get()
    pending = Math.max(0, confirmedSnap.data().count - generated)
  }

  // Ordered by Firestore, not in memory — these 20 are the only documents read.
  const recent: SerializedCertificateRecord[] = recentSnap.docs.map(d => {
    const r = d.data() as CertificateRecord
    return {
      ...r,
      issuedAt:  toISO(r.issuedAt)  ?? new Date().toISOString(),
      emailedAt: toISO(r.emailedAt) ?? null,
    }
  })

  // ═══ RD-REPORT-05 · the CURRENT store ══════════════════════════════════════
  //
  // Applicability is the stored template flag and nothing else — never inferred from
  // the existence of a certificate, a participant state or the event type.
  //
  // ELIGIBILITY is the rule the engine actually enforces, and it takes two checks:
  //   • every generation path (bulk jobs, the issue route) requires status
  //     `confirmed`, and
  //   • `assertRegistrationEligibleForCertificate` additionally refuses a REFUNDED
  //     payment — a refund leaves `status` as 'confirmed', so it has to be excluded
  //     separately or the eligible population is overstated.
  // Both counts come from the same population, so the subtraction is sound.
  //
  // Every certificate filter is equality-only on (eventId, organizerUid, …), served
  // by the existing composite plus index merging. The one exception is `downloadCount
  // > 0`, a range filter with no matching index on this collection — it is attempted
  // and falls back to NULL rather than failing the whole request.
  const count = (q: FirebaseFirestore.Query) =>
    q.count().get().then(s => s.data().count as number).catch(() => null)

  const certs = adminDb.collection(COLLECTIONS.CERTIFICATES)
    .where('eventId',      '==', eventId)
    .where('organizerUid', '==', uid)
  const roster = slug
    ? adminDb.collection('registrations')
        .where('organizerUid', '==', uid)
        .where('eventSlug',    '==', slug)
        .where('status',       '==', 'confirmed')
    : null

  // Σ downloadCount. Equality-only filters, so no composite index is involved.
  const sumDownloads = certs
    .aggregate({ s: AggregateField.sum('downloadCount') }).get()
    .then(r => (r.data().s ?? 0) as number)
    .catch(() => null)

  const [
    tplSnap, cTotal, cGenerated, cEmailed, cSent, cDelivered, cRevoked, cFailed,
    cDownloaded, cDownloadsTotal, cNoArtifact, rConfirmed, rRefunded,
  ] = await Promise.all([
      adminDb.collection('certificateTemplates').doc(eventId).get().catch(() => null),
      count(certs),
      count(certs.where('status', '==', 'generated')),
      count(certs.where('status', '==', 'emailed')),
      count(certs.where('emailStatus', '==', 'sent')),
      count(certs.where('emailStatus', '==', 'delivered')),
      count(certs.where('status', '==', 'revoked')),
      count(certs.where('status', '==', 'failed')),
      count(certs.where('downloadCount', '>', 0)),
      sumDownloads,
      // RD-CERT-02 · R2 health, from metadata alone. Equality on null: no index, and
      // no call to object storage.
      count(certs.where('fileKey', '==', null)),
      roster ? count(roster) : Promise.resolve(null),
      roster ? count(roster.where('paymentStatus', '==', 'refunded')) : Promise.resolve(null),
    ])

  const eligible = rConfirmed === null || rRefunded === null ? null : rConfirmed - rRefunded

  const current: CurrentCertificateStats = {
    enabled: (tplSnap?.exists && (tplSnap.data() as { enabled?: unknown } | undefined)?.enabled === true) || false,
    total: cTotal, generated: cGenerated, emailed: cEmailed,
    emailedSent: cSent, emailedDelivered: cDelivered,
    revoked: cRevoked, failed: cFailed,
    downloaded: cDownloaded, downloadsTotal: cDownloadsTotal,
    withoutArtifact: cNoArtifact,
    eligible, refunded: rRefunded,
  }

  // RD-CERT-CAPACITY-UX-01 — the ledger is keyed by this draft id (the caller's own, proven above).
  const certificateCapacity: CertificateCapacityStatus | null = await readCertificateCapacity(eventId).catch(() => null)

  return NextResponse.json({
    generated, downloaded, emailed, pending, recent, current, certificateCapacity,
  } satisfies CertificateStatsResponse)
}
