// RD-PRICING-01D — Organizer per-event pricing override.
//
//   PATCH → set/merge the organizer override. Organizers may override ONLY the
//           allow-list (Phase 8): registrationLimit (DOWNWARD only — never above the
//           licensed maximum) and convenienceFee. Any other field is rejected.
//
// Workspace-gated (authorizeWorkspace). Writes server-side via the Admin SDK to the
// draft and, if published, events/{slug}.organizerOverride — no schema migration; the
// field is optional and absent on every existing event until first set.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb } from '@/lib/firebase/admin'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { isEventLicenseTier } from '@/lib/licensing/eventLicense'
import {
  resolveEffectivePlatformConfiguration,
  resolveEffectiveLicense,
  validateOrganizerEventOverride,
  type AdminEventOverride,
  type OrganizerEventOverride,
} from '@/lib/platform/pricing'

type Ctx = { params: Promise<{ eventId: string }> }

const ALLOWED_FIELDS = new Set(['registrationLimit', 'convenienceFee'])

export async function PATCH(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  // 1. Auth
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const { eventId } = await params

  // 2. Parse + enforce the allow-list (reject any non-allowed field explicitly).
  let body: Record<string, unknown>
  try { body = await req.json() as Record<string, unknown> } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const disallowed = Object.keys(body).filter(k => !ALLOWED_FIELDS.has(k))
  if (disallowed.length) {
    return NextResponse.json({ error: `Organizers may not override: ${disallowed.join(', ')}` }, { status: 403 })
  }
  const override: OrganizerEventOverride = {}
  if (body.registrationLimit !== undefined) {
    if (typeof body.registrationLimit !== 'number' || !Number.isFinite(body.registrationLimit)) {
      return NextResponse.json({ error: 'registrationLimit must be a number' }, { status: 400 })
    }
    override.registrationLimit = body.registrationLimit
  }
  if (body.convenienceFee !== undefined) {
    if (typeof body.convenienceFee !== 'number' || !Number.isFinite(body.convenienceFee)) {
      return NextResponse.json({ error: 'convenienceFee must be a number' }, { status: 400 })
    }
    override.convenienceFee = body.convenienceFee
  }
  if (Object.keys(override).length === 0) {
    return NextResponse.json({ error: 'No overridable fields supplied' }, { status: 400 })
  }

  // 3. Load draft → resolve tier + slug.
  const draftRef  = adminDb.doc(`users/${uid}/eventDrafts/${eventId}`)
  const draftSnap = await draftRef.get()
  if (!draftSnap.exists) return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  const draft   = draftSnap.data() as Record<string, unknown>
  const tier    = isEventLicenseTier(draft.licenseTier) ? draft.licenseTier : 'starter'
  const details = (draft.eventDetails as Record<string, unknown> | null) ?? {}
  const seo     = (details.seo as Record<string, unknown> | null) ?? {}
  const slug    = typeof seo.urlSlug === 'string' && seo.urlSlug ? seo.urlSlug : null

  // 4. Validate against the LICENSED ceiling (downward-only rule).
  const licensedMax = (await resolveEffectiveLicense({ license: { tier } })).maxRegistrations.value
  const check = validateOrganizerEventOverride(override, licensedMax)
  if (!check.ok) return NextResponse.json({ error: 'Invalid override', details: check.errors }, { status: 400 })

  // 5. Merge onto any existing override + stamp; write to draft and, if published, the event.
  const existing = (draft.organizerOverride as OrganizerEventOverride | undefined) ?? {}
  const next: OrganizerEventOverride = {
    ...existing, ...override,
    updatedAt: new Date().toISOString(), updatedBy: uid,
  }
  await draftRef.update({ organizerOverride: next })

  let adminOverride: AdminEventOverride | null = null
  if (slug) {
    const eventRef  = adminDb.collection('events').doc(slug)
    const eventSnap = await eventRef.get()
    if (eventSnap.exists) {
      await eventRef.update({ organizerOverride: next })
      adminOverride = (eventSnap.data()?.adminOverride as AdminEventOverride | undefined) ?? null
    }
  }

  const configuration = await resolveEffectivePlatformConfiguration({
    license: { tier }, adminOverride, organizerOverride: next,
  })
  return NextResponse.json({ eventId, configuration })
}
