// ─── RegisterDesk Semantic Typography ────────────────────────────────────────
//
// Single source of truth for typography ROLES. Reusable components consume a
// semantic role instead of choosing font sizes/weights ad hoc — pages and shared
// components never make raw typography decisions (no scattered text-[12.5px],
// text-sm, or the raw --fs-2xs … --fs-5xl tokens).
//
// Each role composes ONLY typography concerns: the token-backed `text-fs-*`
// font-size utilities (generated from --fs-* via @theme in globals.css) plus
// weight, tracking, and leading. Roles never encode color, spacing, or layout —
// those stay on the component/page and merge in via cn().
//
// Rules:
//   • No pixel literals — sizes always reference the fs scale (text-fs-*).
//   • cn()/twMerge (lib/utils/cn.ts) treats text-fs-* as font-size utilities, so
//     `cn(typography.body, 'text-muted-foreground')` keeps BOTH size and color.
//
// Usage:
//   import { typography } from '@/lib/ds/typography'
//   <h2 className={cn(typography.sectionHeading, 'text-foreground')}>…</h2>
//   <p  className={cn(typography.body, 'text-muted-foreground')}>Copy</p>
// ─────────────────────────────────────────────────────────────────────────────

// ── Low-level font-size primitive (size only — compose with weight/color/etc.) ──
export const fs = {
  '2xs': 'text-fs-2xs',   // 11px
  xs:    'text-fs-xs',    // 12px
  sm:    'text-fs-sm',    // 13px
  base:  'text-fs-base',  // 14px
  md:    'text-fs-md',    // 15px
  lg:    'text-fs-lg',    // 18px
  xl:    'text-fs-xl',    // 24px
  '2xl': 'text-fs-2xl',   // 28px
  '3xl': 'text-fs-3xl',   // 32px
  '4xl': 'text-fs-4xl',   // 40px
  '5xl': 'text-fs-5xl',   // 48px
} as const

// ── Semantic roles (size + weight + tracking + leading; NO color) ─────────────
export const typography = {
  // Headings
  pageHeading:       'text-fs-3xl font-bold tracking-tight',   // 32 — top-level page H1
  sectionHeading:    'text-fs-2xl font-bold tracking-tight',   // 28 — section H2
  subsectionHeading: 'text-fs-lg font-semibold',               // 18 — sub-section
  cardTitle:         'text-fs-md font-semibold',               // 15 — card / panel title

  // Body
  bodyLarge: 'text-fs-lg leading-relaxed',                     // 18 — intro / hero subtext
  body:      'text-fs-base leading-relaxed',                   // 14 — primary body, table rows
  caption:   'text-fs-sm',                                     // 13 — helper / secondary copy

  // Labels / eyebrows / meta
  overline:    'text-fs-2xs font-semibold uppercase tracking-[0.08em]', // 11 — overline
  metricLabel: 'text-fs-2xs font-medium uppercase tracking-wide',       // 11 — metric label
  metricValue: 'text-fs-xl font-bold tracking-tight',                   // 24 — metric value

  // Interactive
  button: 'text-fs-base font-medium',                          // 14 — button label
  nav:    'text-fs-base font-medium',                          // 14 — nav item

  // Badges / pills
  badge: 'text-fs-2xs font-medium',                            // 11 — status pill

  // Dense / dashboard surfaces
  tableHeader:  'text-fs-2xs font-semibold uppercase tracking-wide',    // 11 — table head
  tableCell:    'text-fs-sm',                                  // 13 — table cell
  sidebarLabel: 'text-fs-sm font-medium',                      // 13 — sidebar label
} as const

export type TypographyRole = keyof typeof typography
export type FontSize = keyof typeof fs
