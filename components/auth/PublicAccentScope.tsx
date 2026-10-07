// PublicAccentScope — re-points the organizer accent (--primary, magenta) at the public
// accent (--action, indigo → violet) for as long as the wrapped screen is mounted.
//
// The organizer auth steps (forgot-password, verify-email, verify-email-success) and the
// /welcome hand-off were written against --primary: bg-primary tiles, the `primary`
// Button, ProgressBar tone="primary". The owner's direction is that every screen an
// organizer sees BEFORE the dashboard wears the public theme. Rather than rewriting each
// page's utilities, this scope redefines the token family while the screen is on the
// page — the same technique the public register route uses
// (app/events/[slug]/register/layout.tsx). The dashboard never mounts it, so the
// product keeps its own accent.
//
// Keyed on `body:has([data-rd-public-accent])` so the variables also reach anything a
// screen portals to <body> (dialogs, toasts). Server-safe: a hoisted <style> plus a
// marker element with `display: contents` — it adds no box and changes no layout.

import type { ReactNode } from 'react'

const PUBLIC_ACCENT = [
  'body:has([data-rd-public-accent]){',
  '--primary:var(--action);',
  '--primary-hover:var(--action-hover);',
  '--primary-text:var(--action);',
  '--primary-rgb:var(--action-rgb);',
  '--primary-from:var(--action);',
  '--primary-to:var(--action-end);',
  '--primary-from-rgb:var(--action-rgb);',
  '--primary-gradient:var(--action-gradient);',
  '--primary-gradient-hover:linear-gradient(135deg,var(--action-hover) 0%,var(--action-end) 100%);',
  '--brand-primary:var(--action);',
  '--brand-primary-hover:var(--action-hover);',
  '--brand-primary-active:var(--action-hover);',
  '--brand-gradient:var(--action-gradient);',
  '--brand-gradient-hover:linear-gradient(135deg,var(--action-hover) 0%,var(--action-end) 100%);',
  '--border-focus:var(--action);',
  '--focus-ring:var(--action);',
  '}',
].join('')

export function PublicAccentScope({ children }: { children: ReactNode }) {
  return (
    <>
      <style href="rd-public-accent" precedence="default">{PUBLIC_ACCENT}</style>
      <div data-rd-public-accent className="contents">{children}</div>
    </>
  )
}
