/* RD-ANALYTICS-12-13 — navigation surfacing, in a real browser. EMULATOR ONLY.
 *
 * The claims are mostly about ABSENCE and DESTINATION, neither of which a screenshot proves:
 * that a row exists and goes where it says, that a role does NOT see a row, that a module is
 * reachable by clicking rather than by typing a URL. So every case is asserted against the
 * rendered DOM and the resulting URL, and captured as well.
 *
 * Assertions are scoped to the sidebar <nav> wherever a word could also appear in page
 * content — RD-ANALYTICS-12-10's QA produced a false positive exactly that way.
 *
 *   node rd-analytics-12-13-shots.mjs
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE = process.env.RD_PROFILE_BASE_URL ?? 'http://localhost:3187'
const OWNER   = { email: 'profiling@registerdesk.test',   password: 'ProfilingPassw0rd!' }
const FINANCE = { email: 'finance.a11@registerdesk.test', password: 'FinancePassw0rd!' }
const MANAGER = { email: 'manager.a06@registerdesk.test', password: 'ManagerPassw0rd!' }
const OUT = 'e2e/.shots/rd-analytics-12-13'

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
  await page.waitForTimeout(1800)   // let the workspace/permission response land
}

/** Sidebar rows only — label → href. Never the whole page. */
const sidebarRows = page => page.evaluate(() => {
  const nav = document.querySelector('aside nav') ?? document.querySelector('nav')
  if (!nav) return null
  return [...nav.querySelectorAll('a')].map(a => ({
    label: (a.textContent ?? '').trim(),
    href:  a.getAttribute('href') ?? '',
  })).filter(r => r.label)
})

// ── Owner: the three destinations, and the modules ───────────────────────────
{
  const ctx  = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  const page = await ctx.newPage()
  page.on('console',   m => { if (m.type() === 'error') issues.push(`[owner] console: ${m.text()}`) })
  page.on('pageerror', e => issues.push(`[owner] pageerror: ${e.message}`))

  await login(page, OWNER)
  await page.screenshot({ path: `${OUT}/desktop-owner-sidebar.png` })

  const rows = await sidebarRows(page)
  if (!rows) { issues.push('[owner] no sidebar found') }
  else {
    const find = label => rows.find(r => r.label === label)
    for (const [label, href] of [
      ['Analytics', '/dashboard/analytics'],
      ['Reports',   '/dashboard/finance/reports'],
      ['Finance',   '/dashboard/finance'],
    ]) {
      const row = find(label)
      if (!row) { issues.push(`[owner] sidebar has no "${label}" row`); continue }
      if (!row.href.startsWith(href)) issues.push(`[owner] "${label}" → ${row.href}, expected ${href}`)
      facts.push(`[owner] sidebar "${label}" → ${row.href}`)
    }
    // The old destination must not be linked from navigation any more.
    const stale = rows.filter(r => r.href.split('?')[0] === '/dashboard/reports')
    if (stale.length) issues.push(`[owner] sidebar still links /dashboard/reports: ${JSON.stringify(stale)}`)
    // Exactly one row each — no duplicates.
    for (const label of ['Analytics', 'Reports', 'Finance']) {
      const n = rows.filter(r => r.label === label).length
      if (n !== 1) issues.push(`[owner] ${n} sidebar rows labelled "${label}" (expected 1)`)
    }
  }

  // Click Analytics → land on the canonical workspace.
  await page.getByRole('link', { name: /^Analytics$/ }).first().click()
  await page.waitForTimeout(2500)
  const analyticsUrl = new URL(page.url()).pathname
  facts.push(`[owner] clicking Analytics → ${analyticsUrl}`)
  if (analyticsUrl !== '/dashboard/analytics') issues.push(`[owner] Analytics landed on ${analyticsUrl}`)
  await page.screenshot({ path: `${OUT}/desktop-owner-analytics.png` })

  // The module strip must be present and must actually navigate.
  const modules = await page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Analytics modules"]')
    return nav ? [...nav.querySelectorAll('a')].map(a => ({
      label: (a.textContent ?? '').trim(), href: a.getAttribute('href') ?? '',
    })) : null
  })
  if (!modules) issues.push('[owner] no Analytics module strip on the landing page')
  else {
    facts.push(`[owner] module strip: ${modules.map(m => m.label).join(' | ')}`)
    for (const want of ['Overview', 'Registrations', 'Revenue', 'Operations', 'Communications']) {
      if (!modules.some(m => m.label === want)) issues.push(`[owner] module strip missing "${want}"`)
    }
  }

  // Walk every module by CLICKING — the whole point of the phase.
  for (const label of ['Overview', 'Registrations', 'Revenue', 'Operations', 'Communications']) {
    try {
      await page.locator('nav[aria-label="Analytics modules"] a', { hasText: new RegExp(`^${label}$`) })
        .first().click({ timeout: 15_000 })
      await page.waitForTimeout(2200)
      const p = new URL(page.url()).pathname
      facts.push(`[owner] module "${label}" → ${p}`)
      if (!p.startsWith('/dashboard/analytics/')) issues.push(`[owner] "${label}" left the workspace: ${p}`)
      const blank = await page.evaluate(() => document.body.innerText.trim().length < 80)
      if (blank) issues.push(`[owner] "${label}" rendered a blank page`)
      // The strip must survive on every module, or the workspace is a one-way trip.
      const still = await page.locator('nav[aria-label="Analytics modules"]').count()
      if (!still) issues.push(`[owner] "${label}" has no module strip — dead end`)
    } catch (e) {
      issues.push(`[owner] could not click module "${label}": ${e.message.split('\n')[0]}`)
    }
  }
  await page.screenshot({ path: `${OUT}/desktop-owner-module-communications.png` })

  // Breadcrumb on a module.
  const crumbs = await page.evaluate(() => {
    const el = document.querySelector('[aria-label="Breadcrumb"], nav[aria-label="breadcrumb"]')
    return el ? el.innerText.replace(/\s+/g, ' ').trim() : null
  })
  facts.push(`[owner] module breadcrumb: ${crumbs ?? 'NOT FOUND'}`)
  if (crumbs && /Analytics\s*\/?\s*Analytics/i.test(crumbs)) issues.push('[owner] breadcrumb duplicates Analytics')

  // Reports row → the report workspace, still working.
  await page.getByRole('link', { name: /^Reports$/ }).first().click()
  await page.waitForTimeout(2500)
  const reportsUrl = new URL(page.url()).pathname
  facts.push(`[owner] clicking Reports → ${reportsUrl}`)
  if (reportsUrl !== '/dashboard/finance/reports') issues.push(`[owner] Reports landed on ${reportsUrl}`)
  const reportsText = await page.evaluate(() => document.body.innerText)
  if (!/Finance & Compliance Reports/i.test(reportsText)) issues.push('[owner] Reports page did not render')
  if (!/History/.test(reportsText)) issues.push('[owner] Reports page lost its History tab')
  const rCrumb = await page.evaluate(() => {
    const el = document.querySelector('[aria-label="Breadcrumb"], nav[aria-label="breadcrumb"]')
    return el ? el.innerText.replace(/\s+/g, ' ').trim() : null
  })
  facts.push(`[owner] Reports breadcrumb: ${rCrumb ?? 'NOT FOUND'}`)
  if (rCrumb && /Analytics/i.test(rCrumb)) issues.push('[owner] Reports breadcrumb says Analytics')
  await page.screenshot({ path: `${OUT}/desktop-owner-reports.png` })

  // The compatibility route still resolves and still names itself.
  await page.goto(`${BASE}/dashboard/reports`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  const legacyText = await page.evaluate(() => document.body.innerText)
  const legacyOk = legacyText.trim().length > 200 && !/404|not found/i.test(legacyText)
  facts.push(`[owner] /dashboard/reports still resolves: ${legacyOk}`)
  if (!legacyOk) issues.push('[owner] the compatibility route stopped working')
  const lCrumb = await page.evaluate(() => {
    const el = document.querySelector('[aria-label="Breadcrumb"], nav[aria-label="breadcrumb"]')
    return el ? el.innerText.replace(/\s+/g, ' ').trim() : null
  })
  facts.push(`[owner] /dashboard/reports breadcrumb: ${lCrumb ?? 'NOT FOUND'}`)
  await page.screenshot({ path: `${OUT}/desktop-owner-legacy-reports.png` })

  // Overview quick action must now say Reports and mean it.
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  const quick = await page.evaluate(() =>
    [...document.querySelectorAll('a')]
      .filter(a => /^Reports\b/.test((a.textContent ?? '').trim()))
      .map(a => a.getAttribute('href')))
  facts.push(`[owner] Overview "Reports" links → ${JSON.stringify(quick)}`)
  if (quick.some(h => h === '/dashboard/reports')) issues.push('[owner] Overview "Reports" still opens the analytics dashboard')

  await ctx.close()
}

// ── Finance: Reports yes, Analytics no (it genuinely 403s) ───────────────────
{
  const ctx  = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  const page = await ctx.newPage()
  page.on('pageerror', e => issues.push(`[finance] pageerror: ${e.message}`))
  await login(page, FINANCE)
  await page.screenshot({ path: `${OUT}/desktop-finance-sidebar.png` })

  const rows = await sidebarRows(page)
  const labels = (rows ?? []).map(r => r.label)
  facts.push(`[finance] sidebar rows: ${labels.join(' | ')}`)
  if (!labels.includes('Reports')) issues.push('[finance] no Reports row — the role that needs it most')
  if (!labels.includes('Finance')) issues.push('[finance] no Finance row')
  if (labels.includes('Analytics')) {
    issues.push('[finance] Analytics row shown, but finance lacks `events` and the modules 403')
  }

  await page.getByRole('link', { name: /^Reports$/ }).first().click()
  await page.waitForTimeout(2500)
  const t = await page.evaluate(() => document.body.innerText)
  facts.push(`[finance] Reports opened: ${/Finance & Compliance Reports/i.test(t)}`)
  if (!/Finance & Compliance Reports/i.test(t)) issues.push('[finance] Reports did not render')
  await ctx.close()
}

// ── Manager: Analytics yes, Finance no ───────────────────────────────────────
{
  const ctx  = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  const page = await ctx.newPage()
  page.on('pageerror', e => issues.push(`[manager] pageerror: ${e.message}`))
  await login(page, MANAGER)
  const rows = await sidebarRows(page)
  const labels = (rows ?? []).map(r => r.label)
  facts.push(`[manager] sidebar rows: ${labels.join(' | ')}`)
  if (!labels.includes('Analytics')) issues.push('[manager] no Analytics row, though manager holds `events`')
  if (labels.includes('Finance')) issues.push('[manager] Finance row shown without `transactions`')
  await page.screenshot({ path: `${OUT}/desktop-manager-sidebar.png` })
  await ctx.close()
}

// ── Command palette ──────────────────────────────────────────────────────────
{
  const ctx  = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  const page = await ctx.newPage()
  await login(page, OWNER)
  await page.keyboard.press('Control+K')
  await page.waitForTimeout(1200)
  await page.keyboard.type('report', { delay: 30 })
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `${OUT}/desktop-palette-reports.png` })
  const results = await page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"]')
    return dlg ? dlg.innerText.replace(/\s+/g, ' ').trim().slice(0, 400) : null
  })
  facts.push(`[palette] "report" → ${results ?? 'NO DIALOG'}`)
  if (!results) issues.push('[palette] command palette did not open')
  await ctx.close()
}

// ── Responsive: mobile drawer must carry the same IA ─────────────────────────
for (const vp of [{ name: 'desktop', width: 1440, height: 1100 },
                  { name: 'tablet',  width: 834,  height: 1100 },
                  { name: 'mobile',  width: 390,  height: 900  }]) {
  const ctx  = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
  const page = await ctx.newPage()
  page.on('pageerror', e => issues.push(`[${vp.name}] pageerror: ${e.message}`))
  await login(page, OWNER)
  await page.goto(`${BASE}/dashboard/analytics/registrations`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)

  if (vp.name === 'mobile') {
    // Open the drawer and confirm it carries the same three rows.
    const opener = page.getByRole('button', { name: /menu|open navigation|navigation/i }).first()
    if (await opener.count()) { await opener.click(); await page.waitForTimeout(900) }
    const labels = ((await sidebarRows(page)) ?? []).map(r => r.label)
    facts.push(`[mobile] drawer rows: ${labels.join(' | ')}`)
    for (const want of ['Analytics', 'Reports', 'Finance']) {
      if (!labels.includes(want)) issues.push(`[mobile] drawer missing "${want}"`)
    }
    await page.screenshot({ path: `${OUT}/mobile-drawer.png` })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(700)
  }

  await page.screenshot({ path: `${OUT}/${vp.name}-analytics-module.png` })
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth)
  // The module strip scrolls rather than wrapping; the PAGE must not scroll sideways.
  const clipped = await page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Analytics modules"]')
    if (!nav) return null
    return [...nav.querySelectorAll('a')].filter(a => a.scrollWidth > a.clientWidth + 1).map(a => a.textContent?.trim())
  })
  facts.push(`[${vp.name}] page overflow ${overflow}px; clipped module labels: ${JSON.stringify(clipped)}`)
  if (overflow > 1) issues.push(`[${vp.name}] horizontal page overflow ${overflow}px`)
  if (clipped === null) issues.push(`[${vp.name}] module strip missing`)
  else if (clipped.length) issues.push(`[${vp.name}] clipped module labels: ${clipped.join(', ')}`)
  await ctx.close()
}

await browser.close()
console.log(facts.join('\n'))
console.log(issues.length ? '\nISSUES:\n' + issues.join('\n')
                          : '\nEvery destination, absence and label held.')
console.log(`shots → ${OUT}`)
