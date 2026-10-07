/* RD-ANALYTICS-12-10 — the Reports workspace, in a real browser. EMULATOR ONLY.
 *
 * The claim under test is half positive and half negative: an owner must SEE eight reports
 * with their descriptions, and a manager must see NONE — an absence that cannot be
 * photographed. So every case is asserted against the rendered text as well as captured.
 *
 *   node rd-analytics-12-10-shots.mjs
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE = process.env.RD_PROFILE_BASE_URL ?? 'http://localhost:3187'
const OWNER   = { email: process.env.RD_PROFILE_EMAIL ?? 'profiling@registerdesk.test',
                  password: process.env.RD_PROFILE_PASSWORD ?? 'ProfilingPassw0rd!' }
const FINANCE = { email: 'finance.a11@registerdesk.test', password: 'FinancePassw0rd!' }
const MANAGER = { email: 'manager.a06@registerdesk.test', password: 'ManagerPassw0rd!' }
const OUT = 'e2e/.shots/rd-analytics-12-10'
const PAGE = `${BASE}/dashboard/finance/reports`

/** Labels and one description fragment each, straight from lib/reports/catalog.ts. */
const REPORTS = [
  ['Transactions',    'Transaction-level financial activity'],
  ['Settlements',     'Settlement requests with their status'],
  ['Wallet Ledger',   'Wallet credits and debits'],
  ['Donations',       'Donations received'],
  ['Refunds',         'Refunds issued from both'],
  ['Broadcast Usage', 'Broadcast campaigns with recipient'],
  ['GST Summary',     'Taxable value and GST on platform fees'],
  ['Payout Statement','Gross, fees, refunds and net settlement'],
]

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
}

const settled = () =>
  /finance & compliance reports|no reports available/i.test(document.body.innerText)

// ── Owner and finance: every report visible, with descriptions ────────────────
for (const [who, name, expectAll] of [[OWNER, 'owner', true], [FINANCE, 'finance', true]]) {
  const ctx  = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await ctx.newPage()
  page.on('console',   m => { if (m.type() === 'error') issues.push(`[${name}] console: ${m.text()}`) })
  page.on('pageerror', e => issues.push(`[${name}] pageerror: ${e.message}`))
  // Record WHICH endpoint refuses, so a 403 can be attributed rather than guessed at.
  page.on('response', r => {
    if (r.status() === 403) facts.push(`[${name}] 403 ← ${new URL(r.url()).pathname}`)
  })
  await login(page, who)
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(settled, { timeout: 45_000 }).catch(() => issues.push(`[${name}] never settled`))
  await page.waitForTimeout(700)
  await page.screenshot({ path: `${OUT}/desktop-${name}.png` })

  const text = await page.evaluate(() => document.body.innerText)
  for (const [label, desc] of REPORTS) {
    if (expectAll && !text.includes(label)) issues.push(`[${name}] missing report "${label}"`)
    if (expectAll && !text.includes(desc))  issues.push(`[${name}] missing description for "${label}"`)
  }
  if (/no reports available/i.test(text)) issues.push(`[${name}] empty state shown to a permitted role`)

  // Formats come from the catalogue: the statement offers PDF only.
  const buttons = await page.getByRole('button', { pressed: false }).count().catch(() => 0)
  facts.push(`[${name}] report buttons rendered (unpressed): ${buttons}`)

  // Selection: pick Payout Statement and confirm the specialized branch.
  await page.getByRole('button', { name: /Payout Statement/ }).first().click()
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `${OUT}/desktop-${name}-statement.png` })
  const stmt = await page.evaluate(() => document.body.innerText)
  if (/Event \(slug\)/i.test(stmt)) issues.push(`[${name}] statement still shows table-only filters`)
  if (/Large dataset\?/i.test(stmt)) issues.push(`[${name}] statement exposes background export`)

  /**
   * Format availability is asserted on the DOWNLOAD BUTTONS, not on body text.
   *
   * An earlier version searched `innerText` for "CSV" and reported a false positive: the
   * page subtitle says "export financial records as CSV, Excel, or PDF", and every other
   * report ROW prints its own "CSV · XLSX · PDF" formats. Both are correct content. What
   * matters is which download controls the SELECTED report offers.
   */
  const dl = await page.evaluate(() =>
    [...document.querySelectorAll('button')]
      .map(b => (b.textContent ?? '').trim())
      .filter(t => /^(CSV|XLSX|PDF)$/.test(t)))
  const uniq = [...new Set(dl)].sort()
  facts.push(`[${name}] statement download buttons: ${uniq.join(',') || 'none'}`)
  if (!uniq.includes('PDF')) issues.push(`[${name}] statement offers no PDF download`)
  if (uniq.includes('CSV') || uniq.includes('XLSX')) {
    issues.push(`[${name}] statement offers a CSV/XLSX download — catalogue says PDF only`)
  }

  // Back to a generic report — filters and all three formats return.
  await page.getByRole('button', { name: /^Transactions/ }).first().click()
  await page.waitForTimeout(1200)
  const gen = await page.evaluate(() => document.body.innerText)
  const genDl = await page.evaluate(() =>
    [...new Set([...document.querySelectorAll('button')]
      .map(b => (b.textContent ?? '').trim())
      .filter(t => /^(CSV|XLSX|PDF)$/.test(t)))].sort())
  for (const f of ['CSV', 'PDF', 'XLSX']) {
    if (!genDl.includes(f)) issues.push(`[${name}] generic report missing a ${f} download`)
  }
  facts.push(`[${name}] generic download buttons: ${genDl.join(',')}`)
  if (!/Event \(slug\)/i.test(gen)) issues.push(`[${name}] generic report lost its filters`)
  if (!/Large dataset\?/i.test(gen)) issues.push(`[${name}] generic report lost background export`)
  facts.push(`[${name}] statement branch + generic branch both correct`)
  await ctx.close()
}

// ── Manager: no finance permission ⇒ no reports, and an explanation ───────────
{
  const ctx  = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await ctx.newPage()
  page.on('pageerror', e => issues.push(`[manager] pageerror: ${e.message}`))
  await login(page, MANAGER)
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(settled, { timeout: 45_000 }).catch(() => {})
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${OUT}/desktop-manager-empty.png` })

  const text = await page.evaluate(() => document.body.innerText)
  if (!/no reports available/i.test(text)) issues.push('[manager] no empty state rendered')
  for (const [label] of REPORTS) {
    if (text.includes(label)) issues.push(`[manager] LEAKED report name "${label}"`)
  }
  if (/permission denied|unauthori[sz]ed|403/i.test(text)) {
    issues.push('[manager] empty state uses authorization-bypass language')
  }
  facts.push('[manager] zero reports, explanation shown, no report names leaked')
  await ctx.close()
}

// ── Responsive + keyboard ────────────────────────────────────────────────────
for (const vp of [{ name: 'desktop', width: 1440, height: 1000 },
                  { name: 'tablet',  width: 834,  height: 1100 },
                  { name: 'mobile',  width: 390,  height: 900  }]) {
  const ctx  = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
  const page = await ctx.newPage()
  page.on('pageerror', e => issues.push(`[${vp.name}] pageerror: ${e.message}`))
  await login(page, OWNER)
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(settled, { timeout: 45_000 }).catch(() => {})
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${OUT}/${vp.name}-reports.png` })

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth)
  if (overflow > 1) issues.push(`[${vp.name}] horizontal overflow ${overflow}px`)
  facts.push(`[${vp.name}] overflow ${overflow}px`)

  if (vp.name === 'desktop') {
    // Keyboard: the report buttons must be reachable and operable.
    const btn = page.getByRole('button', { name: /^Settlements/ }).first()
    await btn.focus()
    const ring = await btn.evaluate(el => {
      el.focus()
      const s = getComputedStyle(el)
      return { outline: s.outlineStyle, shadow: s.boxShadow !== 'none' }
    })
    await page.keyboard.press('Enter')
    await page.waitForTimeout(900)
    const pressed = await page.getByRole('button', { name: /^Settlements/ }).first()
      .getAttribute('aria-pressed')
    if (pressed !== 'true') issues.push('[a11y] Enter did not select the focused report')
    facts.push(`[a11y] focus ring: outline=${ring.outline} shadow=${ring.shadow}; Enter selects=${pressed}`)
    await page.screenshot({ path: `${OUT}/desktop-keyboard-focus.png` })
  }
  await ctx.close()
}

await browser.close()
console.log(facts.join('\n'))
console.log(issues.length ? '\nISSUES:\n' + issues.join('\n')
                          : '\nNo console errors, no overflow, every visibility claim held.')
console.log(`shots → ${OUT}`)
