// /api/unsubscribe?email=...&org=...&token=...
//
// One-click unsubscribe endpoint for the List-Unsubscribe / List-Unsubscribe-Post
// headers (RFC 8058). The existing human-facing /unsubscribe page flow is
// unchanged — this only adds the machine one-click path mail clients POST to.
//
//   POST → verify the HMAC token and add the email to the organizer's suppression
//          list (idempotent), return 200. The one-click body (List-Unsubscribe=
//          One-Click) is not needed; the signed params live in the query string.
//   GET  → redirect to the /unsubscribe confirmation page (so a human opening the
//          header URL sees the same page as the in-email link).

import { NextRequest, NextResponse } from 'next/server'
import { verifyUnsubscribeToken }    from '@/lib/email/unsubscribeToken'
import { addToSuppressionList }      from '@/lib/firebase/firestore/emailSuppressionList'
import { APP_URL }                   from '@/lib/env'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const p     = req.nextUrl.searchParams
  const email = p.get('email') ?? ''
  const org   = p.get('org')   ?? ''
  const token = p.get('token') ?? ''

  if (!email || !org || !token || !verifyUnsubscribeToken(email, org, token)) {
    return NextResponse.json({ success: false, error: 'Invalid unsubscribe link' }, { status: 400 })
  }

  try {
    await addToSuppressionList(email, org, 'unsubscribe_oneclick')
  } catch {
    return NextResponse.json({ success: false, error: 'Could not process unsubscribe' }, { status: 500 })
  }
  return NextResponse.json({ success: true })
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Send humans to the existing confirmation page (unchanged flow).
  const qs = req.nextUrl.searchParams.toString()
  return NextResponse.redirect(`${APP_URL}/unsubscribe${qs ? `?${qs}` : ''}`)
}
