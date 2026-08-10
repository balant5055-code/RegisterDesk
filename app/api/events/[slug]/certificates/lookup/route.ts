// POST /api/events/[slug]/certificates/lookup
//
// PUBLIC endpoint behind the event-day QR poster. An attendee identifies themselves with
// a registration id OR an email and receives the certificates for THAT EVENT only.
//
// ═══ EVENT SCOPING ═══════════════════════════════════════════════════════════
// The slug comes from the URL and is applied to every query as an equality filter. A
// family email used at three different events returns only the certificates belonging to
// the event whose QR was scanned. There is no code path that queries certificates without
// the eventSlug filter.
//
// ═══ WHAT IS RETURNED ════════════════════════════════════════════════════════
// A deliberately tiny projection: participant name, certificate id, event name, status,
// and a freshly minted short-lived download capability. The stored `verificationToken` —
// a PERMANENT credential — is never returned, because the identifiers accepted here are
// guessable and would otherwise trade a guess for indefinite access. Email, phone,
// organizerUid, registrationId, payment fields and the raw document never leave the server.
//
// ═══ ENUMERATION ═════════════════════════════════════════════════════════════
// Every miss returns the SAME empty payload. "No certificate for this email", "that email
// belongs to another event", "the certificate exists but is revoked" and "no such
// registration id" are indistinguishable to the caller. Rate limiting bounds the guess
// rate; the uniform response is what makes the guesses worthless.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { COLLECTIONS }               from '@/lib/certificates/constants'
import { signCertificateDownloadCapability } from '@/lib/certificates/downloadCapability'
import { getClientIp }               from '@/lib/rateLimit'
import { RATE_POLICY, checkPolicy }  from '@/lib/rateLimit/policies'
import type { Certificate }          from '@/lib/certificates/types'

export const dynamic = 'force-dynamic'

/** Cap on returned rows. A family is a handful; anything larger is not a real lookup. */
const MAX_RESULTS = 25

type Params = { params: Promise<{ slug: string }> }

export interface CertificateLookupResult {
  participantName:    string
  certificateId:      string
  eventName:          string
  status:             string
  /** Short-lived, certificate-scoped. NOT the permanent verificationToken. */
  downloadCapability: string
}

export interface CertificateLookupResponse {
  results: CertificateLookupResult[]
}

/** The one shape every miss returns — see the enumeration note above. */
const EMPTY: CertificateLookupResponse = { results: [] }

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const rl = checkPolicy(getClientIp(req), RATE_POLICY.certificateLookup)
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many lookups. Please wait a moment and try again.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    )
  }

  const { slug } = await params
  if (!slug) return NextResponse.json(EMPTY)

  let body: { email?: unknown; registrationId?: unknown }
  try { body = await req.json() as typeof body }
  catch { return NextResponse.json({ error: 'Invalid request.' }, { status: 400 }) }

  const email          = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const registrationId = typeof body.registrationId === 'string' ? body.registrationId.trim() : ''

  // Exactly one mode. Accepting both would mean an implicit OR whose result set is harder
  // to reason about than the sum of its parts — and easy to get subtly wrong.
  if ((!email && !registrationId) || (email && registrationId)) {
    return NextResponse.json(
      { error: 'Enter either a registration ID or an email address.' },
      { status: 400 },
    )
  }
  // Cheap shape check only. An invalid-looking value falls through to the uniform empty
  // response rather than a distinct error, so probing cannot use validation as an oracle.
  if (email && (!email.includes('@') || email.length > 254)) return NextResponse.json(EMPTY)
  if (registrationId && registrationId.length > 128)         return NextResponse.json(EMPTY)

  // Indexed, event-scoped equality queries — never a scan.
  //   certificates: eventSlug + attendeeEmail
  //   certificates: eventSlug + registrationId
  let snap: FirebaseFirestore.QuerySnapshot
  try {
    const base = adminDb.collection(COLLECTIONS.CERTIFICATES).where('eventSlug', '==', slug)
    snap = await (email
      ? base.where('attendeeEmail', '==', email)
      : base.where('registrationId', '==', registrationId)
    ).limit(MAX_RESULTS).get()
  } catch (err) {
    // Never surface a Firestore error; a missing index must not become an oracle either.
    console.error('[certificate-lookup] query_failed', {
      slug, mode: email ? 'email' : 'registrationId',
      name: err instanceof Error ? err.name : 'unknown',
    })
    return NextResponse.json({ error: 'Lookup is temporarily unavailable.' }, { status: 503 })
  }

  const results: CertificateLookupResult[] = []
  for (const doc of snap.docs) {
    const c = doc.data() as Certificate
    // Revoked certificates are omitted entirely — and omitted the same way a non-existent
    // one is, so the response cannot confirm that a revoked certificate ever existed.
    if (c.status === 'revoked' || c.revokedAt) continue
    if (!c.certificateId) continue

    results.push({
      participantName:    c.attendeeName ?? '',
      certificateId:      c.certificateId,
      eventName:          c.eventName ?? '',
      status:             c.status ?? 'issued',
      downloadCapability: signCertificateDownloadCapability(c.certificateId, slug),
    })
  }

  // Stable order so a family sees the same sequence on every search.
  results.sort((a, b) => a.participantName.localeCompare(b.participantName))

  return NextResponse.json({ results } satisfies CertificateLookupResponse, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
