// ─── Skip to main content ────────────────────────────────────────────────────
//
// The first tab stop on every public page. Invisible until focused, then a normal-looking
// control pinned to the top-left; pressing Enter moves focus past the whole header into
// <main id="main-content">.
//
// ═══ WHY IT WAS MISSING ══════════════════════════════════════════════════════
// The target existed all along — HomeShell, EventUtilityLayout and EventPageShell all
// render `<main id="main-content">` — but nothing linked to it. The only skip link in the
// codebase was in the organizer dashboard layout, so a keyboard visitor on the public site
// tabbed through the entire masthead (wordmark, up to seven nav items and dropdowns, the
// organizer CTA) before reaching the page, on every single navigation.
//
// ═══ WHY ITS OWN COMPONENT ═══════════════════════════════════════════════════
// Three public shells need it and must not each grow a copy — two would double the first
// tab stop on any page that nests shells, and a copy is where the token drift starts.
//
// ═══ THE ACCENT IS --action, NOT --primary ═══════════════════════════════════
// The dashboard's skip link rings `--primary`, correctly: that is the organizer/admin
// magenta. This is the public site, which runs on `--action`. Same treatment, right half of
// the two-accent split — no new colour is introduced either way.
//
// `sr-only focus:not-sr-only` is the existing pattern in this repo, so a mouse user never
// sees it and the visual design is unchanged.

export function SkipToContent() {
  return (
    <a
      href="#main-content"
      className={
        'sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[200] ' +
        'focus:rounded-control focus:border focus:border-border focus:bg-background ' +
        'focus:px-4 focus:py-2 focus:text-fs-sm focus:font-medium focus:text-foreground ' +
        'focus:outline-none focus:ring-2 focus:ring-action focus:ring-offset-2'
      }
    >
      Skip to main content
    </a>
  )
}
