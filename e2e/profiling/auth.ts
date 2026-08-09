// RD-EVENT-14 · Organizer authentication for profiling runs. DEV TOOLING ONLY.
//
// ═══ STRATEGY: REAL LOGIN, NO BYPASS ═════════════════════════════════════════
// This drives the actual `/login` form with real credentials. It does NOT:
//   • mint custom tokens or forge an ID token
//   • stub `AuthProvider` or any Firebase module
//   • relax a Firestore rule or an API guard
//
// The reason is not purity — it is validity. A profiling run against a bypassed auth path
// measures a page that does not exist in production. The whole point of this harness is that
// its numbers describe the real application, so it signs in the way an organizer does.
//
// Credentials come from the environment. Nothing is hardcoded and nothing is committed;
// `RD_PROFILE_EMAIL` / `RD_PROFILE_PASSWORD` must be set, and the account must already have
// a VERIFIED email — an unverified account is routed to the OTP flow, which cannot be
// automated and should not be.
//
// The session is saved to `storageState` so subsequent scenarios reuse it instead of logging
// in repeatedly. Logins are slow and rate-limited, and a login inside a measured scenario
// would pollute the very metrics being captured.

import type { Page, BrowserContext } from '@playwright/test'

export const STORAGE_STATE_PATH = 'e2e/.auth/organizer.json'

export interface ProfileCredentials { email: string; password: string }

/** Reads credentials, failing loudly rather than half-running an unauthenticated profile. */
export function readCredentials(): ProfileCredentials {
  const email = process.env.RD_PROFILE_EMAIL
  const password = process.env.RD_PROFILE_PASSWORD
  if (!email || !password) {
    throw new Error(
      'Missing profiling credentials.\n' +
      '  RD_PROFILE_EMAIL and RD_PROFILE_PASSWORD must be set.\n' +
      '  Use a dedicated, email-VERIFIED organizer account — never a real customer account.\n' +
      '  See docs/RD-EVENT-14-PROFILING-AUTOMATION.md.',
    )
  }
  return { email, password }
}

/**
 * Signs in through the real form and waits for the dashboard.
 *
 * Selectors are the stable ids on `components/auth/LoginForm.tsx` (`#login-email`,
 * `#login-password`) rather than text, so a copy change does not break profiling.
 */
export async function loginAsOrganizer(page: Page, creds = readCredentials()): Promise<void> {
  await page.goto('/login')
  await page.locator('#login-email').fill(creds.email)
  await page.locator('#login-password').fill(creds.password)
  await page.getByRole('button', { name: /sign in to dashboard/i }).click()

  // An unverified account lands on the OTP screen instead. Surface that as a clear failure
  // rather than a confusing timeout deeper in the run.
  await page.waitForURL(/\/dashboard|\/verify-email/, { timeout: 30_000 })
  if (page.url().includes('/verify-email')) {
    throw new Error(
      'The profiling account has an UNVERIFIED email and was routed to OTP verification.\n' +
      '  Verify the account once, manually, then re-run. This harness will not bypass it.',
    )
  }
}

/**
 * Guarantees an authenticated page, logging in only if the restored session did not take.
 *
 * `storageState` alone proved unreliable here: Playwright does restore Firebase's
 * `firebaseLocalStorageDb`, but the SDK does not always accept the rehydrated record and
 * the app falls through to /login. Rather than depend on that, each scenario verifies it is
 * actually signed in and logs in if not.
 *
 * This costs a few seconds per scenario and CANNOT affect measurements: it completes before
 * `__rd.start()` is called, so none of it is inside a capture window.
 */
export async function ensureLoggedIn(page: Page): Promise<void> {
  // 'networkidle' can NEVER fire on an authenticated page: Firestore holds an open
  // listener channel for the lifetime of the page. Waiting for it guarantees a timeout.
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2_000)
  if (!page.url().includes('/login')) return
  await loginAsOrganizer(page)
}

/**
 * Persists the signed-in session for reuse by every scenario.
 *
 * `indexedDB: true` is REQUIRED and is not the default. The Firebase Web SDK stores its
 * auth session in IndexedDB (`browserLocalPersistence`), not in cookies or localStorage, so
 * a plain `storageState()` captures a file that looks valid and restores a signed-OUT
 * browser — every scenario then lands on /login instead of the builder.
 */
export async function saveSession(context: BrowserContext): Promise<void> {
  await context.storageState({ path: STORAGE_STATE_PATH, indexedDB: true })
}
