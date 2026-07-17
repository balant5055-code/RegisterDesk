// GET  /api/organizer/events/[eventId]/certificates/jobs — list bulk jobs
// POST /api/organizer/events/[eventId]/certificates/jobs — enqueue a bulk job
//
// Creating a job only enqueues it (status `pending`). Processing is driven by
// repeated calls to the /process endpoint (resumable). Security: auth + event
// ownership.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { organizerStatusGuard }      from '@/lib/admin/organizerStatus'
import { createJob, getActiveTemplate, getTemplateById, getSettings, listJobs } from '@/lib/certificates/firestore'
import { loadEventContext, countScopeTotal } from '@/lib/certificates/jobs'
import { validateJobCreate }         from '@/lib/certificates/validation'
import { serializeCertificateJob }   from '@/lib/certificates/types'
import type { SerializedCertificateJob, CertificateType, CertificateTemplateDoc } from '@/lib/certificates/types'
import type { AssignmentRule }       from '@/lib/certificates/assignment'

type Params = { params: Promise<{ eventId: string }> }

async function authUid(req: NextRequest): Promise<{ uid: string; callerUid: string } | { error: NextResponse }> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return { error: NextResponse.json({ error: authz.error }, { status: authz.status }) }
  return { uid: authz.workspaceUid, callerUid: authz.callerUid }
}

export interface JobsListResponse { jobs: SerializedCertificateJob[] }

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { eventId } = await params
  const auth = await authUid(req)
  if ('error' in auth) return auth.error

  const ctx = await loadEventContext(auth.uid, eventId)
  if (!ctx.ok && ctx.code === 'not_found') {
    return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  }

  const jobs = (await listJobs(eventId, auth.uid)).map(serializeCertificateJob)
  return NextResponse.json({ jobs } satisfies JobsListResponse)
}

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { eventId } = await params
  const auth = await authUid(req)
  if ('error' in auth) return auth.error

  const blocked = await organizerStatusGuard(auth.uid)
  if (blocked) return NextResponse.json({ error: blocked.message }, { status: 403 })

  const ctx = await loadEventContext(auth.uid, eventId)
  if (!ctx.ok) {
    return ctx.code === 'not_found'
      ? NextResponse.json({ error: 'Event not found' }, { status: 404 })
      : NextResponse.json({ error: 'Event not published' }, { status: 422 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = validateJobCreate(body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const { scope, registrationIds, autoEmail } = parsed.value

  const settings = await getSettings(eventId)
  let certificateType: CertificateType = parsed.value.certificateType ?? settings?.defaultType ?? 'participation'

  // "Generate by program" (GA-6 S3): when the body names a program rule, the job uses
  // THAT program's template + type and only issues to matching participants. Otherwise
  // it uses the active template for the whole scope — identical to before.
  let template: CertificateTemplateDoc | null = await getActiveTemplate(eventId, auth.uid)
  let assignmentFilter: AssignmentRule | null = null
  const programRuleId = typeof (body as Record<string, unknown>)?.programRuleId === 'string'
    ? (body as Record<string, unknown>).programRuleId as string : ''
  if (programRuleId) {
    const rule = (settings?.assignmentRules ?? []).find(r => r.id === programRuleId)
    if (!rule) return NextResponse.json({ error: 'Unknown certificate program' }, { status: 422 })
    const t = await getTemplateById(rule.templateId)
    if (!t || t.eventId !== eventId || t.organizerUid !== auth.uid) {
      return NextResponse.json({ error: 'Program template not found' }, { status: 422 })
    }
    template = t
    certificateType = rule.certificateType ?? certificateType
    // Persist a clean rule (no undefined keys — Firestore rejects undefined).
    assignmentFilter = {
      id: rule.id, field: rule.field, op: rule.op, templateId: rule.templateId,
      ...(rule.value !== undefined ? { value: rule.value } : {}),
      ...(rule.certificateType ? { certificateType: rule.certificateType } : {}),
      ...(rule.label ? { label: rule.label } : {}),
    }
  }

  if (!template) {
    return NextResponse.json({ error: 'No active certificate template for this event' }, { status: 422 })
  }

  // Progress denominator (a program filter is applied per-page, so this may over-count).
  const total = registrationIds
    ? registrationIds.length
    : await countScopeTotal(auth.uid, ctx.ctx.eventSlug, scope)

  const job = await createJob(
    {
      eventId,
      organizerUid: auth.uid,
      createdBy:    auth.callerUid,
      templateId:   template.templateId,
      certificateType,
      scope,
      registrationIds,
      autoEmail,
      assignmentFilter,
    },
    total,
  )

  return NextResponse.json(
    { success: true, job: serializeCertificateJob(job) },
    { status: 201 },
  )
}
