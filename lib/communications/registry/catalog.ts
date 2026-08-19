// RD-PLATFORM-COMMS-01 Phase 4C — the canonical Communication Registry (catalog).
//
// ONE declarative source of truth describing EVERY RegisterDesk notification. Keyed by the
// existing NotificationType enum (referenced, never re-declared), it adds the descriptive
// metadata that lives nowhere else today — category, display name, description, trigger,
// audience, priority, mandatory, in-app support, template key, and a reserved future-rule key.
//
// It does NOT duplicate runtime wiring: channel SUPPORT (email/whatsapp) and per-channel
// ENABLED state are DERIVED at resolve time from the real sources (the email dispatchers, the
// WhatsApp template registry, and the communication config) — see ./resolve. This file is pure
// and isomorphic. Nothing here sends, routes, or changes behavior; it only describes.

import { NotificationType } from '@/lib/notifications/catalog'

export type CommRegistryCategory =
  | 'account' | 'security' | 'licensing' | 'billing' | 'platform'
  | 'events'  | 'communication' | 'compliance' | 'marketing' | 'system'

export type CommRegistryAudience = 'user' | 'organizer' | 'attendee' | 'donor' | 'applicant'
export type CommRegistryPriority = 'high' | 'medium' | 'low'

/** A canonical registry entry's declarative metadata (the parts that live only here). */
export interface CommRegistryEntry {
  id:            NotificationType
  category:      CommRegistryCategory
  displayName:   string
  description:   string
  trigger:       string
  audience:      CommRegistryAudience
  priority:      CommRegistryPriority
  mandatory:     boolean          // mandatory ignore opt-out; optional respect it (future rules engine)
  supportsInApp: boolean          // has an in-app inbox entry (organizer feed)
  templateKey:   string           // logical template identity (email template / render key)
  futureRuleKey: string           // reserved key for the Phase-4+ rules engine (dotted namespace)
}

const T = NotificationType

/** THE canonical catalog. Every NotificationType appears exactly once. */
export const COMMUNICATION_REGISTRY: CommRegistryEntry[] = [
  // ── Account ─────────────────────────────────────────────────────────────────
  { id: T.EMAIL_VERIFICATION, category: 'security', displayName: 'Email Verification', description: 'One-time code to verify a new account email.', trigger: 'Signup / email change', audience: 'user', priority: 'high', mandatory: true, supportsInApp: false, templateKey: 'otp', futureRuleKey: 'account.email_verification' },
  { id: T.ACCOUNT_WELCOME, category: 'account', displayName: 'Welcome', description: 'Welcomes a newly verified account.', trigger: 'Account verified', audience: 'user', priority: 'medium', mandatory: false, supportsInApp: false, templateKey: 'welcome', futureRuleKey: 'account.welcome' },

  // ── Events (review workflow, platform → organizer) ───────────────────────────
  { id: T.EVENT_SUBMITTED, category: 'events', displayName: 'Event Submitted', description: 'Confirms an event was submitted for review.', trigger: 'Organizer submits event', audience: 'organizer', priority: 'high', mandatory: true, supportsInApp: true, templateKey: 'review', futureRuleKey: 'event.submitted' },
  { id: T.EVENT_APPROVED, category: 'events', displayName: 'Event Approved', description: 'Event cleared review and is live-eligible.', trigger: 'Admin approves event', audience: 'organizer', priority: 'high', mandatory: true, supportsInApp: true, templateKey: 'review', futureRuleKey: 'event.approved' },
  { id: T.EVENT_REJECTED, category: 'events', displayName: 'Event Rejected', description: 'Event was rejected in review.', trigger: 'Admin rejects event', audience: 'organizer', priority: 'high', mandatory: true, supportsInApp: true, templateKey: 'review', futureRuleKey: 'event.rejected' },
  { id: T.EVENT_CHANGES_REQUESTED, category: 'events', displayName: 'Changes Requested', description: 'Reviewer requested changes before approval.', trigger: 'Admin requests changes', audience: 'organizer', priority: 'high', mandatory: true, supportsInApp: true, templateKey: 'review', futureRuleKey: 'event.changes_requested' },
  { id: T.EVENT_RESUBMITTED, category: 'events', displayName: 'Event Resubmitted', description: 'Confirms a revised event was resubmitted.', trigger: 'Organizer resubmits event', audience: 'organizer', priority: 'medium', mandatory: true, supportsInApp: true, templateKey: 'review', futureRuleKey: 'event.resubmitted' },

  // ── Communication (registration lifecycle, organizer → attendee) ─────────────
  { id: T.REGISTRATION_CONFIRMATION, category: 'communication', displayName: 'Registration Confirmation', description: 'Confirms a successful registration + ticket.', trigger: 'Attendee registers / pays', audience: 'attendee', priority: 'high', mandatory: true, supportsInApp: false, templateKey: 'registration', futureRuleKey: 'registration.confirmation' },
  { id: T.REGISTRATION_APPROVED, category: 'communication', displayName: 'Registration Approved', description: 'Manual-approval registration approved.', trigger: 'Organizer approves registration', audience: 'attendee', priority: 'high', mandatory: true, supportsInApp: false, templateKey: 'registration', futureRuleKey: 'registration.approved' },
  { id: T.REGISTRATION_REJECTED, category: 'communication', displayName: 'Registration Rejected', description: 'Manual-approval registration rejected.', trigger: 'Organizer rejects registration', audience: 'attendee', priority: 'medium', mandatory: true, supportsInApp: false, templateKey: 'rejected', futureRuleKey: 'registration.rejected' },
  { id: T.REGISTRATION_CANCELLED, category: 'communication', displayName: 'Registration Cancelled', description: 'Notifies an attendee their registration was cancelled.', trigger: 'Registration cancelled', audience: 'attendee', priority: 'medium', mandatory: true, supportsInApp: false, templateKey: 'registration-cancelled', futureRuleKey: 'registration.cancelled' },
  { id: T.TICKET_RESENT, category: 'communication', displayName: 'Ticket Resent', description: 'Re-sends an attendee ticket on request.', trigger: 'Ticket resend requested', audience: 'attendee', priority: 'medium', mandatory: false, supportsInApp: false, templateKey: 'ticket', futureRuleKey: 'registration.ticket_resent' },
  { id: T.EVENT_CANCELLED, category: 'communication', displayName: 'Event Cancelled', description: 'Notifies attendees the event was cancelled.', trigger: 'Event cancelled', audience: 'attendee', priority: 'high', mandatory: true, supportsInApp: false, templateKey: 'cancelled', futureRuleKey: 'event.cancelled_attendee' },
  { id: T.EVENT_UPDATED, category: 'communication', displayName: 'Event Updated', description: 'Notifies attendees of important event changes.', trigger: 'Significant event edit', audience: 'attendee', priority: 'medium', mandatory: false, supportsInApp: false, templateKey: 'updated', futureRuleKey: 'event.updated_attendee' },
  { id: T.REFUND_SUCCESS, category: 'billing', displayName: 'Refund Processed', description: 'Confirms a refund to an attendee.', trigger: 'Refund completes', audience: 'attendee', priority: 'high', mandatory: true, supportsInApp: false, templateKey: 'refund', futureRuleKey: 'billing.refund_success' },
  { id: T.WAITLIST_JOINED, category: 'communication', displayName: 'Waitlist Joined', description: 'Confirms an attendee joined the waitlist.', trigger: 'Attendee joins waitlist', audience: 'attendee', priority: 'low', mandatory: false, supportsInApp: false, templateKey: 'waitlist-joined', futureRuleKey: 'waitlist.joined' },
  { id: T.WAITLIST_SPOT_AVAILABLE, category: 'communication', displayName: 'Spot Available', description: 'Notifies a waitlisted attendee a spot opened.', trigger: 'Waitlist spot frees up', audience: 'attendee', priority: 'high', mandatory: false, supportsInApp: false, templateKey: 'spot-available', futureRuleKey: 'waitlist.spot_available' },
  { id: T.CERTIFICATE_READY, category: 'communication', displayName: 'Certificate Ready', description: 'Delivers a participation certificate.', trigger: 'Certificate generated', audience: 'attendee', priority: 'medium', mandatory: false, supportsInApp: false, templateKey: 'certificate', futureRuleKey: 'certificate.ready' },

  // ── Operational broadcasts (RD-WA-BROADCAST-02) — WhatsApp only ──────────────
  // Organizer-composed and sent from the Broadcasts screen rather than fired by a
  // system event, so `trigger` names the human action. No email template exists for
  // either (see EMAIL_DISPATCHERS), hence templateKey 'broadcast'.
  { id: T.REGISTRATION_CONFIRMATION_V2, category: 'communication', displayName: 'Registration Confirmation (v2, dormant)', description: 'Successor registration template held dormant pending Meta approval. Not dispatched.', trigger: 'Not dispatched — awaiting Meta approval and a deliberate migration', audience: 'attendee', priority: 'high', mandatory: false, supportsInApp: false, templateKey: 'registration', futureRuleKey: 'registration.confirmation_v2' },
  { id: T.KIT_COLLECTION, category: 'communication', displayName: 'Kit Collection', description: 'Tells attendees where and when to collect their event kit.', trigger: 'Organizer sends a kit-collection broadcast', audience: 'attendee', priority: 'medium', mandatory: false, supportsInApp: false, templateKey: 'broadcast', futureRuleKey: 'event.kit_collection' },
  { id: T.EVENT_LOCATION, category: 'communication', displayName: 'Event Location', description: 'Sends attendees the venue, date and time of the event.', trigger: 'Organizer sends an event-location broadcast', audience: 'attendee', priority: 'medium', mandatory: false, supportsInApp: false, templateKey: 'broadcast', futureRuleKey: 'event.location' },

  // ── Compliance / Billing (donations) ─────────────────────────────────────────
  { id: T.DONATION_RECEIPT, category: 'billing', displayName: 'Donation Receipt', description: 'Payment receipt for a donation.', trigger: 'Donation succeeds', audience: 'donor', priority: 'high', mandatory: true, supportsInApp: false, templateKey: 'donation-receipt', futureRuleKey: 'donation.receipt' },
  { id: T.DONATION_80G_RECEIPT, category: 'compliance', displayName: '80G Tax Receipt', description: 'Tax-exemption (80G) receipt for a donation.', trigger: 'Donation succeeds (80G-eligible)', audience: 'donor', priority: 'high', mandatory: true, supportsInApp: false, templateKey: 'donation-80g', futureRuleKey: 'compliance.donation_80g' },

  // ── Events (speaker / sponsor applications) ──────────────────────────────────
  { id: T.APPLICATION_RECEIVED, category: 'events', displayName: 'Application Received', description: 'Confirms a speaker/sponsor application.', trigger: 'Application submitted', audience: 'applicant', priority: 'medium', mandatory: false, supportsInApp: false, templateKey: 'application', futureRuleKey: 'application.received' },
  { id: T.APPLICATION_STATUS, category: 'events', displayName: 'Application Status', description: 'Updates an applicant on their status.', trigger: 'Application status changes', audience: 'applicant', priority: 'medium', mandatory: false, supportsInApp: false, templateKey: 'application', futureRuleKey: 'application.status' },

  // ── Billing (settlement & payout, platform → organizer) ──────────────────────
  { id: T.SETTLEMENT_APPROVED, category: 'billing', displayName: 'Settlement Approved', description: 'A payout settlement was approved.', trigger: 'Admin approves settlement', audience: 'organizer', priority: 'high', mandatory: true, supportsInApp: true, templateKey: 'settlement', futureRuleKey: 'billing.settlement_approved' },
  { id: T.SETTLEMENT_REJECTED, category: 'billing', displayName: 'Settlement Rejected', description: 'A payout settlement was rejected.', trigger: 'Admin rejects settlement', audience: 'organizer', priority: 'high', mandatory: true, supportsInApp: true, templateKey: 'settlement', futureRuleKey: 'billing.settlement_rejected' },
  { id: T.SETTLEMENT_PAID, category: 'billing', displayName: 'Settlement Paid', description: 'A settlement was paid out.', trigger: 'Settlement paid', audience: 'organizer', priority: 'high', mandatory: true, supportsInApp: true, templateKey: 'settlement', futureRuleKey: 'billing.settlement_paid' },
  { id: T.PAYOUT_PROFILE_VERIFIED, category: 'billing', displayName: 'Payout Profile Verified', description: 'Organizer payout profile was verified.', trigger: 'Admin verifies payout profile', audience: 'organizer', priority: 'medium', mandatory: true, supportsInApp: true, templateKey: 'payout-profile', futureRuleKey: 'billing.payout_verified' },
  { id: T.PAYOUT_PROFILE_REJECTED, category: 'billing', displayName: 'Payout Profile Rejected', description: 'Organizer payout profile was rejected.', trigger: 'Admin rejects payout profile', audience: 'organizer', priority: 'medium', mandatory: true, supportsInApp: true, templateKey: 'payout-profile', futureRuleKey: 'billing.payout_rejected' },

  // ── Licensing / Billing (platform → organizer) ───────────────────────────────
  { id: T.LICENSE_PURCHASED, category: 'licensing', displayName: 'License Purchased', description: 'Confirms an event license purchase.', trigger: 'License checkout confirmed', audience: 'organizer', priority: 'high', mandatory: true, supportsInApp: true, templateKey: 'organizer', futureRuleKey: 'licensing.purchased' },
  { id: T.WALLET_RECHARGED, category: 'billing', displayName: 'Wallet Recharged', description: 'Confirms a communication-wallet top-up.', trigger: 'Wallet top-up verified', audience: 'organizer', priority: 'medium', mandatory: false, supportsInApp: true, templateKey: 'organizer', futureRuleKey: 'billing.wallet_recharged' },

  // ── Marketing / free-form ────────────────────────────────────────────────────
  { id: T.CUSTOM_EMAIL, category: 'marketing', displayName: 'Custom Email', description: 'Ad-hoc rendered email (team invites, one-offs).', trigger: 'Programmatic custom send', audience: 'organizer', priority: 'low', mandatory: false, supportsInApp: false, templateKey: 'custom', futureRuleKey: 'marketing.custom_email' },
  { id: T.BROADCAST, category: 'marketing', displayName: 'Broadcast', description: 'Organizer broadcast campaign to attendees.', trigger: 'Broadcast campaign send', audience: 'attendee', priority: 'low', mandatory: false, supportsInApp: false, templateKey: 'custom', futureRuleKey: 'marketing.broadcast' },
]

/** Ordered category list for grouped display. */
export const COMM_REGISTRY_CATEGORIES: CommRegistryCategory[] = [
  'account', 'security', 'licensing', 'billing', 'platform',
  'events', 'communication', 'compliance', 'marketing', 'system',
]

const BY_ID: Record<string, CommRegistryEntry> = Object.fromEntries(
  COMMUNICATION_REGISTRY.map(e => [e.id, e]),
)

/** Canonical lookup by NotificationType. */
export function getRegistryEntry(id: NotificationType): CommRegistryEntry | undefined {
  return BY_ID[id]
}
