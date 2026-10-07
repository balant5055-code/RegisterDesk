/* RD-DASHBOARD-08 — browser verification for Header → Quick Actions.
 *
 *   npm run emu:seed
 *   dotenv -e .env.emulator -- node scripts/emulator/seed-dashboard-scope.mjs
 *   dotenv -e .env.emulator -- node scripts/profiling/verify-dashboard-top.mjs
 *
 * ═══ WHAT ONLY A BROWSER CAN ANSWER ══════════════════════════════════════════
 * "Cards in a row have equal height" and "Quick actions stays in the intended row" are
 * MEASUREMENTS, not source facts. A unit test can assert the class names and still miss a
 * wrapped grid, a card that outgrows its neighbours, or a chart that overflows on a phone.
 * So this reads real geometry from a real layout at six widths.
 */
import { chromium } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'

const BASE     = process.env.RD_PROFILE_BASE_URL ?? 'http://localhost:3187'
const EMAIL    = process.env.RD_PROFILE_EMAIL
const PASSWORD = process.env.RD_PROFILE_PASSWORD
const OUT      = 'e2e/.shots/dashboard-top'

const A     = { id: 'scope-event-coastal',   name: 'Coastal Marathon 2026' }
const B     = { id: 'scope-event-hilltrail', name: 'Hill Trail Run 2026' }
const DRAFT = { id: 'scope-event-draft',     name: 'Monsoon 10K 2027' }

const VIEWPORTS = [
  { name: 'wide',    width: 1440, height: 900 },
  { name: 'desktop', width: 1280, height: 860 },
  { name: 'laptop',  width: 1024, height: 820 },
  { name: 'tablet',  width: 768,  height: 1024 },
  { name: 'mobile',  width: 390,  height: 844 },
  { name: 'small',   width: 375,  height: 812 },
]

const checks = [], failures = []
const check = (ok, label, detail = '') => {
  checks.push({ ok, label, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const bodyText = page => page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))

async function selectEvent(page, name) {
  await page.getByRole('button', { name: /change event|select an event/i }).click()
  await page.getByRole('option', { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') })
    .first().click()
  await page.waitForFunction(
    n => !/Loading /.test(document.body.innerText) && document.body.innerText.includes(n),
    name, { timeout: 30_000 })
  await page.waitForTimeout(700)
}

/** Bounding boxes of a section's direct grid children — the raw material for row checks. */
const rowGeometry = (page, label) => page.evaluate(sel => {
  const section = document.querySelector(`[aria-label="${sel}"]`)
  if (!section) return null
  return [...section.children].map(el => {
    const r = el.getBoundingClientRect()
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), width: Math.round(r.width) }
  })
}, label)

/** Group boxes into visual rows by their top edge, then assert each row's bottoms align. */
function equalHeightsByRow(boxes, tolerance = 2) {
  const rows = new Map()
  for (const b of boxes) {
    const key = [...rows.keys()].find(k => Math.abs(k - b.top) <= tolerance) ?? b.top
    rows.set(key, [...(rows.get(key) ?? []), b])
  }
  const offenders = []
  for (const [top, items] of rows) {
    if (items.length < 2) continue
    const min = Math.min(...items.map(i => i.bottom))
    const max = Math.max(...items.map(i => i.bottom))
    if (max - min > tolerance) offenders.push(`row@${top}: bottoms span ${max - min}px`)
  }
  return offenders
}

async function run() {
  mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch()
  const ctx  = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()

  const consoleErrors = []
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`))
  const dashCalls = []
  page.on('request', r => { if (r.url().includes('/api/organizer/dashboard')) dashCalls.push(r.url()) })

  console.log(`\nSigning in at ${BASE}`)
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.locator('#login-email').fill(EMAIL)
  await page.locator('#login-password').fill(PASSWORD)
  await page.getByRole('button', { name: /sign in to dashboard/i }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 60_000 })
  await page.waitForFunction(() => !/Loading /.test(document.body.innerText), undefined, { timeout: 60_000 })
  await page.waitForTimeout(900)

  // ── HEADER ────────────────────────────────────────────────────────────────
  console.log('\n── Header ──')
  await selectEvent(page, A.name)
  const textA = await bodyText(page)
  await page.screenshot({ path: `${OUT}/A-event.png` })

  check(/Good (morning|afternoon|evening)/.test(textA), 'greeting renders')
  check(textA.includes("Here's what's happening for this event today."),
    'event-mode subtitle renders')
  check(textA.includes(A.name), 'the selected event is named')
  // The taxonomy MUST be the seeded configuration: sports → marathon.
  check(/Sports & Fitness/.test(textA), 'event type comes from the event’s configuration',
    'Sports & Fitness')
  check(!/→ Running/.test(textA),
    'no invented subtype — the fixture configures "marathon", not "running"')

  const headerHasCreate = await page.evaluate(() => {
    const h = document.querySelector('header')
    return !!h && /create event/i.test(h.innerText)
  })
  check(!headerHasCreate, 'the duplicate "Create event" button is gone from the header')
  check(/Quick actions/i.test(textA) && /Create event/i.test(textA),
    'Create event is still reachable from Quick actions')

  // ── LICENSE TILE ──────────────────────────────────────────────────────────
  console.log('\n── License entitlement ──')
  // Coastal is seeded on `starter` (catalog limit 100) with 420 confirmed — deliberately
  // over its ceiling, so the critical + upgrade branch is exercised rather than assumed.
  check(/Registration capacity/i.test(textA), 'the entitlement tile renders')
  check(/Starter/.test(textA), 'the PLAN NAME comes from the catalog', 'Starter')
  check(/420 \/ 100/.test(textA), 'used / limit are the real resolved figures', '420 / 100')
  check(/100% used/.test(textA), 'percentage is clamped rather than overflowing')
  check(/Upgrade to /.test(textA), 'the upgrade CTA appears when the plan is over its ceiling')
  check(/Active/.test(textA), 'the licence STATUS is shown as text, not colour alone')

  await selectEvent(page, B.name)
  const textB = await bodyText(page)
  check(/Professional/.test(textB), 'the tile follows the SELECTED event’s licence', 'Professional')
  check(/37 \/ 5,000/.test(textB), 'a healthy plan shows its real headroom', '37 / 5,000')
  // RD-DASHBOARD-09: the CTA is now offered whenever a HIGHER PLAN EXISTS, not only under
  // pressure — a plan with headroom is still upgradeable, and hiding the path made the card
  // read as a read-only readout. Urgency is carried by STYLING, not by presence.
  check(/Upgrade to /.test(textB), 'a healthy plan still offers its real upgrade path')
  check(/Professional/.test(textB) && /Active/.test(textB), 'plan and status both shown')

  // ── DRAFT ─────────────────────────────────────────────────────────────────
  console.log('\n── Draft event ──')
  await selectEvent(page, DRAFT.name)
  const textD = await bodyText(page)
  check(textD.includes(DRAFT.name) && /Draft/.test(textD), 'draft is named and flagged')
  check(/Not published yet/.test(textD), 'the draft notice survives this redesign')
  check(/no license yet|could not be loaded/i.test(textD),
    'an unlicensed draft reports honestly instead of 0 of 0')

  // ── ALL EVENTS ────────────────────────────────────────────────────────────
  console.log('\n── All events ──')
  await page.getByRole('button', { name: /change event|select an event/i }).click()
  await page.getByRole('option', { name: /all events/i }).first().click()
  await page.waitForFunction(
    () => !/Loading /.test(document.body.innerText) && /across all your events/.test(document.body.innerText),
    undefined, { timeout: 30_000 })
  await page.waitForTimeout(700)
  const textAll = await bodyText(page)
  await page.screenshot({ path: `${OUT}/B-all-events.png` })
  check(textAll.includes("Here's what's happening across all your events today."),
    'all-events subtitle renders')
  check(/Across \d+ licensed event/.test(textAll),
    'the workspace entitlement aggregates its licences')
  check(/457/.test(textAll), 'workspace totals are still the sum', '457')

  // ── LAYOUT GEOMETRY, AT EVERY BREAKPOINT ──────────────────────────────────
  console.log('\n── Responsive geometry ──')
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height })
    await page.waitForTimeout(500)

    const overflow = await page.evaluate(() => {
      const el = document.querySelector('#main-content') ?? document.documentElement
      return { scrollW: el.scrollWidth, clientW: el.clientWidth, docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }
    })
    check(overflow.scrollW - overflow.clientW <= 1 && overflow.docOverflow <= 1,
      `${vp.name} (${vp.width}px) · no horizontal overflow`,
      `scroll ${overflow.scrollW} vs client ${overflow.clientW}`)

    for (const label of ['Key metrics', 'Today']) {
      const boxes = await rowGeometry(page, label)
      if (!boxes) { check(false, `${vp.name} · "${label}" section found`); continue }
      const offenders = equalHeightsByRow(boxes)
      check(offenders.length === 0, `${vp.name} · ${label}: cards in a row end level`,
        offenders.join('; ') || `${boxes.length} cards`)
    }

    // The composed row: on xl the three panels share ONE line.
    const composed = await page.evaluate(() => {
      const trend = document.querySelector('[aria-labelledby="trend-heading"]')
      const up    = [...document.querySelectorAll('section')].find(s => /^Upcoming events/.test(s.innerText ?? ''))
      const qa    = document.querySelector('[aria-labelledby="quick-actions-heading"]')
      if (!trend || !qa) return null
      const box = el => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) } }
      return { trend: box(trend), upcoming: up ? box(up) : null, quick: box(qa) }
    })
    if (!composed) { check(false, `${vp.name} · composed row present`); continue }

    if (vp.width >= 1280) {
      const sameRow = Math.abs(composed.trend.top - composed.quick.top) <= 4
      check(sameRow, `${vp.name} · Quick actions stays in the composed row`,
        `trend@${composed.trend.top} quick@${composed.quick.top}`)
      if (composed.upcoming) {
        check(Math.abs(composed.trend.bottom - composed.upcoming.bottom) <= 4,
          `${vp.name} · Trend and Upcoming end level`,
          `${composed.trend.bottom} vs ${composed.upcoming.bottom}`)
      }
    } else {
      check(composed.quick.top > composed.trend.top,
        `${vp.name} · stacks in priority order (trend before quick actions)`)
    }

    await page.screenshot({ path: `${OUT}/vp-${vp.name}.png` })
  }

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForTimeout(400)

  // ── READS ─────────────────────────────────────────────────────────────────
  const before = dashCalls.length
  await selectEvent(page, A.name)
  check(dashCalls.length - before === 1, 'an event switch STILL costs exactly one dashboard read',
    `${dashCalls.length - before}`)

  const real = consoleErrors.filter(e => !/favicon|Download the React DevTools|hydrat/i.test(e))
  check(real.length === 0, 'no console errors', real.slice(0, 2).join(' | '))

  writeFileSync(`${OUT}/result.json`, JSON.stringify({ checks, failures }, null, 2))
  await browser.close()
  console.log(`\n${checks.filter(c => c.ok).length}/${checks.length} checks passed. Screenshots in ${OUT}/`)
  if (failures.length) { console.error(`\nFAILED:\n  ${failures.join('\n  ')}`); process.exit(1) }
}

if (!EMAIL || !PASSWORD) { console.error('RD_PROFILE_EMAIL / RD_PROFILE_PASSWORD required'); process.exit(2) }
run().catch(e => { console.error(e); process.exit(1) })
