// RD-TEAM-INVITE-01 — the ONE post-authentication return-destination rule.
//
// ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
// The team-invitation page sent `?next=`, while the login page read `?redirect=`.
// Nothing errored — the login guard simply returned null and the invitee was
// dropped on the dashboard, so the invitation was silently abandoned and its token
// never consumed. A second copy of the guard in the verify-email hop would be a
// second chance for exactly that drift, so the rule lives here once.
//
// `redirect` is the existing parameter name (C-1, login page) and stays the
// canonical one; the invitation page now speaks it too.
//
// PURE — no DOM, no Firebase — so the guard is unit-testable without a browser.

/** The canonical query parameter carrying a post-auth destination. */
export const REDIRECT_PARAM = 'redirect'

/**
 * Control characters (C0 range + DEL) — header/parser-splitting material.
 *
 * Written as a code-point scan rather than a regex character class on purpose:
 * an escaped class is easy to mangle in transit (an earlier revision of this file
 * silently became `[0000-001F007F]`, which matches ordinary digits and would have
 * rejected legitimate paths). Comparing numbers cannot be corrupted that way.
 */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * A same-origin path this app may navigate to after authentication, or null.
 *
 * ═══ THIS IS AN OPEN-REDIRECT GUARD ══════════════════════════════════════════
 * The value is attacker-supplied (it arrives in a URL anyone can craft and mail),
 * and it drives a post-login navigation — the classic phishing primitive. It is
 * therefore an ALLOW-list of one shape: a single leading slash followed by a path.
 * Every other form is refused rather than sanitised, because "clean it up and use
 * it anyway" is how these guards get bypassed.
 *
 * Rejected, and why each matters:
 *   `https://evil.com`  absolute — off-origin
 *   `//evil.com`        protocol-relative — a browser treats this as absolute
 *   `/\evil.com`        backslash — some browsers normalise `\` to `/`, which
 *                       makes this protocol-relative too
 *   `dashboard`         no leading slash — resolves relative to the current path
 *   control characters  CR/LF/NUL/tab and friends
 */
export function safeInternalRedirect(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value) return null
  if (!value.startsWith('/')) return null
  if (value.startsWith('//')) return null
  if (value.startsWith('/\\')) return null
  if (hasControlChar(value)) return null
  return value
}

/**
 * Appends a destination to a path, preserving any query the path already carries.
 *
 * The destination is encoded as a whole, so an invitation URL's own `?token=…`
 * survives nesting intact — losing it is precisely the bug this fixes. A
 * destination that fails the guard is dropped rather than passed along.
 */
export function withRedirect(path: string, target: string | null | undefined): string {
  const safe = safeInternalRedirect(target)
  if (!safe) return path
  return `${path}${path.includes('?') ? '&' : '?'}${REDIRECT_PARAM}=${encodeURIComponent(safe)}`
}

/**
 * The destination carried by a URL's query string, or null.
 *
 * Takes the search string rather than reading `window` so it serves both the login
 * page (which reads `window.location.search` to avoid a Suspense boundary) and the
 * verify-email page (which already has `useSearchParams`).
 */
export function redirectFromSearch(search: string | URLSearchParams): string | null {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search
  return safeInternalRedirect(params.get(REDIRECT_PARAM))
}
