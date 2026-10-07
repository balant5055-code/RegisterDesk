// Security & trust content for /security — the canonical security page.
//
// Every "shipped" statement maps to REAL product functionality. NO compliance/certification
// claims (no SOC 2 / ISO 27001), NO PCI claim, NO uptime claims, NO fabricated statistics or
// infrastructure. Future items are never presented as available: they carry
// `status: 'coming_soon'`, which the page forwards and CapabilityGrid renders as a
// "Coming soon" badge.
//
// ═══ WHAT WAS REMOVED, AND WHY ═══════════════════════════════════════════════
// Two things, both dead rather than wrong:
//
//   • Seven exports — SECURITY_TRUST_HEADING / _ITEMS / _STRIP, SECURITY_ITEMS,
//     SECURITY_HEADING, SECURITY_GROUPS and the SecurityTrustItem interface. They fed a
//     homepage security section that was deleted when the marketing homepage was retired;
//     nothing has imported them since. They were a second, drifting copy of the same claims
//     — SECURITY_ITEMS still described audit logs as "tamper-evident", a stronger word than
//     the append-only-with-server-timestamp trail below actually earns.
//
//   • The `href` on every capability. Six of them pointed at routes that do not exist
//     (/platform/communications once, /roadmap five times). They rendered nothing —
//     toItems() drops the field and CapabilityGrid has no href prop — so they were never
//     broken links in a browser, just a loaded gun: wiring the field up later would have
//     shipped six 404s from the page whose job is being trustworthy. The field is gone
//     rather than repointed, because there is nothing correct to point it at.

import type { SecurityCapabilityDef } from '@/lib/marketing/types'

// Shipped capabilities — each backed by real product functionality.
export const SECURITY_CAPABILITIES: SecurityCapabilityDef[] = [
  { id: 'rbac',                title: 'Role-based access',             description: 'Granular team roles keep each member — admin, manager, check-in, finance — to exactly what they need.', iconKey: 'lock',          status: 'available' },
  { id: 'workspace-isolation', title: 'Workspace isolation',          description: "Every organizer's data is scoped to its own workspace, isolated from others.",                       iconKey: 'security',      status: 'available' },
  { id: 'event-isolation',     title: 'Event-level isolation',        description: "Each event's registrations, finances, and participants are scoped and separated within your workspace.", iconKey: 'domains',     status: 'available' },
  { id: 'audit',               title: 'Audit history',                description: 'Key actions — registration, identifier, refund, certificate — are recorded with a timestamped history.', iconKey: 'verify',        status: 'available' },
  { id: 'secure-payments',     title: 'Secure payments',              description: 'Payments run through Razorpay; card data is never stored on RegisterDesk.',                            iconKey: 'payments',      status: 'available' },
  { id: 'transaction-history', title: 'Transaction history',          description: 'Every payment, refund, and settlement is recorded for review.',                                        iconKey: 'finance',       status: 'available' },
  { id: 'identifier-integrity',title: 'Participant identifier integrity', description: 'The identifier engine prevents duplicates with locks and keeps a full assignment history.',         iconKey: 'identifier',    status: 'available' },
  { id: 'verified-email',      title: 'Verified email',               description: 'Account access uses verified email sign-in, and attendees receive confirmations at their address.',     iconKey: 'communications', status: 'available' },
  { id: 'data-ownership',      title: 'Data ownership',               description: 'Your data stays yours — export participants and reports to CSV on demand.',                             iconKey: 'reports',       status: 'available' },
  // Carried over from /platform/security when that page was consolidated into this one, and
  // TRIMMED on the way. The original card said "managed, replicated cloud infrastructure".
  // "Managed" is provable — lib/firebase/admin.ts runs on Google Cloud Firestore. "Replicated"
  // is not: no locationId is declared in .firebaserc or firebase.json, so whether the database
  // is multi-region or single-region is not established anywhere in this repository. A trust
  // page is the last place to carry a durability guarantee nobody can check, so the word is
  // gone rather than softened. Restore it only against a declared multi-region configuration.
  { id: 'managed-infrastructure', title: 'Managed infrastructure',    description: 'RegisterDesk runs on Google Cloud, with data stored in the managed Firestore database service.',       iconKey: 'workspace',     status: 'available' },
]

// Future-ready — NOT shipped. Always rendered with a "Coming soon" badge.
export const SECURITY_FUTURE: SecurityCapabilityDef[] = [
  { id: 'sso',        title: 'Single sign-on (SSO)',        description: 'Sign in through your organization’s identity provider.',          iconKey: 'lock',      status: 'coming_soon' },
  { id: 'mfa',        title: 'Two-factor authentication',   description: 'An additional verification step at sign-in.',                     iconKey: 'security',  status: 'coming_soon' },
  { id: 'scim',       title: 'SCIM provisioning',           description: 'Automated team provisioning and de-provisioning.',                iconKey: 'workspace', status: 'coming_soon' },
  { id: 'compliance', title: 'Enterprise compliance',       description: 'A formal compliance program — no certifications are claimed yet.', iconKey: 'verify',   status: 'coming_soon' },
  { id: 'byok',       title: 'Bring your own key',          description: 'Customer-managed encryption keys for organizations that need them.',          iconKey: 'domains',   status: 'coming_soon' },
]
