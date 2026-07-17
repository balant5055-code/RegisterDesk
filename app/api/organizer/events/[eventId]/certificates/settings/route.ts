// GET   /api/organizer/events/[eventId]/certificates/settings — load settings
// PUT   /api/organizer/events/[eventId]/certificates/settings — replace settings
// PATCH /api/organizer/events/[eventId]/certificates/settings — partial update
//
// Security: organizer must be authenticated and own the event. Ownership +
// event existence are both verified by the presence of the event draft under
// the caller's user document (users/{uid}/eventDrafts/{eventId}).

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { getSettings, saveSettings, patchSettings } from '@/lib/certificates/firestore'
import { defaultCertificateSettings } from '@/lib/certificates/types'
import { validateSettingsInput, validateSettingsPatch } from '@/lib/certificates/validation'
import type { CertificateSettings, CertificateSettingsInput } from '@/lib/certificates/types'

type Params = { params: Promise<{ eventId: string }> }

// ─── Auth + ownership ──────────────────────────────────────────────────────────

async function resolveOwner(
  req: NextRequest,
  eventId: string,
): Promise<{ uid: string; error?: never } | { uid?: never; error: NextResponse }> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return { error: NextResponse.json({ error: authz.error }, { status: authz.status }) }
  const uid = authz.workspaceUid

  // Ownership + existence: the draft only exists under its owner's user doc.
  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) {
    return { error: NextResponse.json({ error: 'Event not found' }, { status: 404 }) }
  }

  return { uid }
}

// ─── Response shape ─────────────────────────────────────────────────────────────

export interface SettingsResponse {
  settings: CertificateSettings | null
  defaults: CertificateSettingsInput
}

// ─── GET ────────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { eventId } = await params
  const auth = await resolveOwner(req, eventId)
  if (auth.error) return auth.error

  const settings = await getSettings(eventId)
  return NextResponse.json({
    settings,
    defaults: defaultCertificateSettings(),
  } satisfies SettingsResponse)
}

// ─── PUT (full replace / upsert) ─────────────────────────────────────────────────

export async function PUT(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { eventId } = await params
  const auth = await resolveOwner(req, eventId)
  if (auth.error) return auth.error

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = validateSettingsInput(body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const settings = await saveSettings(eventId, parsed.value, auth.uid)
  return NextResponse.json({ success: true, settings })
}

// ─── PATCH (partial update — enable/disable, single fields, nested groups) ────────

export async function PATCH(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { eventId } = await params
  const auth = await resolveOwner(req, eventId)
  if (auth.error) return auth.error

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = validateSettingsPatch(body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const settings = await patchSettings(eventId, parsed.value, auth.uid)
  return NextResponse.json({ success: true, settings })
}
