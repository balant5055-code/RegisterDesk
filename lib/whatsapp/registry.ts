// WhatsApp Template Registry — the single source of truth mapping NotificationType
// to approved Meta WhatsApp templates. This is the ONLY place template names,
// languages, categories, versions and variable contracts live. Business logic
// resolves a NotificationType through here and never sees a template name.
//
// Phase G3.3 is foundation-only: this registry + resolver exist and are strongly
// typed, but nothing is wired into the Notification Engine and no message is sent.
//
// Adding/altering a template = edit THIS file only. A future v2 of any template
// bumps that entry's `version` + `templateName`; because callers resolve by
// NotificationType (never by name), business logic never changes.

import type { NotificationType } from '@/lib/notifications'
import type { NotificationChannel } from '@/lib/notifications/channels'
import type { WhatsAppTemplateMessage, WhatsAppParameter } from './types'

// Meta template categories (WhatsApp Manager taxonomy).
export type WhatsAppTemplateCategory = 'utility' | 'marketing' | 'authentication'

export interface WhatsAppTemplateDefinition {
  /** The approved template name in Meta WhatsApp Manager. */
  templateName:       string
  /** Default language/locale code (e.g. "en_US"). */
  language:           string
  /** All languages the template is approved in (used for validation). */
  languages:          readonly string[]
  /** Channels this notification supports. WhatsApp entries include 'whatsapp'. */
  channels:           readonly NotificationChannel[]
  /** Ordered body variables — position maps to the template's {{1}}, {{2}}, … */
  requiredVariables:  readonly string[]
  category:           WhatsAppTemplateCategory
  /** Template contract version. Bump alongside templateName for a v2. */
  version:            number
}

// Registry-level version. Individual entries also carry their own `version`.
export const WHATSAPP_TEMPLATE_REGISTRY_VERSION = 1

// ─── The registry ──────────────────────────────────────────────────────────────
//
// Scope (STEP 1): the organizer→attendee operational notifications that will
// realistically use WhatsApp. Platform→organizer and marketing notifications are
// intentionally NOT registered here yet (email-only today) — add them when their
// Meta templates are approved. `as const` freezes the variable tuples so the
// compiler can enforce the variable contract; `satisfies` proves every key is a
// real NotificationType and every entry matches the definition shape.

export const WHATSAPP_TEMPLATE_REGISTRY = {
  REGISTRATION_CONFIRMATION: {
    templateName:      'registration_confirmation',
    language:          'en_US',
    languages:         ['en_US'],
    channels:          ['whatsapp'],
    requiredVariables: ['attendeeName', 'eventName', 'ticketCode'],
    category:          'utility',
    version:           1,
  },
  REGISTRATION_APPROVED: {
    templateName:      'registration_approved',
    language:          'en_US',
    languages:         ['en_US'],
    channels:          ['whatsapp'],
    requiredVariables: ['attendeeName', 'eventName', 'ticketCode'],
    category:          'utility',
    version:           1,
  },
  REGISTRATION_REJECTED: {
    templateName:      'registration_rejected',
    language:          'en_US',
    languages:         ['en_US'],
    channels:          ['whatsapp'],
    requiredVariables: ['attendeeName', 'eventName'],
    category:          'utility',
    version:           1,
  },
  REGISTRATION_CANCELLED: {
    templateName:      'registration_cancelled',
    language:          'en_US',
    languages:         ['en_US'],
    channels:          ['whatsapp'],
    requiredVariables: ['attendeeName', 'eventName'],
    category:          'utility',
    version:           1,
  },
  TICKET_RESENT: {
    templateName:      'ticket_resent',
    language:          'en_US',
    languages:         ['en_US'],
    channels:          ['whatsapp'],
    requiredVariables: ['attendeeName', 'eventName', 'ticketCode'],
    category:          'utility',
    version:           1,
  },
  EVENT_CANCELLED: {
    templateName:      'event_cancelled',
    language:          'en_US',
    languages:         ['en_US'],
    channels:          ['whatsapp'],
    requiredVariables: ['attendeeName', 'eventName'],
    category:          'utility',
    version:           1,
  },
  EVENT_UPDATED: {
    templateName:      'event_updated',
    language:          'en_US',
    languages:         ['en_US'],
    channels:          ['whatsapp'],
    requiredVariables: ['attendeeName', 'eventName'],
    category:          'utility',
    version:           1,
  },
  REFUND_SUCCESS: {
    templateName:      'refund_confirmation',
    language:          'en_US',
    languages:         ['en_US'],
    channels:          ['whatsapp'],
    requiredVariables: ['attendeeName', 'eventName', 'refundAmount'],
    category:          'utility',
    version:           1,
  },
  WAITLIST_JOINED: {
    templateName:      'waitlist_joined',
    language:          'en_US',
    languages:         ['en_US'],
    channels:          ['whatsapp'],
    requiredVariables: ['attendeeName', 'eventName'],
    category:          'utility',
    version:           1,
  },
  WAITLIST_SPOT_AVAILABLE: {
    templateName:      'waitlist_spot_available',
    language:          'en_US',
    languages:         ['en_US'],
    channels:          ['whatsapp'],
    requiredVariables: ['attendeeName', 'eventName'],
    category:          'utility',
    version:           1,
  },
  CERTIFICATE_READY: {
    templateName:      'certificate_ready',
    language:          'en_US',
    languages:         ['en_US'],
    channels:          ['whatsapp'],
    requiredVariables: ['attendeeName', 'eventName'],
    category:          'utility',
    version:           1,
  },

  // ── Platform → Organizer (Phase G3.5) — FREE, never wallet-charged ──────────
  EVENT_SUBMITTED: {
    templateName:      'organizer_event_submitted',
    language:          'en_US',
    languages:         ['en_US'],
    channels:          ['whatsapp'],
    requiredVariables: ['eventName'],
    category:          'utility',
    version:           1,
  },
  EVENT_APPROVED: {
    templateName:      'organizer_event_approved',
    language:          'en_US',
    languages:         ['en_US'],
    channels:          ['whatsapp'],
    requiredVariables: ['eventName'],
    category:          'utility',
    version:           1,
  },
  EVENT_REJECTED: {
    templateName:      'organizer_event_rejected',
    language:          'en_US',
    languages:         ['en_US'],
    channels:          ['whatsapp'],
    requiredVariables: ['eventName'],
    category:          'utility',
    version:           1,
  },
  EVENT_CHANGES_REQUESTED: {
    templateName:      'organizer_event_changes_requested',
    language:          'en_US',
    languages:         ['en_US'],
    channels:          ['whatsapp'],
    requiredVariables: ['eventName'],
    category:          'utility',
    version:           1,
  },
  EVENT_RESUBMITTED: {
    templateName:      'organizer_event_resubmitted',
    language:          'en_US',
    languages:         ['en_US'],
    channels:          ['whatsapp'],
    requiredVariables: ['eventName'],
    category:          'utility',
    version:           1,
  },
  SETTLEMENT_APPROVED: {
    templateName:      'organizer_settlement_ready',
    language:          'en_US',
    languages:         ['en_US'],
    channels:          ['whatsapp'],
    requiredVariables: ['organizerName', 'amount'],
    category:          'utility',
    version:           1,
  },
  LICENSE_PURCHASED: {
    templateName:      'organizer_license_purchased',
    language:          'en_US',
    languages:         ['en_US'],
    channels:          ['whatsapp'],
    requiredVariables: ['organizerName', 'eventName', 'tierName'],
    category:          'utility',
    version:           1,
  },
  WALLET_RECHARGED: {
    templateName:      'organizer_wallet_recharged',
    language:          'en_US',
    languages:         ['en_US'],
    channels:          ['whatsapp'],
    requiredVariables: ['organizerName', 'amount'],
    category:          'utility',
    version:           1,
  },
} as const satisfies Partial<Record<NotificationType, WhatsAppTemplateDefinition>>

// ─── Types derived from the registry ───────────────────────────────────────────

/** Notification types that have a registered WhatsApp template. */
export type WhatsAppTemplateType = keyof typeof WHATSAPP_TEMPLATE_REGISTRY

/**
 * The exact variable object a given template requires. Omitting any required
 * variable is a COMPILE ERROR (STEP 3): the keys come straight from the registry's
 * frozen `requiredVariables` tuple.
 */
export type TemplateVariables<T extends WhatsAppTemplateType> =
  Record<(typeof WHATSAPP_TEMPLATE_REGISTRY)[T]['requiredVariables'][number], string>

// ─── Accessors ─────────────────────────────────────────────────────────────────

/** Runtime existence guard — for callers holding a plain NotificationType string. */
export function hasWhatsAppTemplate(type: string): type is WhatsAppTemplateType {
  return Object.prototype.hasOwnProperty.call(WHATSAPP_TEMPLATE_REGISTRY, type)
}

/** The (widened) definition for a registered type. */
export function getWhatsAppTemplate(type: WhatsAppTemplateType): WhatsAppTemplateDefinition {
  return WHATSAPP_TEMPLATE_REGISTRY[type]
}

// ─── Resolver (STEP 4/5) ───────────────────────────────────────────────────────

export type ResolveTemplateResult =
  | { ok: true;  message: WhatsAppTemplateMessage }
  | { ok: false; error: string; missing?: string[] }

/**
 * Resolve a NotificationType + variables into a ready-to-send WhatsAppTemplateMessage.
 * This is the seam business logic uses — it never names a template.
 *
 * Compile time: `variables` must contain every required key (TemplateVariables<T>).
 * Runtime (STEP 5, before the provider is ever called): verifies the template
 * exists, WhatsApp is a supported channel, the language is available, a recipient
 * is present, and no required variable is blank. Never throws — returns a result.
 */
export function resolveWhatsAppTemplate<T extends WhatsAppTemplateType>(
  type: T,
  to: string,
  variables: TemplateVariables<T>,
  opts?: { languageCode?: string },
): ResolveTemplateResult {
  return resolveWhatsAppTemplateByType(type, to, variables as Record<string, string>, opts)
}

/**
 * Runtime (non-generic) resolver for DYNAMIC dispatch — when the notification type
 * is a `NotificationType` value rather than a string literal (e.g. organizer
 * lifecycle notifications routed by kind). Identical validation to the typed
 * resolver above; compile-time variable enforcement is not available on this path,
 * so it relies on the runtime "required variables" check.
 */
export function resolveWhatsAppTemplateByType(
  type: WhatsAppTemplateType,
  to: string,
  variables: Record<string, string>,
  opts?: { languageCode?: string },
): ResolveTemplateResult {
  const entry = getWhatsAppTemplate(type)

  if (!entry.channels.includes('whatsapp')) {
    return { ok: false, error: `Notification "${type}" does not support WhatsApp` }
  }
  if (!to || !to.trim()) {
    return { ok: false, error: 'Missing recipient phone number' }
  }

  const languageCode = opts?.languageCode ?? entry.language
  if (!entry.languages.includes(languageCode)) {
    return { ok: false, error: `Language "${languageCode}" is not available for "${type}"` }
  }

  const vars = variables as Record<string, string>
  const missing = entry.requiredVariables.filter((k) => {
    const v = vars[k]
    return v === undefined || v === null || String(v).trim() === ''
  })
  if (missing.length) {
    return { ok: false, error: `Missing required variables: ${missing.join(', ')}`, missing: [...missing] }
  }

  // Ordered body parameters — positional map to the template's {{1}}, {{2}}, …
  const bodyParameters: WhatsAppParameter[] = entry.requiredVariables.map((k) => ({
    type: 'text',
    text: String(vars[k]),
  }))

  return {
    ok: true,
    message: {
      to,
      templateName: entry.templateName,
      languageCode,
      bodyParameters,
    },
  }
}
