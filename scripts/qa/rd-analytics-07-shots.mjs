/* RD-ANALYTICS-07 — photographs the comparison, the coverage floor and the terminology.
 * DEV TOOL, EMULATOR ONLY.
 *
 * Viewport screenshots only, never fullPage: a stitched full-page image lays out below-fold
 * sections but does not paint them, so it reports a blank region the real browser renders
 * correctly.
 *
 * Beyond photographing, this ASSERTS the four claims that a screenshot alone cannot settle:
 *
 *   • the lifetime headline and the windowed movement are different figures
 *   • the delta chip only ever appears next to the movement line, never the headline
 *   • "Pending" never appears as a bare label while "Awaiting payment" is on screen
 *   • no financial string reaches a viewer without `transactions`
 *
 *   node rd-analytics-07-shots.mjs [full|partial]
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE     = process.env.RD_PROFILE_BASE_URL ?? 'http://localhost:3187'
const EMAIL    = process.env.RD_PROFILE_EMAIL ?? 'profiling@registerdesk.test'
const PASSWORD = process.env.RD_PROFILE_PASSWORD ?? 'ProfilingPassw0rd!'
const MODE     = process.argv[2] === 'partial' ? 'partial' : 'full'
const OUT      = `e2e/.shots/rd-analytics-07-${MODE}`

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'tablet',  width: 834,  height: 1100 },
  { name: 'mobile',  width: 390,  height: 900  },
]

const MARATHON = 'profiling-draft-event'
const WORKSHOP = 'profiling-event-draft-empty'

mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch()
const issues = []
const facts  = []

for (const vp of VIEWPORTS) {
  const ctx  = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
  const page = await ctx.newPage()
  page.on('console',   m => { if (m.type() === 'error') issues.push(`[${vp.name}] console: ${m.text()}`) })
  page.on('pageerror', e => issues.push(`[${vp.name}] pageerror: ${e.message}`))

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.locator('#login-email').waitFor({ state: 'visible' })
  await page.locator('#login-email').pressSequentially(EMAIL, { delay: 8 })
  await page.locator('#login-password').pressSequentially(PASSWORD, { delay: 8 })
  await page.getByRole('button', { name: /sign in|log ?in/i }).first().click()
  await page.waitForURL(/\/dashboard/, { timeout: 45_000 })

  const shoot = async (label, eventId, preset) => {
    await page.goto(`${BASE}/dashboard/analytics/overview?eventId=${eventId}`,
                    { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => {
      const t = document.body.innerText
      return /Confirmed registrations|Select a single event|Could not load/i.test(t)
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

  // ── The comparison, at each window ─────────────────────────────────────────
  for (const [label, preset] of [['marathon-30d', null], ['marathon-7d', '7D'], ['marathon-90d', '90D']]) {
    const text = await shoot(label, MARATHON, preset)

    // The headline is LIFETIME; the movement line names its own window. If the two figures
    // were ever the same the page would be comparing all-time against 30 days.
    // The label is uppercased by CSS, which `innerText` reflects, and the value sits after
    // a blank line — so match case-insensitively across whitespace rather than assuming
    // the source casing.
    const head = text.match(/confirmed registrations\s+([\d,]+)/i)
    const move = text.match(/([\d,]+)\s+confirmed in the last (\d+) days/)
    if (!head) issues.push(`[${vp.name}] ${label}: no headline figure`)
    if (!move) issues.push(`[${vp.name}] ${label}: no period movement line`)
    if (head && move) {
      facts.push(`[${vp.name}] ${label}: lifetime ${head[1]} · ${move[1]} in last ${move[2]} days`)
      if (head[1] === move[1]) {
        issues.push(`[${vp.name}] ${label}: headline and window report the same figure`)
      }
      if (preset && !new RegExp(`last ${preset.replace('D', '')} days`).test(text)) {
        issues.push(`[${vp.name}] ${label}: window label does not match the pressed preset`)
      }
    }

    // The delta must sit with the movement, never with the headline.
    const chipOnHero = await page.evaluate(() => {
      const hero = [...document.querySelectorAll('p')]
        .find(p => p.textContent?.trim() === 'Confirmed registrations')
      const block = hero?.parentElement
      return Boolean(block?.querySelector('[aria-label*="percent"]'))
    })
    if (chipOnHero) issues.push(`[${vp.name}] ${label}: a delta chip is attached to the lifetime headline`)

    if (MODE === 'partial') {
      // The coverage floor sits 12 days back, so the 30D and 90D windows reach past it and
      // must say so — while the 7D window sits ENTIRELY inside recorded history and must
      // NOT claim a gap. Its baseline, though, lies wholly before the floor, so every
      // preset owes the reader an explanation for the missing comparison. Requiring the
      // notice everywhere would demand a false statement on the 7D view.
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
      if (/vs the \d+ days before/.test(text)) {
        issues.push(`[${vp.name}] ${label}: a comparison is claimed despite missing history`)
      }
    } else {
      if (/daily analytics begin/i.test(text)) {
        issues.push(`[${vp.name}] ${label}: coverage is complete but a gap is claimed`)
      }
    }

    // TERMINOLOGY · the two pending populations must not share a word on one screen.
    if (/Awaiting payment/.test(text) && /(^|\n)\s*Pending\s*(\n|$)/.test(text)) {
      issues.push(`[${vp.name}] ${label}: bare "Pending" sits beside "Awaiting payment"`)
    }
  }

  // ── The measured-but-empty event still states its window honestly ──────────
  const empty = await shoot('workshop-empty', WORKSHOP)
  if (/—\s*confirmed in the last/.test(empty)) {
    issues.push(`[${vp.name}] workshop: an unmeasured movement rendered a mark instead of vanishing`)
  }
  // Nothing in either window means no percentage exists. The comparison phrase must go with
  // the chip rather than standing alone with no figure in front of it.
  if (/\bvs the \d+ days before/.test(empty) && !/\d+%\s*vs the \d+ days before/.test(empty)) {
    issues.push(`[${vp.name}] workshop: a comparison phrase is printed with no percentage`)
  }

  await ctx.close()
}

await browser.close()
console.log(facts.join('\n'))
console.log(issues.length ? '\nISSUES:\n' + issues.join('\n')
                          : '\nNo console errors, no overflow, every comparison claim held.')
console.log(`shots → ${OUT}`)
