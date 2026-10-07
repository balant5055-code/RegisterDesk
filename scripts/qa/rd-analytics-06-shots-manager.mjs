/* RD-ANALYTICS-06 — the SAME Overview as a role without `transactions`.
 *
 * The point is not that the money is hidden; it is that it never arrives. This asserts
 * against the rendered page AND against the raw API payload the page received.
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE = 'http://localhost:3187'
const EMAIL = 'manager.a06@registerdesk.test'
const PASSWORD = 'ManagerPassw0rd!'
const OUT = 'e2e/.shots/rd-analytics-06'
const EVENT = 'profiling-draft-event'

mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await ctx.newPage()

/** Capture the analytics payload actually delivered to this caller. */
let payload = null
page.on('response', async r => {
  if (r.url().includes('/api/organizer/analytics/overview/')) {
    payload = await r.text().catch(() => null)
  }
})

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
await page.locator('#login-email').waitFor({ state: 'visible' })
await page.locator('#login-email').pressSequentially(EMAIL, { delay: 8 })
await page.locator('#login-password').pressSequentially(PASSWORD, { delay: 8 })
await page.getByRole('button', { name: /sign in|log ?in/i }).first().click()
await page.waitForURL(/\/dashboard/, { timeout: 45_000 })

await page.goto(`${BASE}/dashboard/analytics/overview?eventId=${EVENT}`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => /Confirmed registrations|Select a single event|Could not load/i.test(document.body.innerText),
  { timeout: 45_000 }).catch(() => {})
await page.waitForTimeout(1200)
await page.screenshot({ path: `${OUT}/desktop-manager-no-finance.png` })

const text = await page.evaluate(() => document.body.innerText)
const problems = []
if (/₹/.test(text)) problems.push('RENDERED: a rupee symbol is on the page')
if (/Confirmed revenue|Revenue trend/i.test(text)) problems.push('RENDERED: a revenue module is present')
if (payload === null) problems.push('no analytics payload was observed')
else {
  if (/"revenue"/.test(payload)) problems.push('PAYLOAD: carries a `revenue` key')
  if (/Paise/.test(payload)) problems.push('PAYLOAD: carries a money field')
  if (/"financialAllowed":true/.test(payload)) problems.push('PAYLOAD: financialAllowed is true')
}
console.log(problems.length ? 'FAIL:\n' + problems.join('\n') : 'PASS — no money in the rendered page and none in the payload.')
console.log('payload financialAllowed:', payload ? (payload.match(/"financialAllowed":(true|false)/) ?? [])[1] : 'n/a')
await browser.close()
