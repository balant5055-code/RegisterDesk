// /events/[slug]/register — route layout: the PUBLIC accent for the whole checkout.
//
// The registration flow was built on the product accent (--primary, magenta) and uses it
// through ~80 utilities across the route: bg-primary, text-primary, ring-primary,
// rgb(var(--primary-rgb) / a), var(--primary-gradient)… The owner retired the pink here
// (2026-09-23: "we are not going to use this, change to our current theme"), so the
// attendee now finishes on the same indigo → violet they started on at the event page.
//
// Rather than rewrite every utility (and risk a missed one), this layout REMAPS the
// product tokens to the public ones while the route is on screen. `@theme inline` makes
// every `*-primary` utility read var(--primary) directly, so redefining the variable
// recolours all of them. Tokens that were resolved from --primary at :root (--brand-*,
// --focus-ring, --border-focus) are remapped too, since they do not re-resolve below.
//
// Scope: the rule is keyed on `body:has([data-rd-register-theme])`, so it also reaches
// the dialogs and dropdowns this route PORTALS to <body>, and it stops applying the moment
// the route unmounts. React 19 keeps a hoisted <style> after unmount, which is exactly why
// the rule must depend on the marker and not merely exist.
//
// Nothing else changes: same components, same logic, same markup.

import type { ReactNode } from 'react'

const PUBLIC_ACCENT = [
  'body:has([data-rd-register-theme]){',
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
  // The shared CustomSelect has no className prop and is used app-wide, so its corners
  // are squared HERE, for this route only, to match the 6px text fields.
  'body:has([data-rd-register-theme]) [role="combobox"][aria-haspopup="listbox"]{border-radius:var(--radius-control)}',
  'body:has([data-rd-register-theme]) [role="combobox"][aria-haspopup="listbox"] ~ div{border-radius:var(--radius-surface)}',
].join('')

export default function RegisterLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <style href="rd-register-theme" precedence="default">{PUBLIC_ACCENT}</style>
      {/* `contents` — a marker only; it adds no box, so no screen's layout changes. */}
      <div data-rd-register-theme className="contents">{children}</div>
    </>
  )
}
