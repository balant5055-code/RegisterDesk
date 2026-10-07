/* RD-ANALYTICS-12-17 — both data boundaries, in a real browser. EMULATOR ONLY.
 *
 * The server rules are proven end to end by tests/emulator/organizerDataBoundary.emu.test.ts
 * with real tokens. What a browser adds is the half a route test cannot see: that a withheld
 * figure renders as a dash rather than "null", that the row still reads as a sentence, and
 * that no rupee amount survives anywhere on a manager's screen.
 *
 * The money assertion is made on the RENDERED TEXT of the events surfaces, and it is
 * negative — "no amount appears" — which is the only form that can prove a withholding.
 *
 *   node rd-analytics-12-17-shots.mjs
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE = process.env.RD_PROFILE_BASE_URL ?? 'http://localhost:3187'
const OWNER   = { email: 'profiling@registerdesk.test',   password: 'ProfilingPassw0rd!' }
const FINANCE = { email: 'finance.a11@registerdesk.test', password: 'FinancePassw0rd!' }
const MANAGER = { email: 'manager.a06@registerdesk.test', password: 'ManagerPassw0rd!' }
const EVENT   = process.env.RD_QA_EVENT_ID ?? 'profiling-draft-event'
const OUT = 'e2e/.shots/rd-analytics-12-17'

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

/** Any rupee amount of two or more digits — the thing a denied caller must never see. */
const MONEY = /₹\s?[\d,]{2,}/

for (const [who, name, maySeeMoney] of [
  [OWNER, 'owner', true], [FINANCE, 'finance', true], [MANAGER, 'manager', false],
]) {
  const ctx  = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  const page = await ctx.newPage()
  const api = []
  page.on('console',   m => { if (m.type() === 'error') issues.push(`[${name}] console: ${m.text()}`) })
  page.on('pageerror', e => issues.push(`[${name}] pageerror: ${e.message}`))
  page.on('response', async r => {
    const p = new URL(r.url()).pathname
    if (!/\/api\/organizer\/(events|dashboard)/.test(p)) return
    api.push(`${r.status()} ${p}`)
    // The strongest check available: read the PAYLOAD, not the pixels.
    if (!maySeeMoney && r.status() === 200) {
      let body = ''
      try { body = await r.text() } catch { return }
      // RD-ANALYTICS-12-20 · the canonical field must be null for a denied caller, and the
      // deprecated alias must be GONE from the payload entirely — its one-deploy
      // compatibility window closed with this phase.
      if (/"confirmedRevenuePaise":\s*\d/.test(body)) {
        issues.push(`[${name}] a NUMERIC confirmedRevenuePaise was sent by ${p}`)
      }
      if (/"confirmedRevenuePaise":\s*null/.test(body)) {
        facts.push(`[${name}] ${p} sent confirmedRevenuePaise: null`)
      }
      if (/"estimatedRevenue"/.test(body)) {
        issues.push(`[${name}] the REMOVED alias estimatedRevenue is still emitted by ${p}`)
      }
    }
  })

  await login(page, who)

  // ── 1 · Dashboard: recent activity ─────────────────────────────────────────
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3500)
  await page.screenshot({ path: `${OUT}/desktop-${name}-dashboard.png` })
  const dash = await page.evaluate(() => document.body.innerText)
  // Nothing may render the literal null/undefined anywhere.
  for (const bad of ['null registered', 'undefined registered', 'null checked in', 'undefined']) {
    if (dash.includes(bad)) issues.push(`[${name}] dashboard renders "${bad}"`)
  }
  const activityShown = /registered|checked in|A registration|A check-in|No recent activity/i.test(dash)
  facts.push(`[${name}] dashboard activity rendered: ${activityShown}`)
  if (!activityShown) issues.push(`[${name}] recent activity did not render at all`)

  // ── 2 · Events list ────────────────────────────────────────────────────────
  await page.goto(`${BASE}/dashboard/events`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3500)
  await page.screenshot({ path: `${OUT}/desktop-${name}-events.png` })
  const list = await page.evaluate(() => document.body.innerText)
  const listMoney = MONEY.test(list)
  facts.push(`[${name}] events list shows a rupee figure: ${listMoney}`)
  if (!maySeeMoney && listMoney) issues.push(`[${name}] a rupee figure is rendered on the events list`)
  if (list.includes('null')) issues.push(`[${name}] events list renders the literal "null"`)

  // ── 3 · Event detail ───────────────────────────────────────────────────────
  await page.goto(`${BASE}/dashboard/events/${EVENT}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3500)
  await page.screenshot({ path: `${OUT}/desktop-${name}-event.png` })
  const detail = await page.evaluate(() => document.body.innerText)
  const detailMoney = MONEY.test(detail)
  facts.push(`[${name}] event detail shows a rupee figure: ${detailMoney}`)
  if (!maySeeMoney && detailMoney) issues.push(`[${name}] a rupee figure is rendered on the event detail`)
  if (!maySeeMoney && /Requires finance access/i.test(detail)) {
    facts.push(`[${name}] the detail page explains WHY the figure is absent`)
  }
  if (detail.includes('null') || detail.includes('NaN')) {
    issues.push(`[${name}] event detail renders "null" or "NaN"`)
  }

  facts.push(`[${name}] api: ${[...new Set(api)].join(' | ') || 'none'}`)
  await ctx.close()
}

// ── Responsive ───────────────────────────────────────────────────────────────
for (const vp of [{ name: 'desktop', width: 1440, height: 1100 },
                  { name: 'tablet',  width: 834,  height: 1100 },
                  { name: 'mobile',  width: 390,  height: 900  }]) {
  const ctx  = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
  const page = await ctx.newPage()
  page.on('pageerror', e => issues.push(`[${vp.name}] pageerror: ${e.message}`))
  await login(page, MANAGER)
  await page.goto(`${BASE}/dashboard/events`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)
  await page.screenshot({ path: `${OUT}/${vp.name}-manager-events.png` })
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth)
  facts.push(`[${vp.name}] manager events overflow ${overflow}px`)
  if (overflow > 1) issues.push(`[${vp.name}] horizontal overflow ${overflow}px`)
  await ctx.close()
}

await browser.close()
console.log(facts.join('\n'))
console.log(issues.length ? '\nISSUES:\n' + issues.join('\n')
                          : '\nBoth boundaries held on screen and on the wire.')
console.log(`shots → ${OUT}`)
