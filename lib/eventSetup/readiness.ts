// RD-EVENT-04 · Event Setup Center — the authoritative readiness model.
//
// ═══ THE DEFECT THIS EXISTS TO CLOSE ═════════════════════════════════════════
// The Setup registry derived every card's status from the draft with its own rules,
// entirely independently of `evaluatePublishRequirements` — the evaluator the publish
// flow actually gates on. The two disagreed, so a card could read "Ready" for an event
// the platform would refuse to publish, and one publish blocker (`event_organizer`)
// had no card at all: an organizer could see a wall of green and still be unable to go
// live, with nothing on screen explaining why.
//
// Readiness is now sourced from ONE place: `publishChecks` on the event payload, which
// is that same evaluator's roll-call. This module maps checks onto the registry's cards
// and decides precedence; it re-derives no requirement and invents none.
//
// Pure — no React, no Firebase, no DOM.

import type { EventDetailResponse, EventPublishCheck } from '@/app/api/organizer/events/[eventId]/route'
import type { FeatureFlagsConfig } from '@/lib/config/businessConfig'
import type { TeamPermission } from '@/lib/team/types'

// ─── States ───────────────────────────────────────────────────────────────────

/**
 * Ordered by urgency. `blocked` outranks everything because it is the only state that
 * stops the event going live.
 */
export type ItemState =
  | 'blocked'        // an unmet CRITICAL publish requirement — publishing is refused
  | 'attention'      // an unmet warning, or a real configuration gap
  | 'ready'          // authoritatively satisfied
  | 'optional'       // suggestion-tier, or a genuinely optional capability, not set
  | 'unavailable'    // a signal this card needs could not be read
  | 'not_applicable' // switched off for this workspace, or meaningless for this event

export const STATE_RANK: Record<ItemState, number> = {
  blocked: 0, attention: 1, unavailable: 2, ready: 3, optional: 4, not_applicable: 5,
}

/** Human label. Status must be readable without colour, so every state has words. */
export const STATE_LABEL: Record<ItemState, string> = {
  blocked:        'Required',
  attention:      'Needs attention',
  ready:          'Ready',
  optional:       'Optional',
  unavailable:    'Unavailable',
  not_applicable: 'Not applicable',
}

/** Tone from the shared accent scale — never a raw hue. */
export const STATE_TONE: Record<ItemState, 'critical' | 'pending' | 'verify' | 'neutral'> = {
  blocked:        'critical',
  attention:      'pending',
  ready:          'verify',
  optional:       'neutral',
  unavailable:    'neutral',
  not_applicable: 'neutral',
}

// ─── Readiness summary ────────────────────────────────────────────────────────

export interface Readiness {
  /** True only when every CRITICAL check passes. */
  canPublish: boolean
  /** Null when `publishChecks` is absent — status could not be determined. */
  known:      boolean
  criticalTotal:  number
  criticalPassed: number
  warningOpen:    number
  /** Unmet critical checks, in evaluator order. */
  blockers: EventPublishCheck[]
  /** Unmet warnings — worth fixing, never publish-blocking. */
  warnings: EventPublishCheck[]
  /** Headline sentence. Never claims readiness from an unknown state. */
  headline: string
}

export function readiness(event: EventDetailResponse): Readiness {
  const checks = event.publishChecks

  if (!checks || checks.length === 0) {
    // Unknown is NOT ready. Saying "ready to publish" because a check could not run is
    // exactly the failure mode this page exists to prevent.
    return {
      canPublish: false, known: false,
      criticalTotal: 0, criticalPassed: 0, warningOpen: 0,
      blockers: [], warnings: [],
      headline: "Setup status couldn't be checked.",
    }
  }

  const critical  = checks.filter(c => c.severity === 'critical')
  const blockers  = critical.filter(c => !c.passed)
  const warnings  = checks.filter(c => c.severity === 'warning' && !c.passed)
  const canPublish = blockers.length === 0

  return {
    canPublish, known: true,
    criticalTotal:  critical.length,
    criticalPassed: critical.length - blockers.length,
    warningOpen:    warnings.length,
    blockers, warnings,
    headline: canPublish
      ? (warnings.length > 0
          ? 'Everything required for publishing is ready.'
          : 'Everything required for publishing is ready.')
      : `${blockers.length} ${blockers.length === 1 ? 'item blocks' : 'items block'} publishing.`,
  }
}

// ─── Item model ───────────────────────────────────────────────────────────────

export type SetupSection =
  | 'essentials' | 'registration' | 'operations' | 'audience' | 'advanced'

export const SECTION_ORDER: { key: SetupSection; label: string; blurb: string }[] = [
  { key: 'essentials',   label: 'Event essentials',      blurb: 'What the event is, when and where.' },
  { key: 'registration', label: 'Registration & tickets', blurb: 'How attendees sign up and pay.' },
  { key: 'operations',   label: 'Operations',             blurb: 'Running the event on the day.' },
  { key: 'audience',     label: 'Audience & content',     blurb: 'Your public page and how you reach attendees.' },
  { key: 'advanced',     label: 'Advanced',               blurb: 'Workspace-level and optional capabilities.' },
]

export interface ResolvedItem {
  key:      string
  label:    string
  section:  SetupSection
  state:    ItemState
  /** One line: the current VALUE where there is one, else why the state is what it is. */
  summary:  string
  /** Set when this item maps to a publish requirement, so the UI can deep-link a fix. */
  checkId?: string
  action?:  { label: string; href: string; external?: boolean }
}

// ─── Gating ───────────────────────────────────────────────────────────────────

export interface GateContext {
  flags: FeatureFlagsConfig
  has:   (p: TeamPermission) => boolean
}

/**
 * Feature flag and permission for each card, mirroring what the routes already enforce.
 *
 * Setup applied NEITHER before: a workspace with certificates switched off still saw a
 * Certificates card with a live "Configure" button, and a member without `broadcasts`
 * saw Communications. UI gating is not security — every route re-checks server-side —
 * but offering a door that slams is its own defect.
 */
interface Gate { flag?: keyof FeatureFlagsConfig; permission?: TeamPermission }

export const ITEM_GATES: Record<string, Gate> = {
  registrations:  { permission: 'registrations' },
  passes:         { permission: 'events' },
  coupons:        { flag: 'coupons', permission: 'events' },
  waitlist:       { permission: 'registrations' },
  checkin:        { permission: 'checkin' },
  identifiers:    { permission: 'participants' },
  communications: { flag: 'broadcast', permission: 'broadcasts' },
  certificates:   { flag: 'certificates', permission: 'certificates' },
  media:          { permission: 'events' },
  print_assets:   { permission: 'events' },
  donations:      { flag: 'donations' },
  custom_domain:  { flag: 'customDomains' },
  white_label:    { flag: 'whiteLabel' },
  api_access:     { flag: 'publicApi' },
  reports:        {},
}

/** `not_applicable` when the workspace has the feature off or the member lacks the permission. */
export function gateState(key: string, gate: GateContext): ItemState | null {
  const g = ITEM_GATES[key]
  if (!g) return null
  if (g.flag && !gate.flags[g.flag]) return 'not_applicable'
  if (g.permission && !gate.has(g.permission)) return 'not_applicable'
  return null
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

const LIVE_LIKE = new Set(['published', 'registration_closed', 'completed'])

/** Has this event ever gone live? Drives whether operational tooling is usable yet. */
export function isLive(event: EventDetailResponse): boolean {
  return LIVE_LIKE.has(event.lifecycleStatus)
}

/**
 * Configuration is locked once an event is cancelled or archived — the backend refuses
 * lifecycle-changing writes in those states, so offering edit actions would be a lie.
 * `completed` is deliberately NOT locked: reports, certificates and exports stay useful.
 */
export function isLocked(event: EventDetailResponse): boolean {
  return event.lifecycleStatus === 'cancelled' || event.lifecycleStatus === 'archived'
}

/**
 * Publish requirements only matter while the event can still be published. Telling the
 * organizer of a completed event that its description is thin is noise, not readiness.
 */
export function publishChecksApply(event: EventDetailResponse): boolean {
  return event.lifecycleStatus === 'draft'
    || event.lifecycleStatus === 'pending_review'
    || event.lifecycleStatus === 'changes_requested'
    || event.lifecycleStatus === 'unpublished'
}
