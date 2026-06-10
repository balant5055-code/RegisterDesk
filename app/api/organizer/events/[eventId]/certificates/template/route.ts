// GET  /api/organizer/events/[eventId]/certificates/template — load template
// PUT  /api/organizer/events/[eventId]/certificates/template — save template
//
// Security: organizer must own the event (verified via draft doc ownership).

import { NextRequest, NextResponse }  from 'next/server'
import { adminDb, adminAuth }         from '@/lib/firebase/admin'
import { getTemplate, saveTemplate }  from '@/lib/certificates/firestore'
import { defaultTemplateInput }       from '@/lib/certificates/types'
import type { CertificateTemplate, CertificateTemplateInput } from '@/lib/certificates/types'

type Params = { params: Promise<{ eventId: string }> }

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function resolveOwner(
  req: NextRequest,
  eventId: string,
): Promise<{ uid: string; error?: never } | { uid?: never; error: NextResponse }> {
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '')
  if (!token) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  let uid: string
  try {
    uid = (await adminAuth.verifyIdToken(token)).uid
  } catch {
    return { error: NextResponse.json({ error: 'Invalid token' }, { status: 401 }) }
  }

  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) {
    return { error: NextResponse.json({ error: 'Event not found' }, { status: 404 }) }
  }

  return { uid }
}

// ─── GET ──────────────────────────────────────────────────────────────────────

export interface TemplateResponse {
  template: CertificateTemplate | null
  defaults: CertificateTemplateInput
}

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { eventId } = await params
  const auth = await resolveOwner(req, eventId)
  if (auth.error) return auth.error

  const template = await getTemplate(eventId)
  return NextResponse.json({ template, defaults: defaultTemplateInput() } satisfies TemplateResponse)
}

// ─── PUT ──────────────────────────────────────────────────────────────────────

export async function PUT(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { eventId } = await params
  const auth = await resolveOwner(req, eventId)
  if (auth.error) return auth.error

  let input: CertificateTemplateInput
  try {
    input = await req.json() as CertificateTemplateInput
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Validate required fields
  if (typeof input.enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled is required' }, { status: 400 })
  }

  await saveTemplate(eventId, input, auth.uid)
  return NextResponse.json({ success: true })
}
