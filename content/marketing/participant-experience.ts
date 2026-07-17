// Phase P.1.6.5 — Participant Experience content registry.
//
// The REAL attendee lifecycle, using only shipped capabilities. Everything an
// attendee touches is web/email based: the public event page, secure checkout,
// confirmation & update emails, a digital ticket carrying their QR + identifier,
// gate check-in, and certificates. NO mobile app, NO SMS, NO WhatsApp, NO badge
// designer are claimed. Screenshots are referenced by id (all `pending` → the
// frame shows a placeholder). Links use the approved Platform IA.

import type { ParticipantStepDef } from '@/lib/marketing/types'

export const PARTICIPANT_HEADING = {
  eyebrow:  'For your attendees',
  title:    'A clear experience from sign-up to certificate',
  subtitle: 'Attendees register, pay, and get everything they need over the web and email — no app to install.',
}

export const PARTICIPANT_STEPS: ParticipantStepDef[] = [
  { id: 'discover',     title: 'Discover the event',     description: 'A fast, shareable public event page with all the details.',                iconKey: 'verify',         href: '/platform/registration',  screenshotId: 'public-event',    status: 'available' },
  { id: 'register',     title: 'Register & pay',         description: 'Fill a simple form and check out securely online.',                          iconKey: 'registration',   href: '/platform/payments',      screenshotId: 'public-event',    status: 'available' },
  { id: 'confirmation', title: 'Get instant confirmation', description: 'An email confirmation lands the moment registration completes.',            iconKey: 'communications', href: '/platform/communications', screenshotId: 'attendee-email',  status: 'available' },
  { id: 'manage',       title: 'Manage registration',    description: 'View registration details and ticket anytime from a secure link.',          iconKey: 'crm',            href: '/platform/registration',  screenshotId: 'ticket',          status: 'available' },
  { id: 'ticket',       title: 'Ticket & identifier',    description: 'A digital ticket carrying the QR code and assigned bib or badge number.',    iconKey: 'identifier',     href: '/platform/identifiers',   screenshotId: 'ticket',          status: 'available' },
  { id: 'checkin',      title: 'Check in at the gate',   description: 'Show the QR ticket for fast, offline-capable check-in.',                     iconKey: 'checkin',        href: '/platform/check-in',      screenshotId: 'checkin',         status: 'available' },
  { id: 'certificate',  title: 'Receive a certificate',  description: 'Download a verifiable certificate after the event.',                         iconKey: 'certificates',   href: '/platform/certificates',  screenshotId: 'certificates',    status: 'available' },
  { id: 'updates',      title: 'Stay updated',           description: 'Organizer email updates keep attendees informed before and after the event.', iconKey: 'broadcast',      href: '/platform/communications', screenshotId: 'attendee-email',  status: 'available' },
]
