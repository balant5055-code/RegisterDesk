// GET/PUT /api/admin/settings/publishing — platform publishing mode (admin only).
//
// GET returns the current mode; PUT sets it. The mode ('auto_publish' |
// 'manual_approval') decides whether a submitted event goes live immediately or
// waits for admin approval. Stored in Firestore (platformSettings/publishing).

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import {
  getPublishingSettings, setPublishingSettings, isPublishingMode,
} from '@/lib/platform/publishing'

const NO_STORE = { 'Cache-Control': 'no-store' } as const

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const settings = await getPublishingSettings()
  return NextResponse.json(settings, { headers: NO_STORE })
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { mode?: unknown; slaHours?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const patch: { mode?: 'auto_publish' | 'manual_approval'; slaHours?: number } = {}
  if (body.mode !== undefined) {
    if (!isPublishingMode(body.mode)) {
      return NextResponse.json({ error: "mode must be 'auto_publish' or 'manual_approval'" }, { status: 400 })
    }
    patch.mode = body.mode
  }
  if (body.slaHours !== undefined) {
    const n = Number(body.slaHours)
    if (!Number.isFinite(n) || n <= 0 || n > 720) {
      return NextResponse.json({ error: 'slaHours must be a number between 1 and 720' }, { status: 400 })
    }
    patch.slaHours = Math.round(n)
  }
  if (patch.mode === undefined && patch.slaHours === undefined) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  await setPublishingSettings(patch, adminUid)
  return NextResponse.json(await getPublishingSettings(), { headers: NO_STORE })
}
