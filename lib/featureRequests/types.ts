// RD-FEATURE-REQ-01 — Feature Requests: shared types, validation and the organizer-safe view.
// PURE and browser-safe (no Firebase, no Node APIs): the organizer form validates with the SAME
// functions the server enforces, so the two can never disagree about what is acceptable.
//
//   featureRequests/{id}                 the request (Admin SDK only — no firestore.rules match)
//   featureRequests/{id}/history/{hid}   append-only status changes: from, to, actor, time
//   featureRequests/{id}/notes/{nid}     Super Admin internal notes — NEVER read by an organizer route
//
// A request is a record of what an organizer asked for. It never enables anything: `rollout` is
// a PLAN (who a finished feature is meant for), stored for the Super Admin and read by no gate.
// See lib/featureRequests/README.md for the activation interface that would enforce it.

import { EVENT_TYPE_NAMES } from '@/lib/events/taxonomy'

// ─── Status ────────────────────────────────────────────────────────────────────

export const FEATURE_REQUEST_STATUSES = ['submitted', 'under_review', 'planned', 'in_development', 'released', 'declined'] as const
export type FeatureRequestStatus = typeof FEATURE_REQUEST_STATUSES[number]

export const STATUS_LABEL: Record<FeatureRequestStatus, string> = {
  submitted:      'Submitted',
  under_review:   'Under Review',
  planned:        'Planned',
  in_development: 'In Development',
  released:       'Released',
  declined:       'Declined',
}

export const isStatus = (v: unknown): v is FeatureRequestStatus =>
  typeof v === 'string' && (FEATURE_REQUEST_STATUSES as readonly string[]).includes(v)

/**
 * The organizer is told about every status change EXCEPT a move back to "Submitted" — that is a
 * Super Admin correcting their own triage, not news. One notification per history entry.
 */
export function notifiesOrganizer(to: FeatureRequestStatus): boolean {
  return to !== 'submitted'
}

// ─── Organizer input ───────────────────────────────────────────────────────────

export const ORGANIZER_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const
export type OrganizerPriority = typeof ORGANIZER_PRIORITIES[number]
export const ORGANIZER_PRIORITY_LABEL: Record<OrganizerPriority, string> = {
  low: 'Nice to have', medium: 'Important', high: 'Very important', critical: 'Blocking my events',
}

/** Event types an organizer can name: every real type, plus "applies to all". */
export const REQUEST_EVENT_TYPES = ['all', ...Object.keys(EVENT_TYPE_NAMES)] as const
export const requestEventTypeLabel = (t: string): string => (t === 'all' ? 'All event types' : EVENT_TYPE_NAMES[t] ?? t)

export const LIMITS = {
  title:    { min: 8,  max: 120 },
  problem:  { min: 20, max: 2000 },
  proposal: { min: 20, max: 2000 },
  response: { max: 2000 },
  note:     { min: 2, max: 2000 },
  rolloutList: 200,
} as const

export interface FeatureRequestSubmission {
  title:             string
  problem:           string
  proposal:          string
  eventId:           string | null   // the organizer's event (draft id), verified server-side
  eventType:         string
  organizerPriority: OrganizerPriority
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string> }

const text = (v: unknown) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim() : '')
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/

/**
 * The ONLY fields an organizer can set. Anything else in the body — status, workspace, priority
 * overrides, responses — is ignored, never copied (no mass assignment).
 */
export function validateSubmission(raw: unknown): ValidationResult<FeatureRequestSubmission> {
  const b = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const errors: Record<string, string> = {}
  const title = text(b.title), problem = text(b.problem), proposal = text(b.proposal)
  if (title.length < LIMITS.title.min || title.length > LIMITS.title.max) errors.title = `Use ${LIMITS.title.min}–${LIMITS.title.max} characters.`
  if (problem.length < LIMITS.problem.min || problem.length > LIMITS.problem.max) errors.problem = `Describe the need in ${LIMITS.problem.min}–${LIMITS.problem.max} characters.`
  if (proposal.length < LIMITS.proposal.min || proposal.length > LIMITS.proposal.max) errors.proposal = `Describe the behaviour and benefit in ${LIMITS.proposal.min}–${LIMITS.proposal.max} characters.`
  const eventId = b.eventId === null || b.eventId === undefined || b.eventId === '' ? null : typeof b.eventId === 'string' && ID_RE.test(b.eventId) ? b.eventId : undefined
  if (eventId === undefined) errors.eventId = 'Choose one of your events, or none.'
  const eventType = typeof b.eventType === 'string' && (REQUEST_EVENT_TYPES as readonly string[]).includes(b.eventType) ? b.eventType : null
  if (!eventType) errors.eventType = 'Choose an event type.'
  const organizerPriority = typeof b.organizerPriority === 'string' && (ORGANIZER_PRIORITIES as readonly string[]).includes(b.organizerPriority) ? b.organizerPriority as OrganizerPriority : null
  if (!organizerPriority) errors.organizerPriority = 'Choose a priority.'
  if (Object.keys(errors).length) return { ok: false, errors }
  return { ok: true, value: { title, problem, proposal, eventId: eventId ?? null, eventType: eventType!, organizerPriority: organizerPriority! } }
}

// ─── Super Admin input ─────────────────────────────────────────────────────────

export const ADMIN_PRIORITIES = ['p0', 'p1', 'p2', 'p3'] as const
export type AdminPriority = typeof ADMIN_PRIORITIES[number]
export const ADMIN_PRIORITY_LABEL: Record<AdminPriority, string> = { p0: 'P0 · Urgent', p1: 'P1 · High', p2: 'P2 · Normal', p3: 'P3 · Low' }

export const ROLLOUT_SCOPES = ['none', 'selected_events', 'selected_organizers', 'event_types', 'all_eligible'] as const
export type RolloutScope = typeof ROLLOUT_SCOPES[number]
export const ROLLOUT_SCOPE_LABEL: Record<RolloutScope, string> = {
  none: 'Not planned', selected_events: 'Selected events', selected_organizers: 'Selected organizers',
  event_types: 'Eligible event types', all_eligible: 'All eligible events',
}

/** A PLAN, never an activation. `enforced` is always false — no gate reads this record. */
export interface RolloutPlan {
  scope:         RolloutScope
  eventSlugs:    string[]
  organizerUids: string[]
  eventTypes:    string[]
  flagKey:       string | null   // an EXISTING Business Configuration feature flag, if one applies
  enforced:      false
}

export const EMPTY_ROLLOUT: RolloutPlan = { scope: 'none', eventSlugs: [], organizerUids: [], eventTypes: [], flagKey: null, enforced: false }

export interface AdminPatch {
  status?:            FeatureRequestStatus
  adminPriority?:     AdminPriority | null
  organizerResponse?: string | null
  releaseNote?:       string | null
  duplicateOf?:       string | null
  rollout?:           RolloutPlan
  /** Optimistic concurrency: the status the admin was looking at. A mismatch is refused. */
  expectedStatus?:    FeatureRequestStatus
}

const idList = (v: unknown, re: RegExp): string[] | null => {
  if (!Array.isArray(v) || v.length > LIMITS.rolloutList) return null
  const out = [...new Set(v.filter((x): x is string => typeof x === 'string').map(s => s.trim()).filter(Boolean))]
  return out.length === v.length && out.every(s => re.test(s)) ? out : null
}

/**
 * The ONLY fields a Super Admin can change, each validated. Unknown keys are ignored.
 * `flagKeys` is the existing flag registry (FEATURE_FLAG_KEYS), passed in to keep this module pure.
 */
export function validateAdminPatch(raw: unknown, flagKeys: readonly string[]): ValidationResult<AdminPatch> {
  const b = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const errors: Record<string, string> = {}
  const out: AdminPatch = {}
  if ('status' in b) { if (isStatus(b.status)) out.status = b.status; else errors.status = 'Unknown status.' }
  if ('expectedStatus' in b) { if (isStatus(b.expectedStatus)) out.expectedStatus = b.expectedStatus; else errors.expectedStatus = 'Unknown status.' }
  if ('adminPriority' in b) {
    if (b.adminPriority === null) out.adminPriority = null
    else if (typeof b.adminPriority === 'string' && (ADMIN_PRIORITIES as readonly string[]).includes(b.adminPriority)) out.adminPriority = b.adminPriority as AdminPriority
    else errors.adminPriority = 'Unknown priority.'
  }
  for (const k of ['organizerResponse', 'releaseNote'] as const) {
    if (!(k in b)) continue
    if (b[k] === null) { out[k] = null; continue }
    const t = text(b[k])
    if (typeof b[k] !== 'string' || t.length > LIMITS.response.max) errors[k] = `Up to ${LIMITS.response.max} characters.`
    else out[k] = t || null
  }
  if ('duplicateOf' in b) {
    if (b.duplicateOf === null || b.duplicateOf === '') out.duplicateOf = null
    else if (typeof b.duplicateOf === 'string' && ID_RE.test(b.duplicateOf.trim())) out.duplicateOf = b.duplicateOf.trim()
    else errors.duplicateOf = 'Not a request id.'
  }
  if ('rollout' in b) {
    const r = b.rollout && typeof b.rollout === 'object' ? b.rollout as Record<string, unknown> : null
    const scope = r && typeof r.scope === 'string' && (ROLLOUT_SCOPES as readonly string[]).includes(r.scope) ? r.scope as RolloutScope : null
    const eventSlugs = idList(r?.eventSlugs ?? [], /^[a-z0-9][a-z0-9-]{0,127}$/)
    const organizerUids = idList(r?.organizerUids ?? [], ID_RE)
    const eventTypes = idList(r?.eventTypes ?? [], /^[a-z_]{1,40}$/)
    const flagKey = r?.flagKey === null || r?.flagKey === undefined || r?.flagKey === '' ? null : typeof r?.flagKey === 'string' && flagKeys.includes(r.flagKey) ? r.flagKey : undefined
    if (!scope) errors.rollout = 'Unknown rollout scope.'
    else if (!eventSlugs || !organizerUids || !eventTypes) errors.rollout = `Lists must hold up to ${LIMITS.rolloutList} valid ids.`
    else if (eventTypes.some(t => !(t in EVENT_TYPE_NAMES))) errors.rollout = 'Unknown event type in rollout.'
    else if (flagKey === undefined) errors.rollout = 'flagKey must be an existing feature flag.'
    else if (scope === 'selected_events' && eventSlugs.length === 0) errors.rollout = 'Name at least one event.'
    else if (scope === 'selected_organizers' && organizerUids.length === 0) errors.rollout = 'Name at least one organizer.'
    else if (scope === 'event_types' && eventTypes.length === 0) errors.rollout = 'Choose at least one event type.'
    else out.rollout = {
      scope,
      // Only the list the scope uses is kept — a stale list from another scope is not a plan.
      eventSlugs:    scope === 'selected_events' ? eventSlugs : [],
      organizerUids: scope === 'selected_organizers' ? organizerUids : [],
      eventTypes:    scope === 'event_types' ? eventTypes : [],
      flagKey,
      enforced: false,
    }
  }
  if (Object.keys(errors).length) return { ok: false, errors }
  const changes = Object.keys(out).filter(k => k !== 'expectedStatus')
  if (changes.length === 0) return { ok: false, errors: { _: 'Nothing to change.' } }
  return { ok: true, value: out }
}

/** A decline must tell the organizer why. */
export function declineNeedsResponse(nextStatus: FeatureRequestStatus | undefined, response: string | null | undefined): boolean {
  return nextStatus === 'declined' && !(response && response.trim().length >= 10)
}

// ─── Views ─────────────────────────────────────────────────────────────────────

export interface StatusHistoryEntry { id: string; from: FeatureRequestStatus | null; to: FeatureRequestStatus; at: string | null }

/** What an organizer may see. No internal notes, no rollout targets, no admin identities. */
export interface OrganizerFeatureRequestView {
  id:                string
  title:             string
  problem:           string
  proposal:          string
  eventId:           string | null
  eventName:         string | null
  eventType:         string
  organizerPriority: OrganizerPriority
  status:            FeatureRequestStatus
  organizerResponse: string | null
  releaseNote:       string | null
  /** True when the Super Admin tracks this together with an earlier request (never merged). */
  linkedToExisting:  boolean
  createdAt:         string | null
  updatedAt:         string | null
  history?:          StatusHistoryEntry[]
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
export function toISO(v: unknown): string | null {
  if (v && typeof (v as { toDate?: () => Date }).toDate === 'function') {
    try { return (v as { toDate: () => Date }).toDate().toISOString() } catch { return null }
  }
  return typeof v === 'string' ? v : null
}

/** Whitelist projection — every organizer read goes through this, so new admin fields stay private. */
export function toOrganizerView(id: string, d: Record<string, unknown>, history?: StatusHistoryEntry[]): OrganizerFeatureRequestView {
  return {
    id,
    title:             String(d.title ?? ''),
    problem:           String(d.problem ?? ''),
    proposal:          String(d.proposal ?? ''),
    eventId:           str(d.eventId),
    eventName:         str(d.eventName),
    eventType:         String(d.eventType ?? 'all'),
    organizerPriority: (ORGANIZER_PRIORITIES as readonly string[]).includes(String(d.organizerPriority)) ? d.organizerPriority as OrganizerPriority : 'medium',
    status:            isStatus(d.status) ? d.status : 'submitted',
    organizerResponse: str(d.organizerResponse),
    releaseNote:       str(d.releaseNote),
    linkedToExisting:  typeof d.duplicateOf === 'string' && d.duplicateOf.length > 0,
    createdAt:         toISO(d.createdAt),
    updatedAt:         toISO(d.updatedAt),
    ...(history ? { history } : {}),
  }
}

// ─── Duplicate suggestions ─────────────────────────────────────────────────────

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'for', 'of', 'in', 'on', 'with', 'my', 'our', 'be', 'is', 'add', 'allow', 'option', 'feature', 'support', 'ability'])
export function titleTokens(t: string): Set<string> {
  return new Set(t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)))
}
/** Jaccard similarity of two titles' content words, 0–1. A SUGGESTION only — never acted on automatically. */
export function titleSimilarity(a: string, b: string): number {
  const x = titleTokens(a), y = titleTokens(b)
  if (!x.size || !y.size) return 0
  let inter = 0
  for (const w of x) if (y.has(w)) inter++
  return inter / (x.size + y.size - inter)
}
