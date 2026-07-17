// Phase H.4 — Event Setup Center: module registry (metadata-driven).
//
// One declarative registry that works for EVERY event type — no event-type-
// specific UI, no hardcoded assumptions. Each module's `derive` is a pure
// function over REAL signals (the already-loaded event detail + enrichment from
// existing endpoints). When a signal is absent, it returns 'unknown' /
// 'not_yet_available' — it never fabricates a status or percentage.
//
// SDK-free.

import type { SetupModule, SetupContext, SetupCardResult } from './types'

// ─── Shared helpers (pure) ──────────────────────────────────────────────────

const PUBLISHED_LIKE = new Set(['published', 'registration_closed', 'completed'])

function isPublishedLike(ctx: SetupContext): boolean {
  return PUBLISHED_LIKE.has(ctx.event.lifecycleStatus)
}

// Workspace-level capabilities that have no per-event check today → honest
// "Not yet available" with a link out to where they ARE managed.
function workspaceModule(reason: string, href: string, label: string): (ctx: SetupContext) => SetupCardResult {
  return () => ({ state: 'not_yet_available', reason, secondary: { label, href } })
}

// ─── Registry ───────────────────────────────────────────────────────────────

export const SETUP_MODULES: SetupModule[] = [

  // ── Core ──────────────────────────────────────────────────────────────────
  {
    key: 'basic_info', group: 'core', label: 'Basic Information',
    description: 'Event name and description.',
    derive: ({ event }) => {
      const missing: string[] = []
      if (!event.name || event.name === 'Untitled Event') missing.push('name')
      if (!event.shortDesc && !event.fullDesc)            missing.push('description')
      return missing.length === 0
        ? { state: 'ready', reason: 'Name and description are set.', lastUpdated: event.updatedAt, primary: { label: 'Edit details', tab: 'settings' } }
        : { state: 'needs_attention', reason: `Missing: ${missing.join(', ')}.`, lastUpdated: event.updatedAt, primary: { label: 'Complete details', tab: 'settings' } }
    },
  },
  {
    key: 'event_type', group: 'core', label: 'Event Type',
    description: 'The category that shapes this event.',
    derive: ({ event }) => {
      const primary = { label: 'Open settings', tab: 'settings' }
      if (!event.eventType) return { state: 'needs_attention', reason: 'No event type selected.', primary }
      const sub    = event.eventSubtype ? ` · ${event.eventSubtype.replace(/[_-]/g, ' ')}` : ''
      const locked = event.totalRegistrations > 0 ? ' Type is locked while registrations exist.' : ''
      return { state: 'ready', reason: `Type: ${event.eventType.replace(/[_-]/g, ' ')}${sub}.${locked}`, primary }
    },
  },
  {
    key: 'schedule', group: 'core', label: 'Schedule',
    description: 'Dates, times, and timezone.',
    derive: ({ event }) => {
      const primary = { label: 'Edit schedule', tab: 'settings' }
      if (!event.startDate) return { state: 'needs_attention', reason: 'No start date set.', lastUpdated: event.updatedAt, primary }
      const range = event.endDate && event.endDate !== event.startDate ? `${event.startDate} → ${event.endDate}` : event.startDate
      const tz    = event.timezone ? ` (${event.timezone})` : ''
      return { state: 'ready', reason: `Scheduled ${range}${tz}.`, lastUpdated: event.updatedAt, primary }
    },
  },
  {
    key: 'venue', group: 'core', label: 'Venue',
    description: 'Where the event takes place.',
    derive: ({ event }) => {
      const primary = { label: 'Edit venue', tab: 'settings' }
      const t = event.venueType
      if (!t) return { state: 'needs_attention', reason: 'No venue configured.', primary: { label: 'Set venue', tab: 'settings' } }
      if (t === 'online') {
        return event.onlinePlatform
          ? { state: 'ready', reason: `Online via ${event.onlinePlatform}.`, primary }
          : { state: 'needs_attention', reason: 'Online event — no platform set.', primary: { label: 'Set platform', tab: 'settings' } }
      }
      const where = [event.venueName, event.venueCity].filter(Boolean).join(', ')
      return where
        ? { state: 'ready', reason: `${t === 'hybrid' ? 'Hybrid' : 'In person'} — ${where}.`, primary }
        : { state: 'needs_attention', reason: 'Venue type is set but the location is incomplete.', primary: { label: 'Complete venue', tab: 'settings' } }
    },
  },
  {
    key: 'capacity', group: 'core', label: 'Capacity',
    description: 'Total seats across passes.',
    derive: ({ event }) => {
      const primary = { label: 'Manage passes', tab: 'passes' }
      if (event.passes.length === 0)          return { state: 'needs_attention', reason: 'No passes configured — capacity is undefined.', primary }
      if (event.passes.some(p => p.unlimited)) return { state: 'ready', reason: `Unlimited capacity · ${event.totalRegistrations} registered.`, primary }
      const total = event.passes.reduce((s, p) => s + (p.capacity ?? 0), 0)
      if (total === 0)                         return { state: 'needs_attention', reason: 'Passes have no seat limits set.', primary }
      return { state: 'ready', reason: `${total.toLocaleString('en-IN')} seats · ${event.totalRegistrations} registered.`, primary }
    },
  },
  {
    key: 'visibility', group: 'core', label: 'Visibility',
    description: 'Who can find and register.',
    derive: ({ event }) => {
      const primary = { label: 'Open settings', tab: 'settings' }
      if (event.visibility === 'public')  return { state: 'ready', reason: 'Public — discoverable on your events page.', primary }
      if (event.visibility === 'private') return { state: 'ready', reason: 'Private — reachable only by direct link / invite.', primary }
      return { state: 'unknown', reason: 'Visibility is not set for this event.', primary }
    },
  },
  {
    key: 'registration', group: 'core', label: 'Registration',
    description: 'Whether attendees can register.',
    derive: ({ event }) => {
      const s = event.lifecycleStatus
      const primary = { label: 'Manage registrations', tab: 'registrations' }
      if (s === 'published')           return { state: 'ready', reason: 'Registrations are open.', primary }
      if (s === 'registration_closed') return { state: 'ready', reason: 'Registration is currently closed.', primary }
      if (s === 'completed')           return { state: 'ready', reason: 'Event has been completed.', primary }
      if (s === 'cancelled')           return { state: 'needs_attention', reason: 'Event is cancelled.', primary: { label: 'Open settings', tab: 'settings' } }
      return { state: 'needs_attention', reason: 'Event is not published — registrations are not open.', primary: { label: 'Publish event', tab: 'settings' } }
    },
  },
  {
    key: 'event_status', group: 'core', label: 'Event Status',
    description: 'Lifecycle state of the event.',
    derive: ({ event }) => {
      const s = event.lifecycleStatus
      const lastUpdated = event.publishedAt ?? event.updatedAt
      const primary = { label: 'Manage status', tab: 'settings' }
      if (s === 'draft')     return { state: 'needs_attention', reason: 'Event is in draft. Publish it to go live.', primary }
      if (s === 'cancelled') return { state: 'needs_attention', reason: `Event is cancelled${event.cancelReason ? `: ${event.cancelReason}` : '.'}`, lastUpdated, primary }
      return { state: 'ready', reason: `Event is ${s.replace(/_/g, ' ')}.`, lastUpdated, primary }
    },
  },
  {
    key: 'payment', group: 'core', label: 'Payment',
    description: 'How attendees pay.',
    derive: ({ event }) => {
      if (event.isFreeEvent) return { state: 'ready', reason: 'Free event — no payment setup required.', primary: { label: 'View passes', tab: 'passes' } }
      const paid = event.passes.some(p => p.price > 0)
      return paid
        ? { state: 'ready', reason: 'Paid passes are configured. (Payout-profile verification is not shown here.)', primary: { label: 'Manage passes', tab: 'passes' } }
        : { state: 'needs_attention', reason: 'This is a paid event but no priced passes exist yet.', primary: { label: 'Add a pass', tab: 'passes' } }
    },
  },
  {
    key: 'registration_form', group: 'core', label: 'Registration Form',
    description: 'The fields attendees fill in.',
    derive: ({ event }) => {
      // Real signal available here is the registration rules blob; full field
      // counts are not exposed by this endpoint → honest 'unknown' otherwise.
      return event.registrationRules
        ? { state: 'ready', reason: 'A registration form is configured.', primary: { label: 'Edit form', tab: 'settings' } }
        : { state: 'unknown', reason: 'Form details are not available from this view.', primary: { label: 'Open settings', tab: 'settings' } }
    },
  },

  // ── Operations ────────────────────────────────────────────────────────────
  {
    key: 'identifiers', group: 'operations', label: 'Identifiers',
    description: 'Bib / badge / participant identifier engine.',
    derive: ({ event, enrich }) => {
      if (enrich.identifier === 'unknown') return { state: 'unknown', reason: 'Identifier configuration could not be loaded.' }
      if (enrich.identifier.configured)    return { state: 'ready', reason: 'Identifier engine is configured.', primary: event.eventType === 'sports' ? { label: 'Manage identifiers', tab: 'sports' } : undefined }
      if (event.eventType === 'sports')    return { state: 'needs_attention', reason: 'Identifiers are not configured yet.', primary: { label: 'Configure identifiers', tab: 'sports' } }
      return { state: 'not_yet_available', reason: 'Identifier management UI is currently available for sports events.' }
    },
  },
  {
    key: 'checkin', group: 'operations', label: 'Check-in',
    description: 'On-site attendee check-in.',
    derive: (ctx) => {
      const { event } = ctx
      if (!isPublishedLike(ctx)) return { state: 'disabled', reason: 'Publish the event to enable check-in.', primary: { label: 'Open settings', tab: 'settings' } }
      return { state: 'ready', reason: `Check-in is available (${event.checkedInCount} checked in).`, primary: { label: 'Open check-in', href: `/dashboard/events/${event.draftId}/checkin` } }
    },
  },
  {
    key: 'sessions', group: 'operations', label: 'Sessions',
    description: 'Multi-session / conference agenda.',
    derive: ({ enrich }) => {
      if (enrich.sessions === 'unknown') return { state: 'unknown', reason: 'Session data could not be loaded.', primary: { label: 'Open sessions', tab: 'conference' } }
      return enrich.sessions.count > 0
        ? { state: 'ready', reason: `${enrich.sessions.count} session(s) configured.`, primary: { label: 'Manage sessions', tab: 'conference' } }
        : { state: 'disabled', reason: 'No sessions have been created yet.', primary: { label: 'Add sessions', tab: 'conference' } }
    },
  },
  {
    key: 'volunteers', group: 'operations', label: 'Volunteers',
    description: 'Volunteer roster and roles.',
    derive: () => ({ state: 'not_yet_available', reason: 'Volunteer management is not yet available.' }),
  },
  {
    key: 'teams', group: 'operations', label: 'Teams',
    description: 'Per-event staff assignment.',
    derive: () => ({ state: 'not_yet_available', reason: 'Per-event team assignment is not yet available.', secondary: { label: 'Workspace team', href: '/dashboard/settings/team' } }),
  },
  {
    key: 'sponsors', group: 'operations', label: 'Sponsors',
    description: 'Sponsor logos shown on the event page.',
    derive: ({ event }) => {
      const n = event.sponsors.length
      return n > 0
        ? { state: 'ready', reason: `${n} sponsor${n === 1 ? '' : 's'} listed.`, primary: { label: 'Manage sponsors', tab: 'settings' }, secondary: { label: 'Applications', tab: 'sponsor-applications' } }
        : { state: 'disabled', reason: 'No sponsors added yet.', primary: { label: 'Add sponsors', tab: 'settings' }, secondary: { label: 'Applications', tab: 'sponsor-applications' } }
    },
  },

  // ── Communications ────────────────────────────────────────────────────────
  {
    key: 'communication', group: 'communications', label: 'Communication Settings',
    description: 'Attendee notification channels.',
    derive: ({ event }) => {
      const p  = (event.pricing ?? {}) as Record<string, unknown>
      const on: string[] = ['Email']   // email (confirmation/ticket/receipt) is always sent — free
      if (p.whatsappEnabled === true) on.push('WhatsApp')
      if (p.smsEnabled === true)      on.push('SMS')
      if (p.certEnabled === true)     on.push('Certificates')
      return { state: 'ready', reason: `Enabled: ${on.join(', ')}.`, primary: { label: 'Open communications', tab: 'communications' } }
    },
  },
  {
    key: 'branding', group: 'communications', label: 'Branding',
    description: 'Logo and cover banner.',
    derive: ({ event }) => {
      const primary = { label: 'Edit branding', tab: 'settings' }
      const has = [event.logoUrl ? 'logo' : null, event.bannerUrl ? 'cover banner' : null].filter(Boolean) as string[]
      if (has.length === 2) return { state: 'ready', reason: 'Logo and cover banner are set.', primary }
      if (has.length === 1) return { state: 'needs_attention', reason: `Only the ${has[0]} is set — add the other for a polished page.`, primary }
      return { state: 'needs_attention', reason: 'No logo or cover banner yet.', primary }
    },
  },
  {
    key: 'email', group: 'communications', label: 'Email',
    description: 'Transactional attendee emails.',
    derive: () => ({ state: 'ready', reason: 'Confirmation, ticket, and receipt emails are always sent — free.', primary: { label: 'Open communications', tab: 'communications' } }),
  },
  {
    key: 'broadcast', group: 'communications', label: 'Broadcast',
    description: 'Bulk announcements to attendees.',
    derive: () => ({ state: 'unknown', reason: 'Broadcast status is not available from this view.', primary: { label: 'Open communications', tab: 'communications' } }),
  },
  {
    key: 'website', group: 'communications', label: 'Website',
    description: 'Public event page.',
    derive: ({ event }) => {
      return (isPublishedLikePublic(event) && event.slug)
        ? { state: 'ready', reason: 'The public event page is live.', primary: { label: 'Open settings', tab: 'settings' }, secondary: { label: 'View page', href: `/events/${event.slug}`, external: true } }
        : { state: 'needs_attention', reason: 'The public event page is not live yet.', primary: { label: 'Publish event', tab: 'settings' } }
    },
  },
  {
    key: 'seo', group: 'communications', label: 'SEO',
    description: 'Search & social metadata.',
    derive: ({ event }) => {
      return (event.metaTitle && event.metaDescription)
        ? { state: 'ready', reason: 'SEO metadata is configured.', primary: { label: 'Edit SEO', tab: 'settings' } }
        : { state: 'needs_attention', reason: 'Add a meta title and description for better discovery.', primary: { label: 'Add SEO', tab: 'settings' } }
    },
  },

  // ── Finance ───────────────────────────────────────────────────────────────
  {
    key: 'donations', group: 'finance', label: 'Donations',
    description: 'Linked donation campaign.',
    derive: ({ event }) => {
      if (event.linkedCampaignSlug) {
        const raised = event.donationTotalPaise > 0 ? ` (₹${Math.round(event.donationTotalPaise / 100).toLocaleString('en-IN')} raised)` : ''
        return { state: 'ready', reason: `Donations are enabled${raised}.`, primary: { label: 'Open campaign', href: `/dashboard/campaigns/${event.linkedCampaignSlug}` } }
      }
      return { state: 'not_yet_available', reason: 'This event is not configured to collect donations.' }
    },
  },
  {
    key: 'wallet', group: 'finance', label: 'Wallet',
    description: 'Communication & service credits.',
    derive: workspaceModule('Wallet is managed at the workspace level.', '/dashboard/wallet', 'Open wallet'),
  },
  {
    key: 'settlements', group: 'finance', label: 'Settlements',
    description: 'Payouts to your account.',
    derive: workspaceModule('Settlements are managed at the workspace level.', '/dashboard/finance', 'Open finance'),
  },
  {
    key: 'reports', group: 'finance', label: 'Reports',
    description: 'Event analytics & exports.',
    derive: ({ event }) => ({
      state: 'ready',
      reason: event.totalRegistrations > 0 ? `Reports available (${event.totalRegistrations} registrations).` : 'Reports are available.',
      primary: { label: 'Open reports', tab: 'reports' },
    }),
  },

  // ── Certificates ──────────────────────────────────────────────────────────
  {
    key: 'certificate_templates', group: 'certificates', label: 'Certificate Templates',
    description: 'Participation / completion certificates.',
    derive: ({ enrich }) => {
      const primary = { label: 'Configure certificates', tab: 'certificates' }
      if (enrich.cert === 'unknown') return { state: 'unknown', reason: 'Certificate status could not be loaded.', primary }
      if (enrich.cert.generated > 0) return { state: 'ready', reason: `${enrich.cert.generated} certificate(s) issued.`, primary: { label: 'Manage certificates', tab: 'certificates' } }
      if (enrich.cert.pending > 0)   return { state: 'needs_attention', reason: `No certificates issued yet — ${enrich.cert.pending} eligible.`, primary }
      return { state: 'disabled', reason: 'No certificate template has been configured.', primary }
    },
  },
  {
    key: 'badge_templates', group: 'certificates', label: 'Badge Templates',
    description: 'Printable attendee badges.',
    derive: () => ({ state: 'not_yet_available', reason: 'Badge templates are not yet available.' }),
  },

  // ── Integrations ──────────────────────────────────────────────────────────
  {
    key: 'custom_domain', group: 'integrations', label: 'Custom Domain',
    description: 'Host events on your own domain.',
    derive: workspaceModule('Custom domains are managed at the workspace level.', '/dashboard/settings/integrations', 'Open integrations'),
  },
  {
    key: 'white_label', group: 'integrations', label: 'White Label',
    description: 'Remove RegisterDesk branding.',
    derive: () => ({ state: 'not_yet_available', reason: 'White-label is not yet available.' }),
  },
  {
    key: 'webhooks', group: 'integrations', label: 'Webhooks',
    description: 'Real-time event notifications.',
    derive: workspaceModule('Webhooks are managed at the workspace level.', '/dashboard/settings/integrations', 'Open integrations'),
  },
  {
    key: 'api_keys', group: 'integrations', label: 'API Keys',
    description: 'Programmatic access.',
    derive: workspaceModule('API keys are managed at the workspace level.', '/dashboard/settings/integrations', 'Open integrations'),
  },
]

// Local helper used above (kept after the array for readability).
function isPublishedLikePublic(event: SetupContext['event']): boolean {
  return PUBLISHED_LIKE.has(event.lifecycleStatus)
}
