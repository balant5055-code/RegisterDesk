// MS-SETTINGS-02 · Legacy platform-limit override audit and cleanup — SERVER ONLY.
//
// ═══ WHY THESE OVERRIDES EXIST AT ALL ════════════════════════════════════════
// Before MS-SETTINGS-01, `PATCH /api/organizer/media-studio/overrides` accepted every
// platform limit unclamped, and `maxPhotosPerEvent` could be set to `null` — unlimited.
// `mergeMediaLayers` ranks the event layer above plan and global, so those values became the
// limits actually enforced at upload. An organizer could hand themselves a ceiling the
// business never sold them.
//
// The route now refuses those keys. This module deals with what was written before it did.
//
// ═══ ORIGIN IS NOT AMBIGUOUS ═════════════════════════════════════════════════
// MS-SETTINGS-01 flagged that a stored override carries no `setBy` and no per-key timestamp,
// so an organizer self-grant could not be told apart from an admin grant. Auditing the code
// settles it: `saveEventOverride` has exactly ONE caller in the repository — the organizer
// route — and no admin route, script or seed has ever written `eventLimitOverrides`.
//
// Therefore EVERY platform-limit override in this map came through the organizer flow. There
// is no legitimate admin override at this layer to preserve, because that writer has never
// existed. That is what makes an unconditional cleanup safe rather than a guess.
//
// ═══ WHAT IS NEVER TOUCHED ═══════════════════════════════════════════════════
// Only the six PLATFORM_LIMIT_KEYS are removed. Compression, renditions, visibility and
// public-gallery preferences are the organizer's own product and stay exactly as they are —
// including when they sit in the same override object as a limit being removed.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { MEDIA_SETTINGS, type MediaSettingsDoc } from '@/features/media-studio/types'
import { PLATFORM_LIMIT_KEYS } from '@/lib/config/mediaLimitLayers'
import { resolveMediaConfig } from '@/lib/config/resolveMediaConfig'
import type { MediaOverridableConfig } from '@/lib/config/businessConfig'

type LimitKey = (typeof PLATFORM_LIMIT_KEYS)[number]

export interface LegacyOverrideFinding {
  organizerUid: string
  eventId:      string
  /** Which of the six were found on this event. */
  keys:         LimitKey[]
  /** What the organizer stored, per key. `null` is the "unlimited" case. */
  storedValues:    Partial<Record<LimitKey, unknown>>
  /** What the platform would give this event WITHOUT the override — plan, else global. */
  inheritedValues: Partial<Record<LimitKey, unknown>>
  /** What is enforced today, i.e. the stored value winning over the inherited one. */
  effectiveValues: Partial<Record<LimitKey, unknown>>
  /** Preference keys sharing this override object. Recorded so cleanup can prove it kept them. */
  preservedKeys:   string[]
}

export interface LegacyOverrideAudit {
  scannedWorkspaces: number
  scannedEvents:     number
  affectedEvents:    number
  /** Events whose override object holds NOTHING but platform limits — removed entirely. */
  fullyLegacyEvents: number
  findings:          LegacyOverrideFinding[]
  /** True when the scan stopped at `limit` and more workspaces remain. */
  truncated:         boolean
}

const settings = () => adminDb.collection(MEDIA_SETTINGS)

const isLimitKey = (k: string): k is LimitKey =>
  (PLATFORM_LIMIT_KEYS as readonly string[]).includes(k)

/**
 * Reads every workspace's settings document and reports platform-limit overrides.
 *
 * READ ONLY. Nothing here writes, so it is safe to run against any environment — including
 * production — to answer "is there anything to clean" before deciding to clean it.
 *
 * `resolveMediaConfig` is called twice per affected event: once as stored, once with the
 * event layer suppressed, so the report can show what the override is actually changing
 * rather than only that it exists. That is two reads per AFFECTED event, not per event.
 */
export async function auditLegacyOverrides(params?: {
  limit?: number
}): Promise<LegacyOverrideAudit> {
  const limit = params?.limit ?? 500

  const snap = await settings().limit(limit + 1).get()
  const docs = snap.docs.slice(0, limit)

  const audit: LegacyOverrideAudit = {
    scannedWorkspaces: docs.length,
    scannedEvents:     0,
    affectedEvents:    0,
    fullyLegacyEvents: 0,
    findings:          [],
    truncated:         snap.size > limit,
  }

  for (const doc of docs) {
    const data = doc.data() as MediaSettingsDoc
    const map  = data.eventLimitOverrides ?? {}

    for (const [eventId, override] of Object.entries(map)) {
      audit.scannedEvents++
      if (!override || typeof override !== 'object') continue

      const present = Object.keys(override).filter(isLimitKey)
      if (present.length === 0) continue    // preferences only — nothing to do

      audit.affectedEvents++
      const preservedKeys = Object.keys(override).filter(k => !isLimitKey(k))
      if (preservedKeys.length === 0) audit.fullyLegacyEvents++

      const storedValues:    Partial<Record<LimitKey, unknown>> = {}
      const inheritedValues: Partial<Record<LimitKey, unknown>> = {}
      const effectiveValues: Partial<Record<LimitKey, unknown>> = {}
      for (const key of present) {
        storedValues[key] = (override as Record<string, unknown>)[key]
      }

      // What is enforced now, and what WOULD be enforced without this event's override.
      // Failure here must not abort the audit: a deleted event or an unreadable licence is
      // exactly the sort of thing an audit exists to surface, not to crash on.
      try {
        const [withOverride, withoutOverride] = await Promise.all([
          resolveMediaConfig({ organizerUid: doc.id, eventId }),
          resolveEffectiveWithoutEventLayer(doc.id, eventId),
        ])
        for (const key of present) {
          effectiveValues[key] = withOverride[key as keyof MediaOverridableConfig]
          inheritedValues[key] = withoutOverride[key as keyof MediaOverridableConfig]
        }
      } catch {
        // Leave both maps partial; `storedValues` and `keys` still identify the record.
      }

      audit.findings.push({
        organizerUid: doc.id, eventId,
        keys: present, storedValues, inheritedValues, effectiveValues, preservedKeys,
      })
    }
  }

  return audit
}

/**
 * The effective config an event would receive with its own override layer removed.
 *
 * Resolves against a deliberately non-existent event id under the same workspace, so the
 * plan and global layers are read exactly as the real resolver reads them while the event
 * layer is guaranteed empty. Cheaper and far less error-prone than duplicating the merge.
 */
async function resolveEffectiveWithoutEventLayer(organizerUid: string, eventId: string) {
  return resolveMediaConfig({
    organizerUid,
    // A suffix no real event id carries; the override map lookup simply misses.
    eventId: `${eventId}::__ms_settings_02_probe__`,
  })
}

export interface CleanupResult {
  dryRun:            boolean
  workspacesTouched: number
  eventsCleaned:     number
  /** Event entries removed wholesale because nothing but limits remained. */
  entriesRemoved:    number
  keysRemoved:       number
  /** Preference keys deliberately left in place. Reported so the claim is checkable. */
  keysPreserved:     number
  findings:          LegacyOverrideFinding[]
}

/**
 * Removes legacy platform-limit overrides.
 *
 * DRY RUN BY DEFAULT. A destructive data operation should require someone to say so twice,
 * and the report a dry run produces is identical to the one the real run produces — so the
 * decision is made on the same evidence.
 *
 * Per-key deletion, never whole-object replacement: an override object holding both a legacy
 * limit and a live preference must lose only the limit. Where nothing but limits remains,
 * the event entry itself is deleted rather than left as an empty object the resolver would
 * still have to read.
 *
 * Idempotent: a second run finds nothing and reports zero.
 */
export async function cleanLegacyOverrides(params?: {
  limit?:  number
  dryRun?: boolean
}): Promise<CleanupResult> {
  const dryRun = params?.dryRun ?? true
  const audit  = await auditLegacyOverrides({ limit: params?.limit })

  const result: CleanupResult = {
    dryRun,
    workspacesTouched: new Set(audit.findings.map(f => f.organizerUid)).size,
    eventsCleaned:     audit.findings.length,
    entriesRemoved:    audit.findings.filter(f => f.preservedKeys.length === 0).length,
    keysRemoved:       audit.findings.reduce((n, f) => n + f.keys.length, 0),
    keysPreserved:     audit.findings.reduce((n, f) => n + f.preservedKeys.length, 0),
    findings:          audit.findings,
  }

  if (dryRun) return result

  for (const finding of audit.findings) {
    const ref  = settings().doc(finding.organizerUid)
    const base = `eventLimitOverrides.${finding.eventId}`

    if (finding.preservedKeys.length === 0) {
      // Nothing worth keeping — drop the whole entry so the resolver stops reading it.
      await ref.update({
        [base]: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      })
      continue
    }

    // Surgical: delete the six by field path, leaving every preference untouched.
    const patch: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() }
    for (const key of finding.keys) patch[`${base}.${key}`] = FieldValue.delete()
    await ref.update(patch)
  }

  return result
}
