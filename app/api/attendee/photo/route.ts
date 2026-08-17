// GET / POST / DELETE /api/attendee/photo
//
// RD-CERT-PHOTO-01 — the attendee's own certificate photo. Ownership is derived from the
// OTP attendee session, exactly as /api/attendee/certificates does; a registration id is
// never treated as a bearer token.
//
// The bytes arrive already cropped, oriented and resized by the browser (~150–400 KB).
// The server re-checks size, allow-listed type, and that the magic bytes agree with the
// declared type before anything is stored.
//
// Deliberately NOT here: certificate generation, delivery, billing, or anything that
// touches certificate IDs. This route owns one key on one registration.

import { NextRequest, NextResponse } from 'next/server'
import { requireAttendee } from '@/lib/attendee/auth'
import type { AttendeeSession } from '@/lib/attendee/auth'
import type { RegistrationDocument } from '@/lib/registrations/types'
import { storage } from '@/features/platform-storage'
import {
  loadOwnedRegistration, setAttendeePhoto, removeAttendeePhoto,
  ATTENDEE_PHOTO_MAX_BYTES,
} from '@/lib/registrations/attendeePhoto'

export const dynamic     = 'force-dynamic'
export const maxDuration = 30

const STATUS: Record<string, number> = {
  unauthorized: 401, forbidden: 403, not_found: 404,
  too_large: 413, unsupported_type: 415, empty: 400,
}

function fail(error: string): NextResponse {
  return NextResponse.json({ error }, { status: STATUS[error] ?? 400 })
}

/** Resolves the session + registration for every verb below. */
type RouteContext =
  | { error: NextResponse }
  | { error?: undefined; session: AttendeeSession; reg: RegistrationDocument; registrationId: string }

async function context(registrationId: string | null): Promise<RouteContext> {
  const session = await requireAttendee()
  if (!session) return { error: fail('unauthorized') }
  if (!registrationId) return { error: NextResponse.json({ error: 'registrationId is required' }, { status: 400 }) }

  const owned = await loadOwnedRegistration(registrationId, session.normalizedEmail)
  if (!owned.ok) return { error: fail(owned.error) }
  return { session, reg: owned.reg, registrationId }
}

/** Short-lived signed URL so the attendee can see their CURRENT photo. Never durable. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const ctx = await context(req.nextUrl.searchParams.get('registrationId'))
  if (ctx.error) return ctx.error

  const key = ctx.reg.attendeePhotoKey
  if (!key) return NextResponse.json({ hasPhoto: false, url: null })

  try {
    const url = await storage.generateSignedUrl({ path: key, expiresIn: 300 })
    return NextResponse.json({ hasPhoto: true, url })
  } catch {
    // The reference exists but the object is unreadable — report "no photo" rather than
    // 500ing the attendee's page. Certificate generation degrades the same way.
    return NextResponse.json({ hasPhoto: false, url: null })
  }
}

/** Upload or replace. Body is the raw image; type comes from Content-Type. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const ctx = await context(req.nextUrl.searchParams.get('registrationId'))
  if (ctx.error) return ctx.error

  const declared = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()

  // Reject on the declared length before reading the body, so an oversized upload costs
  // no bandwidth. The real byte length is re-checked in the service regardless.
  const declaredLength = Number(req.headers.get('content-length') ?? '0')
  if (declaredLength > ATTENDEE_PHOTO_MAX_BYTES) return fail('too_large')

  const bytes = new Uint8Array(await req.arrayBuffer())

  const result = await setAttendeePhoto({
    registrationId: ctx.registrationId,
    reg:            ctx.reg,
    bytes,
    declaredMime:   declared,
    actorEmail:     ctx.session.normalizedEmail,
  })
  if (!result.ok) return fail(result.error)

  return NextResponse.json({ success: true, hasPhoto: true })
}

/** Remove. Idempotent — removing a photo that is already gone succeeds. */
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const ctx = await context(req.nextUrl.searchParams.get('registrationId'))
  if (ctx.error) return ctx.error

  await removeAttendeePhoto({ registrationId: ctx.registrationId, reg: ctx.reg })
  return NextResponse.json({ success: true, hasPhoto: false })
}
