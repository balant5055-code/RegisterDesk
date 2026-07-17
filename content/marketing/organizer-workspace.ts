// Phase P.1.6.4 — Organizer Workspace content registry.
//
// The REAL RegisterDesk organizer workspaces, presented as one operating system.
// No fabricated modules — each entry is a shipped workspace. Every screenshot is
// referenced by id from the screenshot registry (all `pending` → the frame shows
// a placeholder; no fake captures). Links use the approved Platform IA — the
// exact hrefs from the navigation registry. All workspaces are `available`.

import type { WorkspaceItemDef } from '@/lib/marketing/types'

export const ORGANIZER_WORKSPACE_HEADING = {
  eyebrow:  'The organizer workspace',
  title:    'Run every event from one operating system',
  subtitle: 'Each part of the workflow has a purpose-built workspace — all sharing the same live data.',
}

export const ORGANIZER_WORKSPACES: WorkspaceItemDef[] = [
  { id: 'setup',       title: 'Setup Center',         description: 'Configure event details, passes, and the registration form in one guided place.', iconKey: 'workspace',  href: '/platform/registration', screenshotId: 'setup-center',      status: 'available' },
  { id: 'operations',  title: 'Operations Center',    description: 'The command center for a live event — status, tasks, and quick actions at a glance.', iconKey: 'fast',       href: '/platform/check-in',     screenshotId: 'event-home',        status: 'available' },
  { id: 'participant', title: 'Participant Workspace', description: 'A 360° view of any attendee: registration, payments, identifiers, and history.',     iconKey: 'crm',        href: '/platform/crm',          screenshotId: 'participant-360',   status: 'available' },
  { id: 'identifier',  title: 'Identifier Center',    description: 'Assign, swap, and track bibs, badges, or any participant identifier from one engine.', iconKey: 'identifier', href: '/platform/identifiers',  screenshotId: 'identifier-center', status: 'available' },
  { id: 'finance',     title: 'Finance Center',       description: 'Track revenue, fees, refunds, and settlements, then pay out to your account.',       iconKey: 'finance',    href: '/platform/finance',      screenshotId: 'finance',           status: 'available' },
  { id: 'crm',         title: 'CRM',                  description: 'A unified contact record across every event you run.',                               iconKey: 'crm',        href: '/platform/crm',          screenshotId: 'crm',               status: 'available' },
  { id: 'sessions',    title: 'Sessions',             description: 'Build multi-track agendas and manage session capacity.',                             iconKey: 'sessions',   href: '/platform/sessions',     screenshotId: 'sessions',          status: 'available' },
]
