// PATCH /api/admin/campaigns/[slug]
//
// Admin-only campaign moderation: take_down / restore / under_review.
// Audited (campaign.taken_down | campaign.restored | campaign.under_review)
// with oldStatus/newStatus/reason, and notifies the organizer by email
// (fire-and-forget — the admin action never fails if email fails).

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid }           from '@/lib/admin/auth'
import { applyModeration, notifyOrganizerModeration } from '@/lib/admin/moderationService'
import type { AdminAuditAction }     from '@/lib/admin/audit'
import type {
  AdminModerationAction,
  AdminModerationPatchResponse,
} from '@/lib/admin/moderationTypes'

interface RouteContext {
  params: Promise<{ slug: string }>
}

interface PatchBody {
  action?: unknown
  reason?: unknown
}

const AUDIT_ACTION: Record<AdminModerationAction, AdminAuditAction> = {
  take_down:    'campaign.taken_down',
  restore:      'campaign.restored',
  under_review: 'campaign.under_review',
}

function campaignTitle(d: Record<string, unknown>): string {
  const cd     = d.campaignDetails as Record<string, unknown> | undefined
  const basics = cd?.basics as Record<string, unknown> | undefined
  const title  = basics?.title
  return typeof title === 'string' && title.trim() ? title.trim() : '(untitled campaign)'
}

export async function PATCH(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { slug } = await ctx.params

  let body: PatchBody
  try { body = await req.json() as PatchBody }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const action = body.action
  if (action !== 'take_down' && action !== 'restore' && action !== 'under_review') {
    return NextResponse.json({ error: "action must be 'take_down', 'restore', or 'under_review'" }, { status: 400 })
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''

  const result = await applyModeration({
    collection:  'donationCampaigns',
    slug,
    action,
    adminUid,
    reason,
    auditAction: AUDIT_ACTION[action],
    entityType:  'campaign',
    titleOf:     campaignTitle,
  })

  if (!result.ok) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })

  notifyOrganizerModeration(result.organizerUid, 'campaign', action, result.title, reason)

  return NextResponse.json({
    slug,
    moderationStatus: result.newStatus,
  } satisfies AdminModerationPatchResponse)
}
