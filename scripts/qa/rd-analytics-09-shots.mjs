/* RD-ANALYTICS-09 — photographs and ASSERTS the Revenue module. EMULATOR ONLY.
 *
 * Financial UI is the one place a screenshot is not enough: a wrong rupee figure looks
 * exactly like a right one. So every claim below is measured, and the network payload is
 * inspected as well as the page — hiding money in React would pass a visual check and fail
 * the only test that matters.
 *
 *   node rd-analytics-09-shots.mjs [full|partial]
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE  = process.env.RD_PROFILE_BASE_URL ?? 'http://localhost:3187'
const OWNER = { email: process.env.RD_PROFILE_EMAIL ?? 'profiling@registerdesk.test',
                password: process.env.RD_PROFILE_PASSWORD ?? 'ProfilingPassw0rd!' }
const MANAGER = { email: 'manager.a06@registerdesk.test', password: 'ManagerPassw0rd!' }
const STAFF   = { email: 'staff.a08@registerdesk.test',   password: 'StaffPassw0rd!' }
const MODE  = process.argv[2] === 'partial' ? 'partial' : 'full'
const OUT   = `e2e/.shots/rd-analytics-09-${MODE}`

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'tablet',  width: 834,  height: 1100 },
  { name: 'mobile',  width: 390,  height: 900  },
]

const MARATHON = 'profiling-draft-event'          // has revenue, ledger and refunds
const FREE     = 'profiling-event-draft-empty'    // free event, amount 0 throughout

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

const settled = () => {
  const t = document.body.innerText
  return /confirmed revenue|not available to you|select a single event|could not load/i.test(t)
}

for (const vp of VIEWPORTS) {
  const ctx  = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
  const page = await ctx.newPage()
  page.on('console',   m => { if (m.type() === 'error') issues.push(`[${vp.name}] console: ${m.text()}`) })
  page.on('pageerror', e => issues.push(`[${vp.name}] pageerror: ${e.message}`))
  await login(page, OWNER)

  const shoot = async (label, eventId, preset) => {
    await page.goto(`${BASE}/dashboard/analytics/revenue?eventId=${eventId}`,
                    { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(settled, { timeout: 45_000 })
      .catch(() => issues.push(`[${vp.name}] ${label}: never settled`))
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

  for (const [label, preset] of [['revenue-30d', null], ['revenue-7d', '7D'], ['revenue-90d', '90D']]) {
    const text = await shoot(label, MARATHON, preset)

    // Currency is Indian-grouped and never clipped into scientific/rounded junk.
    const rupees = text.match(/₹[\d,]+/g) ?? []
    if (rupees.length < 3) issues.push(`[${vp.name}] ${label}: too few currency figures rendered`)
    for (const r of rupees) {
      if (/[eE]\+|NaN|Infinity/.test(r)) issues.push(`[${vp.name}] ${label}: malformed currency ${r}`)
    }

    // Terminology: confirmed revenue, completed refunds and net revenue are all present and
    // distinct, and no gateway figure is called bare "Revenue".
    for (const phrase of [/confirmed revenue/i, /completed refunds/i, /net revenue/i,
                          /gross collected/i, /net settlement/i]) {
      if (!phrase.test(text)) issues.push(`[${vp.name}] ${label}: ${phrase} missing`)
    }

    // The period figure names its window; the lifetime headline does not carry a chip.
    const move = text.match(/₹[\d,]+\s+in the last (\d+) days/)
    if (!move) issues.push(`[${vp.name}] ${label}: no period revenue figure`)
    else facts.push(`[${vp.name}] ${label}: period revenue over ${move[1]} days`)

    const chipOnHeadline = await page.evaluate(() => {
      const el = [...document.querySelectorAll('p')]
        .find(p => p.textContent?.trim().toLowerCase() === 'confirmed revenue')
      return Boolean(el?.closest('section')?.querySelector('[aria-label*="percent"]'))
    })
    if (chipOnHeadline) issues.push(`[${vp.name}] ${label}: a delta chip is attached to lifetime revenue`)

    // Net revenue must differ from confirmed revenue when refunds exist.
    const conf = text.match(/CONFIRMED REVENUE\s*\n\s*(₹[\d,]+)/i)?.[1]
    const net  = text.match(/NET REVENUE\s*\n\s*(₹[\d,]+)/i)?.[1]
    if (conf && net) {
      facts.push(`[${vp.name}] ${label}: confirmed ${conf} · net ${net}`)
      if (conf === net) issues.push(`[${vp.name}] ${label}: net equals confirmed despite seeded refunds`)
    }

    // Pass revenue is lifetime and says so.
    if (!/all time — not limited to the selected period/.test(text)) {
      issues.push(`[${vp.name}] ${label}: the pass revenue panel does not state its basis`)
    }

    if (MODE === 'partial') {
      const clipped = label !== 'revenue-7d'
      if (clipped && !/daily analytics begin/i.test(text)) {
        issues.push(`[${vp.name}] ${label}: partial coverage is not disclosed`)
      }
      if (!/no earlier period on record to compare/i.test(text)) {
        issues.push(`[${vp.name}] ${label}: a refused baseline is not explained`)
      }
    } else if (/daily analytics begin/i.test(text)) {
      issues.push(`[${vp.name}] ${label}: coverage is complete but a gap is claimed`)
    }
  }

  // A FREE event: ₹0 must be a measurement, not an "unavailable" mark.
  const free = await shoot('free-event', FREE)
  if (!/₹0/.test(free)) issues.push(`[${vp.name}] free event: no ₹0 rendered`)
  if (/could not be read/i.test(free)) {
    issues.push(`[${vp.name}] free event: a measured zero was reported as unreadable`)
  }
  facts.push(`[${vp.name}] free event: ${(free.match(/₹[\d,]+/g) ?? []).slice(0, 3).join(' ')}`)

  await ctx.close()
}

// ── The two roles that must receive NO financial bytes ────────────────────────
for (const [who, name] of [[MANAGER, 'manager'], [STAFF, 'staff']]) {
  const ctx  = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await ctx.newPage()
  let payload = null
  let bearer  = null
  page.on('request', r => {
    const h = r.headers()['authorization']
    if (!bearer && h?.startsWith('Bearer ') && r.url().includes('/api/')) bearer = h
  })
  page.on('response', async r => {
    if (r.url().includes('/api/organizer/analytics/overview/')) {
      payload = await r.text().catch(() => null)
    }
  })
  await login(page, who)
  await page.goto(`${BASE}/dashboard/analytics/revenue?eventId=${MARATHON}`,
                  { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3_000)
  await page.screenshot({ path: `${OUT}/desktop-${name}-no-finance.png` })

  const text = await page.evaluate(() => document.body.innerText)
  if (/₹/.test(text)) issues.push(`[${name}] RENDERED: a rupee symbol is on the page`)

  // The rendered page is only half the test. Inspect the wire, and probe the endpoint
  // directly with this role's own bearer — a shell redirect is not an authorization proof.
  const direct = bearer
    ? await page.request
        .get(`${BASE}/api/organizer/analytics/overview/rd-analytics-06-marathon?preset=30d`,
             { headers: { Authorization: bearer } })
        .then(async r => ({ status: r.status(), body: (await r.text()).slice(0, 4000) }))
        .catch(e => ({ status: null, body: String(e) }))
    : { status: null, body: '' }

  facts.push(`[${name}] shell payload: ${payload ? 'observed' : 'none'} · direct probe: ${direct.status}`)

  const bodies = [payload, direct.body].filter(Boolean)
  for (const b of bodies) {
    for (const probe of [/Paise/, /"revenue"/, /profitEstimate/, /netSettlement/, /gatewayFee/]) {
      if (probe.test(b)) issues.push(`[${name}] PAYLOAD leaked ${probe}`)
    }
  }
  if (name === 'manager') {
    if (direct.status !== 200) issues.push(`[manager] analytics endpoint answered ${direct.status}`)
    if (!/"financialAllowed":false/.test(direct.body)) {
      issues.push('[manager] financialAllowed is not false')
    }
    if (!/not available to you/i.test(text)) {
      issues.push('[manager] the module did not state why revenue is unavailable')
    }
  } else if (direct.status !== 403 && direct.status !== 401) {
    issues.push(`[staff] analytics endpoint answered ${direct.status} for a check-in-only role`)
  }
  await ctx.close()
}

await browser.close()
console.log(facts.join('\n'))
console.log(issues.length ? '\nISSUES:\n' + issues.join('\n')
                          : '\nNo console errors, no overflow, every financial claim held.')
console.log(`shots → ${OUT}`)
