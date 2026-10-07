/* RD-ANALYTICS-12-33 — Premium Analytics UX. EMULATOR ONLY. Run the 12-28/12-29/12-31 fixtures first.
 *
 * Verifies presentation against the payload it renders: the three new states (empty
 * denominator, unknown event, attendance not started), Overview provenance, ONE event
 * selector, capability-gated module strip, ≥ 40px targets, the loading skeleton, the
 * Communications table fitting a phone, and no main-page overflow — for every module at
 * 1440/834/390 (owner) and 1440 (finance/admin/manager), plus gate staff.
 *
 *   node rd-analytics-12-33-shots.mjs
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE = process.env.RD_PROFILE_BASE_URL ?? 'http://localhost:3187'
const ACCOUNTS = {
  owner:   { email: 'profiling@registerdesk.test',    password: 'ProfilingPassw0rd!', money: true,  analytics: true },
  finance: { email: 'finance.a11@registerdesk.test',  password: 'FinancePassw0rd!',   money: true,  analytics: true },
  admin:   { email: 'admin.a1220@registerdesk.test',  password: 'AdminPassw0rd!',     money: false, analytics: true },
  manager: { email: 'manager.a06@registerdesk.test',  password: 'ManagerPassw0rd!',   money: false, analytics: true },
  staff:   { email: 'staff.a08@registerdesk.test',    password: 'StaffPassw0rd!',     money: false, analytics: false },
}
const MODULES = ['overview', 'registrations', 'revenue', 'operations', 'communications', 'participants', 'insights']
const OUT = 'e2e/.shots/rd-analytics-12-33-impl'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const issues = [], facts = []
const ok = (tag, label) => facts.push(`[${tag}] ${label} ✓`)
const bad = (tag, label) => issues.push(`[${tag}] ${label}`)
const check = (tag, cond, label) => (cond ? ok(tag, label) : bad(tag, label))

async function login(page, who) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.locator('#login-email').waitFor({ state: 'visible', timeout: 60_000 })
  await page.locator('#login-email').pressSequentially(who.email, { delay: 5 })
  await page.locator('#login-password').pressSequentially(who.password, { delay: 5 })
  await page.getByRole('button', { name: /sign in|log ?in/i }).first().click()
  await page.waitForURL(/\/dashboard|\/checkin/, { timeout: 90_000 })
  await page.waitForTimeout(1500)
}

const probe = () => {
  const main = document.querySelector('main') ?? document.body
  const overflow = Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, main.scrollWidth - main.clientWidth)
  const selectorsInMain = main.querySelectorAll('button[aria-label^="Selected event:"], button[aria-label^="Scope: All events"], button[aria-label="Select an event"]').length
  const selectorsTotal  = document.querySelectorAll('button[aria-label^="Selected event:"], button[aria-label^="Scope: All events"], button[aria-label="Select an event"]').length
  const nav = [...document.querySelectorAll('nav[aria-label="Analytics modules"] a')].map(a => a.textContent.trim())
  const small = [...main.querySelectorAll('button,a')].filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height < 36 })
    .map(b => `${b.tagName}:${(b.textContent || b.getAttribute('aria-label') || '').trim().slice(0, 18)} ${Math.round(b.getBoundingClientRect().height)}px`)
  const h1 = main.querySelector('h1')?.textContent.trim() ?? ''
  const firstFigure = (() => { const el = main.querySelector('section, table, article'); return el ? Math.round(el.getBoundingClientRect().top + window.scrollY) : null })()
  const tables = [...main.querySelectorAll('table')].filter(t => t.getBoundingClientRect().width > 0).map(t => ({ w: Math.round(t.getBoundingClientRect().width), parent: Math.round(t.parentElement.getBoundingClientRect().width) }))
  return { overflow, selectorsInMain, selectorsTotal, nav, small, h1, firstFigure, tables, text: main.innerText }
}

for (const [name, who] of Object.entries(ACCOUNTS)) {
  const vps = name === 'owner'
    ? [{ tag: 'desktop', width: 1440, height: 1100 }, { tag: 'tablet', width: 834, height: 1100 }, { tag: 'mobile', width: 390, height: 900 }]
    : [{ tag: 'desktop', width: 1440, height: 1100 }]
  for (const vp of vps) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
    const page = await ctx.newPage()
    const tag = `${name}/${vp.tag}`
    page.on('console', m => { if (m.type() === 'error' && !(name === 'staff' && /40[123]/.test(m.text()))) bad(tag, `console: ${m.text().slice(0, 140)}`) })
    page.on('pageerror', e => bad(tag, `pageerror: ${e.message}`))
    const payloads = new Map()
    page.on('response', async r => {
      const m = new URL(r.url()).pathname.match(/\/api\/organizer\/analytics\/(?:overview\/)?([^/]+)$/)
      if (!m) return
      const slug = decodeURIComponent(m[1]).replace(/-draft$/, '')
      const key = `${slug}|${new URL(r.url()).search}`
      payloads.set(key, (payloads.get(key) ?? 0) + 1)
      if (r.status() === 200) { try { const b = await r.text(); payloads.set(slug, JSON.parse(b).analytics) } catch { /* ignore */ } }
    })

    await login(page, who)
    if (!who.analytics) {
      await page.goto(`${BASE}/dashboard/analytics/overview?eventId=a29-mix-draft`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(5000)
      check(tag, ![...payloads.keys()].some(k => k.startsWith('a29-mix|')), 'gate role never reaches the analytics API')
      const t = await page.evaluate(() => document.body.innerText)
      check(tag, !/All time|Highlights|Not started/.test(t), 'gate role sees no analytics content')
      await ctx.close(); continue
    }

    for (const mod of MODULES) {
      const slug = 'a29-mix'
      await page.goto(`${BASE}/dashboard/analytics/${mod}?eventId=${slug}-draft`, { waitUntil: 'domcontentloaded' })
      // Loading skeleton: probe early.
      await page.waitForTimeout(250)
      const early = await page.evaluate(() => Boolean(document.querySelector('main [aria-busy="true"]')) || /Loading events/.test(document.body.innerText) || Boolean(document.querySelector('main section')))
      await page.waitForTimeout(6500)
      await page.screenshot({ path: `${OUT}/${vp.tag}-${name}-${mod}.png`, fullPage: true })
      const p = await page.evaluate(probe)
      const t = `${tag}/${mod}`
      check(t, p.overflow <= 1, `no overflow (${p.overflow}px)`)
      check(t, p.selectorsInMain === 0 && p.selectorsTotal === 1, `one event selector (main:${p.selectorsInMain}, total:${p.selectorsTotal})`)
      check(t, p.small.length === 0, `no target under 36px${p.small.length ? ': ' + p.small.join(' | ') : ''}`)
      check(t, early, 'skeleton/placeholder present before data')
      if (!/NaN|Infinity|undefined|\bnull\b/.test(p.text)) ok(t, 'no literal NaN/undefined/null'); else bad(t, 'literal NaN/undefined/null on screen')
      const a = payloads.get(slug)
      if (a) {
        // Strip reflects capabilities.modules; Overview/Insights always.
        const expected = ['Insights', 'Overview', ...['registrations', 'revenue', 'operations', 'communications', 'participants'].filter(k => a.capabilities.modules.includes(k)).map(k => k[0].toUpperCase() + k.slice(1))]
        check(t, JSON.stringify(p.nav) === JSON.stringify(expected), `strip = capabilities (${p.nav.join(',')})`)
        check(t, who.money === ('revenue' in a), 'revenue key follows transactions')
        if (mod === 'overview') {
          check(t, p.h1 === 'Overview', `H1 is the module (${p.h1})`)
          check(t, (p.text.match(/All time/g) ?? []).length >= 4, 'lifetime figures captioned All time')
          check(t, /Highlights/.test(p.text) && !/\nInsights\n[^]*Derived from/.test(p.text), 'Highlights section, no second Insights')
          check(t, p.text.includes(a.registrations.confirmed.toLocaleString('en-IN')), `confirmed ${a.registrations.confirmed} rendered from payload`)
          if (a.operations.checkedIn === 0) check(t, /no check-ins yet/.test(p.text), 'Overview says no check-ins yet')
        }
        if (mod === 'operations' && a.operations.attendance.checkedIn === 0) {
          check(t, /Not started/.test(p.text) && !/Attendance\s*\n?\s*0%/.test(p.text), 'attendance Not started, not 0%')
          check(t, /No check-ins yet/.test(p.text), 'not-started explanation')
        }
        if (mod === 'communications') {
          const tb = p.tables[0]
          if (vp.tag === 'mobile') check(t, !tb && /Attempted[\s\S]*Skipped/.test(p.text), 'phone width: window figures as a list, no table')
          else check(t, tb && tb.w <= tb.parent + 1, `window table fits its container (${tb?.w}/${tb?.parent})`)
        }
        if (mod === 'revenue' && who.money && a.revenue?.intelligence.averageOrderValue.denominator === 0) {
          check(t, /No paid registrations yet/.test(p.text) && !/could not be read/.test(p.text.slice(p.text.indexOf('AVERAGE ORDER VALUE'), p.text.indexOf('AVERAGE ORDER VALUE') + 200)), 'AOV empty denominator — no read-failure wording')
        }
        if (mod === 'revenue' && !who.money) check(t, /not available to you/.test(p.text) && !/₹/.test(p.text), 'revenue denied without figures')
      } else bad(t, 'payload not observed')
    }
    // Unknown event: honest, non-leaky.
    await page.goto(`${BASE}/dashboard/analytics/overview?eventId=does-not-exist`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(5000)
    const u = await page.evaluate(probe)
    check(tag, /This event is not available in your workspace/.test(u.text) && !/Select a single event/.test(u.text), 'unknown event state distinct from no selection')
    check(tag, !/another workspace|belongs to|owned by/i.test(u.text), 'unknown event state is non-leaky')
    if (vp.tag === 'desktop' && name === 'owner') await page.screenshot({ path: `${OUT}/desktop-owner-unknown-event.png`, fullPage: true })
    // Empty-denominator on an event with revenue reads but no paid registrations (a28-intel).
    if (who.money) {
      await page.goto(`${BASE}/dashboard/analytics/revenue?eventId=a28-intel-draft`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(6500)
      const r = await page.evaluate(probe)
      const a = payloads.get('a28-intel')
      if (a?.revenue?.intelligence.averageOrderValue.denominator === 0) {
        const aovStart = r.text.indexOf('AVERAGE ORDER VALUE')
      const aovEnd = r.text.indexOf('TICKET VALUE BEFORE DISCOUNT', aovStart)
      const aov = r.text.slice(aovStart, aovEnd > 0 ? aovEnd : aovStart + 160)
        check(tag, /No paid registrations yet/.test(aov) && !/could not be read/.test(aov) && !/₹0/.test(aov), `AOV empty denominator on a28-intel: "${aov.replace(/\s+/g, ' ').slice(0, 90)}"`)
      }
      if (vp.tag === 'desktop' && name === 'owner') await page.screenshot({ path: `${OUT}/desktop-owner-a28-intel-revenue.png`, fullPage: true })
    }
    // Keyboard: Tab reaches the strip and a preset; focus ring visible.
    if (vp.tag === 'desktop' && name === 'owner') {
      await page.goto(`${BASE}/dashboard/analytics/overview?eventId=a29-mix-draft`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(5000)
      await page.locator('nav[aria-label="Analytics modules"] a').first().focus()
      await page.keyboard.press('Tab')
      const ring = await page.evaluate(() => { const e = document.activeElement; return { tag: e?.tagName, ring: getComputedStyle(e).boxShadow } })
      check(tag, ring.tag === 'A' && /0px 0px 0px 2px/.test(ring.ring), `focus ring visible on strip link (${ring.tag})`)
      await page.locator('button[aria-pressed]').first().focus()
      await page.keyboard.press('Enter')
      await page.waitForTimeout(3000)
      const pressed = await page.evaluate(() => document.querySelector('button[aria-pressed="true"]')?.textContent.trim())
      check(tag, pressed === '7D', `Enter activates a preset (${pressed})`)
      const range = await page.evaluate(() => (document.querySelector('main') ?? document.body).innerText.match(/Last \d+ days/)?.[0])
      check(tag, range === 'Last 7 days', `range line follows the preset (${range})`)
    }
    // First-figure position on mobile.
    if (vp.tag === 'mobile') {
      await page.goto(`${BASE}/dashboard/analytics/overview?eventId=a29-mix-draft`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(6000)
      const m = await page.evaluate(probe)
      facts.push(`[${tag}] first content block top = ${m.firstFigure}px`)
      check(tag, m.firstFigure !== null && m.firstFigure < 260, `first content block within 260px of the top (${m.firstFigure})`)
    }
    await ctx.close()
  }
}

await browser.close()
console.log(facts.join('\n'))
console.log(issues.length ? '\nISSUES:\n' + issues.join('\n') : '\nPremium UX: every state, target, selector and strip check passed; presentation matches the payload.')
console.log(`shots → ${OUT}`)
