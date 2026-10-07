// GET   /api/admin/platform-settings  — the effective platform pricing settings.
// PATCH /api/admin/platform-settings  — validate + persist a deep-partial patch.
//
// RD-PRICING-01B infrastructure. Admin-gated (resolveAdminUid, fail-closed),
// validated (rejects out-of-range values with 400), and audited
// (platform_settings.updated on adminAuditLogs). Backing the singleton
// platformSettings/default. NO consumer reads the engine yet.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid, resolveSuperAdminUid } from '@/lib/admin/auth'
import { getPlatformSettings, updatePlatformSettings } from '@/lib/platform/pricing/service'
import type { PlatformSettingsPatch } from '@/lib/platform/pricing/types'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const settings = await getPlatformSettings()
  return NextResponse.json({ settings }, { headers: { 'Cache-Control': 'no-store' } })
}

/** RD-PHASE4-S2 — a reason must say something (the same bounds as other money decisions). */
const MIN_REASON_LENGTH = 3
const MAX_REASON_LENGTH = 500

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  // RD-PHASE4-S2 — EVERY key in platformSettings/default is pricing or a pricing switch (platform
  // fee, GST, gateway %, convenience fee, who pays, pricingEngineEnabled, licence tier prices), so
  // every write is Super Admin only (ADMIN_UIDS), decided from the verified token. A plain
  // `admin: true` claim reads (GET) but never writes.
  if (!(await resolveAdminUid(req.headers.get('authorization')))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const adminUid = await resolveSuperAdminUid(req.headers.get('authorization'))
  if (!adminUid) {
    return NextResponse.json({ error: 'Only a Super Admin can change platform pricing settings.', code: 'SUPER_ADMIN_REQUIRED' }, { status: 403 })
  }

  let patch: PlatformSettingsPatch
  let reason = ''
  try {
    // The service reads only recognized fields defensively; validation rejects
    // any out-of-range VALUE, so an unknown/garbage body cannot corrupt state.
    // RD-PHASE4-S2 — `reason` travels beside the patch keys and is not part of the patch.
    const body = (await req.json()) as PlatformSettingsPatch & { reason?: unknown }
    reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
    const rest: Record<string, unknown> = { ...(body ?? {}) }
    delete rest.reason
    patch = rest as PlatformSettingsPatch
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (reason.length < MIN_REASON_LENGTH || reason.length > MAX_REASON_LENGTH) {
    return NextResponse.json({ error: `A reason (${MIN_REASON_LENGTH}–${MAX_REASON_LENGTH} characters) is required to change platform settings.` }, { status: 400 })
  }

  // RD-PHASE4-S2 — settings + audit (actor, changed paths, before/after, reason) in ONE transaction.
  const result = await updatePlatformSettings(patch, adminUid, new Date().toISOString(), {
    collection: 'adminAuditLogs', reason, data: { superAdmin: true },
  })
  if (!result.ok) {
    return NextResponse.json({ error: 'Validation failed', details: result.errors }, { status: 400 })
  }

  return NextResponse.json({ settings: result.settings, changed: result.changed }, { headers: { 'Cache-Control': 'no-store' } })
}
