// Phase P.1.6.6 — Why RegisterDesk content registry.
//
// The platform PHILOSOPHY and operational advantages — no competitor comparison,
// no fabricated customer counts, no unsupported certifications. Every pillar is
// grounded in a shipped capability and links into the approved IA. "Enterprise
// ready" describes only what exists today (role-based access, audit logs,
// workspace isolation) — it does NOT claim any compliance certification.

import type { WhyPillarDef } from '@/lib/marketing/types'

export const WHY_HEADING = {
  eyebrow:  'Why RegisterDesk',
  title:    'One connected platform built for how events actually run',
  subtitle: 'Not a bundle of disconnected tools — a single system where registration, operations, and finance share the same data.',
}

export const WHY_PILLARS: WhyPillarDef[] = [
  { id: 'one-platform',   title: 'One platform',        description: 'Registration, participants, identifiers, check-in, certificates, and payouts live in one place — no syncing between tools.', iconKey: 'workspace',   href: '/platform',             status: 'available' },
  { id: 'operations',     title: 'Built for operations', description: 'Purpose-built workspaces for the day of the event: fast check-in, identifier assignment, and a live operations center.',      iconKey: 'fast',        href: '/platform/check-in',    status: 'available' },
  { id: 'enterprise',     title: 'Enterprise ready',    description: 'Role-based access, audit logs, and workspace isolation keep large teams and sensitive data under control.',                  iconKey: 'security',    href: '/security',             status: 'available' },
  { id: 'financial',      title: 'Financial confidence', description: 'Secure payments, automatic refunds, a wallet, and clear settlement tracking with payouts to your account.',                  iconKey: 'finance',     href: '/platform/finance',     status: 'available' },
  { id: 'grow',           title: 'Designed to grow',    description: 'Run many events, reuse configuration, and extend with a developer API and signed webhooks as you scale.',                    iconKey: 'api',         href: '/platform/api',         status: 'available' },
]
