// GET /api/admin/communications/suppression?email=… — Super Admin investigation. READ-ONLY.
//
// RD-COMMS-P2-G — every scope that stops email to ONE address (the platform record from SES
// bounces/complaints, each organizer's opt-out) and its opt-out history. ADMIN_UIDS only
// (resolveAdminUid). Deliberately no write: a platform suppression cannot be lifted from here.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import { investigateSuppression } from '@/lib/firebase/firestore/emailSuppressionList'
import { investigateWhatsAppOptOut } from '@/lib/whatsapp/broadcastConsent'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  // RD-COMMS-WA-CONSENT — ?phone= looks up a number's WhatsApp BROADCAST opt-out (STOP/START).
  const phone = (req.nextUrl.searchParams.get('phone') ?? '').trim()
  if (phone) {
    if (phone.length > 32) return NextResponse.json({ error: 'A valid phone number is required' }, { status: 400 })
    try {
      const r = await investigateWhatsAppOptOut(phone)
      if (!r.phoneKey) return NextResponse.json({ error: 'A valid phone number is required' }, { status: 400 })
      return NextResponse.json({ whatsapp: r }, { headers: { 'Cache-Control': 'no-store' } })
    } catch (e) {
      console.error('[admin/communications/suppression] whatsapp lookup failed', e)
      return NextResponse.json({ error: 'Lookup failed' }, { status: 500 })
    }
  }
  const email = (req.nextUrl.searchParams.get('email') ?? '').trim()
  if (!email || email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(email)) return NextResponse.json({ error: 'A valid email address is required' }, { status: 400 })
  try {
    return NextResponse.json(await investigateSuppression(email), { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[admin/communications/suppression] failed', e)
    return NextResponse.json({ error: 'Lookup failed' }, { status: 500 })
  }
}
