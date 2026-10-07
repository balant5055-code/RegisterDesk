// RD-DASH-08 · Workspace health. PURE — no Firestore, no clock, no React.
//
// ═══ WHAT THIS REPLACED, AND WHY ═════════════════════════════════════════════
// A percentage: `round(doneCount / 6 * 100)` over six equally-weighted checklist items,
// rendered as "33% setup complete". Three things were wrong with it.
//
//   1. IT WAS A MANUFACTURED SCORE. RegisterDesk has no authoritative health-scoring model,
//      so the weights were invented — a missing certificate signature counted exactly as
//      much as having no published event. A number implies a model; there wasn't one.
//   2. IT WAS A CHECKLIST, NOT HEALTH. It answered "did I finish onboarding", not "is my
//      workspace operational". The audited workspace scored 33% while running an event with
//      2,329 registrations.
//   3. ONE ITEM WAS SIMPLY WRONG. See DEFAULT_SEND_CONFIRMATION below.
//
// So the score is gone. What replaces it is a STATE — healthy / needs attention / action
// required / unavailable — derived only from checks the platform can actually observe.
//
// ═══ WHAT THIS CARD IS FOR, AND WHAT IT LEAVES ALONE ═════════════════════════
// "Is my workspace operational and ready?" — deliberately NOT "what needs me right now",
// which the Attention Center already answers from lib/dashboard/insights.ts. The split is
// URGENCY vs READINESS: a published event missing a required field is not time-sensitive,
// but it is broken, and nothing on the dashboard was saying so.
//
// Excluded on purpose, because another card already owns them:
//   • capacity, closing dates, review outcomes, pace  → Attention Center
//   • message volume and failures                     → Communication Usage
//   • coupon states                                   → Coupon Performance
//   • revenue, fees, payouts                          → Finance Summary
//
// ═══ NO INVENTED THRESHOLDS ══════════════════════════════════════════════════
// Event configuration severity is NOT decided here. It comes from
// lib/events/publishRequirements — the same evaluator the publish flow itself runs — so a
// finding this card calls "critical" is exactly one the platform would block a publish on.
// Nothing here invents a business rule, estimates, or infers quality from volume.

/** Severity, ordered. `action` outranks `attention` outranks `info`. */
export type HealthSeverity = 'action' | 'attention' | 'info'

export const SEVERITY_RANK: Record<HealthSeverity, number> = { action: 0, attention: 1, info: 2 }

/**
 * The card's overall verdict.
 *
 * `unavailable` is NOT a fourth degree of bad — it means the checks could not be run at all,
 * and it must never be reported as `healthy`. A workspace whose health is unknown is not a
 * healthy workspace.
 */
export type HealthState = 'healthy' | 'attention' | 'action' | 'unavailable'

export interface HealthCheck {
  id:     string
  label:  string
  /** Why it matters, in the organizer's terms. Shown only when the check is failing. */
  detail: string
  done:   boolean
}

export interface HealthIssue {
  id:          string
  severity:    HealthSeverity
  title:       string
  detail:      string
  /** An EXISTING route, or null when there is nowhere useful to send the organizer. */
  href:        string | null
  actionLabel: string | null
}

export interface WorkspaceHealthInput {
  /** users/{uid}. null ⇒ the profile could not be read; the setup checks are unavailable. */
  profile: {
    organizationName: string | null
    supportEmail:     string | null
    logoUrl:          string | null
    certSignatureUrl: string | null
    /**
     * `communications.sendRegistrationConfirmation` as STORED — undefined when the organizer
     * has never opened the setting. See DEFAULT_SEND_CONFIRMATION.
     */
    sendRegistrationConfirmation: boolean | undefined
  } | null
  /** Published events, with the publish requirements they currently fail. */
  events: {
    publishedCount: number
    /** One entry per published event that fails at least one requirement. */
    gaps: Array<{
      draftId:  string
      name:     string
      critical: number
      warning:  number
    }>
  } | null
}

export interface WorkspaceHealth {
  state:  HealthState
  /** The six setup checks, in display order. Empty when the profile was unreadable. */
  checks: HealthCheck[]
  setup:  { done: number; total: number; unavailable: boolean }
  events: { published: number; criticalEvents: number; warningEvents: number; unavailable: boolean }
  /** Ranked most-severe first. The surface caps how many it shows; nothing is dropped here. */
  issues: HealthIssue[]
}

/**
 * ═══ THE DEFECT THIS CONSTANT FIXES ══════════════════════════════════════════
 * The health check read `communications.sendRegistrationConfirmation ?? false`, while the
 * settings API — the authoritative reader, at app/api/organizer/settings/route.ts — reads
 * the same field `?? true`.
 *
 * So on any workspace that never opened the setting (the field is absent entirely), Settings
 * showed the toggle ON and this card reported "Email communications on: not done". The
 * audited workspace was exactly that case: no `communications` key at all, and 4,707 emails
 * actually sent. An ABSENT setting is the default, not a disabled feature — collapsing the
 * two is the same zero-versus-unavailable error the rest of this dashboard has been purging.
 *
 * Pinned by test against the settings route, so the two cannot drift apart again.
 */
export const DEFAULT_SEND_CONFIRMATION = true

/** Where each failing check sends the organizer. Existing routes only — none is invented. */
const SETTINGS = '/dashboard/settings'
const BRANDING = '/dashboard/settings/branding'
const EVENTS   = '/dashboard/events'

const filled = (v: string | null | undefined): boolean => typeof v === 'string' && v.trim().length > 0

/**
 * PURE. Derives the card from data the dashboard route has already loaded.
 *
 * No I/O and no clock: every rule below is a function of its input, so each is pinned by a
 * test that needs neither Firestore nor a frozen date.
 */
export function buildWorkspaceHealth(input: WorkspaceHealthInput): WorkspaceHealth {
  const { profile, events } = input

  // ── Setup ────────────────────────────────────────────────────────────────
  // The SAME six items the previous card listed. Kept deliberately: they are the existing
  // product definition of workspace setup, and this phase is not the place to invent a new
  // one. What changed is that they no longer become a percentage.
  const checks: HealthCheck[] = profile === null ? [] : [
    {
      id: 'org_name', label: 'Organization name', done: filled(profile.organizationName),
      detail: 'Attendees see this on your public pages, tickets and emails.',
    },
    {
      id: 'support_email', label: 'Support email address', done: filled(profile.supportEmail),
      detail: 'Without one, attendees have no way to reach you about a registration.',
    },
    {
      id: 'send_confirmation', label: 'Registration confirmation email',
      // Absent ⇒ the platform default, which is ON. Never `?? false`.
      done: profile.sendRegistrationConfirmation ?? DEFAULT_SEND_CONFIRMATION,
      detail: 'Attendees are not emailed a confirmation when they register.',
    },
    {
      id: 'logo', label: 'Organization logo', done: filled(profile.logoUrl),
      detail: 'Your logo appears on public event pages and outgoing email.',
    },
    {
      id: 'cert_signature', label: 'Certificate signature', done: filled(profile.certSignatureUrl),
      detail: 'Needed before certificates can be issued for an event.',
    },
    {
      id: 'published_event', label: 'A published event',
      done: (events?.publishedCount ?? 0) > 0,
      detail: 'Nothing is live yet, so nobody can register.',
    },
  ]

  const setupUnavailable = profile === null
  const done  = checks.filter(c => c.done).length
  const total = checks.length

  // ── Event configuration ──────────────────────────────────────────────────
  const gaps           = events?.gaps ?? []
  const criticalEvents = gaps.filter(g => g.critical > 0)
  const warningEvents  = gaps.filter(g => g.critical === 0 && g.warning > 0)

  // ── Issues, ranked ───────────────────────────────────────────────────────
  const issues: HealthIssue[] = []

  // Published-and-broken outranks everything: the event is live and something the platform
  // itself treats as mandatory is missing from it.
  for (const g of criticalEvents) {
    issues.push({
      id: `event_critical:${g.draftId}`, severity: 'action',
      title: g.name,
      detail: `${g.critical} required ${g.critical === 1 ? 'setting is' : 'settings are'} missing on this published event.`,
      href: `/dashboard/events/${encodeURIComponent(g.draftId)}`, actionLabel: 'Fix',
    })
  }

  // Setup gaps, in the order the checks are declared — which is the order they matter in.
  for (const c of checks) {
    if (c.done) continue
    issues.push({
      id: `setup:${c.id}`,
      // The one setup item with an operational consequence rather than a cosmetic one: with
      // it off, every attendee registers and hears nothing back.
      severity: c.id === 'send_confirmation' ? 'action' : 'attention',
      title: c.label, detail: c.detail,
      href: c.id === 'logo' || c.id === 'cert_signature' ? BRANDING : SETTINGS,
      actionLabel: 'Set up',
    })
  }

  // Quality gaps on live events. INFO, not attention: `publishRequirements` classes these as
  // warnings/suggestions and does not block a publish on them, so neither does this card.
  if (warningEvents.length > 0) {
    issues.push({
      id: 'event_warnings', severity: 'info',
      title: `${warningEvents.length} published ${warningEvents.length === 1 ? 'event has' : 'events have'} optional gaps`,
      detail: 'Cover image, description or contact details are incomplete.',
      href: EVENTS, actionLabel: 'Review',
    })
  }

  issues.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])

  // ── The verdict ──────────────────────────────────────────────────────────
  // Unknown is never healthy. If NEITHER source could be read the card has nothing to say
  // and must say that, rather than reporting an all-clear it did not earn.
  const state: HealthState =
    setupUnavailable && (events === null) ? 'unavailable'
      : issues.some(i => i.severity === 'action')    ? 'action'
      : issues.some(i => i.severity === 'attention') ? 'attention'
      : 'healthy'

  return {
    state,
    checks,
    setup:  { done, total, unavailable: setupUnavailable },
    events: {
      published:      events?.publishedCount ?? 0,
      criticalEvents: criticalEvents.length,
      warningEvents:  warningEvents.length,
      unavailable:    events === null,
    },
    issues,
  }
}
