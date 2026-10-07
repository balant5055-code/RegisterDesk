/* RD-ANALYTICS-12-26 — revenue intelligence on the Analytics Revenue module. EMULATOR ONLY.
 *
 * The fixture event has confirmed revenue of ₹0 and no paid registrations, which is the
 * useful case: it exercises the MEASURED-ZERO branches (velocity ₹0/day, before-discount ₹0)
 * and the UNMEASURED-BY-DENOMINATOR branches (AOV with 0 paid, refund rate with ₹0 revenue)
 * on one screen. What must NOT appear anywhere: "NaN", "Infinity", "undefined", "null",
 * or a "0%" refund rate on zero revenue.
 *
 * Manager holds no `transactions`, so the whole financial module must be absent.
 *
 *   node rd-analytics-12-26-shots.mjs
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE = process.env.RD_PROFILE_BASE_URL ?? 'http://localhost:3187'
const OWNER   = { email: 'profiling@registerdesk.test',   password: 'ProfilingPassw0rd!' }
const MANAGER = { email: 'manager.a06@registerdesk.test', password: 'ManagerPassw0rd!' }
const OUT = 'e2e/.shots/rd-analytics-12-26'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const issues = [], facts = []

async function login(page, who) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.locator('#login-email').waitFor({ state: 'visible', timeout: 60_000 })
  await page.locator('#login-email').pressSequentially(who.email, { delay: 8 })
  await page.locator('#login-password').pressSequentially(who.password, { delay: 8 })
  await page.getByRole('button', { name: /sign in|log ?in/i }).first().click()
  await page.waitForURL(/\/dashboard/, { timeout: 90_000 })
  await page.waitForTimeout(2500)
}

for (const [who, name, entitled] of [[OWNER, 'owner', true], [MANAGER, 'manager', false]]) {
  for (const vp of [{ tag: 'desktop', width: 1440, height: 1200 }, { tag: 'tablet', width: 834, height: 1200 }, { tag: 'mobile', width: 390, height: 1000 }]) {
    if (!entitled && vp.tag !== 'desktop') continue
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
    const page = await ctx.newPage()
    page.on('console', m => { if (m.type() === 'error') issues.push(`[${name}/${vp.tag}] console: ${m.text().slice(0, 140)}`) })
    page.on('pageerror', e => issues.push(`[${name}/${vp.tag}] pageerror: ${e.message}`))
    page.on('response', async r => {
      const p = new URL(r.url()).pathname
      if (!/\/api\/organizer\/analytics\//.test(p) || r.status() !== 200) return
      let body = ''; try { body = await r.text() } catch { return }
      const hasIntel = /"intelligence"/.test(body)
      facts.push(`[${name}/${vp.tag}] ${p} carries intelligence block: ${hasIntel}`)
      if (!entitled && hasIntel) issues.push(`[${name}] intelligence block sent to a caller without transactions`)
      if (entitled && !hasIntel) issues.push(`[${name}] intelligence block MISSING for an entitled caller`)
      if (/Infinity|NaN/.test(body)) issues.push(`[${name}/${vp.tag}] payload contains Infinity/NaN`)
      const basis = body.match(/"basis":"([a-z_]+)"/g) ?? []
      if (entitled) facts.push(`[${name}/${vp.tag}] bases declared: ${[...new Set(basis)].length}`)
    })

    await login(page, who)
    await page.goto(`${BASE}/dashboard/analytics/revenue?eventId=profiling-draft-event`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(6500)
    await page.screenshot({ path: `${OUT}/${vp.tag}-${name}-revenue.png`, fullPage: true })
    const text = await page.evaluate(() => document.body.innerText)

    for (const bad of ['NaN', 'Infinity', 'undefined', 'null']) {
      if (new RegExp(`\\b${bad}\\b`).test(text)) issues.push(`[${name}/${vp.tag}] renders literal "${bad}"`)
    }
    const hasVelocity = /revenue velocity/i.test(text)
    const hasAov      = /average order value/i.test(text)
    const hasBefore   = /ticket value before discount/i.test(text)
    const hasRate     = /refund rate/i.test(text)
    facts.push(`[${name}/${vp.tag}] velocity:${hasVelocity} aov:${hasAov} beforeDiscount:${hasBefore} refundRate:${hasRate}`)
    if (entitled) {
      if (!hasVelocity || !hasAov || !hasBefore || !hasRate) issues.push(`[${name}/${vp.tag}] an intelligence row is missing`)
      // Zero-revenue fixture: rate must be ABSENT, not 0%.
      if (/Refund rate\s*0%/.test(text)) issues.push(`[${name}/${vp.tag}] refund rate rendered as 0% on zero revenue`)
      if (/needs measured revenue above zero/.test(text)) facts.push(`[${name}/${vp.tag}] refund rate honestly absent on ₹0 revenue`)
      if (/\/day/.test(text)) facts.push(`[${name}/${vp.tag}] velocity carries its /day unit`)
    } else {
      if (hasVelocity || hasAov || hasRate) issues.push(`[${name}] financial intelligence rendered to a manager`)
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    facts.push(`[${name}/${vp.tag}] overflow ${overflow}px`)
    if (overflow > 1) issues.push(`[${name}/${vp.tag}] horizontal overflow ${overflow}px`)
    await ctx.close()
  }
}

await browser.close()
console.log(facts.join('\n'))
console.log(issues.length ? '\nISSUES:\n' + issues.join('\n') : '\nRevenue intelligence renders honestly at every width, and only to entitled callers.')
console.log(`shots → ${OUT}`)
