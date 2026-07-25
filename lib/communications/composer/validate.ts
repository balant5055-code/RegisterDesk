// RD-PLATFORM-COMMS-02 Phase 5C — the pure Composer validation (isomorphic, server-free).
//
// The ONE place a draft's readiness is computed. PURE — takes the already-resolved parts
// (booleans/objects from the canonical resolvers) and returns validation results. No I/O, no
// composition of domain logic — just the composite verdict. Split out so it is testable.

import { CAMPAIGN_TYPES, CAMPAIGN_CATEGORIES } from '@/lib/communications/campaigns/types'
import type { ComposerValidation, ComposerVariable } from './types'

export interface ComposerValidationInput {
  campaignName:      string
  campaignType:      string
  campaignCategory:  string
  notificationFound: boolean
  audience:          { valid: boolean; health: string } | null
  template:          { bound: boolean } | null
  channelSupported:  boolean
  variables:         ComposerVariable[]
  policyResolved:    boolean
}

/** Build the composite composer validation. PURE. */
export function buildComposerValidation(i: ComposerValidationInput): ComposerValidation[] {
  const unknownVars = i.variables.filter(v => !v.known).map(v => v.id)
  return [
    {
      check: 'campaign', ok: !!i.campaignName && (CAMPAIGN_TYPES as string[]).includes(i.campaignType) && (CAMPAIGN_CATEGORIES as string[]).includes(i.campaignCategory),
      detail: i.campaignName ? `"${i.campaignName}" (${i.campaignType}/${i.campaignCategory}).` : 'Campaign needs a name.',
    },
    {
      check: 'notification', ok: i.notificationFound,
      detail: i.notificationFound ? 'Notification resolved from the registry.' : 'Notification not found in the registry.',
    },
    {
      check: 'audience', ok: i.audience ? i.audience.valid : false,
      detail: !i.audience ? 'No audience selected.' : i.audience.valid ? 'Audience is valid.' : `Audience is ${i.audience.health}.`,
    },
    {
      check: 'template', ok: !!i.template?.bound,
      detail: !i.template ? 'No template for this channel.' : i.template.bound ? 'Template resolved and bound.' : 'Template not bound.',
    },
    {
      check: 'channel', ok: i.channelSupported,
      detail: i.channelSupported ? 'Channel is supported for this notification.' : 'Channel is not supported for this notification.',
    },
    {
      check: 'variables', ok: unknownVars.length === 0,
      detail: unknownVars.length === 0 ? `All ${i.variables.length} variables are registered.` : `Unknown: ${unknownVars.join(', ')}`,
    },
    {
      check: 'policy', ok: i.policyResolved,
      detail: i.policyResolved ? 'Policy resolved.' : 'Policy could not be resolved.',
    },
  ]
}

/** Convenience: is the whole draft ready? */
export function isDraftReady(validation: ComposerValidation[]): boolean {
  return validation.every(v => v.ok)
}
