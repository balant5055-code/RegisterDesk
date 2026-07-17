// Publish Governance Engine (EA-4 S1) — the SINGLE gateway before any publish.
//
//   Publish/Republish → governPublish() → License(expiry: caller) → Registration
//   Safety → Identity Validation → decision → existing publish pipeline.
//
// Both /api/events/publish and /organizer/events/[eventId]/republish call this.
// It never duplicates the publish transaction — it only decides whether the caller
// may proceed. First governed publish (no baseline) always allows; the caller then
// lazily records the baseline (see recordPublish).

import { getGovernanceConfig } from './config'
import { getBaseline }         from './baseline'
import { extractIdentity, classifyIdentityChange } from './identity'
import { getEventActivity }    from './registrationSafety'
import type { GovernanceResult } from './types'

export interface GovernInput {
  eventId:   string                    // draftId — the immutable Event ID (binding key)
  draft:     Record<string, unknown>   // current draft (source of the current identity)
  slug:      string | null             // published slug, if the event has one
  confirmed: boolean                   // organizer confirmed a moderate-change warning
}

const allow = (over: Partial<GovernanceResult> = {}): GovernanceResult => ({
  ok: true, decision: 'allow', firstPublish: false, level: 'none', changedFields: [],
  requiresConfirmation: false, suggestDuplicate: false, hasActivity: false, reason: '', ...over,
})

export async function governPublish(input: GovernInput): Promise<GovernanceResult> {
  const baseline = await getBaseline(input.eventId)

  // First governed publish → allow; the caller records the baseline (lazy capture,
  // which also grandfathers every legacy event on its next publish).
  if (!baseline) return allow({ firstPublish: true })

  // Admin force-publish / identity override → bypass identity governance entirely.
  const overrides = baseline.overrides
  if (overrides?.publish || overrides?.identity) return allow({ reason: 'admin_override' })

  const config = await getGovernanceConfig()
  if (!config.enabled) return allow({ reason: 'governance_disabled' })

  const cls = classifyIdentityChange(baseline.identity, extractIdentity(input.draft), config)

  // Registration safety runs BEFORE the identity decision: a live event with
  // attendees hard-blocks any non-minor identity change (unless an admin bypass).
  const activity = (cls.level === 'moderate' || cls.level === 'major') && !overrides?.registrationSafety
    ? await getEventActivity(input.slug ?? '')
    : { hasActivity: false, registrations: 0, checkedIn: 0 }

  if (cls.level === 'major') {
    return {
      ok: false, decision: 'block', firstPublish: false, level: 'major',
      changedFields: cls.changedFields, requiresConfirmation: false, suggestDuplicate: true,
      hasActivity: activity.hasActivity,
      reason: `This has become a different event (${cls.majorFields.join(', ')} changed). Publishing under the same license is blocked — duplicate it as a new event to publish under a new license.`,
    }
  }

  if (cls.level === 'moderate') {
    if (activity.hasActivity) {
      return {
        ok: false, decision: 'block', firstPublish: false, level: 'moderate',
        changedFields: cls.changedFields, requiresConfirmation: false, suggestDuplicate: true,
        hasActivity: true,
        reason: `This event already has registrations; significant changes (${cls.moderateFields.join(', ')}) are blocked to protect existing attendees. Duplicate it as a new event instead.`,
      }
    }
    if (!input.confirmed) {
      return {
        ok: false, decision: 'warn', firstPublish: false, level: 'moderate',
        changedFields: cls.changedFields, requiresConfirmation: true, suggestDuplicate: false,
        hasActivity: false,
        reason: `You changed ${cls.moderateFields.join(', ')}. Confirm to republish the same event with these changes.`,
      }
    }
    return allow({ level: 'moderate', changedFields: cls.changedFields, reason: 'confirmed' })
  }

  return allow({ level: cls.level, changedFields: cls.changedFields })
}
