// GET/POST/DELETE /api/events/{slug}/certificates/photo?certificateId=…
//
// RD-CERT-PHOTO-03 — the PUBLIC Certificate Center's photo, and it is TEMPORARY.
//
// ─── Why this no longer touches the registration ─────────────────────────────
// This route used to call setAttendeePhoto(), writing `registration.attendeePhotoKey`
// permanently. That was defensible while a grant required an emailed OTP. It is not
// defensible now: the grant is minted straight after a public lookup, and a lookup only
// proves knowledge of a mobile number. Anyone who knew a family's number could have
// permanently replaced a stranger's stored photo.
//
// So the public flow writes a TEMPORARY object instead, keyed under its own certificate
// (`events/{slug}/certificate-photos-tmp/{certificateId}/{objectId}`), referenced from the
// grant, and gone when the grant expires or is replaced. The authenticated attendee portal
// (/api/attendee/photo) keeps the permanent flow, unchanged — the two are deliberately
// separate and must not be merged.
//
// ─── What the browser may and may not decide ─────────────────────────────────
// It supplies the certificateId (checked against the grant) and the image bytes. It does
// NOT supply registrationId, photoKey, storage path or event scope: registrationId comes
// from the grant, which took it from the certificate record, and the key is built by
// StorageService from server-side values only.

import { NextRequest, NextResponse } from 'next/server'
import { storage, buildObjectKey, generateObjectId } from '@/features/platform-storage'
import {
  verifyCertificatePhotoGrant, setCertificatePhotoGrantKey, clearCertificatePhotoGrantKey,
} from '@/lib/certificates/photoGrant'
import { isValidCertificateId }        from '@/lib/certificates/id'
import { getCertificate }              from '@/lib/certificates/firestore'
import { COLLECTIONS }                 from '@/lib/certificates/constants'
import { adminDb }                     from '@/lib/firebase/admin'
import { FieldValue }                  from 'firebase-admin/firestore'
import { verifyCertificateDownloadCapability } from '@/lib/certificates/downloadCapability'
import { sniffImageMime, ATTENDEE_PHOTO_MAX_BYTES } from '@/lib/registrations/attendeePhoto'
import { getClientIp }              from '@/lib/rateLimit'
import { RATE_POLICY, checkPolicy } from '@/lib/rateLimit/policies'

export const dynamic     = 'force-dynamic'
export const maxDuration = 30

type Params = { params: Promise<{ slug: string }> }

const STATUS: Record<string, number> = {
  unauthorized: 401, forbidden: 403, not_found: 404,
  too_large: 413, unsupported_type: 415, empty: 400,
}
function fail(error: string): NextResponse {
  return NextResponse.json({ error }, { status: STATUS[error] ?? 400 })
}

type RouteContext =
  | { error: NextResponse }
  | {
      error?:         undefined
      /** Present only when a photo GRANT authorised this call — writes require one. */
      token?:         string
      certificateId:  string
      eventSlug:      string
      /** The grant's TEMPORARY photo, when a grant is in play. */
      grantPhotoKey?: string
      /** The PERSISTED photo, read from the certificate record. Never from the request. */
      photoKey?:      string
    }

/**
 * Resolves the grant for every verb below.
 *
 * `slug` comes from the URL and `certificateId` from the query, and BOTH are re-checked
 * against the stored grant — so a grant for one certificate cannot be replayed against
 * another, nor the same certificate reached through a different event's URL.
 */
async function context(req: NextRequest, slug: string, opts: { write: boolean }): Promise<RouteContext> {
  const rl = checkPolicy(getClientIp(req), RATE_POLICY.certificatePhotoWrite)
  if (rl.limited) {
    return { error: NextResponse.json(
      { error: 'Too many requests. Please try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    ) }
  }

  const certificateId = req.nextUrl.searchParams.get('certificateId') ?? ''
  if (!isValidCertificateId(certificateId)) return { error: fail('unauthorized') }

  const token      = req.headers.get('x-certificate-grant') ?? ''
  const capability = req.nextUrl.searchParams.get('token') ?? ''

  // A grant is the WRITE credential. Both verbs re-check the certificate below, so a grant
  // for one certificate can never act on another.
  const grant = token ? await verifyCertificatePhotoGrant(token, certificateId, slug) : null

  // RD-CERT-PHOTO-04 — READ may also present the certificate's download capability.
  //
  // WHY THAT IS ACCEPTABLE HERE: the capability is already HMAC-scoped to
  // eventSlug + certificateId and already authorises downloading THIS certificate's PDF.
  // The photo exists only to personalise that same PDF, so it grants no audience anything
  // it could not already obtain. It is deliberately NOT accepted for writes.
  const viaCapability = !opts.write && !!capability &&
    verifyCertificateDownloadCapability(certificateId, slug, capability)

  if (!grant && !viaCapability) return { error: fail('unauthorized') }

  // The certificate is the ownership boundary — loaded server-side, every time.
  const cert = await getCertificate(certificateId)
  if (!cert || cert.eventSlug !== slug) return { error: fail('unauthorized') }
  if (cert.status === 'revoked' || cert.revokedAt) return { error: fail('forbidden') }

  return {
    ...(grant ? { token } : {}),
    certificateId,
    eventSlug: slug,
    ...(grant?.photoKey ? { grantPhotoKey: grant.photoKey } : {}),
    ...(cert.attendeePhotoKey ? { photoKey: cert.attendeePhotoKey } : {}),
  }
}

/** Writes the persisted key onto the CERTIFICATE — never onto a registration. */
async function setCertificatePhotoKey(certificateId: string, key: string | null): Promise<void> {
  await adminDb.collection(COLLECTIONS.CERTIFICATES).doc(certificateId).update({
    attendeePhotoKey: key === null ? FieldValue.delete() : key,
    updatedAt: FieldValue.serverTimestamp(),
  })
}

/** The PERSISTED certificate photo, as a short-lived signed URL. */
export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { slug } = await params
  const ctx = await context(req, slug, { write: false })
  if (ctx.error) return ctx.error

  // The key comes from the certificate record resolved above — never from the request.
  if (!ctx.photoKey) return NextResponse.json({ hasPhoto: false, url: null })

  try {
    const url = await storage.generateSignedUrl({ path: ctx.photoKey, expiresIn: 300 })
    return NextResponse.json({ hasPhoto: true, url }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    // Reference present, object unreadable — report "no photo" rather than 500ing, exactly
    // as the portal route and certificate rendering both degrade.
    return NextResponse.json({ hasPhoto: false, url: null })
  }
}

/**
 * Upload / replace, then FINALIZE.
 *
 * Ordering is the whole safety story: copy → commit Firestore → only then delete anything.
 * A failure after the copy rolls the new object back and leaves the previous photo and its
 * reference exactly as they were, so Firestore can never point at an object that is gone.
 */
export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { slug } = await params
  const ctx = await context(req, slug, { write: true })
  if (ctx.error) return ctx.error
  if (!ctx.token) return fail('unauthorized')     // a capability may not write

  const declared = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (Number(req.headers.get('content-length') ?? '0') > ATTENDEE_PHOTO_MAX_BYTES) return fail('too_large')

  const bytes = new Uint8Array(await req.arrayBuffer())
  if (bytes.byteLength === 0) return fail('empty')
  if (bytes.byteLength > ATTENDEE_PHOTO_MAX_BYTES) return fail('too_large')

  // The bytes must BE what the request says they are — same check the portal path applies.
  const sniffed = sniffImageMime(bytes)
  if (!sniffed || sniffed !== declared) return fail('unsupported_type')

  // 1. Land it in the temporary namespace first, so a rejected or abandoned upload never
  //    occupies the persistent one.
  const tmp = await storage.upload({
    type: 'event-certificate-photo-tmp',
    eventSlug: slug, scopeId: ctx.certificateId,
    body: bytes, mimeType: sniffed, uploadedBy: `certificate:${ctx.certificateId}`,
  })
  const tmpKey = tmp.metadata.path
  await setCertificatePhotoGrantKey(ctx.token, ctx.certificateId, slug, tmpKey).catch(() => null)

  // 2. Copy into the PERSISTENT, certificate-scoped location.
  const permKey = buildObjectKey({
    type: 'event-certificate-photo', eventSlug: slug,
    scopeId: ctx.certificateId, objectId: generateObjectId(sniffed),
  })
  try {
    await storage.copy(tmpKey, permKey)
  } catch {
    await storage.delete(tmpKey).catch(() => {})
    return fail('upload_failed')
  }

  // 3. Commit the reference. Until this succeeds nothing is deleted.
  const previousKey = ctx.photoKey
  try {
    await setCertificatePhotoKey(ctx.certificateId, permKey)
  } catch {
    // Roll the new object back; the old photo and its reference are untouched.
    await storage.delete(permKey).catch(() => {})
    await storage.delete(tmpKey).catch(() => {})
    return fail('upload_failed')
  }

  // 4. Committed. Cleanup is best-effort from here — a leaked object is recoverable,
  //    a dangling reference is not.
  if (previousKey && previousKey !== permKey) await storage.delete(previousKey).catch(() => {})
  await storage.delete(tmpKey).catch(() => {})
  await clearCertificatePhotoGrantKey(ctx.token, ctx.certificateId, slug).catch(() => null)

  return NextResponse.json({ success: true, hasPhoto: true })
}

/** Remove. Idempotent — removing a photo that is already gone succeeds. */
export async function DELETE(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { slug } = await params
  const ctx = await context(req, slug, { write: true })
  if (ctx.error) return ctx.error
  if (!ctx.token) return fail('unauthorized')

  // Server-side key only — the browser never names what gets deleted.
  const key = ctx.photoKey
  if (key) {
    await setCertificatePhotoKey(ctx.certificateId, null)
    await storage.delete(key).catch(() => { /* orphan; the reference is already gone */ })
  }
  if (ctx.grantPhotoKey) {
    await storage.delete(ctx.grantPhotoKey).catch(() => {})
  }
  await clearCertificatePhotoGrantKey(ctx.token, ctx.certificateId, slug).catch(() => null)

  return NextResponse.json({ success: true, hasPhoto: false })
}
