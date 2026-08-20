// POST /api/organizer/broadcasts/count
//
// Returns the number of registrations that match the given audience filter.
// Called client-side when event + audience changes to show recipient count preview.
//
// Body: { eventSlug: string; audience: BroadcastAudience; registrationDate?: RegistrationDateFilterInput }

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import type { BroadcastAudience }    from '@/lib/broadcasts/types'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { resolveMaxRecipientsPerBroadcast } from '@/lib/broadcasts/limits'
import { countUniqueRecipients, countUniquePhones } from '@/lib/broadcasts/dedupeRecipients'
import {
  parseRegistrationDateFilter, resolveRegistrationDateWindow, applyRegistrationDateRange,
  type RegistrationDateWindow,
} from '@/lib/broadcasts/registrationDateFilter'
import { resolveBroadcastTimezone } from '@/lib/broadcasts/resolveBroadcastTimezone'
import { countUndatedRegistrations } from '@/lib/broadcasts/undatedRegistrations'
import { todayISOInTz }              from '@/lib/registrations/salesWindow'

interface CountResponse {
  success: boolean
  count?:  number
  error?:  string
  /**
   * RD-BCAST-DATE-01 — what the preview must SAY, not just count.
   * `timezone`/`dateLabel` make the window explicit ("20 Aug 2026, Asia/Kolkata"), and
   * `undatedCount` surfaces registrations the filter structurally cannot reach.
   */
  timezone?:     string
  dateLabel?:    string
  undatedCount?: number
}

export async function POST(req: NextRequest): Promise<NextResponse<CountResponse>> {
  const authz = await authorizeWorkspace(req, 'broadcasts')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  let body: unknown
  try { body = await req.json() }
  catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }) }

  const { eventSlug, audience, channel, dedupeEmails: dedupeRaw, dedupePhones: dedupePhonesRaw } = body as Record<string, unknown>
  // Strict === true so anything else preserves the existing count behaviour exactly.
  const dedupeEmails = dedupeRaw === true
  const dedupePhones = dedupePhonesRaw === true
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

  // ═══ RD-BCAST-DATE-01 — registration-date window ═════════════════════════════
  // Resolved and applied HERE, once, BEFORE the three channel branches below. Applying it
  // per-branch would be three chances to forget one, and the preview would then disagree
  // with what gets billed and sent.
  //
  // The organizer's browser proposes a date; the server decides the zone and the instants.
  const parsed = parseRegistrationDateFilter((body as Record<string, unknown>).registrationDate)
  if (!parsed.ok) {
    return NextResponse.json({ success: false, error: `Invalid registration date filter (${parsed.error})` }, { status: 400 })
  }

  let dateWindow: RegistrationDateWindow | null = null
  if (parsed.value.type !== 'all') {
    const timezone = await resolveBroadcastTimezone(eventSlug, uid)
    const resolved = resolveRegistrationDateWindow(parsed.value, timezone, todayISOInTz(timezone))
    if (!resolved.ok) {
      return NextResponse.json({ success: false, error: `Invalid registration date filter (${resolved.error})` }, { status: 400 })
    }
    dateWindow = resolved.window
  }

  // Registrations with no usable `registeredAt` can never match a range query: Firestore
  // leaves them out of the index entirely. Counting them costs two index-only aggregates
  // (zero document reads) and is the difference between "not included" and "silently
  // missing". Measured against the audience BEFORE the date range, which is the only
  // query that can still see them.
  const undatedCount = dateWindow ? await countUndatedRegistrations(query) : 0

  // A Firestore `where`, never an in-memory filter — see applyRegistrationDateRange.
  query = applyRegistrationDateRange(query, dateWindow)

  // Attached to every branch below, so the composer can state the window it is counting
  // and warn about registrations the filter cannot reach.
  const windowMeta = dateWindow
    ? { timezone: dateWindow.timezone, dateLabel: dateWindow.label, undatedCount }
    : {}

  // RD-ORGANIZER-04 P1-1: bound recipient counting so the preview never loads the whole
  // collection. WhatsApp still needs per-doc phone presence (not expressible as an
  // aggregate), so cap the projected load at cap+1; email uses an indexed count()
  // aggregate (zero document reads).
  const maxRecipients = await resolveMaxRecipientsPerBroadcast(uid)

  if (channel === 'whatsapp') {
    const snap = await query.select('attendee').limit(maxRecipients + 1).get()
    const phones: (string | undefined)[] = []
    for (const d of snap.docs) {
      const phone = (d.data() as { attendee?: { phone?: string } }).attendee?.phone
      // Presence filter FIRST, exactly as before: a registration with no number is not a
      // WhatsApp recipient at all, whether or not dedupe is on.
      if (typeof phone === 'string' && phone.trim().length > 0) phones.push(phone)
    }
    // 'Ignore duplicate WhatsApp numbers': count CANONICAL numbers, not registrations.
    // Counted by the same helper the send path collapses with, so the number previewed, the
    // number billed and the number of rows snapshotted cannot disagree. Off ⇒ the previous
    // count, unchanged.
    return NextResponse.json({
      success: true,
      count: dedupePhones ? countUniquePhones(phones) : phones.length,
      ...windowMeta,
    })
  }

  // Email + "Ignore duplicate email IDs": the count must be UNIQUE ADDRESSES, and Firestore
  // has no DISTINCT — count() would report registrations and over-state what gets sent.
  // Reuses the WhatsApp branch's bounded shape above (projected read, capped at cap+1), so
  // the read cost is one already-established pattern rather than a new one, and the whole
  // collection is never loaded — here or in the browser.
  if (dedupeEmails) {
    const snap = await query.select('attendee').limit(maxRecipients + 1).get()
    const emails = snap.docs.map(d => (d.data() as { attendee?: { email?: string } }).attendee?.email)
    return NextResponse.json({ success: true, count: countUniqueRecipients(emails), ...windowMeta })
  }

  // Email: exact count via an indexed aggregate — no documents transferred.
  const agg = await query.count().get()
  return NextResponse.json({ success: true, count: agg.data().count, ...windowMeta })
}
