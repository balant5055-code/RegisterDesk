// RD-PLATFORM-COMMS-01 Phase 4E — the canonical PLATFORM template registry.
//
// Binds every RegisterDesk → Organizer notification (audience user/organizer) to ONE template
// per supported channel. Organizer-authored and participant-facing templates are OUT of scope.
// Pure + isomorphic. Read-only — describes bindings + variable contracts; renders/sends nothing.
//
// Templates are code-managed (they live in lib/email/templates etc.), so they are 'published'
// by definition and carry a fixed code-managed timestamp rather than DB rows.

import type { CommRegistryEntry, CommRegistryAudience } from '@/lib/communications/registry/catalog'
import type { NotificationType } from '@/lib/notifications/catalog'
import { isKnownVariable } from './variables'

export type TemplateChannel = 'email' | 'whatsapp' | 'inapp'
export type TemplateStatus  = 'draft' | 'published' | 'archived'

/** Code-managed templates have no DB lifecycle; a fixed marker stands in for created/updated. */
export const TEMPLATE_CODE_MANAGED_AT = '2026-01-01T00:00:00.000Z'

export interface PlatformTemplate {
  templateId:    string          // `${notificationId}.${channel}`
  notificationId: NotificationType
  channel:       TemplateChannel
  category:      string
  displayName:   string
  description:   string
  version:       number
  status:        TemplateStatus
  variables:     string[]        // variable ids used (must all be in the variable registry)
  createdAt:     string
  updatedAt:     string
}

export interface TemplateHealth {
  templateId:        string
  status:            TemplateStatus
  bound:             boolean       // bound to a notification
  unknownVariables:  string[]      // variables not in the canonical registry
  missingChannels:   TemplateChannel[]  // supported channels with no template version
  healthy:           boolean
}

/** Platform notifications are RegisterDesk → Organizer/User. */
export function isPlatformAudience(a: CommRegistryAudience): boolean {
  return a === 'organizer' || a === 'user'
}

/** The variable contract each platform template exposes. Every id MUST exist in the canonical
 *  variable registry (enforced by template health + tests). */
export const PLATFORM_TEMPLATE_VARS: Partial<Record<NotificationType, string[]>> = {
  EMAIL_VERIFICATION:      ['RecipientName', 'VerificationCode', 'SupportEmail'],
  ACCOUNT_WELCOME:         ['RecipientName', 'OrganizationName', 'DashboardUrl', 'SupportEmail'],
  EVENT_SUBMITTED:         ['OrganizerName', 'EventName', 'DashboardUrl'],
  EVENT_APPROVED:          ['OrganizerName', 'EventName', 'DashboardUrl'],
  EVENT_REJECTED:          ['OrganizerName', 'EventName', 'ReviewNote', 'SupportEmail'],
  EVENT_CHANGES_REQUESTED: ['OrganizerName', 'EventName', 'ReviewNote', 'DashboardUrl'],
  EVENT_RESUBMITTED:       ['OrganizerName', 'EventName', 'DashboardUrl'],
  SETTLEMENT_APPROVED:     ['OrganizerName', 'Amount', 'SettlementId', 'DashboardUrl'],
  SETTLEMENT_REJECTED:     ['OrganizerName', 'Amount', 'ReviewNote', 'SupportEmail'],
  SETTLEMENT_PAID:         ['OrganizerName', 'Amount', 'SettlementId', 'DashboardUrl'],
  PAYOUT_PROFILE_VERIFIED: ['OrganizerName', 'AccountHolderName', 'DashboardUrl'],
  PAYOUT_PROFILE_REJECTED: ['OrganizerName', 'AccountHolderName', 'ReviewNote', 'SupportEmail'],
  LICENSE_PURCHASED:       ['OrganizerName', 'LicenseName', 'Amount', 'InvoiceNumber', 'DashboardUrl'],
  WALLET_RECHARGED:        ['OrganizerName', 'Amount', 'DashboardUrl'],
  CUSTOM_EMAIL:            ['RecipientName', 'OrganizationName', 'SupportEmail'],
}

/** Channel support subset the builder needs. */
export interface TemplateChannelSupport { email: boolean; whatsapp: boolean; inapp: boolean }

/**
 * Build the platform template bindings for a notification, one per supported channel.
 * PURE. Returns [] when the notification is not a platform notification (no variable contract).
 */
export function buildTemplatesForNotification(
  entry:    CommRegistryEntry,
  supports: TemplateChannelSupport,
): PlatformTemplate[] {
  if (!isPlatformAudience(entry.audience)) return []
  const variables = PLATFORM_TEMPLATE_VARS[entry.id]
  if (!variables) return []

  const channels: TemplateChannel[] = [
    'email',
    ...(supports.whatsapp ? (['whatsapp'] as TemplateChannel[]) : []),
    ...(supports.inapp ? (['inapp'] as TemplateChannel[]) : []),
  ]
  return channels.map(channel => ({
    templateId:     `${entry.id}.${channel}`,
    notificationId: entry.id,
    channel,
    category:       entry.category,
    displayName:    entry.displayName,
    description:    entry.description,
    version:        1,
    status:         'published' as TemplateStatus,
    variables,
    createdAt:      TEMPLATE_CODE_MANAGED_AT,
    updatedAt:      TEMPLATE_CODE_MANAGED_AT,
  }))
}

/** Compute a template's health — validates the variable contract + binding. PURE. */
export function templateHealth(t: PlatformTemplate): TemplateHealth {
  const unknownVariables = t.variables.filter(id => !isKnownVariable(id))
  const bound = Boolean(t.notificationId)
  return {
    templateId:       t.templateId,
    status:           t.status,
    bound,
    unknownVariables,
    missingChannels:  [],   // built per supported channel, so none are missing by construction
    healthy:          bound && unknownVariables.length === 0 && t.status === 'published',
  }
}
