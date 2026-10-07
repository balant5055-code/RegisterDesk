/* RD-ANALYTICS-08 — photographs and ASSERTS the Registrations module. EMULATOR ONLY.
 *
 * Runs against the fixtures RD-ANALYTICS-07's seeds create:
 *   rd-analytics-07-seed.mjs full|partial   coverage + 200 rollup days
 *   rd-analytics-07-manager.mjs             a manager (no `transactions`)
 *
 * Viewport screenshots only, never fullPage: a stitched full-page image lays out below-fold
 * sections but does not paint them, so it reports a blank region the real browser renders.
 *
 * What it asserts, beyond photographing — each is a claim a screenshot cannot settle:
 *   • the two "pending" populations carry different words on one screen
 *   • no lifetime figure sits next to a percentage chip
 *   • the pass panel is captioned as lifetime, never as the selected window
 *   • no money reaches a caller without the finance permission
 *   • no BIB/chip/timing vocabulary appears in a universal module
 *   • partial coverage is disclosed, and a refused baseline is explained
 *
 *   node rd-analytics-08-shots.mjs [full|partial]
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE  = process.env.RD_PROFILE_BASE_URL ?? 'http://localhost:3187'
const OWNER = { email: process.env.RD_PROFILE_EMAIL ?? 'profiling@registerdesk.test',
                password: process.env.RD_PROFILE_PASSWORD ?? 'ProfilingPassw0rd!' }
const MANAGER = { email: 'manager.a06@registerdesk.test', password: 'ManagerPassw0rd!' }
const STAFF   = { email: 'staff.a08@registerdesk.test',   password: 'StaffPassw0rd!' }
const MODE  = process.argv[2] === 'partial' ? 'partial' : 'full'
const OUT   = `e2e/.shots/rd-analytics-08-${MODE}`

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'tablet',  width: 834,  height: 1100 },
  { name: 'mobile',  width: 390,  height: 900  },
]

const MARATHON = 'profiling-draft-event'          // sports, capacity, registrations
const WORKSHOP = 'profiling-event-draft-empty'    // uncapped, empty

mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch()
const issues = []
const facts  = []

async function login(page, who) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.locator('#login-email').waitFor({ state: 'visible' })
  await page.locator('#login-email').pressSequentially(who.email, { delay: 8 })
  await page.locator('#login-password').pressSequentially(who.password, { delay: 8 })
  await page.getByRole('button', { name: /sign in|log ?in/i }).first().click()
  await page.waitForURL(/\/dashboard/, { timeout: 45_000 })
}

for (const vp of VIEWPORTS) {
  const ctx  = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
  const page = await ctx.newPage()
  page.on('console',   m => { if (m.type() === 'error') issues.push(`[${vp.name}] console: ${m.text()}`) })
  page.on('pageerror', e => issues.push(`[${vp.name}] pageerror: ${e.message}`))
  await login(page, OWNER)

  const shoot = async (label, eventId, preset) => {
    await page.goto(`${BASE}/dashboard/analytics/registrations?eventId=${eventId}`,
                    { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => {
      const t = document.body.innerText
      return /Total registrations|Select a single event|Could not load/i.test(t)
    }, { timeout: 45_000 }).catch(() => issues.push(`[${vp.name}] ${label}: never settled`))

    if (preset) {
      await page.getByRole('group', { name: 'Date range' })
                .getByRole('button', { name: preset }).click()
      await page.waitForTimeout(1_100)
    }
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${OUT}/${vp.name}-${label}.png` })

    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth)
    if (overflow > 1) issues.push(`[${vp.name}] ${label}: horizontal overflow ${overflow}px`)

    return page.evaluate(() => document.body.innerText)
  }

  for (const [label, preset] of [['marathon-30d', null], ['marathon-7d', '7D'], ['marathon-90d', '90D']]) {
    const text = await shoot(label, MARATHON, preset)

    // TERMINOLOGY · both populations present, neither called bare "Pending".
    // Labels are uppercased by CSS, which innerText reflects — match case-insensitively.
    for (const phrase of [/awaiting payment/i, /registration pending/i]) {
      if (!phrase.test(text)) issues.push(`[${vp.name}] ${label}: ${phrase} missing`)
    }
    if (/(^|\n)\s*Pending\s*(\n|$)/.test(text)) {
      issues.push(`[${vp.name}] ${label}: a bare "Pending" label is on screen`)
    }

    // The window figure exists and names its own window.
    const move = text.match(/([\d,]+)\s+confirmed in the last (\d+) days/)
    if (!move) issues.push(`[${vp.name}] ${label}: no period figure on the trend`)
    else facts.push(`[${vp.name}] ${label}: ${move[1]} confirmed in last ${move[2]} days`)

    // No chip may hang off a lifetime figure. The KPI row is entirely lifetime.
    const chipOnTotals = await page.evaluate(() => {
      const label = [...document.querySelectorAll('p')]
        .find(p => p.textContent?.trim().toLowerCase() === 'total registrations')
      return Boolean(label?.closest('section')?.querySelector('[aria-label*="percent"]'))
    })
    if (chipOnTotals) issues.push(`[${vp.name}] ${label}: a delta chip is attached to a lifetime total`)

    // A RISE in cancellations must not be painted as good news. The registration chip and
    // the cancellation chip both point up here, so a shared colour would be visible proof
    // that `invert` is not wired — which source-reading alone cannot establish.
    const chipTones = await page.evaluate(() => {
      const near = (headingText) => {
        const h = [...document.querySelectorAll('h2')]
          .find(x => x.textContent?.trim() === headingText)
        const el = h?.closest('section')?.querySelector('[aria-label*="percent"]')
        if (!el) return null
        const l = el.getAttribute('aria-label') ?? ''
        return { color: getComputedStyle(el).color, up: / up /.test(l) }
      }
      return { trend: near('Registration trend'), cancels: near('Cancellations') }
    })
    if (chipTones.trend && chipTones.cancels
        && chipTones.trend.up && chipTones.cancels.up
        && chipTones.trend.color === chipTones.cancels.color) {
      issues.push(`[${vp.name}] ${label}: a rise in cancellations is painted like a rise in registrations`)
    }
    if (chipTones.cancels) {
      facts.push(`[${vp.name}] ${label}: cancellation chip ${chipTones.cancels.up ? 'up' : 'down'} ${chipTones.cancels.color}`)
    }

    // The pass panel is lifetime and says so.
    if (!/all time — not limited to the selected period/.test(text)) {
      issues.push(`[${vp.name}] ${label}: the pass panel does not state its basis`)
    }

    // A universal module must carry no sports vocabulary.
    for (const w of [/\bBIB\b/i, /timing chip/i, /finish time/i, /race category/i]) {
      if (w.test(text)) issues.push(`[${vp.name}] ${label}: sports vocabulary "${w}" on screen`)
    }

    if (MODE === 'partial') {
      const windowClipped = label !== 'marathon-7d'
      if (windowClipped && !/daily analytics begin/i.test(text)) {
        issues.push(`[${vp.name}] ${label}: partial coverage is not disclosed`)
      }
      if (!windowClipped && /daily analytics begin/i.test(text)) {
        issues.push(`[${vp.name}] ${label}: a gap is claimed for a fully covered window`)
      }
      if (!/no earlier period on record to compare/i.test(text)) {
        issues.push(`[${vp.name}] ${label}: a refused baseline is not explained`)
      }
    } else if (/daily analytics begin/i.test(text)) {
      issues.push(`[${vp.name}] ${label}: coverage is complete but a gap is claimed`)
    }
  }

  // The empty event: measured zeros, no invented composition.
  const empty = await shoot('workshop-empty', WORKSHOP)
  if (!/total registrations/i.test(empty)) issues.push(`[${vp.name}] workshop: no KPI row`)
  if (/%\s*of all registrations/.test(empty) && !/—/.test(empty)) {
    issues.push(`[${vp.name}] workshop: a share was computed against an empty denominator`)
  }

  await ctx.close()
}

// ── Financial isolation, as a role that holds `events` but not `transactions` ──
{
  const ctx  = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await ctx.newPage()
  let payload = null
  page.on('response', async r => {
    if (r.url().includes('/api/organizer/analytics/overview/')) {
      payload = await r.text().catch(() => null)
    }
  })
  await login(page, MANAGER)
  await page.goto(`${BASE}/dashboard/analytics/registrations?eventId=${MARATHON}`,
                  { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => /Total registrations|Select a single event|Could not load/i
    .test(document.body.innerText), { timeout: 45_000 }).catch(() => {})
  await page.waitForTimeout(1_200)
  await page.screenshot({ path: `${OUT}/desktop-manager-no-finance.png` })

  const text = await page.evaluate(() => document.body.innerText)
  if (/₹/.test(text)) issues.push('[manager] RENDERED: a rupee symbol is on the page')
  // The module is registration COUNTS, so it must be fully usable without the permission.
  if (!/total registrations/i.test(text)) issues.push('[manager] the module did not render')
  if (payload === null) issues.push('[manager] no analytics payload was observed')
  else {
    if (/"revenue"/.test(payload)) issues.push('[manager] PAYLOAD: carries a `revenue` key')
    if (/Paise/.test(payload))     issues.push('[manager] PAYLOAD: carries a money field')
    if (/"financialAllowed":true/.test(payload)) issues.push('[manager] PAYLOAD: financialAllowed is true')
  }
  await ctx.close()
}

// ── A check-in-only role must not reach Analytics because a module was added ──
{
  const ctx  = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await ctx.newPage()
  let status = null
  // Capture a real bearer from any authenticated call this session makes. Reading it from
  // storage is unreliable (the SDK may persist in IndexedDB); the wire never lies.
  let bearer = null
  page.on('request', r => {
    const h = r.headers()['authorization']
    if (!bearer && h?.startsWith('Bearer ') && r.url().includes('/api/')) bearer = h
  })
  page.on('response', r => {
    if (r.url().includes('/api/organizer/analytics/overview/')) status = r.status()
  })
  await login(page, STAFF)
  await page.goto(`${BASE}/dashboard/analytics/registrations?eventId=${MARATHON}`,
                  { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3_000)
  await page.screenshot({ path: `${OUT}/desktop-staff-refused.png` })

  const text = await page.evaluate(() => document.body.innerText)
  // The dashboard shell routes a gate-only role to the check-in console, so the page may
  // never issue the request at all. That is a pass, but it is the SHELL refusing — and a
  // shell can be bypassed by typing a URL. So the endpoint is probed directly, from the
  // staff member's own authenticated session, which is what an attacker would have.
  const direct = bearer
    ? await page.request
        .get(`${BASE}/api/organizer/analytics/overview/rd-analytics-06-marathon?preset=30d`,
             { headers: { Authorization: bearer } })
        .then(async res => ({ probed: true, status: res.status(), body: (await res.text()).slice(0, 300) }))
        .catch(e => ({ probed: false, status: null, body: String(e) }))
    : { probed: false, status: null, body: '' }

  if (!direct.probed) {
    issues.push('[staff] could not probe the endpoint directly — the refusal is unproven')
  } else if (direct.status !== 403 && direct.status !== 401) {
    issues.push(`[staff] the analytics endpoint answered ${direct.status} for a check-in-only role`)
  } else if (/Paise|"revenue"|"registrations":\s*\{/.test(direct.body ?? '')) {
    issues.push('[staff] the refusal body leaked analytics data')
  }
  facts.push(`[staff] shell request: ${status ?? 'never called'} · direct probe: ${direct.probed ? direct.status : 'no token'}`)
  // No registration figures may be on screen either way.
  if (/total registrations\s*\n\s*[\d,]+/i.test(text)) {
    issues.push('[staff] registration figures rendered for a check-in-only role')
  }
  if (/₹/.test(text)) issues.push('[staff] a rupee symbol is on the page')
  await ctx.close()
}

await browser.close()
console.log(facts.join('\n'))
console.log(issues.length ? '\nISSUES:\n' + issues.join('\n')
                          : '\nNo console errors, no overflow, every registration claim held.')
console.log(`shots → ${OUT}`)
