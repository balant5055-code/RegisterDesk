/* RD-ANALYTICS-12-20 — alias removal + the authorization-state caption. EMULATOR ONLY.
 *
 * Two claims a route test cannot make:
 *
 *   A · the removed `estimatedRevenue` key is absent from the WIRE, not merely from the types.
 *       A type-level removal still compiles if a response literal keeps emitting the field, so
 *       this reads the payload itself.
 *
 *   B · a caller without `transactions` is no longer told the platform failed. The old caption
 *       said "Some figures couldn't be loaded… try again shortly" for what is actually a
 *       permission boundary — advice that could never work. The assertion is negative on that
 *       sentence and positive on the neutral one, for BOTH unauthorized roles.
 *
 *   node rd-analytics-12-20-shots.mjs
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE = process.env.RD_PROFILE_BASE_URL ?? 'http://localhost:3187'
const OWNER   = { email: 'profiling@registerdesk.test',    password: 'ProfilingPassw0rd!' }
const FINANCE = { email: 'finance.a11@registerdesk.test',  password: 'FinancePassw0rd!' }
const MANAGER = { email: 'manager.a06@registerdesk.test',  password: 'ManagerPassw0rd!' }
const ADMIN   = { email: 'admin.a1220@registerdesk.test',  password: 'AdminPassw0rd!' }
const EVENT   = process.env.RD_QA_EVENT_ID ?? 'profiling-draft-event'
const OUT = 'e2e/.shots/rd-analytics-12-20'

mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch()
const issues = []
const facts  = []

async function login(page, who) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.locator('#login-email').waitFor({ state: 'visible', timeout: 60_000 })
  await page.locator('#login-email').pressSequentially(who.email, { delay: 8 })
  await page.locator('#login-password').pressSequentially(who.password, { delay: 8 })
  await page.getByRole('button', { name: /sign in|log ?in/i }).first().click()
  await page.waitForURL(/\/dashboard/, { timeout: 90_000 })
  await page.waitForTimeout(2500)
}

/** Any rupee amount of two or more digits — what a denied caller must never see. */
const MONEY = /₹\s?[\d,]{2,}/
const RETRY = /try again shortly/i
const NEUTRAL = /requires finance access/i

for (const [who, name, maySeeMoney] of [
  [OWNER, 'owner', true], [FINANCE, 'finance', true],
  [MANAGER, 'manager', false], [ADMIN, 'admin', false],
]) {
  const ctx  = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  const page = await ctx.newPage()
  page.on('console',   m => { if (m.type() === 'error') issues.push(`[${name}] console: ${m.text().slice(0, 160)}`) })
  page.on('pageerror', e => issues.push(`[${name}] pageerror: ${e.message}`))
  page.on('response', async r => {
    const p = new URL(r.url()).pathname
    if (!/\/api\/organizer\/events/.test(p) || r.status() !== 200) return
    let body = ''
    try { body = await r.text() } catch { return }
    // A · the alias must be gone for EVERY role, authorized ones included.
    if (/"estimatedRevenue"/.test(body)) {
      issues.push(`[${name}] the REMOVED alias estimatedRevenue is still emitted by ${p}`)
    } else if (/"confirmedRevenuePaise"/.test(body)) {
      facts.push(`[${name}] ${p} carries confirmedRevenuePaise and NO estimatedRevenue`)
    }
    if (!maySeeMoney && /"confirmedRevenuePaise":\s*\d/.test(body)) {
      issues.push(`[${name}] a NUMERIC confirmedRevenuePaise was sent by ${p}`)
    }
  })

  await login(page, who)

  // ── Events list ────────────────────────────────────────────────────────────
  await page.goto(`${BASE}/dashboard/events`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(6000)
  await page.screenshot({ path: `${OUT}/desktop-${name}-events.png`, fullPage: true })
  const list = await page.evaluate(() => document.body.innerText)

  const money = MONEY.test(list)
  facts.push(`[${name}] events list shows a rupee figure: ${money}`)
  if (!maySeeMoney && money) issues.push(`[${name}] a rupee figure is rendered on the events list`)

  // B · the caption. The retry sentence is only honest for a genuine read failure.
  const retry = RETRY.test(list)
  const neutral = NEUTRAL.test(list)
  facts.push(`[${name}] list caption — retry:${retry} neutral:${neutral}`)
  if (!maySeeMoney) {
    if (retry) issues.push(`[${name}] the MISLEADING retry caption is shown for an authorization denial`)
    if (!neutral) issues.push(`[${name}] no neutral permission caption is shown at all`)
  }
  if (maySeeMoney && neutral) {
    issues.push(`[${name}] an AUTHORIZED caller is told revenue requires finance access`)
  }

  for (const bad of ['NaN', 'undefined', 'null']) {
    if (list.includes(bad)) issues.push(`[${name}] events list renders the literal "${bad}"`)
  }
  // The permission itself must never be named to a user.
  if (/transactions permission/i.test(list)) {
    issues.push(`[${name}] the raw permission name is exposed in the UI`)
  }

  // ── Event detail ───────────────────────────────────────────────────────────
  await page.goto(`${BASE}/dashboard/events/${EVENT}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(6000)
  await page.screenshot({ path: `${OUT}/desktop-${name}-event.png`, fullPage: true })
  const detail = await page.evaluate(() => document.body.innerText)
  const dMoney = MONEY.test(detail)
  facts.push(`[${name}] event detail shows a rupee figure: ${dMoney}`)
  if (!maySeeMoney && dMoney) issues.push(`[${name}] a rupee figure is rendered on the event detail`)
  if (detail.includes('NaN')) issues.push(`[${name}] event detail renders "NaN"`)

  await ctx.close()
}

// ── Responsive · the unauthorized card is the one that changed ────────────────
for (const vp of [{ name: 'desktop', width: 1440, height: 1100 },
                  { name: 'tablet',  width: 834,  height: 1100 },
                  { name: 'mobile',  width: 390,  height: 900  }]) {
  const ctx  = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
  const page = await ctx.newPage()
  page.on('pageerror', e => issues.push(`[${vp.name}] pageerror: ${e.message}`))
  await login(page, MANAGER)
  await page.goto(`${BASE}/dashboard/events`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(5000)
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
                          : '\nAlias gone from the wire; denial no longer reads as a failure.')
console.log(`shots → ${OUT}`)
