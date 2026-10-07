// POST /api/organizer/drafts — RD-CE-FIX M2/H6 · create an event draft.
//
// The draft is created under the WORKSPACE (users/{workspaceUid}/eventDrafts), never the caller's
// own uid, so a team member's draft is the workspace's draft. Every server-controlled field is fixed
// here; the seed passes through the same allow-list as PATCH (lib/events/draftWrite.ts).

import { NextRequest, NextResponse } from 'next/server'
import { createHash }               from 'node:crypto'
import { FieldValue }                from 'firebase-admin/firestore'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { sanitizeDraftPayload }      from '@/lib/events/draftWrite'

const MAX_STEPS = 9

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  let body: unknown
  try { body = await req.json() } catch { body = {} }
  const seed = (body as { seed?: unknown } | null)?.seed ?? {}
  const check = sanitizeDraftPayload(seed)
  if (!check.ok) return NextResponse.json({ error: check.error, field: check.field ?? null }, { status: 400 })

  // RD-CE-FIX (orphan drafts) — an optional client request id makes creation idempotent: the id is
  // kept in the tab's sessionStorage until creation is acknowledged, so a refresh mid-create (or a
  // double submit) resolves to the SAME draft instead of leaving an orphan and creating a second one.
  // A repeat only refreshes the seed of a draft nobody has progressed yet.
  const requestId = (body as { requestId?: unknown } | null)?.requestId
  const col = adminDb.collection(`users/${authz.workspaceUid}/eventDrafts`)
  const ref = typeof requestId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(requestId)
    ? col.doc(`d_${createHash('sha256').update(`${authz.workspaceUid}:${requestId}`).digest('hex').slice(0, 24)}`)
    : col.doc()
  const existing = await ref.get()
  if (existing.exists) {
    const untouched = (existing.get('currentStep') ?? 0) <= 1 && existing.get('publishedAt') == null
    if (untouched && Object.keys(check.fields).length > 0) {
      await ref.update({ ...check.fields, updatedAt: FieldValue.serverTimestamp(), updatedBy: authz.callerUid })
    }
    return NextResponse.json({ id: ref.id, dropped: check.dropped, reused: true }, { status: 200 })
  }
  await ref.create({
    id:                 ref.id,
    status:             'draft',
    currentStep:        0,
    completedValues:    Array(MAX_STEPS).fill(null),
    eventType:          null,
    eventSubtype:       null,
    customEventSubtype: null,
    campaignType:       null,
    linkedCampaign:     null,
    visibility:         null,
    accessControl:      null,
    pricing:            null,
    registrationForm:   null,
    eventDetails:       {},
    communicationBilling: null,
    publishedAt:        null,
    ...check.fields,
    createdBy:          authz.callerUid,
    createdAt:          FieldValue.serverTimestamp(),
    updatedAt:          FieldValue.serverTimestamp(),
  })
  return NextResponse.json({ id: ref.id, dropped: check.dropped }, { status: 201 })
}
