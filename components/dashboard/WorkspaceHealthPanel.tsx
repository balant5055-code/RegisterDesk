'use client'

// RD-DASH-08 · Workspace health.
//
// ═══ WHAT THIS REPLACED ══════════════════════════════════════════════════════
// "33% setup complete" over six dots. The percentage was `round(done / 6 * 100)` — six
// equally-weighted items, so a missing certificate signature cost exactly as much as having
// no published event. The audited workspace scored 33% while running an event with 2,329
// registrations, which tells you what the number was worth.
//
// ═══ WHAT THE CARD IS FOR ════════════════════════════════════════════════════
// "Is my workspace operational and ready?" — a VERDICT first, then only as much detail as it
// takes to act on it.
//
//   STATE     one word, earned from the checks below and never from a score.
//   SIGNALS   the two things the verdict is made of: setup, and live-event configuration.
//   ISSUES    the top few, most severe first, each with somewhere to go.
//
// Deliberately NOT "what needs me right now" — the Attention Center above already answers
// that, from the same event set. The split is urgency versus readiness, and it is why this
// card says nothing about capacity, closing dates, review outcomes, message volume or
// coupons: four other cards own those, and repeating them would make this one furniture.
//
// ═══ THE RULE THAT SHAPES EVERY BRANCH ═══════════════════════════════════════
// `unavailable` is not a fourth degree of bad. It means the checks could not be run, and it
// can never render as the healthy state — a workspace whose health is unknown is not a
// healthy workspace. That is the same rule RD-DASH-05A through 07 applied to zeros.

import Link from 'next/link'
import { AlertTriangle, HeartPulse, HelpCircle, ShieldCheck, ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { accent } from '@/lib/dashboard/accents'
import { SectionCard } from '@/components/dashboard/SectionCard'
import type { HealthSeverity, HealthState, WorkspaceHealth } from '@/lib/dashboard/workspaceHealth'

/** How many issues the card lists. The rest are counted, never dropped silently. */
export const HEALTH_ISSUES_SHOWN = 3

// ─── The palette ────────────────────────────────────────────────────────────────

/**
 * A state and the `--health-*` token family that dresses it.
 *
 * Four states, four tones, no overlap — and only `healthy` carries a gradient, because it is
 * the card's one hero element. A warning that shimmers reads as decoration.
 */
type HealthTone = 'healthy' | 'attention' | 'action' | 'unknown'

const STATE_TONE: Record<HealthState, HealthTone> = {
  healthy: 'healthy', attention: 'attention', action: 'action', unavailable: 'unknown',
}
/** Severity → the same four tones, so an issue and the verdict it caused wear one colour. */
const SEVERITY_TONE: Record<HealthSeverity, HealthTone> = {
  action: 'action', attention: 'attention', info: 'unknown',
}

const toneTint = (t: HealthTone) => `var(--health-${t}-tint)`
const toneInk  = (t: HealthTone) => `var(--health-${t}-ink)`

const STATE_LABEL: Record<HealthState, string> = {
  healthy:     'Healthy',
  attention:   'Needs attention',
  action:      'Action required',
  unavailable: 'Unavailable',
}

const STATE_ICON: Record<HealthState, React.ElementType> = {
  healthy: ShieldCheck, attention: AlertTriangle, action: ShieldAlert, unavailable: HelpCircle,
}

// ─── Supporting signal ──────────────────────────────────────────────────────────

/**
 * One of the two things the verdict is made of.
 *
 * `value` is already resolved by the caller so this stays a dumb renderer — including the
 * unmeasured case, which reads "Unavailable" rather than borrowing a zero.
 */
function Signal({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="min-w-0" role="group" aria-label={`${label}: ${value}. ${note}`}>
      <p className="text-fs-2xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-fs-sm font-semibold tabular-nums text-foreground">{value}</p>
      <p className="text-fs-2xs text-muted-foreground">{note}</p>
    </div>
  )
}

// ─── One issue ──────────────────────────────────────────────────────────────────

/**
 * An issue says WHAT is wrong, WHY it matters, and offers WHERE to fix it.
 *
 * The row is only a link when there is somewhere useful to go — a clickable row that lands
 * on a page with nothing to do on it is worse than a row that is not clickable.
 */
function Issue({ severity, title, detail, href, actionLabel }: {
  severity:    HealthSeverity
  title:       string
  detail:      string
  href:        string | null
  actionLabel: string | null
}) {
  const tone = SEVERITY_TONE[severity]
  const body = (
    <>
      <span
        className="mt-1 size-2 shrink-0 rounded-pill"
        style={{ background: toneInk(tone) }}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="block break-words text-fs-xs font-semibold text-foreground">{title}</span>
        <span className="block break-words text-fs-2xs text-muted-foreground">{detail}</span>
      </span>
      {/* RD-DASH-15 · `text-primary-text` is the text-safe brand pink; `text-primary` is the
          FILL and measures 4.28:1 at body size. */}
      {href && actionLabel && (
        <span className="shrink-0 text-fs-2xs font-medium text-primary-text">{actionLabel}</span>
      )}
    </>
  )

  // The severity word is part of the spoken sentence, so nothing here rests on the dot's
  // colour alone.
  const spoken = `${severity === 'action' ? 'Action required' : severity === 'attention' ? 'Needs attention' : 'For information'}: ${title}. ${detail}`

  return href ? (
    <li>
      <Link
        href={href}
        aria-label={`${spoken} ${actionLabel ?? ''}`.trim()}
        className="flex items-start gap-2 rounded-control py-1.5 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >{body}</Link>
    </li>
  ) : (
    <li className="flex items-start gap-2 py-1.5" role="group" aria-label={spoken}>{body}</li>
  )
}

// ─── The card ───────────────────────────────────────────────────────────────────

export function WorkspaceHealthPanel({ health, scopeNote, href = '/dashboard/settings' }: {
  health: WorkspaceHealth
  /**
   * The workspace-scope pill, decided by the SERVER and forwarded by the page.
   *
   * Not hardcoded here on purpose: `scope.workspaceOnly` is server-owned so that a section
   * which becomes genuinely scopeable loses its pill by itself. Communication Usage did
   * exactly that in RD-DASH-06 — the server had already dropped it from the list while the
   * page still carried a comment claiming the opposite.
   */
  scopeNote?: string
  href?: string
}) {
  const { state, setup, events, issues } = health
  const tone  = STATE_TONE[state]
  const Icon  = STATE_ICON[state]
  const shown = issues.slice(0, HEALTH_ISSUES_SHOWN)

  /**
   * One sentence under the verdict, and it must agree with the verdict exactly.
   *
   * The healthy line names what was actually checked. "Everything is fine" over an unstated
   * scope is the kind of reassurance that stops being believed the first time it is wrong.
   */
  const summary = state === 'unavailable'
    ? 'These checks could not be run, so nothing here is reported as healthy.'
    : state === 'healthy'
      ? 'Workspace setup is complete and every published event passes its required checks.'
      : issues.length === 1
        ? '1 thing to look at.'
        : `${issues.length} things to look at.`

  return (
    <SectionCard
      title="Workspace health"
      leading={
        <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-control', accent('verify').tile)} aria-hidden>
          <HeartPulse className="size-3.5" />
        </span>
      }
      href={href}
      hrefLabel="Settings"
      // Setup, branding and event configuration are properties of the WORKSPACE, not of any
      // one event — so this card stays workspace-wide even when an event is selected, and
      // wears the server's pill to say so.
      scopeNote={scopeNote}
      className="h-full"
      bodyClassName="flex flex-col"
    >
      <div className="flex flex-1 flex-col gap-3 px-4 py-3">
        {/* ── VERDICT ── */}
        <div
          className="flex items-start gap-2.5 rounded-surface px-3 py-2.5"
          // Only the healthy state gets the gradient; the rest take a flat tint.
          style={state === 'healthy'
            ? { backgroundImage: 'var(--health-healthy-fill)', color: 'var(--kpi-on-fill)' }
            : { background: toneTint(tone) }}
          role="status"
        >
          <Icon
            className="mt-0.5 size-4 shrink-0"
            style={state === 'healthy' ? undefined : { color: toneInk(tone) }}
            aria-hidden
          />
          <span className="min-w-0">
            {/* The state is TEXT. A screen reader gets the verdict, not a colour. */}
            <span
              className={cn('block text-fs-md font-semibold leading-tight',
                state !== 'healthy' && 'text-foreground')}
              style={state === 'healthy' ? undefined : { color: toneInk(tone) }}
            >{STATE_LABEL[state]}</span>
            <span className={cn('mt-0.5 block break-words text-fs-2xs',
              state === 'healthy' ? 'opacity-90' : 'text-muted-foreground')}>{summary}</span>
          </span>
        </div>

        {/* ── SIGNALS · the two things the verdict is made of ── */}
        <div className="grid grid-cols-2 gap-3">
          <Signal
            label="Setup"
            // Never a percentage. A tally is a literal count of a checklist; a percentage
            // implies a weighting model that RegisterDesk does not have.
            value={setup.unavailable ? 'Unavailable' : `${setup.done} of ${setup.total}`}
            note={setup.unavailable ? 'profile could not be read' : 'settings complete'}
          />
          <Signal
            label="Live events"
            value={events.unavailable ? 'Unavailable' : String(events.published)}
            note={events.unavailable ? 'events could not be read'
              : events.published === 0 ? 'nothing published yet'
              : events.criticalEvents > 0
                ? `${events.criticalEvents} ${events.criticalEvents === 1 ? 'is' : 'are'} missing required settings`
                : 'all pass required checks'}
          />
        </div>

        {/* ── ISSUES · most severe first ── */}
        {shown.length > 0 && (
          <ul className="divide-y divide-border/70">
            {shown.map(i => (
              <Issue
                key={i.id}
                severity={i.severity}
                title={i.title}
                detail={i.detail}
                href={i.href}
                actionLabel={i.actionLabel}
              />
            ))}
          </ul>
        )}

        {/* A top-N list that does not admit it is one reads as the whole set. Pushed to the
            foot so the row of cards shares one bottom edge whatever each has to say. */}
        <dl className="mt-auto flex items-baseline justify-between gap-3 border-t border-border pt-2.5">
          <dt className="truncate text-fs-2xs font-medium uppercase tracking-wide text-muted-foreground">
            {issues.length > shown.length ? `Top ${shown.length} by severity` : 'Workspace-wide'}
          </dt>
          <dd className="shrink-0 text-fs-2xs text-muted-foreground">
            {/* An unavailable card computed no issues, so it must not report a count of
                them — "0 to look at" beside "Unavailable" reads as an all-clear. */}
            {state === 'unavailable' ? 'not checked'
              : issues.length > shown.length ? `of ${issues.length} to look at`
              : state === 'healthy' ? 'nothing outstanding'
              : `${issues.length} to look at`}
          </dd>
        </dl>
      </div>
    </SectionCard>
  )
}

