// PATCH /api/admin/events/[slug]/email-provider
//
// ADMIN-ONLY control over which transport carries an event's attendee mail.
//
// ═══ WHY THIS IS ITS OWN ENDPOINT ════════════════════════════════════════════
// PATCH /api/admin/events/[slug] is the MODERATION endpoint (take_down / restore /
// under_review). Mixing an infrastructure setting into it would put two unrelated
// authorities behind one contract. This route does exactly one thing.
//
// ═══ TRUST BOUNDARY ══════════════════════════════════════════════════════════
// The body may carry ONE key with ONE of two enum values. It can never supply an API
// key, a provider URL, a credential or an arbitrary provider name — `isEmailProviderName`
// is the only thing that decides what is acceptable, and it is the same guard the send
// path uses. Nothing about provider credentials is read or returned here.
//
// The organizer edit route refuses this field outright (403), so this is the ONLY
// write path to events/{slug}.emailProvider.
//
// ═══ WRITE SCOPE ═════════════════════════════════════════════════════════════
// A single-field `update()` on ONE document. NOT `set()` — a full-document write here
// would destroy the event. Nothing else is touched: no draft, no content, no pricing,
// no registration data, no templates, no SES/Resend configuration.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { resolveAdminUid }           from '@/lib/admin/auth'
import { logAdminAction }            from '@/lib/admin/audit'
import {
  isEmailProviderName, parseEmailProviderName, type EmailProviderName,
} from '@/lib/email/providerName'

export const dynamic = 'force-dynamic'

interface RouteContext {
  params: Promise<{ slug: string }>
}

interface PatchBody {
  emailProvider?: unknown
}

export interface AdminEmailProviderPatchResponse {
  slug:          string
  emailProvider: EmailProviderName
}

export async function PATCH(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { slug } = await ctx.params

  let body: PatchBody
  try { body = await req.json() as PatchBody }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  // Enum or nothing. Anything else — a credential, a URL, 'sendgrid', an object — is a 400.
  const emailProvider = body.emailProvider
  if (!isEmailProviderName(emailProvider)) {
    return NextResponse.json(
      { error: "emailProvider must be 'ses' or 'resend'" },
      { status: 400 },
    )
  }

  const ref  = adminDb.collection('events').doc(slug)
  const snap = await ref.get()
  if (!snap.exists) return NextResponse.json({ error: 'Event not found' }, { status: 404 })

  // Recorded before the write so the audit trail carries the real transition. Read through
  // the shared parser, so a legacy event with no stored value audits honestly as 'ses'.
  const previous = parseEmailProviderName((snap.data() as { emailProvider?: unknown } | undefined)?.emailProvider)

  // Single-field update. Never set() — that would overwrite the whole event document.
  await ref.update({ emailProvider })

  void logAdminAction({
    adminUid,
    action:     'event.email_provider_changed',
    entityType: 'event',
    entityId:   slug,
    metadata:   { from: previous, to: emailProvider },
  }).catch((err: unknown) => console.error('[audit] email-provider log failed:', err))

  return NextResponse.json({
    slug,
    emailProvider,
  } satisfies AdminEmailProviderPatchResponse)
}
