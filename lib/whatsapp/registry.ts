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

/** Verified Meta WhatsApp Manager state — see WhatsAppTemplateDefinition.metaStatus. */
export type MetaTemplateStatus = 'active' | 'in_review' | 'rejected' | 'unverified'

/**
 * Statuses we have POSITIVE evidence cannot deliver, so a send is refused before Meta is
 * called. Deliberately a blocklist, not an allowlist: 'unverified' entries keep their
 * existing behaviour exactly, so introducing this field changes nothing for any template
 * whose Meta state nobody has confirmed.
 */
const NON_SENDABLE: ReadonlySet<MetaTemplateStatus> = new Set(['in_review', 'rejected'])

/** True when this template may be sent — i.e. not known-unsendable. */
export function isSendableMetaStatus(status: MetaTemplateStatus): boolean {
  return !NON_SENDABLE.has(status)
}

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
  /**
   * The template's state in Meta WhatsApp Manager, as VERIFIED BY A HUMAN and recorded
   * here by hand. Nothing synchronises this — there is no Meta template API in this
   * codebase — so it is a manual fact, not a live value, and it is only ever as fresh as
   * the last person who checked the console.
   *
   *   'active'     — approved and sendable.
   *   'in_review'  — submitted, NOT yet approved. Sending fails at Meta with 132001.
   *   'rejected'   — refused by Meta. Must never be sent.
   *   'unverified' — nobody has checked. Behaves exactly as before this field existed:
   *                  the send is attempted and Meta decides.
   */
  metaStatus:         MetaTemplateStatus
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

// ─── LOCALE IS PER TEMPLATE ──────────────────────────────────────────────────
//
// THE RULE: a template's locale MUST match the locale actually configured for it in
// WhatsApp Manager. It is a property of that one template, never a house style — some
// templates on this WABA are legitimately `en` and others `en_US`, and both are correct.
//
// WHY IT MATTERS: WhatsApp resolves a template by the (name, language) PAIR and does NOT
// fall back between locales, so `en` and `en_US` are two different templates as far as
// Meta is concerned. Declaring a locale the WABA does not hold fails at send with 132001
// "Template name does not exist in the translation" — once per recipient, and for a
// broadcast that happens after the campaign has already been billed upfront.
//
// So: never normalise these values in either direction, and never copy a locale from a
// neighbouring entry. Read each one off WhatsApp Manager and record what is actually
// there. Entries still marked `metaStatus: 'unverified'` have not been checked against
// Meta at all; their locale is a guess until someone confirms it in the console.
export const WHATSAPP_TEMPLATE_REGISTRY = {
  REGISTRATION_CONFIRMATION: {
    templateName:      'registration_confirmation',
    // 'en', NOT 'en_US'. WhatsApp resolves a template by the (name, language) PAIR and does
    // not fall back between locales, so requesting a locale the template was not approved in
    // fails at Meta with 132001 "Template name does not exist in the translation". This
    // template is approved on the WABA in `en`; the registry must state the locale Meta
    // actually holds. Other entries keep en_US — only this one was verified against Meta.
    language:          'en',
    languages:         ['en'],
    channels:          ['whatsapp'],
    requiredVariables: ['attendeeName', 'eventName', 'ticketCode'],
    metaStatus:        'active',
    category:          'utility',
    version:           1,
  },
  REGISTRATION_APPROVED: {
    templateName:      'registration_approved',
    language:          'en_US',
    languages:         ['en_US'],
    channels:          ['whatsapp'],
    requiredVariables: ['attendeeName', 'eventName', 'ticketCode'],
    metaStatus:        'unverified',
    category:          'utility',
    version:           1,
  },
  REGISTRATION_REJECTED: {
    templateName:      'registration_rejected',
    language:          'en_US',
    languages:         ['en_US'],
    channels:          ['whatsapp'],
    requiredVariables: ['attendeeName', 'eventName'],
    metaStatus:        'unverified',
    category:          'utility',
    version:           1,
  },
  REGISTRATION_CANCELLED: {
    templateName:      'registration_cancelled',
    language:          'en_US',
    languages:         ['en_US'],
    channels:          ['whatsapp'],
    requiredVariables: ['attendeeName', 'eventName'],
    metaStatus:        'unverified',
    category:          'utility',
    version:           1,
  },
  TICKET_RESENT: {
    templateName:      'ticket_resent',
    language:          'en_US',
    languages:         ['en_US'],
    channels:          ['whatsapp'],
    requiredVariables: ['attendeeName', 'eventName', 'ticketCode'],
    metaStatus:        'unverified',
    category:          'utility',
    version:           1,
  },
  EVENT_CANCELLED: {
    templateName:      'event_cancelled',
    language:          'en_US',
    languages:         ['en_US'],
    channels:          ['whatsapp'],
    requiredVariables: ['attendeeName', 'eventName'],
    metaStatus:        'unverified',
    category:          'utility',
    version:           1,
  },
  EVENT_UPDATED: {
    templateName:      'event_updated',
    language:          'en_US',
    languages:         ['en_US'],
    channels:          ['whatsapp'],
    requiredVariables: ['attendeeName', 'eventName'],
    metaStatus:        'unverified',
    category:          'utility',
    version:           1,
  },
  REFUND_SUCCESS: {
    templateName:      'refund_confirmation',
    language:          'en_US',
    languages:         ['en_US'],
    channels:          ['whatsapp'],
    requiredVariables: ['attendeeName', 'eventName', 'refundAmount'],
    metaStatus:        'unverified',
    category:          'utility',
    version:           1,
  },
  WAITLIST_JOINED: {
    templateName:      'waitlist_joined',
    language:          'en_US',
    languages:         ['en_US'],
    channels:          ['whatsapp'],
    requiredVariables: ['attendeeName', 'eventName'],
    metaStatus:        'unverified',
    category:          'utility',
    version:           1,
  },
  WAITLIST_SPOT_AVAILABLE: {
    templateName:      'waitlist_spot_available',
    language:          'en_US',
    languages:         ['en_US'],
    channels:          ['whatsapp'],
    requiredVariables: ['attendeeName', 'eventName'],
    metaStatus:        'unverified',
    category:          'utility',
    version:           1,
  },
  CERTIFICATE_READY: {
    // v2 — a NEW Meta template, not a re-approval of `certificate_ready`. The parameter
    // count changed from 2 to 3, and Meta matches a template by (name, language) with a
    // fixed variable count: sending 3 parameters to the 2-variable `certificate_ready`
    // fails at the Graph API, so the name must change alongside the contract.
    templateName:      'certificate_ready_v2',
    language:          'en',
    languages:         ['en'],
    channels:          ['whatsapp'],
    // `certificateUrl` is SERVER-DERIVED per campaign (see whatsappJob.ts) — the
    // organizer never types it, so a preview/deployment host can never reach an attendee.
    requiredVariables: ['attendeeName', 'eventName', 'certificateUrl'],
    metaStatus:        'active',
    category:          'utility',
    version:           2,
  },

  // ── Dormant successor to the live registration confirmation ────────────────
  //
  // Registered so the registry describes Meta's ACTUAL template set, and so the eventual
  // migration is a one-line change. It is `in_review`, so the resolver refuses it and it
  // never appears in the broadcast composer. REGISTRATION_CONFIRMATION is unaffected and
  // remains the only template the live registration path resolves.
  REGISTRATION_CONFIRMATION_V2: {
    templateName:      'registration_confirmation_v2',
    language:          'en',
    languages:         ['en'],
    channels:          ['whatsapp'],
    requiredVariables: ['attendeeName', 'eventName', 'ticketCode'],
    metaStatus:        'in_review',
    category:          'utility',
    version:           2,
  },
  // ── Operational broadcasts (RD-WA-BROADCAST-02) ────────────────────────────
  //
  // Both are organizer-composed broadcasts: `attendeeName` and `eventName` are filled
  // per recipient by the broadcast job, and every remaining variable is typed by the
  // organizer in the composer, which renders one input per non-auto variable straight
  // from the tuple below. Ordering IS the contract — position maps to {{1}}, {{2}}, …
  // in the approved Meta template, so reordering these silently reshuffles a live message.
  KIT_COLLECTION: {
    // `kit_collection` (no suffix) was REJECTED by Meta and is deliberately NOT registered
    // anywhere — a rejected name must never become a selectable broadcast option.
    templateName:      'kit_collection_v2',
    // English (US) — this template ALONE. Meta resolves by the (name, language) PAIR and
    // never falls back, so this locale is not interchangeable with its `en` siblings.
    language:          'en_US',
    languages:         ['en_US'],
    channels:          ['whatsapp'],
    requiredVariables: ['attendeeName', 'eventName', 'collectionDate', 'collectionTime', 'collectionLocation', 'mapsUrl'],
    metaStatus:        'active',
    category:          'utility',
    version:           1,
  },
  EVENT_LOCATION: {
    templateName:      'event_location_v2',
    language:          'en',
    languages:         ['en'],
    channels:          ['whatsapp'],
    requiredVariables: ['attendeeName', 'eventName', 'eventDate', 'eventTime', 'venue', 'mapsUrl'],
    metaStatus:        'active',
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
    metaStatus:        'unverified',
    category:          'utility',
    version:           1,
  },
  EVENT_APPROVED: {
    templateName:      'organizer_event_approved',
    language:          'en_US',
    languages:         ['en_US'],
    channels:          ['whatsapp'],
    requiredVariables: ['eventName'],
    metaStatus:        'unverified',
    category:          'utility',
    version:           1,
  },
  EVENT_REJECTED: {
    templateName:      'organizer_event_rejected',
    language:          'en_US',
    languages:         ['en_US'],
    channels:          ['whatsapp'],
    requiredVariables: ['eventName'],
    metaStatus:        'unverified',
    category:          'utility',
    version:           1,
  },
  EVENT_CHANGES_REQUESTED: {
    templateName:      'organizer_event_changes_requested',
    language:          'en_US',
    languages:         ['en_US'],
    channels:          ['whatsapp'],
    requiredVariables: ['eventName'],
    metaStatus:        'unverified',
    category:          'utility',
    version:           1,
  },
  EVENT_RESUBMITTED: {
    templateName:      'organizer_event_resubmitted',
    language:          'en_US',
    languages:         ['en_US'],
    channels:          ['whatsapp'],
    requiredVariables: ['eventName'],
    metaStatus:        'unverified',
    category:          'utility',
    version:           1,
  },
  SETTLEMENT_APPROVED: {
    templateName:      'organizer_settlement_ready',
    language:          'en_US',
    languages:         ['en_US'],
    channels:          ['whatsapp'],
    requiredVariables: ['organizerName', 'amount'],
    metaStatus:        'unverified',
    category:          'utility',
    version:           1,
  },
  LICENSE_PURCHASED: {
    templateName:      'organizer_license_purchased',
    language:          'en_US',
    languages:         ['en_US'],
    channels:          ['whatsapp'],
    requiredVariables: ['organizerName', 'eventName', 'tierName'],
    metaStatus:        'unverified',
    category:          'utility',
    version:           1,
  },
  WALLET_RECHARGED: {
    templateName:      'organizer_wallet_recharged',
    language:          'en_US',
    languages:         ['en_US'],
    channels:          ['whatsapp'],
    requiredVariables: ['organizerName', 'amount'],
    metaStatus:        'unverified',
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

  // THE ONE PLACE AN UNAPPROVED TEMPLATE IS STOPPED.
  //
  // Every sender — transactional, broadcast and retry — passes through this resolver, so
  // gating here covers all of them at once rather than trusting each caller to check.
  // Refusing BEFORE the provider is called also means Meta is never asked, no wallet is
  // debited, and a broadcast fails at creation instead of per-recipient after billing.
  //
  // Only states we have POSITIVE evidence about are blocked ('in_review', 'rejected').
  // An 'unverified' template behaves exactly as it did before this gate existed.
  if (!isSendableMetaStatus(entry.metaStatus)) {
    return {
      ok: false,
      error: entry.metaStatus === 'rejected'
        ? `The WhatsApp template for "${type}" was rejected by Meta and cannot be sent.`
        : `The WhatsApp template for "${type}" is still awaiting Meta approval.`,
    }
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
