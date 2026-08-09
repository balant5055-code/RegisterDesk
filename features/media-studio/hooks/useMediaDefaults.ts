'use client'

// RD-MS-CLOSURE-01 · The resolved upload defaults for the active event.
//
// ═══ WHY THIS EXISTS ══════════════════════════════════════════════════════════
// Four `MediaDefaultsConfig` keys were configurable at every layer, resolved correctly by
// `resolveMediaConfig`, returned by `GET /media-studio/limits` — and then ignored. The import
// client hardcoded them:
//
//   const PLAN = { keepOriginal: true, generateMedium: true, generateThumbnail: true }
//   const [profileId, setProfileId] = useState(DEFAULT_PROFILE_ID)
//
// So an admin setting `defaultCompressionProfileId: 'efficient'` on the Free tier to control
// storage cost had no effect whatever — every organizer uploaded at `balanced`. Plan-layer
// cost control did not work, and neither did any per-event rendition override.
//
// ═══ WHAT THIS IS NOT ═════════════════════════════════════════════════════════
// Not a new configuration system, not a new endpoint and not a second resolver. It reads the
// EXISTING `/limits` route, which already returns exactly these four values already resolved
// global → plan → event. Nothing here decides anything.
//
// The organizer may still change the profile for a batch — these are DEFAULTS, which is what
// the config calls them. The plan sets where the picker starts, not where it is stuck.

import { useEffect, useState } from 'react'
import { useAuth } from '@/components/auth/AuthProvider'
import { DEFAULT_PROFILE_ID } from '@/features/media-studio/utils/compressionProfiles'

const API = '/api/organizer/media-studio'

/** Which renditions an upload produces. Mirrors `browserImage.RenditionPlan`. */
export interface RenditionPlan {
  keepOriginal:      boolean
  generateMedium:    boolean
  generateThumbnail: boolean
}

export interface MediaDefaults {
  /** Where the compression picker starts. */
  profileId: string
  plan:      RenditionPlan
}

/**
 * What the workspace falls back to before `/limits` answers, and if it never does.
 *
 * Deliberately the same values the import client used to hardcode, so a failed or slow
 * config read produces exactly the behaviour that shipped before this sprint rather than a
 * surprising one. A defaults read must never be able to break an upload.
 */
export const FALLBACK_MEDIA_DEFAULTS: MediaDefaults = {
  profileId: DEFAULT_PROFILE_ID,
  plan: { keepOriginal: true, generateMedium: true, generateThumbnail: true },
}

interface LimitsDefaults {
  defaultCompressionProfileId?: unknown
  generateThumbnail?: unknown
  generateMedium?:    unknown
  keepOriginal?:      unknown
}

const bool = (v: unknown, fallback: boolean) => typeof v === 'boolean' ? v : fallback

/**
 * Resolved defaults for one event, re-read whenever the event changes.
 *
 * Per event, not per workspace: the resolver ranks event above plan above global, so two
 * events on one account can legitimately differ.
 */
export function useMediaDefaults(eventId: string | null): MediaDefaults {
  const { getToken } = useAuth()

  /**
   * The resolved answer, TAGGED with the event it was resolved for.
   *
   * Tagged rather than reset in an effect: switching event must fall back instantly, and a
   * `setState` in an effect would show the previous event's defaults for one render — which
   * on the import page is one render during which the wrong compression profile is selected.
   * The tag makes the fallback a derivation, so it is correct on the very first render.
   */
  const [resolved, setResolved] = useState<{ eventId: string; defaults: MediaDefaults } | null>(null)

  // The read lives INSIDE the effect, matching every other data-loading component in Media
  // Studio (see CustomPurchaseCard, GalleryBrowserClient). A hoisted `useCallback` would be
  // traced by `react-hooks/set-state-in-effect` as a synchronous set, which it is not — the
  // state lands after an await, on a later tick.
  useEffect(() => {
    if (!eventId) return
    let cancelled = false

    const run = async () => {
      try {
        const token = await getToken()
        const res = await fetch(`${API}/limits?eventId=${encodeURIComponent(eventId)}`, {
          headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
        })
        if (!res.ok) return                     // keep the fallback; never block an upload
        const body = await res.json() as { defaults?: LimitsDefaults }
        const d = body.defaults
        if (!d || cancelled) return

        setResolved({
          eventId,
          defaults: {
            profileId: typeof d.defaultCompressionProfileId === 'string'
              && d.defaultCompressionProfileId.trim() !== ''
              ? d.defaultCompressionProfileId
              : DEFAULT_PROFILE_ID,
            plan: {
              keepOriginal:      bool(d.keepOriginal,      true),
              generateMedium:    bool(d.generateMedium,    true),
              generateThumbnail: bool(d.generateThumbnail, true),
            },
          },
        })
      } catch {
        // Offline, or the workspace has no access. The fallback below already applies.
      }
    }

    void run()
    return () => { cancelled = true }
  }, [eventId, getToken])

  // The resolved value only applies to the event it was resolved for. Anything else — no
  // event chosen, an event switched a moment ago, or a read that has not answered — is the
  // documented fallback, which is exactly what shipped before this hook existed.
  return resolved && resolved.eventId === eventId
    ? resolved.defaults
    : FALLBACK_MEDIA_DEFAULTS
}
