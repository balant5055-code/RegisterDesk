// POST /api/waitlist/join
//
// Public endpoint — no auth required (same as registration).
// Creates a waitlist entry and fires a confirmation email.
// Validates that the event is full (not just open) before allowing join.

import { NextRequest, NextResponse }  from 'next/server'
import { FieldValue }                  from 'firebase-admin/firestore'
import { adminAuth, adminDb }          from '@/lib/firebase/admin'
import { getEventBySlug }              from '@/lib/firebase/firestore/events'
import { checkRegistrationGate, WAITLIST_ENABLED } from '@/lib/registrations/gate'
import { checkRateLimit, getClientIp } from '@/lib/rateLimit'
import { sendWaitlistJoinedEmail }     from '@/lib/waitlist/sendWaitlistJoinedEmail'
import type { WaitlistDocument }       from '@/lib/waitlist/types'

interface JoinBody {
  slug:    string
  passId:  string
  name:    string
  email:   string
  phone:   string
}

export interface JoinWaitlistResponse {
  success:      boolean
  waitlistId?:  string
  error?:       string
}

function isValidEmail(e: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim())
}

export async function POST(
  req: NextRequest,
): Promise<NextResponse<JoinWaitlistResponse>> {
  // V1: the waitlist is disabled platform-wide (no auto-promotion yet). Refuse
  // new entries defensively even though the gate no longer offers WAITLIST_AVAILABLE.
  if (!WAITLIST_ENABLED) {
    return NextResponse.json(
      { success: false, error: 'The waitlist is not available for this event.' },
      { status: 403 },
    )
  }

  const ip = getClientIp(req)
  const rl = checkRateLimit(ip, 'waitlist-join', 10, 10 * 60 * 1000)
  if (rl.limited) {
    return NextResponse.json(
      { success: false, error: 'Too many requests. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
    )
  }

  // Optional auth — guest waitlist join is supported
  let uid: string | undefined
  const authHeader = req.headers.get('authorization') ?? ''
  const token      = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (token) {
    try { uid = (await adminAuth.verifyIdToken(token)).uid } catch { /* guest */ }
  }

  let body: JoinBody
  try {
    body = (await req.json()) as JoinBody
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 })
  }

  const { slug, passId, name, email, phone } = body
  if (!slug || !passId || !name?.trim() || !email?.trim() || !phone?.trim()) {
    return NextResponse.json(
      { success: false, error: 'slug, passId, name, email, and phone are required' },
      { status: 400 },
    )
  }
  if (!isValidEmail(email)) {
    return NextResponse.json({ success: false, error: 'Invalid email address' }, { status: 400 })
  }

  // Verify the gate returns WAITLIST_AVAILABLE (event must actually be full)
  const gate = await checkRegistrationGate(slug, passId)
  if (gate.allowed) {
    return NextResponse.json(
      { success: false, error: 'Registration is still open. Please register normally.' },
      { status: 400 },
    )
  }
  if (gate.reason !== 'WAITLIST_AVAILABLE') {
    return NextResponse.json(
      { success: false, error: 'Waitlist is not available for this event.' },
      { status: 403 },
    )
  }

  // Load event for metadata
  const event = await getEventBySlug(slug)
  if (!event) {
    return NextResponse.json({ success: false, error: 'Event not found' }, { status: 404 })
  }

  // Check waitlistLimit if set
  const wlLimit = typeof (event as unknown as Record<string, unknown>).waitlistLimit === 'number'
    ? (event as unknown as Record<string, unknown>).waitlistLimit as number
    : null
  if (wlLimit !== null) {
    const countSnap = await adminDb
      .collection('waitlists')
      .where('eventSlug', '==', slug)
      .where('status',    '==', 'waiting')
      .count()
      .get()
    if (countSnap.data().count >= wlLimit) {
      return NextResponse.json(
        { success: false, error: 'The waitlist for this event is full.' },
        { status: 409 },
      )
    }
  }

  // Prevent duplicate waitlist entries for the same email + event
  const dupSnap = await adminDb
    .collection('waitlists')
    .where('eventSlug',       '==', slug)
    .where('attendee.email',  '==', email.trim().toLowerCase())
    .where('status',          'in', ['waiting', 'invited'])
    .limit(1)
    .get()
  if (!dupSnap.empty) {
    return NextResponse.json(
      { success: false, error: 'You are already on the waitlist for this event.' },
      { status: 409 },
    )
  }

  // Resolve pass and event names for denormalization
  const rawDetails  = event.eventDetails as Record<string, unknown>
  const rawInfo     = rawDetails?.info as Record<string, unknown> | null
  const eventName   = typeof rawInfo?.name === 'string' ? rawInfo.name : 'Event'
  const rawPricing  = event.pricing as Record<string, unknown> | null
  const passes      = Array.isArray(rawPricing?.passes)
    ? (rawPricing!.passes as Record<string, unknown>[]) : []
  const pass        = passes.find(p => p.id === passId)
  const passName    = typeof pass?.name === 'string' ? pass.name : 'Pass'

  // Write waitlist entry
  const docRef = adminDb.collection('waitlists').doc()
  const entry: Omit<WaitlistDocument, 'joinedAt' | 'updatedAt'> & {
    joinedAt: unknown; updatedAt: unknown; uid?: string
  } = {
    id:           docRef.id,
    eventSlug:    slug,
    eventName,
    organizerUid: event.uid,
    passId,
    passName,
    attendee: {
      name:  name.trim(),
      email: email.trim().toLowerCase(),
      phone: phone.trim(),
    },
    status:    'waiting',
    joinedAt:  FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    ...(uid ? { uid } : {}),
  }

  await docRef.set(entry)

  // Increment analytics counter (fire-and-forget)
  adminDb.collection('waitlistCounters').doc(slug).set({
    eventSlug:     slug,
    waitlistCount: FieldValue.increment(1),
    promotedCount: FieldValue.increment(0),
    updatedAt:     FieldValue.serverTimestamp(),
  }, { merge: true }).catch(e => console.error('[waitlist] counter increment failed:', e))

  // Send confirmation email (fire-and-forget)
  const baseUrl     = process.env.NEXT_PUBLIC_APP_URL ?? ''
  const eventPageUrl = `${baseUrl}/events/${slug}`
  sendWaitlistJoinedEmail(entry as WaitlistDocument, eventPageUrl)
    .catch(e => console.error('[waitlist] joined email failed:', e))

  return NextResponse.json({ success: true, waitlistId: docRef.id })
}
