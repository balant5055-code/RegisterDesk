// GET   /api/organizer/media-studio/settings
// PATCH /api/organizer/media-studio/settings
//
// Workspace-level upload defaults. One document per organizer; an absent document IS the
// documented default, so a first-time organizer never sees an error.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeMedia } from '@/features/media-studio/services/authorize'
import {
  getSettings, saveSettings, type SettingsPatch,
} from '@/features/media-studio/repositories/settingsRepo'
import { COMPRESSION_PROFILES, CUSTOM_PROFILE_ID } from '@/features/media-studio/utils/compressionProfiles'
import type { MediaSettingsDoc } from '@/features/media-studio/types'

export interface SettingsResponse {
  settings: Omit<MediaSettingsDoc, 'updatedAt'> & { updatedAt: string | null }
}

const VALID_PROFILE_IDS = new Set<string>([
  ...COMPRESSION_PROFILES.map(p => p.id), CUSTOM_PROFILE_ID,
])

function serialize(doc: MediaSettingsDoc): SettingsResponse['settings'] {
  const updatedAt = doc.updatedAt && typeof doc.updatedAt === 'object' && 'toDate' in doc.updatedAt
    ? (doc.updatedAt as { toDate: () => Date }).toDate().toISOString()
    : null
  return { ...doc, updatedAt }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeMedia(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const body: SettingsResponse = { settings: serialize(await getSettings(authz.workspaceUid)) }
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeMedia(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  let raw: Record<string, unknown>
  try { raw = await req.json() as Record<string, unknown> }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const patch: SettingsPatch = {}

  if ('defaultProfileId' in raw) {
    const id = typeof raw.defaultProfileId === 'string' ? raw.defaultProfileId : ''
    if (!VALID_PROFILE_IDS.has(id)) {
      return NextResponse.json({ error: 'Unknown compression profile.' }, { status: 400 })
    }
    patch.defaultProfileId = id
  }

  // RD-MS-CLEANUP-02 · `generateThumbnail` / `generateMedium` / `keepOriginal` are no
  // longer accepted. Every upload produces all three renditions — the import client has
  // always passed a hardcoded plan and never read these values, so accepting them was
  // offering a choice the pipeline did not honour. They stay on the stored document and in
  // the resolved config (the limits endpoint still reports them) but nothing may set them.

  if ('defaultVisibility' in raw) {
    const v = raw.defaultVisibility
    if (v !== 'PUBLIC' && v !== 'SIGNED_URL') {
      return NextResponse.json({ error: 'Visibility must be PUBLIC or SIGNED_URL.' }, { status: 400 })
    }
    patch.defaultVisibility = v
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  // RD-MS-CLEANUP-02 · The "at least one rendition" guard is gone with the fields it
  // guarded. It existed to stop an organizer switching all three off; none of them can be
  // switched off any more, so the combination it refused is now unreachable.

  const body: SettingsResponse = {
    settings: serialize(await saveSettings(authz.workspaceUid, patch)),
  }
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}
