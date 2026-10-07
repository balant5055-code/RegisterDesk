/* RD-ANALYTICS-12-15 — the reconciled Analytics authorization, in a real browser.
 * EMULATOR ONLY.
 *
 * The server behaviour is proven end to end by tests/emulator/organizerAnalyticsAuthz.emu.test.ts
 * with real tokens. What a browser adds, and the only reason to run it, is the half a route
 * test cannot see: that FINANCE now has a working Analytics workspace — a visible row, a
 * populated event selector, modules that render — and that MANAGER's money stays absent on
 * screen rather than merely absent from a payload.
 *
 *   node rd-analytics-12-15-shots.mjs
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE = process.env.RD_PROFILE_BASE_URL ?? 'http://localhost:3187'
const OWNER   = { email: 'profiling@registerdesk.test',   password: 'ProfilingPassw0rd!' }
const FINANCE = { email: 'finance.a11@registerdesk.test', password: 'FinancePassw0rd!' }
const MANAGER = { email: 'manager.a06@registerdesk.test', password: 'ManagerPassw0rd!' }
const OUT = 'e2e/.shots/rd-analytics-12-15'
// The modules are event-scoped and read ?eventId=. Without it the EventContext may sit in
// 'All events' and every module renders its select-an-event state — which is neither a grant
// nor a refusal, and is what made the first two runs inconclusive.
const EVENT = process.env.RD_QA_EVENT_ID ?? 'profiling-draft-event'

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
  await page.waitForTimeout(2000)
}

const sidebarLabels = page => page.evaluate(() => {
  const nav = document.querySelector('aside nav') ?? document.querySelector('nav')
  return nav ? [...nav.querySelectorAll('a')].map(a => (a.textContent ?? '').trim()).filter(Boolean) : []
})

for (const [who, name, expectAnalytics] of [
  [OWNER, 'owner', true], [FINANCE, 'finance', true], [MANAGER, 'manager', true],
]) {
  const ctx  = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  const page = await ctx.newPage()
  const codes = []
  page.on('pageerror', e => issues.push(`[${name}] pageerror: ${e.message}`))
  page.on('response', r => {
    const p = new URL(r.url()).pathname
    if (/\/api\/organizer\/(analytics|events)/.test(p)) codes.push(`${r.status()} ${p.split('/').slice(0, 5).join('/')}`)
  })

  await login(page, who)
  const labels = await sidebarLabels(page)
  facts.push(`[${name}] sidebar: ${labels.join(' | ')}`)
  const hasAnalytics = labels.includes('Analytics')
  if (hasAnalytics !== expectAnalytics) {
    issues.push(`[${name}] Analytics row ${hasAnalytics ? 'present' : 'ABSENT'}, expected ${expectAnalytics ? 'present' : 'absent'}`)
  }

  await page.goto(`${BASE}/dashboard/analytics/overview?eventId=${EVENT}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3500)
  await page.screenshot({ path: `${OUT}/desktop-${name}-overview.png` })

  const text = await page.evaluate(() => document.body.innerText)
  if (/you are not assigned|not authori|permission/i.test(text)) {
    issues.push(`[${name}] Analytics refused in the browser: ${text.slice(0, 160)}`)
  }
  // The event selector must be populated — this is the dependency the phase had to solve.
  const events = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')]
    const sel = btns.find(b => /marathon|select an event|all events/i.test(b.textContent ?? ''))
    return sel ? (sel.textContent ?? '').trim().slice(0, 40) : null
  })
  facts.push(`[${name}] event selector shows: ${events ?? 'NOTHING'}`)
  if (!events) issues.push(`[${name}] event selector is empty — cannot choose an event`)

  // Revenue module: money must be present for owner/finance and refused for manager.
  await page.goto(`${BASE}/dashboard/analytics/revenue?eventId=${EVENT}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3500)
  await page.screenshot({ path: `${OUT}/desktop-${name}-revenue.png` })
  const rev = await page.evaluate(() => document.body.innerText)
  const refusedMoney = /financial analytics are not available|requires the Transactions permission/i.test(rev)
  /**
   * "No event data" is a THIRD outcome, and it must not be mistaken for either of the other
   * two. The first run of this script reported "manager was not refused money" when in fact
   * no role had any data at all — the seeded event was a draft, so every module rendered its
   * select-an-event state. A check that cannot tell "withheld" from "absent" proves nothing,
   * so it says so instead of guessing. rd-analytics-12-15-fixture.mjs publishes the event.
   */
  const noData = /select a single event|publish an event/i.test(rev)
  facts.push(`[${name}] revenue module → ${noData ? 'NO EVENT DATA (inconclusive)' : refusedMoney ? 'NO FINANCIAL ACCESS (gated)' : 'financial view'}`)

  if (noData) {
    issues.push(`[${name}] revenue money check INCONCLUSIVE — no published event; run rd-analytics-12-15-fixture.mjs`)
  } else {
    if (name === 'manager' && !refusedMoney) {
      issues.push('[manager] revenue module did not refuse money — manager holds no `transactions`')
    }
    if (name !== 'manager' && refusedMoney) {
      issues.push(`[${name}] revenue module refused money, but this role holds \`transactions\``)
    }
  }
  // Whatever the screen says, no rupee figure may appear for the manager.
  if (name === 'manager' && /₹\s?[\d,]{2,}/.test(rev)) {
    issues.push('[manager] a rupee figure is rendered in the Revenue module')
  }

  facts.push(`[${name}] api: ${[...new Set(codes)].join(' | ') || 'none'}`)
  const denied = codes.filter(c => c.startsWith('403') || c.startsWith('401'))
  if (denied.length) facts.push(`[${name}] refused calls: ${[...new Set(denied)].join(' | ')}`)
  await ctx.close()
}

// ── Responsive ───────────────────────────────────────────────────────────────
for (const vp of [{ name: 'desktop', width: 1440, height: 1100 },
                  { name: 'tablet',  width: 834,  height: 1100 },
                  { name: 'mobile',  width: 390,  height: 900  }]) {
  const ctx  = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
  const page = await ctx.newPage()
  page.on('pageerror', e => issues.push(`[${vp.name}] pageerror: ${e.message}`))
  await login(page, FINANCE)
  await page.goto(`${BASE}/dashboard/analytics/overview?eventId=${EVENT}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)
  await page.screenshot({ path: `${OUT}/${vp.name}-finance-analytics.png` })
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth)
  facts.push(`[${vp.name}] finance analytics overflow ${overflow}px`)
  if (overflow > 1) issues.push(`[${vp.name}] horizontal overflow ${overflow}px`)
  await ctx.close()
}

await browser.close()
console.log(facts.join('\n'))
console.log(issues.length ? '\nISSUES:\n' + issues.join('\n')
                          : '\nEvery role behaved as the reconciled model requires.')
console.log(`shots → ${OUT}`)
