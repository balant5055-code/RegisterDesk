// RD-BADGE-01 · Badge design — the PURE half.
//
// No SDK, no React, no DOM, no I/O. Everything that decides what the badge SAYS lives here,
// so the copy, the truncation and the fallbacks are unit-testable without rendering a pixel.
//
// The rendering half (JSX → PNG) is in ./renderBadge.tsx and contains no decisions.

import type { BadgeRenderInput } from '@/features/finisher-badges/types'

// ─── Palette ──────────────────────────────────────────────────────────────────
//
// Satori resolves no CSS variables and no Tailwind — it needs literal values. These are the
// LITERAL equivalents of the tokens in styles/tokens.css, listed here with their token names
// so a future token change has one obvious place to follow.

export const BADGE_COLORS = {
  /** --primary */
  primary:     '#6D28D9',
  /** --primary-deep */
  primaryDeep: '#4C1D95',
  ink:         '#0F172A',
  surface:     '#FFFFFF',
  muted:       '#64748B',
  hairline:    'rgba(255,255,255,0.14)',
  /** --success */
  success:     '#059669',
  /** --warning */
  warning:     '#D97706',
} as const

// ─── Text preparation ─────────────────────────────────────────────────────────

/**
 * Truncates to fit the badge without overflowing.
 *
 * Satori does not reflow overflowing text the way a browser does, so a 90-character event
 * name would silently run off the canvas. Truncation is explicit and ellipsised.
 */
export function fit(text: string, max: number): string {
  const clean = text.trim().replace(/\s+/g, ' ')
  if (clean.length <= max) return clean
  return `${clean.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

export const LIMITS = {
  eventName:  42,
  raceName:   28,
  runnerName: 30,
  bibNumber:  12,
} as const

// ─── Status presentation ──────────────────────────────────────────────────────

export interface StatusPresentation {
  label: string
  color: string
  /** True when the badge should read as an achievement rather than a record. */
  celebratory: boolean
}

/**
 * How each outcome is presented.
 *
 * A DNF badge is deliberately still issued and still dignified: finishing is not the only
 * thing worth recording, and silently refusing a badge would read as a bug to the
 * participant. It simply does not claim a finish.
 */
export function presentStatus(status: BadgeRenderInput['status']): StatusPresentation {
  switch (status) {
    case 'finished': return { label: 'FINISHER',       color: BADGE_COLORS.success, celebratory: true  }
    case 'dnf':      return { label: 'DID NOT FINISH', color: BADGE_COLORS.warning, celebratory: false }
    case 'dns':      return { label: 'DID NOT START',  color: BADGE_COLORS.muted,   celebratory: false }
    case 'dq':       return { label: 'DISQUALIFIED',   color: BADGE_COLORS.warning, celebratory: false }
    default: {
      const never: never = status
      throw new Error(`Unknown status: ${String(never)}`)
    }
  }
}

/** `1` → `1st`. Shared shape with the certificate ordinal, kept local so this module is pure. */
export function ordinal(n: number): string {
  const rem100 = n % 100
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`
  switch (n % 10) {
    case 1:  return `${n}st`
    case 2:  return `${n}nd`
    case 3:  return `${n}rd`
    default: return `${n}th`
  }
}

/** `2026-02-01` → `1 February 2026`. Returns null rather than inventing a date. */
export function formatEventDate(iso: string | null): string | null {
  if (!iso) return null
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return null
  const date = new Date(Date.UTC(y, m - 1, d))
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleDateString('en-IN', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  })
}

// ─── The resolved view model ──────────────────────────────────────────────────

export interface BadgeViewModel {
  eventName:    string
  eventDate:    string | null
  eventLogoUrl: string | null
  raceName:     string
  /** Falls back to the bib when the timing file carried no name. */
  displayName:  string
  bibNumber:    string
  /** Null when there is no time to show. */
  timeLabel:    string | null
  /** Null when unranked. */
  rankLabel:    string | null
  rankSubLabel: string | null
  status:       StatusPresentation
}

/**
 * Turns raw snapshot facts into exactly what the badge prints.
 *
 * Every fallback is decided here, so the renderer never contains an `??`. Notably:
 *   • no runner name (the timing file had no name column) → "Bib 1234"
 *   • no rank (DNF / DNS / DQ)                            → the rank block is omitted
 *   • no chip time                                        → the time block is omitted
 * A badge is produced in every one of those cases rather than failing.
 */
export function buildViewModel(input: BadgeRenderInput): BadgeViewModel {
  const status = presentStatus(input.status)

  return {
    eventName:    fit(input.eventName, LIMITS.eventName),
    eventDate:    formatEventDate(input.eventDate),
    eventLogoUrl: input.eventLogoUrl,
    raceName:     fit(input.raceName, LIMITS.raceName),
    displayName:  input.runnerName
      ? fit(input.runnerName, LIMITS.runnerName)
      : `Bib ${fit(input.bibNumber, LIMITS.bibNumber)}`,
    bibNumber:    fit(input.bibNumber, LIMITS.bibNumber),
    timeLabel:    input.chipTime ?? null,
    rankLabel:    input.overallRank !== null ? ordinal(input.overallRank) : null,
    rankSubLabel: input.overallRank !== null && input.finisherCount > 0
      ? `of ${input.finisherCount.toLocaleString('en-IN')} finishers`
      : null,
    status,
  }
}
