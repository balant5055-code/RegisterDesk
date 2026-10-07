/* RD-ANALYTICS-12-11 — two checks the main QA left underdetermined. EMULATOR ONLY.
 *
 * 1. THE FOCUS RING. The first run measured it after a programmatic `.focus()`, which in
 *    Chromium does not necessarily match `:focus-visible` — so `boxShadow: none` said nothing
 *    about keyboard users. This drives the real keyboard instead.
 *
 * 2. THE MANAGER'S ENDPOINT. The first run called /reports/history from page.evaluate with no
 *    Authorization header and got 401, which proves only that the route requires auth. The
 *    interesting case is an AUTHENTICATED caller holding no finance permission: the route must
 *    answer 200 with an empty feed and no metadata, not 401 and not rows.
 *
 *   node rd-analytics-12-11-checks.mjs
 */
import { chromium } from 'playwright'

const BASE = process.env.RD_PROFILE_BASE_URL ?? 'http://localhost:3187'
const OWNER   = { email: 'profiling@registerdesk.test',   password: 'ProfilingPassw0rd!' }
const MANAGER = { email: 'manager.a06@registerdesk.test', password: 'ManagerPassw0rd!' }
const PAGE = `${BASE}/dashboard/finance/reports`

const browser = await chromium.launch()
const out = []

async function login(page, who) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.locator('#login-email').waitFor({ state: 'visible' })
  await page.locator('#login-email').pressSequentially(who.email, { delay: 8 })
  await page.locator('#login-password').pressSequentially(who.password, { delay: 8 })
  await page.getByRole('button', { name: /sign in|log ?in/i }).first().click()
  await page.waitForURL(/\/dashboard/, { timeout: 45_000 })
}

// ── 1 · the focus ring, under a real keyboard ────────────────────────────────
{
  const ctx  = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await ctx.newPage()
  await login(page, OWNER)
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => /finance & compliance reports/i.test(document.body.innerText), { timeout: 45_000 })
  await page.waitForTimeout(800)

  // Walk the keyboard forward until the History tab has focus — no mouse, no .focus().
  let found = false
  for (let i = 0; i < 60 && !found; i++) {
    await page.keyboard.press('Tab')
    found = await page.evaluate(() => {
      const el = document.activeElement
      return !!el && el.getAttribute('role') === 'tab' && /History/.test(el.textContent ?? '')
    })
  }
  out.push(`focus reached the History tab by keyboard: ${found}`)

  if (found) {
    const ring = await page.evaluate(() => {
      const el = document.activeElement
      const s = getComputedStyle(el)
      return {
        matchesFocusVisible: el.matches(':focus-visible'),
        boxShadow: s.boxShadow,
        outline:   `${s.outlineStyle} ${s.outlineWidth}`,
      }
    })
    out.push(`  :focus-visible = ${ring.matchesFocusVisible}`)
    out.push(`  box-shadow     = ${ring.boxShadow}`)
    out.push(`  outline        = ${ring.outline}`)
    const visible = ring.boxShadow !== 'none' || !/none/.test(ring.outline)
    out.push(`  A VISIBLE FOCUS INDICATOR: ${visible}`)

    await page.keyboard.press('Enter')
    await page.waitForTimeout(1200)
    const selected = await page.getByRole('tab', { name: /History/ }).getAttribute('aria-selected')
    const rows = await page.locator('ul.divide-y > li').count()
    out.push(`  Enter activated it: aria-selected=${selected}, rows rendered=${rows}`)
    await page.screenshot({ path: 'e2e/.shots/rd-analytics-12-11/keyboard-focus-visible.png' })
  }
  await ctx.close()
}

await browser.close()

// ── 2 · the endpoint, called by AUTHENTICATED callers ────────────────────────
//
// The UI hides the tab from a manager, but hiding is not the control — the server is. So
// this bypasses the browser entirely: sign in against the Auth emulator's REST API and call
// the endpoint directly with a real ID token, which is exactly what a caller ignoring the UI
// would do.
const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'
const KEY  = process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? 'demo-key'

async function idToken(who) {
  const r = await fetch(
    `http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: who.email, password: who.password, returnSecureToken: true }) })
  const j = await r.json()
  if (!j.idToken) throw new Error(`sign-in failed for ${who.email}: ${JSON.stringify(j).slice(0, 200)}`)
  return j.idToken
}

for (const [name, who] of [['owner', OWNER], ['manager', MANAGER]]) {
  const token = await idToken(who)
  const res  = await fetch(`${BASE}/api/organizer/reports/history`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const body = await res.text()
  const json = (() => { try { return JSON.parse(body) } catch { return null } })()
  const count = Array.isArray(json?.jobs) ? json.jobs.length : 'n/a'
  out.push(`${name} → ${res.status}, jobs=${count}, hasMore=${json?.hasMore}`)
  // Nothing a caller without the permission may learn.
  if (name === 'manager') {
    const leaks = ['transactions', 'settlements', 'wallet-ledger', 'rex_seed', 'reportExports']
      .filter(t => body.toLowerCase().includes(t))
    out.push(`  metadata leaked to the manager: ${leaks.length ? leaks.join(', ') : 'NONE'}`)
  } else {
    out.push(`  cursor is opaque and names no job: ${!String(json?.nextCursor ?? '').includes('rex_')}`)
    out.push(`  response contains a storage path: ${body.includes('reportExports/')}`)
  }
}
console.log(out.join('\n'))
