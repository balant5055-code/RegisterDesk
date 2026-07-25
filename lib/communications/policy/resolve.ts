// RD-PLATFORM-COMMS-01 Phase 4D — the canonical Notification Policy resolver.
//
// The Registry (Phase 4C) defines WHAT each notification is; the Policy Center defines HOW it
// behaves. This is the ONE place a policy is derived. It does NOT duplicate the registry:
// priority, mandatory, audience, and channel support are taken FROM the resolved registry
// entry; the policy-specific fields (delivery mode, retry, expiry, escalation, scheduling,
// digest, realtime/batch, future-readiness) are DERIVED by category/priority rules here.
//
// PURE + isomorphic. READ-ONLY policy description — no retry engine, scheduler, dispatch, or
// runtime behavior is created or changed. `future*` flags are reserved markers for later
// phases, not active controls.

import type { CommRegistryEntry, CommRegistryAudience } from '@/lib/communications/registry/catalog'
import type { NotificationType } from '@/lib/notifications/catalog'

export type PolicyPriority    = 'critical' | 'high' | 'medium' | 'low' | 'informational'
export type DeliveryMode      = 'immediate' | 'scheduled' | 'manual' | 'digest' | 'disabled'
export type RetryPolicy       = 'never' | 'retry_1' | 'retry_3' | 'retry_5' | 'unlimited'
export type EscalationPolicy  = 'none' | 'organizer' | 'platform_admin' | 'support_team' | 'security_team' | 'future_workflow'
export type ExpiryPolicy      = 'none' | '24h' | '7d' | '30d'

export interface ChannelSupport {
  email: boolean; whatsapp: boolean; inapp: boolean; sms: boolean; push: boolean
}

export interface ResolvedNotificationPolicy {
  notificationId:   NotificationType
  priority:         PolicyPriority
  mandatory:        boolean
  deliveryMode:     DeliveryMode
  retryPolicy:      RetryPolicy
  expiryPolicy:     ExpiryPolicy
  visibility:       CommRegistryAudience
  escalation:       EscalationPolicy
  allowDisable:     boolean
  requireTemplate:  boolean
  allowScheduling:  boolean
  allowDigest:      boolean
  supportsRealtime: boolean
  supportsBatch:    boolean
  supportsEmail:    boolean
  supportsWhatsApp: boolean
  supportsInApp:    boolean
  supportsSMS:      boolean
  supportsPush:     boolean
  futureAutomation: boolean
  futureCampaign:   boolean
  futureWorkflow:   boolean
}

function policyPriority(e: CommRegistryEntry): PolicyPriority {
  if (e.category === 'security') return 'critical'
  if (e.mandatory && (e.category === 'billing' || e.category === 'licensing' || e.category === 'compliance')) return 'critical'
  if (e.category === 'marketing') return 'informational'
  if (e.priority === 'high')   return 'high'
  if (e.priority === 'medium') return 'medium'
  return 'low'
}

const RETRY_BY_PRIORITY: Record<PolicyPriority, RetryPolicy> = {
  critical: 'retry_5', high: 'retry_3', medium: 'retry_1', low: 'retry_1', informational: 'never',
}

function escalationFor(e: CommRegistryEntry): EscalationPolicy {
  if (e.category === 'security') return 'security_team'
  if (e.category === 'billing' || e.category === 'licensing' || e.category === 'compliance') return 'platform_admin'
  if (e.category === 'events') return 'organizer'
  return 'none'
}

/**
 * Resolve one notification's policy from its resolved registry entry + channel support.
 * PURE. Every field is either taken from the registry (no duplication) or derived by rule.
 */
export function resolveNotificationPolicy(
  entry:    CommRegistryEntry,
  supports: ChannelSupport,
): ResolvedNotificationPolicy {
  const priority     = policyPriority(entry)
  const isMarketing  = entry.category === 'marketing'
  const isInfo       = priority === 'informational'

  return {
    notificationId:   entry.id,
    priority,
    mandatory:        entry.mandatory,                                   // from registry
    deliveryMode:     isMarketing ? 'manual' : 'immediate',
    retryPolicy:      RETRY_BY_PRIORITY[priority],
    expiryPolicy:     isMarketing || isInfo ? '30d' : 'none',
    visibility:       entry.audience,                                    // from registry
    escalation:       escalationFor(entry),
    allowDisable:     !entry.mandatory,                                  // mandatory can't be disabled
    requireTemplate:  true,
    allowScheduling:  isMarketing,
    allowDigest:      isMarketing || isInfo,
    supportsRealtime: !isMarketing,
    supportsBatch:    isMarketing,
    supportsEmail:    supports.email,                                    // from resolved registry
    supportsWhatsApp: supports.whatsapp,
    supportsInApp:    supports.inapp,
    supportsSMS:      supports.sms,
    supportsPush:     supports.push,
    futureAutomation: true,                                             // reserved (Phase 4+)
    futureCampaign:   isMarketing,
    futureWorkflow:   entry.category === 'events' || entry.category === 'billing',
  }
}
