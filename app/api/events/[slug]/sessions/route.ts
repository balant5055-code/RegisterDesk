// GET /api/events/[slug]/sessions — PUBLIC published schedule for an event
// (agenda display + the registration form's session picker). Published sessions only.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb } from '@/lib/firebase/admin'
import { getSchedule } from '@/lib/sessions/queries'
import { canExposePublicEvent } from '@/lib/events/publicVisibility'
import { deriveLifecycleStatus } from '@/lib/events/lifecycle'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, ctx: { params: Promise<{ slug: string }> }): Promise<NextResponse> {
  const { slug } = await ctx.params
  const evSnap = await adminDb.doc(`events/${slug}`).get()
  if (!evSnap.exists) return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  const raw = evSnap.data() as Record<string, unknown>
  // Public visibility — shared allow-list. deriveLifecycleStatus keeps legacy
  // docs (no lifecycleStatus field) resolving to their real state, so published
  // events never regress to 404.
  if (!canExposePublicEvent(deriveLifecycleStatus(raw))) {
    return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  }
  const uid = (raw as { uid?: string }).uid
  if (!uid) return NextResponse.json({ error: 'Event not found' }, { status: 404 })

  const bundle = await getSchedule(uid, slug, { publishedOnly: true })
  return NextResponse.json(bundle, { headers: { 'Cache-Control': 'public, max-age=30' } })
}
