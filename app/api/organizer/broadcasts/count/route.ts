// POST /api/organizer/broadcasts/count
//
// Returns the number of registrations that match the given audience filter.
// Called client-side when event + audience changes to show recipient count preview.
//
// Body: { eventSlug: string; audience: BroadcastAudience }

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import type { BroadcastAudience }    from '@/lib/broadcasts/types'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { resolveMaxRecipientsPerBroadcast } from '@/lib/broadcasts/limits'
import { countUniqueRecipients } from '@/lib/broadcasts/dedupeRecipients'

interface CountResponse {
  success: boolean
  count?:  number
  error?:  string
}

export async function POST(req: NextRequest): Promise<NextResponse<CountResponse>> {
  const authz = await authorizeWorkspace(req, 'broadcasts')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  let body: unknown
  try { body = await req.json() }
  catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }) }

  const { eventSlug, audience, channel, dedupeEmails: dedupeRaw } = body as Record<string, unknown>
  // Strict === true so anything else preserves the existing count behaviour exactly.
  const dedupeEmails = dedupeRaw === true
  if (typeof eventSlug !== 'string' || !eventSlug) {
    return NextResponse.json({ success: false, error: 'eventSlug is required' }, { status: 400 })
  }

  const AUDIENCES: BroadcastAudience[] = ['all', 'confirmed', 'pending', 'rejected', 'cancelled']
  if (!AUDIENCES.includes(audience as BroadcastAudience)) {
    return NextResponse.json({ success: false, error: 'Invalid audience' }, { status: 400 })
  }

  // Verify the event belongs to this organizer by checking the eventSlug matches
  // (Firestore registrations are denormalized with organizerUid — use that for auth)
  let query = adminDb.collection('registrations')
    .where('organizerUid', '==', uid)
    .where('eventSlug',    '==', eventSlug) as FirebaseFirestore.Query

  if (audience !== 'all') {
    query = query.where('status', '==', audience)
  }

  // RD-ORGANIZER-04 P1-1: bound recipient counting so the preview never loads the whole
  // collection. WhatsApp still needs per-doc phone presence (not expressible as an
  // aggregate), so cap the projected load at cap+1; email uses an indexed count()
  // aggregate (zero document reads).
  const maxRecipients = await resolveMaxRecipientsPerBroadcast(uid)

  if (channel === 'whatsapp') {
    const snap = await query.select('attendee').limit(maxRecipients + 1).get()
    let count = 0
    for (const d of snap.docs) {
      const phone = (d.data() as { attendee?: { phone?: string } }).attendee?.phone
      if (typeof phone === 'string' && phone.trim().length > 0) count++
    }
    return NextResponse.json({ success: true, count })
  }

  // Email + "Ignore duplicate email IDs": the count must be UNIQUE ADDRESSES, and Firestore
  // has no DISTINCT — count() would report registrations and over-state what gets sent.
  // Reuses the WhatsApp branch's bounded shape above (projected read, capped at cap+1), so
  // the read cost is one already-established pattern rather than a new one, and the whole
  // collection is never loaded — here or in the browser.
  if (dedupeEmails) {
    const snap = await query.select('attendee').limit(maxRecipients + 1).get()
    const emails = snap.docs.map(d => (d.data() as { attendee?: { email?: string } }).attendee?.email)
    return NextResponse.json({ success: true, count: countUniqueRecipients(emails) })
  }

  // Email: exact count via an indexed aggregate — no documents transferred.
  const agg = await query.count().get()
  return NextResponse.json({ success: true, count: agg.data().count })
}
