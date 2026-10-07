// RD-EVENT-04 · Event Setup Center — the item resolver.
//
// One pure function per capability, mapping real signals to a state. The rules:
//
//   1. Anything that maps to a publish requirement takes its state from
//      `publishChecks` — the evaluator the publish flow gates on. Never re-derived.
//   2. Anything gated by a feature flag or permission resolves to `not_applicable`
//      before any other consideration.
//   3. A signal that could not be read is `unavailable`. Never `ready`, never zero.
//   4. Optional capabilities that are simply unset are `optional`, never
//      "needs attention" — an event with no coupons is not a broken event.
//
// Pure — no React, no Firebase, no DOM.

import { eventHasWaitlist } from '@/lib/events/eventCapabilities'
import type { EventDetailResponse, EventPublishCheck } from '@/app/api/organizer/events/[eventId]/route'
import {
  gateState, isLive, publishChecksApply,
  type GateContext, type ItemState, type ResolvedItem, type SetupSection,
} from './readiness'

/** Signals fetched alongside the event. `'unavailable'` is a first-class value. */
export type Signal<T> = T | 'unavailable'

export interface SetupSignals {
  certificates: Signal<{ generated: number; pending: number }>
  identifiers:  Signal<{ configured: boolean }>
  sessions:     Signal<{ count: number }>
  coupons:      Signal<{ count: number }>
  waitlist:     Signal<{ count: number }>
}

export const UNRESOLVED_SIGNALS: SetupSignals = {
  certificates: 'unavailable', identifiers: 'unavailable', sessions: 'unavailable',
  coupons: 'unavailable', waitlist: 'unavailable',
}

export interface ItemContext {
  event:   EventDetailResponse
  signals: SetupSignals
  gate:    GateContext
  /** `/dashboard/events/{id}` — every destination is built from this. */
  eventHref: string
  /** `?tab=` links into the existing event workspace. */
  tab: (key: string) => string
  /** `?eventId=` links into standalone modules. */
  scoped: (path: string) => string
}

const n = (v: number) => v.toLocaleString('en-IN')

// ─── Publish-requirement-backed items ─────────────────────────────────────────

/**
 * Resolve a card whose readiness IS a publish requirement.
 *
 * The check's own `passed` and `severity` decide the state, so this card and the
 * publish button can never disagree. When the requirement no longer applies (the event
 * is already live), a passed check stays `ready` and a failed one drops to `optional` —
 * it is real feedback, but it no longer blocks anything.
 */
function fromCheck(
  ctx: ItemContext, checkId: string, fallback: ItemState = 'unavailable',
): { state: ItemState; check?: EventPublishCheck } {
  const check = ctx.event.publishChecks?.find(c => c.id === checkId)
  if (!check) return { state: fallback }
  if (check.passed) return { state: 'ready', check }
  if (!publishChecksApply(ctx.event)) return { state: 'optional', check }
  if (check.severity === 'critical')  return { state: 'blocked', check }
  if (check.severity === 'warning')   return { state: 'attention', check }
  return { state: 'optional', check }
}

// ─── Item definitions ─────────────────────────────────────────────────────────

interface ItemDef {
  key:     string
  label:   string
  section: SetupSection
  resolve: (ctx: ItemContext) => Omit<ResolvedItem, 'key' | 'label' | 'section'>
}

const DEFS: ItemDef[] = [
  // ── Essentials ────────────────────────────────────────────────────────────
  {
    key: 'basics', label: 'Event name & description', section: 'essentials',
    resolve: ctx => {
      const title = fromCheck(ctx, 'event_title')
      const desc  = fromCheck(ctx, 'event_description')
      // The NAME blocks publishing; the description is only a warning. Reporting the
      // worse of the two keeps the card honest without promoting a warning to a blocker.
      const state = title.state === 'ready' ? desc.state : title.state
      return {
        state,
        summary: title.state !== 'ready'
          ? 'No event name yet.'
          : desc.state === 'ready'
            ? ctx.event.name
            : `${ctx.event.name} · description is thin`,
        checkId: title.state !== 'ready' ? 'event_title' : 'event_description',
        action: { label: 'Edit details', href: ctx.tab('settings') },
      }
    },
  },
  {
    key: 'schedule', label: 'Schedule', section: 'essentials',
    resolve: ctx => {
      const { state } = fromCheck(ctx, 'event_schedule')
      const e = ctx.event
      const when = e.startDate
        ? [e.startDate, e.endDate && e.endDate !== e.startDate ? `→ ${e.endDate}` : null]
            .filter(Boolean).join(' ')
        : 'Not scheduled'
      return {
        state,
        summary: e.timezone ? `${when} · ${e.timezone}` : when,
        checkId: 'event_schedule',
        action: { label: 'Edit schedule', href: ctx.tab('settings') },
      }
    },
  },
  {
    key: 'venue', label: 'Venue', section: 'essentials',
    resolve: ctx => {
      const { state } = fromCheck(ctx, 'event_venue')
      const e = ctx.event
      const where = e.venueType === 'online'
        ? (e.onlinePlatform ? `Online · ${e.onlinePlatform}` : 'Online · platform not set')
        : [e.venueName, e.venueCity].filter(Boolean).join(', ') || 'Location not set'
      return {
        state, summary: where, checkId: 'event_venue',
        action: { label: 'Edit venue', href: ctx.tab('settings') },
      }
    },
  },
  {
    key: 'organizer', label: 'Organizer contact', section: 'essentials',
    resolve: ctx => {
      // RD-EVENT-04 · This card DID NOT EXIST. `event_organizer` is a CRITICAL publish
      // requirement, so an event could show every Setup card green and still be refused
      // at publish, with nothing on the page saying why.
      const org   = fromCheck(ctx, 'event_organizer')
      const phone = fromCheck(ctx, 'organizer_phone')
      const state = org.state === 'ready' ? phone.state : org.state
      return {
        state,
        summary: org.state !== 'ready'
          ? 'Organizer name and contact email are required.'
          : phone.state === 'ready'
            ? 'Name, email and phone are set.'
            : 'No contact phone — attendees have no way to reach you urgently.',
        checkId: org.state !== 'ready' ? 'event_organizer' : 'organizer_phone',
        action: { label: 'Edit organizer', href: ctx.tab('settings') },
      }
    },
  },
  {
    key: 'visibility', label: 'Visibility', section: 'essentials',
    resolve: ctx => {
      const v = ctx.event.visibility
      if (v === 'public')  return { state: 'ready', summary: 'Public — listed on your events page.', action: { label: 'Change', href: ctx.tab('settings') } }
      if (v === 'private') return { state: 'ready', summary: 'Private — reachable by direct link only.', action: { label: 'Change', href: ctx.tab('settings') } }
      return { state: 'attention', summary: 'Not set — attendees may not be able to find this event.', action: { label: 'Set visibility', href: ctx.tab('settings') } }
    },
  },

  // ── Registration & tickets ────────────────────────────────────────────────
  {
    key: 'pricing', label: 'Pricing model', section: 'registration',
    resolve: ctx => {
      const { state } = fromCheck(ctx, 'pricing_model')
      return {
        state,
        summary: ctx.event.isFreeEvent ? 'Free event.' : 'Paid event.',
        checkId: 'pricing_model',
        action: { label: 'Edit pricing', href: ctx.tab('passes') },
      }
    },
  },
  {
    key: 'passes', label: 'Passes & capacity', section: 'registration',
    resolve: ctx => {
      const gated = gateState('passes', ctx.gate)
      if (gated) return { state: gated, summary: 'You do not have access to passes.' }
      const { state } = fromCheck(ctx, 'passes')
      const p = ctx.event.passes
      const unlimited = p.some(x => x.unlimited)
      const seats = unlimited ? null : p.reduce((s, x) => s + (x.capacity ?? 0), 0)
      const summary = p.length === 0
        ? 'No passes created yet.'
        : `${p.length} pass${p.length === 1 ? '' : 'es'} · ${unlimited ? 'unlimited capacity' : `${n(seats ?? 0)} seats`}`
      return { state, summary, checkId: 'passes', action: { label: 'Manage passes', href: ctx.tab('passes') } }
    },
  },
  {
    key: 'registration_form', label: 'Registration form', section: 'registration',
    resolve: ctx => {
      const { state } = fromCheck(ctx, 'registration_form')
      return {
        state,
        summary: state === 'ready'
          ? 'Attendee fields are configured.'
          : 'Choose a template or build a custom form.',
        checkId: 'registration_form',
        action: { label: 'Edit form', href: ctx.tab('settings') },
      }
    },
  },
  {
    key: 'registrations', label: 'Registrations', section: 'registration',
    resolve: ctx => {
      const gated = gateState('registrations', ctx.gate)
      if (gated) return { state: gated, summary: 'You do not have access to registrations.' }
      if (ctx.event.statsUnavailable) {
        return { state: 'unavailable', summary: "Registration count couldn't be loaded.", action: { label: 'Open registrations', href: ctx.scoped('/dashboard/registrations') } }
      }
      if (!isLive(ctx.event)) {
        return { state: 'optional', summary: 'Opens once the event is published.', action: { label: 'Open registrations', href: ctx.scoped('/dashboard/registrations') } }
      }
      return {
        state: 'ready',
        summary: `${n(ctx.event.totalRegistrations)} registered.`,
        action: { label: 'Open registrations', href: ctx.scoped('/dashboard/registrations') },
      }
    },
  },
  {
    key: 'coupons', label: 'Coupons', section: 'registration',
    resolve: ctx => {
      // RD-EVENT-04 · A missed feature: coupons have a working tab and a nav entry but
      // no Setup card existed.
      const gated = gateState('coupons', ctx.gate)
      if (gated) return { state: gated, summary: 'Coupons are not enabled for this workspace.' }
      const s = ctx.signals.coupons
      const action = { label: 'Manage coupons', href: ctx.tab('coupons') }
      if (s === 'unavailable') return { state: 'unavailable', summary: "Coupon count couldn't be loaded.", action }
      return s.count > 0
        ? { state: 'ready',    summary: `${n(s.count)} coupon${s.count === 1 ? '' : 's'} created.`, action }
        : { state: 'optional', summary: 'None created — optional.', action }
    },
  },
  {
    key: 'waitlist', label: 'Waitlist', section: 'registration',
    resolve: ctx => {
      // RD-EVENT-04 · Also missed: a working tab and nav entry with no Setup card.
      const gated = gateState('waitlist', ctx.gate)
      if (gated) return { state: gated, summary: 'You do not have access to the waitlist.' }
      const s = ctx.signals.waitlist

      // RD-EVENT-16 · the Waitlist TAB is hidden when this event's waitlist is switched
      // off, so linking there would land on the command center. Off is also not the same
      // as "nobody waiting": entries collected before the switch was turned off are still
      // counted here, and turning it back on is what makes them manageable again.
      const on = eventHasWaitlist(ctx.event.registrationRules)
      if (!on) {
        const settings = { label: 'Registration settings', href: ctx.tab('settings') }
        if (s === 'unavailable') {
          return { state: 'unavailable', summary: "Waitlist couldn't be loaded.", action: settings }
        }
        return s.count > 0
          ? { state: 'attention', summary: `Switched off, but ${n(s.count)} still queued from before.`, action: settings }
          : { state: 'optional',  summary: 'Not collecting a waitlist.', action: settings }
      }

      const action = { label: 'Open waitlist', href: ctx.tab('waitlist') }
      if (s === 'unavailable') return { state: 'unavailable', summary: "Waitlist couldn't be loaded.", action }
      return s.count > 0
        ? { state: 'attention', summary: `${n(s.count)} waiting for a place.`, action }
        : { state: 'optional',  summary: 'Nobody waiting.', action }
    },
  },

  // ── Operations ────────────────────────────────────────────────────────────
  {
    key: 'checkin', label: 'Check-in', section: 'operations',
    resolve: ctx => {
      const gated = gateState('checkin', ctx.gate)
      if (gated) return { state: gated, summary: 'You do not have access to check-in.' }
      const action = { label: 'Open check-in', href: ctx.scoped('/dashboard/check-in') }
      if (!isLive(ctx.event)) return { state: 'optional', summary: 'Available once the event is published.', action }
      if (ctx.event.statsUnavailable) return { state: 'unavailable', summary: "Check-in count couldn't be loaded.", action }
      return { state: 'ready', summary: `${n(ctx.event.checkedInCount)} checked in.`, action }
    },
  },
  {
    key: 'identifiers', label: 'BIB & identifiers', section: 'operations',
    resolve: ctx => {
      const gated = gateState('identifiers', ctx.gate)
      if (gated) return { state: gated, summary: 'You do not have access to identifiers.' }
      const s = ctx.signals.identifiers
      const action = { label: 'Configure identifiers', href: ctx.tab('sports') }
      if (s === 'unavailable') return { state: 'unavailable', summary: "Identifier configuration couldn't be loaded.", action }
      if (s.configured) return { state: 'ready', summary: 'Identifier engine configured.', action }
      return ctx.event.eventType === 'sports'
        ? { state: 'attention', summary: 'Not configured — sports events usually need bibs.', action }
        : { state: 'optional',  summary: 'Not configured — optional for this event type.', action }
    },
  },
  {
    key: 'sessions', label: 'Sessions & agenda', section: 'operations',
    resolve: ctx => {
      const s = ctx.signals.sessions
      const action = { label: 'Manage sessions', href: ctx.tab('conference') }
      if (s === 'unavailable') return { state: 'unavailable', summary: "Session data couldn't be loaded.", action }
      return s.count > 0
        ? { state: 'ready',    summary: `${n(s.count)} session${s.count === 1 ? '' : 's'} scheduled.`, action }
        : { state: 'optional', summary: 'No agenda added — optional.', action }
    },
  },
  {
    key: 'reports', label: 'Reports & exports', section: 'operations',
    resolve: () => ({
      state: 'ready',
      summary: 'Generate and download reports.',
      /**
       * RD-ANALYTICS-12-13 · "Open reports" now opens the report generator.
       *
       * The label said "Reports & exports" and the button said "Open reports", and both
       * opened the analytics dashboard. The summary said "Analytics and attendee exports",
       * which is how one row came to describe two products.
       *
       * NOT `ctx.scoped(...)`, unlike its neighbours: Reports is workspace-scoped. Its event
       * field is a slug FILTER typed by the user, not the `eventId` the scoped helper
       * appends, so scoping this link would add a parameter the page ignores and imply an
       * event context it does not have.
       */
      action: { label: 'Open reports', href: '/dashboard/finance/reports' },
    }),
  },

  // ── Audience & content ────────────────────────────────────────────────────
  {
    key: 'branding', label: 'Cover image & logo', section: 'audience',
    resolve: ctx => {
      // The COVER is a warning; the LOGO is only a suggestion. The old card treated a
      // missing logo as "Needs Attention", which promoted a suggestion to a problem.
      const cover = fromCheck(ctx, 'event_cover')
      const logo  = fromCheck(ctx, 'event_branding')
      const state = cover.state === 'ready' ? logo.state : cover.state
      return {
        state,
        summary: cover.state !== 'ready'
          ? 'No cover image — events with one convert significantly better.'
          : logo.state === 'ready' ? 'Cover image and logo are set.' : 'Cover image set · logo is optional.',
        checkId: cover.state !== 'ready' ? 'event_cover' : 'event_branding',
        action: { label: 'Edit branding', href: ctx.tab('settings') },
      }
    },
  },
  {
    key: 'public_page', label: 'Public event page', section: 'audience',
    resolve: ctx => {
      const e = ctx.event
      if (isLive(e) && e.slug) {
        return {
          state: 'ready', summary: 'Live and accepting visitors.',
          action: { label: 'View page', href: e.campaignType === 'donation_only' ? `/campaign/${e.slug}` : `/events/${e.slug}`, external: true },
        }
      }
      return { state: 'optional', summary: 'Goes live when the event is published.', action: { label: 'Open settings', href: ctx.tab('settings') } }
    },
  },
  {
    key: 'social', label: 'Social links', section: 'audience',
    resolve: ctx => {
      const { state } = fromCheck(ctx, 'event_social')
      return {
        state,
        summary: state === 'ready' ? 'Social profiles linked.' : 'None linked — optional.',
        checkId: 'event_social',
        action: { label: 'Add links', href: ctx.tab('settings') },
      }
    },
  },
  {
    key: 'communications', label: 'Communications', section: 'audience',
    resolve: ctx => {
      const gated = gateState('communications', ctx.gate)
      if (gated) return { state: gated, summary: 'Communications are not enabled for this workspace.' }
      return {
        state: 'ready',
        summary: 'Confirmation, ticket and receipt emails are always sent.',
        action: { label: 'Open communications', href: ctx.scoped('/dashboard/communications') },
      }
    },
  },
  {
    key: 'certificates', label: 'Certificates', section: 'audience',
    resolve: ctx => {
      const gated = gateState('certificates', ctx.gate)
      if (gated) return { state: gated, summary: 'Certificates are not enabled for this workspace.' }
      const s = ctx.signals.certificates
      const action = { label: 'Configure certificates', href: ctx.tab('certificates') }
      if (s === 'unavailable') return { state: 'unavailable', summary: "Certificate status couldn't be loaded.", action }
      if (s.generated > 0) return { state: 'ready', summary: `${n(s.generated)} issued.`, action }
      if (s.pending > 0)   return { state: 'attention', summary: `${n(s.pending)} attendees eligible, none issued yet.`, action }
      return { state: 'optional', summary: 'No template configured — optional.', action }
    },
  },
  {
    key: 'media', label: 'Media studio', section: 'audience',
    resolve: ctx => {
      const gated = gateState('media', ctx.gate)
      if (gated) return { state: gated, summary: 'You do not have access to media.' }
      return { state: 'optional', summary: 'Event photos and galleries.', action: { label: 'Open media studio', href: ctx.scoped('/dashboard/media-studio') } }
    },
  },

  // ── Advanced ──────────────────────────────────────────────────────────────
  {
    key: 'print_assets', label: 'Print & assets', section: 'advanced',
    resolve: ctx => {
      const gated = gateState('print_assets', ctx.gate)
      if (gated) return { state: gated, summary: 'You do not have access to print assets.' }
      return { state: 'optional', summary: 'Badges, signage and printable material.', action: { label: 'Open print & assets', href: ctx.scoped('/dashboard/print-assets') } }
    },
  },
  {
    key: 'donations', label: 'Donations', section: 'advanced',
    resolve: ctx => {
      const gated = gateState('donations', ctx.gate)
      if (gated) return { state: gated, summary: 'Donations are not enabled for this workspace.' }
      return ctx.event.campaignType === 'event_plus_donation' || ctx.event.campaignType === 'donation_only'
        ? { state: 'ready',          summary: 'A donation campaign is linked to this event.' }
        : { state: 'not_applicable', summary: 'This event does not collect donations.' }
    },
  },
  {
    key: 'custom_domain', label: 'Custom domain', section: 'advanced',
    resolve: ctx => {
      const gated = gateState('custom_domain', ctx.gate)
      if (gated) return { state: gated, summary: 'Custom domains are not enabled for this workspace.' }
      return { state: 'optional', summary: 'Managed for the whole workspace.', action: { label: 'Open integrations', href: '/dashboard/settings/integrations' } }
    },
  },
  {
    key: 'api_access', label: 'API & webhooks', section: 'advanced',
    resolve: ctx => {
      const gated = gateState('api_access', ctx.gate)
      if (gated) return { state: gated, summary: 'API access is not enabled for this workspace.' }
      return { state: 'optional', summary: 'Managed for the whole workspace.', action: { label: 'Open integrations', href: '/dashboard/settings/integrations' } }
    },
  },
]

// ─── Resolution ───────────────────────────────────────────────────────────────

export function resolveItems(ctx: ItemContext): ResolvedItem[] {
  const locked = ctx.event.lifecycleStatus === 'cancelled' || ctx.event.lifecycleStatus === 'archived'

  return DEFS.map(def => {
    const r = def.resolve(ctx)
    // A cancelled or archived event cannot be reconfigured — the backend refuses those
    // writes — so no card offers an edit action it would be refused for.
    const action = locked && r.action && !r.action.external ? undefined : r.action
    return { key: def.key, label: def.label, section: def.section, ...r, action }
  })
}

/** Item keys, exported so tests can pin the inventory without importing the defs. */
export const SETUP_ITEM_KEYS = DEFS.map(d => d.key)
