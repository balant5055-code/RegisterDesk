// Phase P.1.3 — Security & trust content (factual; maps to shipped controls).
// Phase P.1.6.8 — adds SECURITY_CAPABILITIES (shipped) and SECURITY_FUTURE
// (clearly-labelled, Coming soon) for the Security & Reliability section. Every
// "shipped" statement maps to REAL product functionality. NO compliance/
// certification claims (no SOC 2 / ISO 27001), NO PCI claim, NO uptime claims,
// NO fabricated statistics or infrastructure. Future items are never shown as
// available.

import type { SecurityItem, SecurityCapabilityDef } from '@/lib/marketing/types'

// ── Compact homepage trust section (P.security refactor) ─────────────────────
// A short enterprise-trust block: heading + six one-line assurances + a trust
// strip. Named services map to real infrastructure; no compliance/uptime claims.

export const SECURITY_TRUST_HEADING = {
  eyebrow:     'Security & reliability',
  title:       'Built for organizations that cannot afford mistakes',
  description: 'Every registration, payment, participant, certificate, and payout is protected by enterprise-grade security built into RegisterDesk.',
}

export interface SecurityTrustItem {
  id:    string
  title: string
  line:  string
  /** Maps to a lucide icon in the section component's ICONS table. */
  icon:  string
}

export const SECURITY_TRUST_ITEMS: SecurityTrustItem[] = [
  { id: 'rbac',       title: 'Role-based Access',       line: 'Granular permissions for every team member.', icon: 'access' },
  { id: 'isolation',  title: 'Workspace Isolation',     line: 'Every organizer has isolated data.',          icon: 'isolation' },
  { id: 'payments',   title: 'Secure Payments',         line: 'Payments processed securely through Razorpay.', icon: 'payments' },
  { id: 'audit',      title: 'Audit Logs',              line: 'Every important action is traceable.',        icon: 'audit' },
  { id: 'event',      title: 'Event Isolation',         line: 'Each event stays completely separated.',      icon: 'event' },
  { id: 'infra',      title: 'Reliable Infrastructure', line: 'Built for large-scale events.',               icon: 'infra' },
]

export const SECURITY_TRUST_STRIP = ['Registrations', 'Payments', 'QR Check-in', 'Certificates', 'Settlements']

export const SECURITY_ITEMS: SecurityItem[] = [
  { iconKey: 'payments', title: 'Secure payments', description: 'Payments run through Razorpay; card data is never stored on RegisterDesk.' },
  { iconKey: 'lock', title: 'Role-based access', description: 'Granular team roles and permissions keep each person to exactly what they need.' },
  { iconKey: 'verify', title: 'Immutable audit logs', description: 'Key actions — registration, identifier, refund, certificate — are recorded and tamper-evident.' },
  { iconKey: 'security', title: 'Workspace isolation', description: 'Every organizer’s data is scoped to their own workspace.' },
  { iconKey: 'finance', title: 'Financial integrity', description: 'Reconciliation and settlement controls keep revenue, refunds, and payouts consistent.' },
  { iconKey: 'invoice', title: 'Compliance-ready', description: 'GST-ready invoices and 80G donation receipts where configured.' },
]

export const SECURITY_HEADING = {
  eyebrow:  'Security & reliability',
  title:    'Built so organizers can trust RegisterDesk with their events',
  subtitle: 'Every claim below maps to a real capability in the product — access control, isolation, audit, and financial integrity.',
}

export const SECURITY_GROUPS = {
  supported: 'Built-in today',
  future:    'Future-ready',
} as const

// Shipped capabilities — each backed by real product functionality.
export const SECURITY_CAPABILITIES: SecurityCapabilityDef[] = [
  { id: 'rbac',                title: 'Role-based access',             description: 'Granular team roles keep each member — admin, manager, check-in, finance — to exactly what they need.', iconKey: 'lock',          href: '/security',             status: 'available' },
  { id: 'workspace-isolation', title: 'Workspace isolation',          description: "Every organizer's data is scoped to its own workspace, isolated from others.",                       iconKey: 'security',      href: '/security',             status: 'available' },
  { id: 'event-isolation',     title: 'Event-level isolation',        description: "Each event's registrations, finances, and participants are scoped and separated within your workspace.", iconKey: 'domains',     href: '/security',             status: 'available' },
  { id: 'audit',               title: 'Audit history',                description: 'Key actions — registration, identifier, refund, certificate — are recorded with a timestamped history.', iconKey: 'verify',        href: '/security',             status: 'available' },
  { id: 'secure-payments',     title: 'Secure payments',              description: 'Payments run through Razorpay; card data is never stored on RegisterDesk.',                            iconKey: 'payments',      href: '/platform/payments',    status: 'available' },
  { id: 'transaction-history', title: 'Transaction history',          description: 'Every payment, refund, and settlement is recorded for review.',                                        iconKey: 'finance',       href: '/platform/finance',     status: 'available' },
  { id: 'identifier-integrity',title: 'Participant identifier integrity', description: 'The identifier engine prevents duplicates with locks and keeps a full assignment history.',         iconKey: 'identifier',    href: '/platform/identifiers', status: 'available' },
  { id: 'verified-email',      title: 'Verified email',               description: 'Account access uses verified email sign-in, and attendees receive confirmations at their address.',     iconKey: 'communications', href: '/platform/communications', status: 'available' },
  { id: 'data-ownership',      title: 'Data ownership',               description: 'Your data stays yours — export participants and reports to CSV on demand.',                             iconKey: 'reports',       href: '/security',             status: 'available' },
]

// Future-ready — NOT shipped. Always rendered with a "Coming soon" badge.
export const SECURITY_FUTURE: SecurityCapabilityDef[] = [
  { id: 'sso',        title: 'Single sign-on (SSO)',        description: 'Sign in through your organization’s identity provider.',          iconKey: 'lock',      href: '/roadmap', status: 'coming_soon' },
  { id: 'mfa',        title: 'Two-factor authentication',   description: 'An additional verification step at sign-in.',                     iconKey: 'security',  href: '/roadmap', status: 'coming_soon' },
  { id: 'scim',       title: 'SCIM provisioning',           description: 'Automated team provisioning and de-provisioning.',                iconKey: 'workspace', href: '/roadmap', status: 'coming_soon' },
  { id: 'compliance', title: 'Enterprise compliance',       description: 'A formal compliance program — no certifications are claimed yet.', iconKey: 'verify',   href: '/roadmap', status: 'coming_soon' },
  { id: 'byok',       title: 'Bring your own key',          description: 'Customer-managed encryption keys for enterprise plans.',          iconKey: 'domains',   href: '/roadmap', status: 'coming_soon' },
]
