// GET   /api/admin/platform-settings  — the effective platform pricing settings.
// PATCH /api/admin/platform-settings  — validate + persist a deep-partial patch.
//
// RD-PRICING-01B infrastructure. Admin-gated (resolveAdminUid, fail-closed),
// validated (rejects out-of-range values with 400), and audited
// (platform_settings.updated on adminAuditLogs). Backing the singleton
// platformSettings/default. NO consumer reads the engine yet.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid }           from '@/lib/admin/auth'
import { logAdminAction }            from '@/lib/admin/audit'
import { getPlatformSettings, updatePlatformSettings } from '@/lib/platform/pricing/service'
import type { PlatformSettingsPatch } from '@/lib/platform/pricing/types'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const settings = await getPlatformSettings()
  return NextResponse.json({ settings }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  let patch: PlatformSettingsPatch
  try {
    // The service reads only recognized fields defensively; validation rejects
    // any out-of-range VALUE, so an unknown/garbage body cannot corrupt state.
    patch = (await req.json()) as PlatformSettingsPatch
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const result = await updatePlatformSettings(patch, adminUid, new Date().toISOString())
  if (!result.ok) {
    return NextResponse.json({ error: 'Validation failed', details: result.errors }, { status: 400 })
  }

  void logAdminAction({
    adminUid,
    action:     'platform_settings.updated',
    entityType: 'platform_settings',
    entityId:   'default',
    metadata:   { version: result.settings.metadata.version },
  }).catch(() => { /* audit is best-effort — never block the write */ })

  return NextResponse.json({ settings: result.settings }, { headers: { 'Cache-Control': 'no-store' } })
}
