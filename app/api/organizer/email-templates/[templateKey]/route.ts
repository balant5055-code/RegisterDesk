// DELETE /api/organizer/email-templates/[templateKey]
// Removes the organizer's custom override and reverts to the platform default.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { TEMPLATE_KEYS }             from '@/lib/email-templates/types'
import type { TemplateKey }          from '@/lib/email-templates/types'
import { authorizeWorkspace }        from '@/lib/team/workspace'

type DeleteResponse = { success: true }
                   | { success: false; error: string }

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ templateKey: string }> },
): Promise<NextResponse<DeleteResponse>> {
  const authz = await authorizeWorkspace(req, 'broadcasts')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const { templateKey } = await params
  if (!TEMPLATE_KEYS.includes(templateKey as TemplateKey)) {
    return NextResponse.json({ success: false, error: 'Invalid template key' }, { status: 400 })
  }

  const docRef = adminDb
    .collection('users').doc(uid)
    .collection('emailTemplates').doc(templateKey)

  await docRef.delete()
  return NextResponse.json({ success: true })
}
