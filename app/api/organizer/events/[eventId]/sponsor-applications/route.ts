// GET  /api/organizer/events/[eventId]/sponsor-applications
// PATCH /api/organizer/events/[eventId]/sponsor-applications  { appId, status, note? }

import { NextRequest, NextResponse }   from 'next/server'
import { FieldValue }                  from 'firebase-admin/firestore'
import { adminDb }                     from '@/lib/firebase/admin'
import { authorizeWorkspace }          from '@/lib/team/workspace'
import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
import type {
  SponsorApplicationSummary,
  SponsorApplicationsApiResponse,
  ApplicationStatus,
} from '@/lib/applications/types'

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://registerdesk.in'

function toISO(ts: unknown): string {
  if (!ts) return ''
  if (typeof (ts as { toDate?: () => Date }).toDate === 'function')
    return (ts as { toDate: () => Date }).toDate().toISOString()
  return ''
}

async function resolveSlugAndName(uid: string, eventId: string): Promise<{ slug: string; name: string } | null> {
  const snap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!snap.exists) return null
  const d   = snap.data() as Record<string, unknown>
  const ed  = d.eventDetails as Record<string, unknown> | null
  const seo = ed?.seo as Record<string, unknown> | null
  const slug = typeof seo?.urlSlug === 'string' ? seo.urlSlug : null
  if (!slug) return null
  const name = typeof (ed?.info as Record<string, unknown> | null)?.name === 'string'
    ? (ed!.info as Record<string, unknown>).name as string
    : slug
  return { slug, name }
}

type Ctx = { params: Promise<{ eventId: string }> }

export async function GET(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const { eventId } = await params
  const meta = await resolveSlugAndName(uid, eventId)
  if (!meta) return NextResponse.json({ error: 'Event not found' }, { status: 404 })

  const snap = await adminDb
    .collection('sponsorApplications')
    .where('organizerUid', '==', uid)
    .where('eventSlug',    '==', meta.slug)
    .orderBy('submittedAt', 'desc')
    .limit(1000)
    .get()

  const applications: SponsorApplicationSummary[] = snap.docs.map(doc => {
    const d = doc.data() as Record<string, unknown>
    return {
      id:            doc.id,
      status:        (d.status as ApplicationStatus | undefined) ?? 'pending',
      submittedAt:   toISO(d.submittedAt),
      reviewedAt:    toISO(d.reviewedAt),
      companyName:   String(d.companyName   ?? ''),
      contactName:   String(d.contactName   ?? ''),
      email:         String(d.email         ?? ''),
      phone:         String(d.phone         ?? ''),
      website:       String(d.website       ?? ''),
      preferredTier: String(d.preferredTier ?? ''),
      message:       String(d.message       ?? ''),
    }
  })

  const pending  = applications.filter(a => a.status === 'pending').length
  const approved = applications.filter(a => a.status === 'approved').length
  const rejected = applications.filter(a => a.status === 'rejected').length

  const body: SponsorApplicationsApiResponse = {
    total: applications.length, pending, approved, rejected, applications,
  }
  return NextResponse.json(body)
}

export async function PATCH(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const { eventId } = await params
  const meta = await resolveSlugAndName(uid, eventId)
  if (!meta) return NextResponse.json({ error: 'Event not found' }, { status: 404 })

  let body: Record<string, unknown>
  try { body = await req.json() as Record<string, unknown> }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const appId  = String(body.appId  ?? '').trim()
  const status = String(body.status ?? '').trim() as ApplicationStatus
  const note   = typeof body.note === 'string' ? body.note.trim() : undefined

  if (!appId) return NextResponse.json({ error: 'appId required' }, { status: 422 })
  if (status !== 'approved' && status !== 'rejected')
    return NextResponse.json({ error: 'status must be approved or rejected' }, { status: 422 })

  const appRef  = adminDb.collection('sponsorApplications').doc(appId)
  const appSnap = await appRef.get()
  if (!appSnap.exists) return NextResponse.json({ error: 'Application not found' }, { status: 404 })

  const appData = appSnap.data() as Record<string, unknown>
  if (appData.organizerUid !== uid || appData.eventSlug !== meta.slug) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
  }

  await appRef.update({ status, reviewedAt: FieldValue.serverTimestamp() })

  try {
    if (notificationEngine.isAvailable(NotificationChannel.EMAIL) && typeof appData.email === 'string') {
      await notificationEngine.send(NotificationType.APPLICATION_STATUS, {
        to:              appData.email,
        applicantName:   typeof appData.contactName === 'string' ? appData.contactName : '',
        eventName:       meta.name,
        applicationType: 'sponsor',
        status,
        eventUrl:        `${BASE_URL}/events/${meta.slug}`,
        note,
      })
    }
  } catch { /* email must not break review */ }

  return NextResponse.json({ success: true })
}
