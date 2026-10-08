// /api/unsubscribe — opt a recipient out of (or back into) ONE organizer's broadcast and reminder
// email. Public, no login: the link itself is the credential.
//
//   POST, one-click (RFC 8058)  mail clients POST the List-Unsubscribe URL (signed params in the
//                               query string) with body `List-Unsubscribe=One-Click` → opt out,
//                               200 JSON.
//   POST, from /unsubscribe     the confirmation page's form (`action` = unsubscribe |
//                               resubscribe, signed params as hidden fields) → 303 back to the
//                               page with the outcome. Nothing changes on a GET, so link scanners
//                               that prefetch URLs cannot unsubscribe anyone.
//   GET                         redirect to the /unsubscribe confirmation page.
//
// RD-COMMS-P2-G — the recipient and organizer come ONLY from the verified token (a sealed v2 `t`
// or a legacy HMAC v1 `email`/`org`/`token`); an edited, expired or unverifiable link changes
// nothing. Both actions are idempotent and audited once per real change (emailSuppressionList).
// Only the ORGANIZER scope is ever written: a platform suppression (bounce / complaint) is not
// reachable from here.

import { NextRequest, NextResponse } from 'next/server'
import { parseUnsubscribeParams }    from '@/lib/email/unsubscribeToken'
import { optOutOfOrganizer, resubscribeToOrganizer } from '@/lib/firebase/firestore/emailSuppressionList'
import { APP_URL }                   from '@/lib/env'

export const dynamic = 'force-dynamic'

const SIGNED_KEYS = ['t', 'email', 'org', 'token'] as const

/** The signed link parameters only — nothing else from the request is trusted or echoed. */
function signedParams(src: { get(k: string): string | null }): URLSearchParams {
  const out = new URLSearchParams()
  for (const k of SIGNED_KEYS) { const v = src.get(k); if (v) out.set(k, v) }
  return out
}

function backToPage(params: URLSearchParams, state: string): NextResponse {
  const q = new URLSearchParams(params)
  q.set('state', state)
  return NextResponse.redirect(`${APP_URL}/unsubscribe?${q.toString()}`, { status: 303 })
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const contentType = req.headers.get('content-type') ?? ''
  const form = contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')
    ? await req.formData().catch(() => null)
    : null
  const action = typeof form?.get('action') === 'string' ? String(form.get('action')) : null

  // The page's form carries the signed params in its body; a one-click POST carries them in the URL.
  const fromPage = action === 'unsubscribe' || action === 'resubscribe'
  const params = signedParams(fromPage
    ? { get: (k: string) => (typeof form?.get(k) === 'string' ? String(form.get(k)) : null) }
    : req.nextUrl.searchParams)
  const parsed = parseUnsubscribeParams(params)

  if (!parsed.ok) {
    return fromPage
      ? backToPage(params, parsed.reason === 'expired' ? 'expired' : 'invalid')
      : NextResponse.json({ success: false, error: parsed.reason === 'expired' ? 'Unsubscribe link expired' : 'Invalid unsubscribe link' }, { status: 400 })
  }
  const { email, organizerUid, eventSlug, kind } = parsed.target

  try {
    if (action === 'resubscribe') {
      const r = await resubscribeToOrganizer(email, organizerUid, { eventSlug })
      return backToPage(params, r === 'not_allowed' ? 'cannot_resubscribe' : 'resubscribed')
    }
    await optOutOfOrganizer(email, organizerUid, { source: fromPage ? 'unsubscribe_link' : 'unsubscribe_oneclick', eventSlug, kind })
  } catch {
    return fromPage
      ? backToPage(params, 'error')
      : NextResponse.json({ success: false, error: 'Could not process unsubscribe' }, { status: 500 })
  }
  return fromPage ? backToPage(params, 'unsubscribed') : NextResponse.json({ success: true })
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Humans opening the header URL see the same confirmation page as the in-email link.
  const qs = signedParams(req.nextUrl.searchParams).toString()
  return NextResponse.redirect(`${APP_URL}/unsubscribe${qs ? `?${qs}` : ''}`)
}
