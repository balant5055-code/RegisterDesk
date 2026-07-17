// POST /api/nominations/submit
//
// Public endpoint — no auth required.
// Rate-limited: 5 nominations per 10 minutes per IP.
// Validates category against the event's stored AwardsDetails.categories.

import { NextRequest, NextResponse } from 'next/server'
import { FieldValue }               from 'firebase-admin/firestore'
import { adminDb }                  from '@/lib/firebase/admin'
import { getEventBySlug }           from '@/lib/firebase/firestore/events'
import { checkRateLimit, getClientIp } from '@/lib/rateLimit'
import type { AwardsDetails }       from '@/components/wizard/eventDetailsConfig'

// ─── Request / response ───────────────────────────────────────────────────────

interface NominationSubmitBody {
  slug:         string
  category:     string
  nomineeName:  string
  organization?: string
  description?:  string
  supportingUrl?: string
}

export interface NominationSubmitResponse {
  success:       boolean
  nominationId?: string
  error?:        string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isValidUrl(url: string): boolean {
  try { new URL(url); return true } catch { return false }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(
  req: NextRequest,
): Promise<NextResponse<NominationSubmitResponse>> {
  // ── Rate limit ────────────────────────────────────────────────────────────
  const ip = getClientIp(req)
  const rl = checkRateLimit(ip, 'nominations_submit', 5, 10 * 60 * 1000)
  if (rl.limited) {
    return NextResponse.json(
      { success: false, error: 'Too many submissions. Please try again later.' },
      {
        status: 429,
        headers: {
          'Retry-After':       String(Math.ceil((rl.resetAt - Date.now()) / 1000)),
          'X-RateLimit-Limit': '5',
          'X-RateLimit-Reset': String(rl.resetAt),
        },
      },
    )
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let body: NominationSubmitBody
  try { body = (await req.json()) as NominationSubmitBody }
  catch { return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 }) }

  const { slug, category, nomineeName, organization, description, supportingUrl } = body

  // ── Basic field validation ────────────────────────────────────────────────
  if (!slug?.trim())
    return NextResponse.json({ success: false, error: 'Event slug is required.' }, { status: 400 })
  if (!category?.trim())
    return NextResponse.json({ success: false, error: 'Category is required.' }, { status: 400 })
  if (!nomineeName?.trim())
    return NextResponse.json({ success: false, error: 'Nominee name is required.' }, { status: 400 })
  if (supportingUrl?.trim() && !isValidUrl(supportingUrl.trim()))
    return NextResponse.json({ success: false, error: 'Supporting URL is not valid.' }, { status: 400 })

  // ── Load and validate event ───────────────────────────────────────────────
  const event = await getEventBySlug(slug)
  if (!event)
    return NextResponse.json({ success: false, error: 'Event not found.' }, { status: 404 })
  if (event.lifecycleStatus !== 'published')
    return NextResponse.json({ success: false, error: 'Nominations are not open for this event.' }, { status: 403 })
  if (event.eventType !== 'awards')
    return NextResponse.json({ success: false, error: 'This event does not accept nominations.' }, { status: 400 })

  // ── Validate category against event's stored categories ──────────────────
  const rawDetails = event.eventDetails as Record<string, unknown>
  const td = rawDetails?.typeDetails as AwardsDetails | null
  const categories = td?.categories?.filter(c => c.name?.trim()) ?? []
  if (categories.length > 0) {
    const valid = categories.some(c => c.name.trim() === category.trim())
    if (!valid)
      return NextResponse.json({ success: false, error: 'Invalid category.' }, { status: 400 })
  }

  // ── Write nomination ──────────────────────────────────────────────────────
  const docRef = adminDb.collection('eventNominations').doc()
  await docRef.set({
    id:            docRef.id,
    eventSlug:     slug.trim(),
    organizerUid:  event.uid,
    category:      category.trim(),
    nomineeName:   nomineeName.trim(),
    organization:  organization?.trim() ?? '',
    description:   description?.trim()  ?? '',
    supportingUrl: supportingUrl?.trim() ?? '',
    status:        'pending',
    submittedAt:   FieldValue.serverTimestamp(),
  })

  return NextResponse.json({ success: true, nominationId: docRef.id })
}
