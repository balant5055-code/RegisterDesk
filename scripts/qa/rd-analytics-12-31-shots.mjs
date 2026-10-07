/* RD-ANALYTICS-12-31 — the Insights module. EMULATOR ONLY.
 *
 * Reuses the 12-28 and 12-29 fixtures (run those first). For each event the script runs the
 * SAME pure engine over the observed payload in Node and demands the screen show exactly
 * those cards, so a card on screen that the payload does not justify — or a justified card
 * that is missing — is a failure, not an impression.
 *
 *   a28-intel  wallet-held (6), a sizeable communications window → cards
 *   a29-mix    capacity 90% (warning) + revenue growth (owner/finance only) + registrations growth
 *   a29-clean  nothing clears a floor → the empty state
 *
 *   node rd-analytics-12-31-shots.mjs
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const BASE = process.env.RD_PROFILE_BASE_URL ?? 'http://localhost:3187'
const ACCOUNTS = {
  owner:   { email: 'profiling@registerdesk.test',    password: 'ProfilingPassw0rd!', money: true,  analytics: true },
  finance: { email: 'finance.a11@registerdesk.test',  password: 'FinancePassw0rd!',   money: true,  analytics: true },
  admin:   { email: 'admin.a1220@registerdesk.test',  password: 'AdminPassw0rd!',     money: false, analytics: true },
  manager: { email: 'manager.a06@registerdesk.test',  password: 'ManagerPassw0rd!',   money: false, analytics: true },
  staff:   { email: 'staff.a08@registerdesk.test',    password: 'StaffPassw0rd!',     money: false, analytics: false },
}
const OUT = 'e2e/.shots/rd-analytics-12-31'
mkdirSync(OUT, { recursive: true })

// The engine is TypeScript; bundle it (and its pure imports) with the project's esbuild into a
// scratch ESM file and import that. Nothing in the bundle touches Firebase — the bundle itself
// is the proof, and the unit suite pins it.
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
const BUNDLE = resolve('e2e/.shots/rd-analytics-12-31/insightsRules.bundle.mjs')
execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['esbuild', 'lib/analytics/insightsRules.ts', '--bundle', '--format=esm', '--platform=node', '--alias:@=.', '--outfile=' + BUNDLE],
  { stdio: 'inherit', shell: process.platform === 'win32' })
const { buildInsights } = await import(pathToFileURL(BUNDLE).href)

const browser = await chromium.launch()
const issues = [], facts = []

async function login(page, who) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.locator('#login-email').waitFor({ state: 'visible', timeout: 60_000 })
  await page.locator('#login-email').pressSequentially(who.email, { delay: 8 })
  await page.locator('#login-password').pressSequentially(who.password, { delay: 8 })
  await page.getByRole('button', { name: /sign in|log ?in/i }).first().click()
  await page.waitForURL(/\/dashboard|\/checkin/, { timeout: 90_000 })
  await page.waitForTimeout(2000)
}

for (const [name, who] of Object.entries(ACCOUNTS)) {
  const vps = name === 'owner'
    ? [{ tag: 'desktop', width: 1440, height: 1200 }, { tag: 'tablet', width: 834, height: 1200 }, { tag: 'mobile', width: 390, height: 1000 }]
    : [{ tag: 'desktop', width: 1440, height: 1200 }]
  for (const vp of vps) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
    const page = await ctx.newPage()
    const tag = `${name}/${vp.tag}`
    page.on('console', m => { if (m.type() === 'error' && !(name === 'staff' && /40[123]/.test(m.text()))) issues.push(`[${tag}] console: ${m.text().slice(0, 160)}`) })
    page.on('pageerror', e => issues.push(`[${tag}] pageerror: ${e.message}`))
    const payloads = new Map()
    page.on('response', async r => {
      const m = new URL(r.url()).pathname.match(/\/api\/organizer\/analytics\/(?:overview\/)?([^/]+)$/)
      if (!m) return
      const slug = decodeURIComponent(m[1]).replace(/-draft$/, '')
      if (r.status() !== 200) { payloads.set(slug, { status: r.status() }); return }
      let body = ''; try { body = await r.text() } catch { return }
      if (!payloads.has(slug)) payloads.set(slug, { status: 200, analytics: JSON.parse(body).analytics })
    })

    await login(page, who)
    if (!who.analytics) {
      await page.goto(`${BASE}/dashboard/analytics/insights?eventId=a28-intel-draft`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(6000)
      await page.screenshot({ path: `${OUT}/desktop-staff-gate.png`, fullPage: true })
      const p = payloads.get('a28-intel')
      facts.push(`[${tag}] gate role analytics API → ${p ? 'HTTP ' + p.status : 'never called'}`)
      if (p?.status === 200) issues.push(`[${tag}] gate role received a 200 analytics payload`)
      const text = await page.evaluate(() => document.body.innerText)
      if (/checks cleared|No significant changes|Evidence/.test(text)) issues.push(`[${tag}] insights rendered to a gate role`)
      await ctx.close(); continue
    }

    for (const slug of ['a28-intel', 'a29-mix', 'a29-clean']) {
      if (vp.tag !== 'desktop' && slug !== 'a28-intel') continue
      await page.goto(`${BASE}/dashboard/analytics/insights?eventId=${slug}-draft`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(7000)
      await page.screenshot({ path: `${OUT}/${vp.tag}-${name}-${slug}.png`, fullPage: true })
      const main = await page.evaluate(() => (document.querySelector('main') ?? document.body).innerText)
      const p = payloads.get(slug)
      if (!p || p.status !== 200) { issues.push(`[${tag}/${slug}] analytics payload never observed`); continue }

      // Cross-check: the same engine over the same payload must produce the cards on screen.
      const expected = buildInsights(p.analytics)
      const titles = await page.evaluate(() => [...document.querySelectorAll('section[aria-label="Insights"] article h3')].map(h => h.textContent.trim()))
      const want = expected.insights.map(i => i.title)
      if (JSON.stringify(titles) !== JSON.stringify(want)) issues.push(`[${tag}/${slug}] cards differ from the engine: screen=${JSON.stringify(titles)} engine=${JSON.stringify(want)}`)
      else facts.push(`[${tag}/${slug}] ${want.length} card(s) match the engine ✓${want.length ? ' — ' + expected.insights.map(i => i.rule).join(', ') : ''}`)
      if (want.length === 0 && !/No significant changes detected/.test(main)) issues.push(`[${tag}/${slug}] empty state missing`)
      if (want.length > 0 && !/checks cleared their floors/.test(main)) issues.push(`[${tag}/${slug}] summary line missing`)
      if (want.length > 6) issues.push(`[${tag}/${slug}] engine returned more than six`)

      // Permission: a non-money viewer's payload has no revenue key, so no money card and no rupee sign in the cards.
      const cardText = await page.evaluate(() => (document.querySelector('section[aria-label="Insights"]')?.innerText ?? ''))
      if (!who.money && /₹/.test(cardText)) issues.push(`[${tag}/${slug}] rupee figure rendered to a non-money role`)
      if (!who.money && 'revenue' in p.analytics) issues.push(`[${tag}/${slug}] revenue key present for a non-money role`)
      for (const bad of ['NaN', 'Infinity', 'undefined', 'null']) if (new RegExp(`\\b${bad}\\b`).test(main)) issues.push(`[${tag}/${slug}] renders literal "${bad}"`)
      if (/no[- ]show|unique participants|lack permission|hidden because|AI/.test(main)) issues.push(`[${tag}/${slug}] forbidden wording`)
      if (/@[a-z0-9-]+\.test/.test(main)) issues.push(`[${tag}/${slug}] an email address is on screen`)
      const navHas = await page.evaluate(() => [...document.querySelectorAll('nav[aria-label="Analytics modules"] a')].some(a => a.textContent?.trim() === 'Insights'))
      if (!navHas) issues.push(`[${tag}/${slug}] Insights missing from the module nav`)
      const overflow = await page.evaluate(() => Math.max(
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
        (document.querySelector('main')?.scrollWidth ?? 0) - (document.querySelector('main')?.clientWidth ?? 0)))
      facts.push(`[${tag}/${slug}] overflow ${overflow}px`)
      if (overflow > 1) issues.push(`[${tag}/${slug}] horizontal overflow ${overflow}px`)
      // Every "View analytics" link must carry the event context.
      const links = await page.evaluate(() => [...document.querySelectorAll('section[aria-label="Insights"] a')].map(a => a.getAttribute('href')))
      for (const h of links) if (!/eventId=/.test(h)) issues.push(`[${tag}/${slug}] link without event context: ${h}`)
    }
    await ctx.close()
  }
}

await browser.close()
console.log(facts.join('\n'))
console.log(issues.length ? '\nISSUES:\n' + issues.join('\n') : '\nInsights: every card on screen is justified by the engine over the observed payload, and only the right roles see money.')
console.log(`shots → ${OUT}`)
