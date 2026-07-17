// Phase P.1.6.2 — Event Journey content registry.
//
// The REAL RegisterDesk lifecycle — every step reflects a shipped capability.
// No fabricated workflows. Each step links into the approved Platform IA (the
// same hrefs used by the navigation registry), so there are no dead links
// outside the IA. All steps are `available` today.

import type { JourneyStepDef } from '@/lib/marketing/types'

export const JOURNEY_HEADING = {
  eyebrow:  'How it works',
  title:    'One platform for the whole event lifecycle',
  subtitle: 'From the first registration to the final payout — every step lives in one connected workspace.',
}

export const JOURNEY_STEPS: JourneyStepDef[] = [
  { id: 'create',       title: 'Create your event',     description: 'Set up details, passes, and a custom registration form.',          iconKey: 'workspace',    module: 'Event setup',            href: '/platform/registration', status: 'available' },
  { id: 'publish',      title: 'Publish',               description: 'Go live with a public event page and SEO built in.',               iconKey: 'verify',       module: 'Public pages',           href: '/platform/registration', status: 'available' },
  { id: 'register',     title: 'Take registrations',    description: 'Collect sign-ups with coupons, waitlists, and capacity control.',  iconKey: 'registration', module: 'Registration & Ticketing', href: '/platform/registration', status: 'available' },
  { id: 'payments',     title: 'Accept payments',       description: 'Secure checkout with automatic refund handling.',                  iconKey: 'payments',     module: 'Payments',               href: '/platform/payments',     status: 'available' },
  { id: 'participants', title: 'Manage participants',   description: 'A unified view of every attendee and their details.',              iconKey: 'crm',          module: 'Participants & CRM',     href: '/platform/crm',          status: 'available' },
  { id: 'identifiers',  title: 'Assign identifiers',    description: 'Bibs, badges, or any participant ID from one engine.',             iconKey: 'identifier',   module: 'Identifier Engine',      href: '/platform/identifiers',  status: 'available' },
  { id: 'checkin',      title: 'Run check-in',          description: 'Fast QR check-in that works offline at the gate.',                 iconKey: 'checkin',      module: 'Check-in & Attendance',  href: '/platform/check-in',     status: 'available' },
  { id: 'certificates', title: 'Issue certificates',    description: 'Generate, email, and verify certificates in bulk.',                iconKey: 'certificates', module: 'Certificates',           href: '/platform/certificates', status: 'available' },
  { id: 'reports',      title: 'Track reports',         description: 'Real-time registrations, revenue, and attendance.',                iconKey: 'reports',      module: 'Reports',                href: '/platform/finance',      status: 'available' },
  { id: 'settlement',   title: 'Receive settlements',   description: 'Track revenue and get paid to your bank account or UPI.',          iconKey: 'settlements',  module: 'Finance & Payouts',      href: '/platform/finance',      status: 'available' },
]
