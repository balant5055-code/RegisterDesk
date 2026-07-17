// POST /api/organizer/events/[eventId]/certificates/generate
//
// Generates certificate records for all eligible registrations that do not
// yet have one. Eligibility depends on the template type:
//   participation — any confirmed registration
//   completion    — confirmed + checked-in
//
// Sends a certificate email (fire-and-forget) for each newly generated record.

import { NextRequest, NextResponse }         from 'next/server'
import { adminDb }                           from '@/lib/firebase/admin'
import { authorizeWorkspace }                from '@/lib/team/workspace'
import { getTemplate }                       from '@/lib/certificates/firestore'
import { generateCertificateId }             from '@/lib/certificates/id'
import {
  getCertificateByRegistrationId,
  createCertificateRecord,
  markCertificateEmailed,
}                                            from '@/lib/certificates/firestore'
import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
import type { RegistrationDocument }         from '@/lib/registrations/types'

type Params = { params: Promise<{ eventId: string }> }

export interface GenerateCertificatesResponse {
  generated:    number
  skipped:      number   // already had a certificate
  ineligible:   number   // not yet eligible (e.g. not checked in for completion type)
}

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? 'https://registerdesk.in').replace(/\/$/, '')

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'long', year: 'numeric',
  })
}

function toISO(val: unknown): string | null {
  if (!val) return null
  if (typeof (val as { toDate?: () => Date }).toDate === 'function') {
    return (val as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const { eventId } = await params

  // ── Verify ownership and load event data ───────────────────────────────────
  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) {
    return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  }

  const draft    = draftSnap.data() as Record<string, unknown>
  const details  = (draft.eventDetails as Record<string, unknown>) ?? {}
  const seo      = (details.seo        as Record<string, unknown>) ?? {}
  const info     = (details.info       as Record<string, unknown>) ?? {}
  const sched    = (details.schedule   as Record<string, unknown>) ?? {}
  const slug     = typeof seo.urlSlug  === 'string' ? seo.urlSlug : null
  const eventName = typeof info.name   === 'string' ? info.name   : 'Event'
  const startDate = typeof sched.startDate === 'string' ? sched.startDate : null

  if (!slug) return NextResponse.json({ error: 'Event not published' }, { status: 422 })

  // ── Load certificate template ──────────────────────────────────────────────
  const template = await getTemplate(eventId)
  if (!template?.enabled) {
    return NextResponse.json({ error: 'Certificates are not enabled for this event' }, { status: 422 })
  }

  // ── Load eligible registrations ────────────────────────────────────────────
  const regsSnap = await adminDb
    .collection('registrations')
    .where('organizerUid', '==', uid)
    .where('eventSlug',    '==', slug)
    .where('status',       '==', 'confirmed')
    .get()

  const regs = regsSnap.docs.map(d => {
    const data = d.data() as RegistrationDocument
    return { ...data, id: d.id }
  })

  let generated = 0, skipped = 0, ineligible = 0

  const emailAvailable = notificationEngine.isAvailable(NotificationChannel.EMAIL)
  const issueDate     = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
  const eventDate     = startDate ? fmtDate(startDate) : ''

  for (const reg of regs) {
    // Eligibility (P7.1): never issue to a refunded registration. Cancelled /
    // rejected are already excluded by the status == 'confirmed' query above.
    if (reg.paymentStatus === 'refunded') {
      ineligible++
      continue
    }
    // Check eligibility
    if (template.type === 'completion' && !reg.checkedIn) {
      ineligible++
      continue
    }

    // Skip if already has a certificate
    const existing = await getCertificateByRegistrationId(reg.id)
    if (existing) { skipped++; continue }

    // Generate certificate ID
    const certificateId = generateCertificateId()
    const verifyUrl     = `${APP_URL}/verify/certificate/${certificateId}`
    const downloadUrl   = `${APP_URL}/api/certificates/${certificateId}`

    // Create record
    await createCertificateRecord({
      certificateId,
      eventId,
      eventSlug:      slug,
      registrationId: reg.id,
      organizerUid:   uid,
      attendeeName:   reg.attendee.name,
      attendeeEmail:  reg.attendee.email,
      eventName,
      eventDate,
    })

    generated++

    // Send email — fire-and-forget
    if (emailAvailable && reg.attendee.email) {
      void (async () => {
        try {
          const result = await notificationEngine.send(NotificationType.CERTIFICATE_READY, {
            to:            reg.attendee.email,
            attendeeName:  reg.attendee.name,
            eventName,
            certificateId,
            downloadUrl,
            verifyUrl,
          })
          await markCertificateEmailed(certificateId, result.success)
        } catch {
          await markCertificateEmailed(certificateId, false).catch(() => {})
        }
      })()
    }
  }

  return NextResponse.json({ generated, skipped, ineligible } satisfies GenerateCertificatesResponse)
}
