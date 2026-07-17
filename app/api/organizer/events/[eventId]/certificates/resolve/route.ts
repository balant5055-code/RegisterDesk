// POST /api/organizer/events/[eventId]/certificates/resolve
//
// Workflow preview (GA-6 S3): given a registrationId, returns which certificate
// PROGRAM (template + type) the participant resolves to via the assignment rules —
// WITHOUT generating anything. Reuses the same deterministic engine the issue/bulk
// paths use, so the preview matches real issuance exactly.
//
// Body: { registrationId: string }
// Security: auth + event ownership; registration must belong to the event.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { getActiveTemplate, getTemplateById, getSettings } from '@/lib/certificates/firestore'
import { buildAssignmentContext, resolveAssignment } from '@/lib/certificates/assignment'
import type { RegistrationDocument }  from '@/lib/registrations/types'

type Params = { params: Promise<{ eventId: string }> }

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const { eventId } = await params
  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) return NextResponse.json({ error: 'Event not found' }, { status: 404 })

  let body: { registrationId?: unknown }
  try { body = await req.json() as typeof body } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const registrationId = typeof body.registrationId === 'string' ? body.registrationId : ''
  if (!registrationId) return NextResponse.json({ error: 'registrationId is required' }, { status: 400 })

  const regSnap = await adminDb.collection('registrations').doc(registrationId).get()
  if (!regSnap.exists) return NextResponse.json({ error: 'Registration not found' }, { status: 404 })
  const reg = regSnap.data() as RegistrationDocument
  if (reg.organizerUid !== uid) return NextResponse.json({ error: 'Registration does not belong to you' }, { status: 403 })

  const [settings, activeTemplate] = await Promise.all([getSettings(eventId), getActiveTemplate(eventId, uid)])
  const fallbackType = settings?.defaultType ?? 'participation'
  const context = buildAssignmentContext(reg)
  const res = resolveAssignment(
    settings?.assignmentRules,
    context,
    { templateId: activeTemplate?.templateId ?? '', certificateType: fallbackType },
  )

  // Resolve the program template name for display (active or a rule's target).
  let templateName = activeTemplate?.name ?? null
  if (res.matchedRuleId && res.templateId !== activeTemplate?.templateId) {
    const t = await getTemplateById(res.templateId)
    templateName = t && t.eventId === eventId && t.organizerUid === uid ? t.name : null
  }
  const matchedRule = res.matchedRuleId ? (settings?.assignmentRules ?? []).find(r => r.id === res.matchedRuleId) : null

  return NextResponse.json({
    registrationId,
    resolved: {
      matchedRuleId:   res.matchedRuleId,
      ruleLabel:       matchedRule?.label ?? null,
      programTemplateId: res.templateId || null,
      programTemplateName: templateName,
      certificateType: res.certificateType,
      isDefault:       res.matchedRuleId === null,   // fell through to the active/default program
    },
    context,   // the fields the rules evaluated against (for the organizer to verify)
  })
}
