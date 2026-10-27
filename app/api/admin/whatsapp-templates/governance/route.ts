// RD-WA-TEMPLATES-01 — the template review mode (Super Admin only).
//   GET → { mode, unavailable, metaConfigured }
//   PUT { mode: 'manual' | 'automatic', reason } → change it for every organizer template.
//
// 'manual' (default): a Super Admin approves each version before it is submitted to Meta.
// 'automatic': server validation, then straight to Meta. Meta must approve a template before it can
// be broadcast in BOTH modes — automatic mode never bypasses Meta. Saved through
// businessConfig.updateSection (versioned, configuration audit) with an admin-audit row staged in
// the same transaction. Only templates submitted AFTER a change follow the new mode.

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { stageAdminAudit } from '@/lib/admin/audit'
import { businessConfig } from '@/lib/config/businessConfigService'
import { isMetaConfigured } from '@/lib/whatsapp/config'
import { resolveReviewMode } from '@/lib/whatsappTemplates/governance'
import { parseReviewMode, type ReviewMode } from '@/lib/whatsappTemplates/types'
import { NO_STORE, readJson } from '@/lib/whatsappTemplates/http'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  return NextResponse.json({ ...(await resolveReviewMode()), metaConfigured: isMetaConfigured() }, { headers: NO_STORE })
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  const parsed = await readJson(req)
  if (!parsed.ok) return parsed.response
  const { mode: rawMode, reason: rawReason } = parsed.body
  if (rawMode !== 'manual' && rawMode !== 'automatic') return NextResponse.json({ error: "mode must be 'manual' or 'automatic'.", code: 'INVALID' }, { status: 400, headers: NO_STORE })
  const reason = typeof rawReason === 'string' ? rawReason.trim() : ''
  if (reason.length < 5 || reason.length > 500) return NextResponse.json({ error: 'Give a reason for the change (5–500 characters).', code: 'REASON_REQUIRED' }, { status: 400, headers: NO_STORE })
  const next = rawMode as ReviewMode
  const current = await resolveReviewMode()
  if (current.unavailable) return NextResponse.json({ error: 'The current setting could not be read, so nothing was changed. Try again.', code: 'CONFIG_UNAVAILABLE' }, { status: 503, headers: NO_STORE })
  if (current.mode === next) return NextResponse.json({ error: `Review mode is already ${next}.`, code: 'NO_CHANGE' }, { status: 400, headers: NO_STORE })
  try {
    const result = await businessConfig.updateSection('integrations', { whatsappTemplateReviewMode: next }, {
      updatedBy: gate.uid, reason, canEditPricing: false,
      stageInTransaction: (txn, info) => {
        const before = parseReviewMode((info.before as { whatsappTemplateReviewMode?: unknown } | null)?.whatsappTemplateReviewMode)
        stageAdminAudit(txn, {
          adminUid: gate.uid, actorRole: 'super_admin', action: 'platform.whatsapp_template_review_mode_changed', entityType: 'platform_settings',
          entityId: 'integrations.whatsappTemplateReviewMode', reason,
          changedFields: ['whatsappTemplateReviewMode'], before: { whatsappTemplateReviewMode: before }, after: { whatsappTemplateReviewMode: next },
          metadata: { configVersion: info.version },
        })
      },
    })
    return NextResponse.json({ ok: true, mode: next, version: result.version }, { headers: NO_STORE })
  } catch (err) {
    console.error('[admin/whatsapp-templates/governance] update failed', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not save the change. Nothing was changed.' }, { status: 500, headers: NO_STORE })
  }
}
