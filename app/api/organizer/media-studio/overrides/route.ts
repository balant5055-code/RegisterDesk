// GET   /api/organizer/media-studio/overrides?eventId=  — this event's own override deltas
// PATCH /api/organizer/media-studio/overrides            — set or clear them
//
// RD-MEDIA-09. The TOP layer of the limit hierarchy, made editable.
//
// ═══ ONE EVENT AT A TIME, NEVER THE WHOLE MAP ═════════════════════════════════
// The overrides live in a map on `mediaSettings/{organizerUid}` keyed by eventId. A PATCH
// that accepted the whole map would let one stale browser tab wipe every other event's
// overrides on save. So the body names ONE event, and the write is a targeted field path.
// ══════════════════════════════════════════════════════════════════════════════
//
// This route does NOT resolve anything. It stores deltas; `resolveMediaConfig` remains the
// only place that decides an effective value, exactly as RD-MEDIA-08 built it.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeMedia, resolveOwnedEvent } from '@/features/media-studio/services/authorize'
import { PLATFORM_LIMIT_KEYS } from '@/lib/config/mediaLimitLayers'
import {
  getEventOverride, saveEventOverride,
} from '@/features/media-studio/repositories/settingsRepo'
import { COMPRESSION_PROFILES, CUSTOM_PROFILE_ID } from '@/features/media-studio/utils/compressionProfiles'
import type { MediaOverridableConfig } from '@/lib/config/businessConfig'

export interface OverridesResponse {
  eventId:   string
  overrides: Partial<MediaOverridableConfig>
}

const VALID_PROFILE_IDS = new Set<string>([
  ...COMPRESSION_PROFILES.map(p => p.id), CUSTOM_PROFILE_ID,
])

// ─── MS-SETTINGS-01: platform limits are ADMIN-ONLY ──────────────────────────
//
// This route previously accepted every overridable key, unclamped. An organizer could send
// `maxPhotosPerEvent: null` and grant themselves unlimited storage, or raise their own file
// size and gallery caps — the resolver ranks the event layer above plan and global, so those
// values became the EFFECTIVE limits that `checkCount` and `checkSize` enforce.
//
// The fix is here rather than in the UI. Hiding the controls would leave the escalation one
// `curl` away; refusing the keys at the server is what actually closes it.
//
// `PLATFORM_LIMIT_KEYS` is imported, never restated — a key added there is refused here
// automatically, so the two cannot drift.
//
// Every numeric override this route once accepted was a platform limit, so the numeric
// branch is gone entirely rather than kept as a loop over an empty list. What remains is the
// organizer's own product: which renditions to keep, how hard to compress, and whether the
// gallery is public.
// RD-MS-CLEANUP-02 · The three rendition booleans were removed from this list. Which
// versions of a photo get stored is a platform decision now, not a per-event one. They
// remain in `MediaOverridableConfig` and in the resolver — the limits endpoint still
// reports the effective values — but no event may override them.
const BOOLEANS: (keyof MediaOverridableConfig)[] = [
  'publicGalleryEnabled',
]

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeMedia(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const eventId = req.nextUrl.searchParams.get('eventId')?.trim() ?? ''
  if (!eventId) return NextResponse.json({ error: 'eventId is required' }, { status: 400 })

  const event = await resolveOwnedEvent(authz.workspaceUid, eventId)
  if (!event.ok) return NextResponse.json({ error: event.error }, { status: event.status })

  const body: OverridesResponse = {
    eventId,
    overrides: await getEventOverride(authz.workspaceUid, eventId),
  }
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeMedia(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  let raw: Record<string, unknown>
  try { raw = await req.json() as Record<string, unknown> }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const eventId = typeof raw.eventId === 'string' ? raw.eventId.trim() : ''
  if (!eventId) return NextResponse.json({ error: 'eventId is required' }, { status: 400 })

  const event = await resolveOwnedEvent(authz.workspaceUid, eventId)
  if (!event.ok) return NextResponse.json({ error: event.error }, { status: event.status })

  const incoming = raw.overrides
  if (typeof incoming !== 'object' || incoming === null || Array.isArray(incoming)) {
    return NextResponse.json({ error: 'overrides must be an object' }, { status: 400 })
  }
  const input = incoming as Record<string, unknown>

  // ── MS-SETTINGS-01: refuse platform limits explicitly ──
  // Silently dropping them would let a caller believe the write succeeded and leave the UI
  // showing a limit the server never stored. A 403 names the reason instead.
  const attemptedLimits = PLATFORM_LIMIT_KEYS.filter(k => k in input)
  if (attemptedLimits.length > 0) {
    return NextResponse.json({
      error: `These limits are set by the platform and cannot be changed here: ${attemptedLimits.join(", ")}.`,
      code:  'PLATFORM_LIMIT_READ_ONLY',
      fields: attemptedLimits,
    }, { status: 403 })
  }

  // Built key by key, never spread: an unknown key in the body must not become an override
  // the resolver would then hand to every consumer.
  const overrides: Partial<MediaOverridableConfig> = {}

  for (const key of BOOLEANS) {
    if (!(key in input) || input[key] === undefined) continue
    if (typeof input[key] !== 'boolean') {
      return NextResponse.json({ error: `${key} must be true or false.` }, { status: 400 })
    }
    Object.assign(overrides, { [key]: input[key] })
  }

  if ('defaultCompressionProfileId' in input && input.defaultCompressionProfileId !== undefined) {
    const id = input.defaultCompressionProfileId
    if (typeof id !== 'string' || !VALID_PROFILE_IDS.has(id)) {
      return NextResponse.json({ error: 'Unknown compression profile.' }, { status: 400 })
    }
    overrides.defaultCompressionProfileId = id
  }

  if ('defaultVisibility' in input && input.defaultVisibility !== undefined) {
    const v = input.defaultVisibility
    if (v !== 'PUBLIC' && v !== 'SIGNED_URL') {
      return NextResponse.json({ error: 'Visibility must be PUBLIC or SIGNED_URL.' }, { status: 400 })
    }
    overrides.defaultVisibility = v
  }

  // An empty object CLEARS every override for this event — "inherit everything" is a
  // legitimate destination, and it must not require deleting the event.
  await saveEventOverride(authz.workspaceUid, eventId, overrides)

  const body: OverridesResponse = { eventId, overrides }
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}
