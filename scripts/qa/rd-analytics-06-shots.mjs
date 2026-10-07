/* RD-ANALYTICS-06 — photographs the Analytics Overview. DEV TOOL, EMULATOR ONLY.
 *
 * Viewport screenshots only, never fullPage: a stitched full-page image lays out
 * below-fold sections but does not paint them, so it reports a blank region that the real
 * browser renders correctly. Each state is captured at the width it has to survive.
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE = process.env.RD_PROFILE_BASE_URL ?? 'http://localhost:3187'
const EMAIL = process.env.RD_PROFILE_EMAIL ?? 'profiling@registerdesk.test'
const PASSWORD = process.env.RD_PROFILE_PASSWORD ?? 'ProfilingPassw0rd!'
const OUT = 'e2e/.shots/rd-analytics-06'

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'tablet',  width: 834,  height: 1100 },
  { name: 'mobile',  width: 390,  height: 900  },
]

const MARATHON = 'profiling-draft-event'            // sports, 900 capacity, 640 registrations
const WORKSHOP = 'profiling-event-draft-empty'      // workshop, uncapped, empty

mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch()
const issues = []

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
  const page = await ctx.newPage()
  page.on('console', m => { if (m.type() === 'error') issues.push(`[${vp.name}] console: ${m.text()}`) })
  page.on('pageerror', e => issues.push(`[${vp.name}] pageerror: ${e.message}`))

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  // Hydration race: fill before React attaches and the value is discarded.
  await page.locator('#login-email').waitFor({ state: 'visible' })
  await page.locator('#login-email').pressSequentially(EMAIL, { delay: 8 })
  await page.locator('#login-password').pressSequentially(PASSWORD, { delay: 8 })
  await page.getByRole('button', { name: /sign in|log ?in/i }).first().click()
  await page.waitForURL(/\/dashboard/, { timeout: 45_000 })

  const shoot = async (label, eventId, preset) => {
    const url = `${BASE}/dashboard/analytics/overview?eventId=${eventId}`
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    // Wait for the single analytics request to land, or for a stated empty/error state.
    await page.waitForFunction(() => {
      const t = document.body.innerText
      return /Confirmed registrations|Select a single event|Could not load/i.test(t)
    }, { timeout: 45_000 }).catch(() => issues.push(`[${vp.name}] ${label}: never settled`))

    if (preset) {
      await page.getByRole('group', { name: 'Date range' }).getByRole('button', { name: preset }).click()
      await page.waitForTimeout(900)
    }
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${OUT}/${vp.name}-${label}.png` })

    // Horizontal overflow is a layout defect, not an opinion — measure it.
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth)
    if (overflow > 1) issues.push(`[${vp.name}] ${label}: horizontal overflow ${overflow}px`)
  }

  await shoot('marathon-30d', MARATHON)
  await shoot('marathon-7d', MARATHON, '7D')
  await shoot('workshop-empty', WORKSHOP)

  await ctx.close()
}

await browser.close()
console.log(issues.length ? 'ISSUES:\n' + issues.join('\n') : 'No console errors, no overflow at any viewport.')
console.log(`shots → ${OUT}`)
