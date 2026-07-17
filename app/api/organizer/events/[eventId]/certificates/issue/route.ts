// POST /api/organizer/events/[eventId]/certificates/issue
//
// Manually issues a single certificate for one registration using the event's
// ACTIVE template, writing to the new `certificates` collection. Idempotent:
// re-issuing the same (event, registration, type) returns the existing record.
//
// Body: { registrationId: string, certificateType?: CertificateType }
//
// Security: auth required; organizer must own the event; the registration must
// belong to this event.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { getFeatureFlags }           from '@/lib/config/resolveFeatureFlags'
import { checkRateLimit }            from '@/lib/rateLimit'
import { getActiveTemplate, getTemplateById, getSettings, CertificateIneligibleError } from '@/lib/certificates/firestore'
import { generateCertificate, CertificateInProgressError } from '@/lib/certificates/generate'
import { buildAssignmentContext, resolveAssignment } from '@/lib/certificates/assignment'
import { isCertificateType }         from '@/lib/certificates/validation'
import { serializeCertificate }      from '@/lib/certificates/types'
import type { RegistrationDocument } from '@/lib/registrations/types'
import type { CertificateType }      from '@/lib/certificates/types'

type Params = { params: Promise<{ eventId: string }> }

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function fmtDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
}

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  // Feature flag (Business Configuration) — global certificates master switch.
  if (!(await getFeatureFlags()).certificates) {
    return NextResponse.json({ error: 'Certificates are currently disabled.' }, { status: 403 })
  }
  const uid       = authz.workspaceUid    // authorization / ownership scope
  const callerUid = authz.callerUid       // attribution: the issuing operator

  // Per-operator rate limit (workspace+operator): 60 manual issues / min each, so
  // one staff member can't exhaust the workspace's issuance budget.
  const rl = checkRateLimit(`${uid}:${callerUid}`, 'certificate-issue', 60, 60 * 1000)
  if (rl.limited) {
    return NextResponse.json({ error: 'Too many certificate requests. Please slow down.' }, { status: 429 })
  }

  const { eventId } = await params

  // ── Ownership + event data ─────────────────────────────────────────────────
  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) return NextResponse.json({ error: 'Event not found' }, { status: 404 })

  const draft   = draftSnap.data() as Record<string, unknown>
  const details = (draft.eventDetails as Record<string, unknown>) ?? {}
  const seo     = (details.seo      as Record<string, unknown>) ?? {}
  const info    = (details.info     as Record<string, unknown>) ?? {}
  const sched   = (details.schedule as Record<string, unknown>) ?? {}

  const slug = str(seo.urlSlug)
  if (!slug) return NextResponse.json({ error: 'Event not published' }, { status: 422 })

  const eventName     = str(info.name) || 'Event'
  const eventDate     = fmtDate(str(sched.startDate) || null)
  const eventLocation = str(info.location) || str(info.venue) || str(info.city)
  const organizerName = str(info.organizerName) || str(draft.organizerName) || ''

  // ── Body ───────────────────────────────────────────────────────────────────
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const registrationId = str((body as Record<string, unknown>)?.registrationId)
  if (!registrationId) return NextResponse.json({ error: 'registrationId is required' }, { status: 400 })

  // ── Active template ──────────────────────────────────────────────────────────
  const template = await getActiveTemplate(eventId, uid)
  if (!template) {
    return NextResponse.json({ error: 'No active certificate template for this event' }, { status: 422 })
  }

  // ── Certificate type (body → settings default → participation) ────────────────
  const settings = await getSettings(eventId)
  const bodyType = (body as Record<string, unknown>)?.certificateType
  const certificateType: CertificateType = isCertificateType(bodyType)
    ? bodyType
    : (settings?.defaultType ?? 'participation')

  // ── Registration ─────────────────────────────────────────────────────────────
  const regSnap = await adminDb.collection('registrations').doc(registrationId).get()
  if (!regSnap.exists) return NextResponse.json({ error: 'Registration not found' }, { status: 404 })
  const reg = regSnap.data() as RegistrationDocument

  if (reg.organizerUid !== uid || reg.eventSlug !== slug) {
    return NextResponse.json({ error: 'Registration does not belong to this event' }, { status: 403 })
  }
  if (reg.status !== 'confirmed') {
    return NextResponse.json({ error: 'Registration is not confirmed' }, { status: 422 })
  }

  // ── Program assignment (GA-6 S3) — resolve which program (template + type) this
  //    participant gets. No rules → the active template + type (unchanged behaviour).
  let assignedTemplate = template
  let assignedType     = certificateType
  const res = resolveAssignment(
    settings?.assignmentRules,
    buildAssignmentContext(reg),
    { templateId: template.templateId, certificateType },
  )
  if (res.matchedRuleId && res.templateId !== template.templateId) {
    const t = await getTemplateById(res.templateId)
    if (t && t.eventId === eventId && t.organizerUid === uid) {
      assignedTemplate = t
      assignedType     = res.certificateType
    }
  }

  // ── Generate ───────────────────────────────────────────────────────────────
  try {
    const { certificate, created } = await generateCertificate({
      input: {
        eventId,
        eventSlug:      slug,
        organizerUid:   uid,
        eventName,
        eventDate,
        eventLocation,
        organizerName,
        registrationId,
        attendeeName:   reg.attendee.name,
        attendeeEmail:  reg.attendee.email,
        ticketCode:     reg.ticketCode ?? '',
        bibNumber:      reg.bibNumber ?? '',
        distance:       '',
        finishTime:     '',
        position:       '',
        category:       reg.bibCategory ?? '',
      },
      certificateType: assignedType,
      source:   'manual',
      template: assignedTemplate,
      issuedBy: callerUid,
    })

    return NextResponse.json(
      { success: true, created, certificate: serializeCertificate(certificate) },
      { status: created ? 201 : 200 },
    )
  } catch (err) {
    if (err instanceof CertificateInProgressError) {
      return NextResponse.json({ error: err.message }, { status: 409 })
    }
    if (err instanceof CertificateIneligibleError) {
      return NextResponse.json({ error: `Registration is not eligible for a certificate (${err.reason}).` }, { status: 422 })
    }
    console.error('[certificates/issue]', err)
    return NextResponse.json({ error: 'Certificate generation failed' }, { status: 500 })
  }
}
