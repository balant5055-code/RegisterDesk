// POST /api/events/[slug]/apply/speaker
// Public — no auth required. Submits a speaker application for an event.

import { NextRequest, NextResponse } from 'next/server'
import { FieldValue }                from 'firebase-admin/firestore'
import { adminDb }                   from '@/lib/firebase/admin'
import { getEventBySlug }            from '@/lib/firebase/firestore/events'
import { canExposePublicEvent }      from '@/lib/events/publicVisibility'
import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
import { checkPolicy, RATE_POLICY } from '@/lib/rateLimit/policies'
import { getClientIp } from '@/lib/rateLimit'
import type { SpeakerApplicationInput } from '@/lib/applications/types'

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://registerdesk.in'

// Per-field length caps — a public form must never write a near-1 MB document.
const SHORT = 200, LONG = 5000, URL_MAX = 500

type Ctx = { params: Promise<{ slug: string }> }

export async function POST(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const { slug } = await params

  // Public spam / amplification guard (per client IP) — reuses the shared policy.
  const rl = checkPolicy(getClientIp(req), RATE_POLICY.publicApplication)
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many applications. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    )
  }

  // ── Load event ──────────────────────────────────────────────────────────────
  const event = await getEventBySlug(slug)
  if (!event) return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  if (!canExposePublicEvent(event.lifecycleStatus)) {
    return NextResponse.json({ error: 'Event not available' }, { status: 404 })
  }

  // ── Check applications enabled ──────────────────────────────────────────────
  const ed           = event.eventDetails as Record<string, unknown> | null
  const applications = ed?.applications as Record<string, unknown> | null
  const speakerCfg   = applications?.speaker as Record<string, unknown> | null
  if (speakerCfg?.enabled !== true) {
    return NextResponse.json({ error: 'Speaker applications are not open for this event' }, { status: 400 })
  }

  const closingDate = typeof speakerCfg.closingDate === 'string' ? speakerCfg.closingDate : ''
  if (closingDate) {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
    if (today > closingDate) {
      return NextResponse.json({ error: 'Speaker applications have closed for this event' }, { status: 400 })
    }
  }

  // ── Parse + validate body ───────────────────────────────────────────────────
  let body: Record<string, unknown>
  try { body = await req.json() as Record<string, unknown> }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const name         = String(body.name         ?? '').trim().slice(0, SHORT)
  const email        = String(body.email        ?? '').trim().toLowerCase().slice(0, SHORT)
  const phone        = String(body.phone        ?? '').trim().slice(0, SHORT)
  const jobTitle     = String(body.jobTitle     ?? '').trim().slice(0, SHORT)
  const company      = String(body.company      ?? '').trim().slice(0, SHORT)
  const bio          = String(body.bio          ?? '').trim().slice(0, LONG)
  const talkTitle    = String(body.talkTitle    ?? '').trim().slice(0, SHORT)
  const talkAbstract = String(body.talkAbstract ?? '').trim().slice(0, LONG)
  const talkDuration = String(body.talkDuration ?? '').trim().slice(0, SHORT)
  const previousSpeaking = String(body.previousSpeaking ?? '').trim().slice(0, LONG)
  const portfolioUrl     = String(body.portfolioUrl     ?? '').trim().slice(0, URL_MAX)

  if (!name)         return NextResponse.json({ error: 'Name is required' },       { status: 422 })
  if (!email || !email.includes('@'))
                     return NextResponse.json({ error: 'Valid email is required' }, { status: 422 })
  if (!bio)          return NextResponse.json({ error: 'Bio is required' },         { status: 422 })
  if (!talkTitle)    return NextResponse.json({ error: 'Talk title is required' },  { status: 422 })
  if (!talkAbstract) return NextResponse.json({ error: 'Talk abstract is required' }, { status: 422 })

  // ── Write to Firestore ──────────────────────────────────────────────────────
  const doc: SpeakerApplicationInput & {
    eventSlug:    string
    organizerUid: string
    status:       'pending'
    submittedAt:  FirebaseFirestore.FieldValue
  } = {
    eventSlug:    slug,
    organizerUid: event.uid,
    status:       'pending',
    submittedAt:  FieldValue.serverTimestamp(),
    name, email, phone, jobTitle, company, bio,
    talkTitle, talkAbstract, talkDuration,
    previousSpeaking, portfolioUrl,
  }

  await adminDb.collection('speakerApplications').add(doc)

  // ── Send confirmation email (non-critical) ──────────────────────────────────
  try {
    const eventName = typeof (ed?.info as Record<string, unknown> | null)?.name === 'string'
      ? (ed!.info as Record<string, unknown>).name as string
      : slug
    if (notificationEngine.isAvailable(NotificationChannel.EMAIL)) {
      await notificationEngine.send(NotificationType.APPLICATION_RECEIVED, {
        to: email, applicantName: name,
        eventName, applicationType: 'speaker',
        eventUrl: `${BASE_URL}/events/${slug}`,
      })
    }
  } catch { /* email must not break submission */ }

  return NextResponse.json({ success: true })
}
