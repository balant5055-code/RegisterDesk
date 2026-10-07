/* RD-ANALYTICS-12-11 — Reports History, in a real browser. EMULATOR ONLY.
 *
 * The claims are half positive and half negative. An owner must SEE their export history with
 * the right states; a manager must see NOTHING, and a hidden job's metadata must appear
 * nowhere — an absence that cannot be photographed. So every case is asserted against the
 * rendered text and the observed network traffic as well as captured.
 *
 * Assertions are scoped to the History LIST wherever a word could also legitimately appear in
 * the page chrome. RD-ANALYTICS-12-10's QA produced a false positive exactly that way.
 *
 *   node rd-analytics-12-11-shots.mjs
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE = process.env.RD_PROFILE_BASE_URL ?? 'http://localhost:3187'
const OWNER   = { email: 'profiling@registerdesk.test',   password: 'ProfilingPassw0rd!' }
const FINANCE = { email: 'finance.a11@registerdesk.test', password: 'FinancePassw0rd!' }
const MANAGER = { email: 'manager.a06@registerdesk.test', password: 'ManagerPassw0rd!' }
const OUT  = 'e2e/.shots/rd-analytics-12-11'
const PAGE = `${BASE}/dashboard/finance/reports`

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

/** The History list only — never the whole page. */
const listText = page => page.evaluate(() => {
  const ul = document.querySelector('ul.divide-y')
  return ul ? ul.innerText : ''
})

async function openHistory(page) {
  await page.getByRole('tab', { name: /History/ }).click()
  await page.waitForTimeout(1500)
}

// ── Owner: the full feed, every state ─────────────────────────────────────────
{
  const ctx  = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  const page = await ctx.newPage()
  const calls = []
  page.on('console',   m => { if (m.type() === 'error') issues.push(`[owner] console: ${m.text()}`) })
  page.on('pageerror', e => issues.push(`[owner] pageerror: ${e.message}`))
  page.on('request',  r => { if (r.url().includes('/api/organizer/reports/')) calls.push(`${r.method()} ${new URL(r.url()).pathname}${new URL(r.url()).search ? '?…' : ''}`) })
  page.on('response', r => { if (r.url().includes('/reports/history')) facts.push(`[owner] history ← ${r.status()}`) })

  await login(page, OWNER)
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(settled, { timeout: 45_000 }).catch(() => issues.push('[owner] never settled'))
  await page.waitForTimeout(800)

  // The Reports tab must still be the landing view and still work.
  const reportsText = await page.evaluate(() => document.body.innerText)
  if (!/Transactions/.test(reportsText)) issues.push('[owner] Reports discovery missing')
  if (!/Large dataset\?/.test(reportsText)) issues.push('[owner] background export panel missing')
  await page.screenshot({ path: `${OUT}/desktop-owner-reports.png`, fullPage: false })

  await openHistory(page)
  await page.screenshot({ path: `${OUT}/desktop-owner-history.png`, fullPage: false })

  const list = await listText(page)
  const rows = await page.locator('ul.divide-y > li').count()
  facts.push(`[owner] history rows on first page: ${rows}`)
  if (rows !== 25) issues.push(`[owner] expected a 25-row page, got ${rows}`)

  // Every seeded state must be visible and correctly labelled.
  const expect = [
    ['Transactions',    'the available row'],
    ['Settlements',     'the row created by the finance member'],
    ['Wallet Ledger',   'the expired-artifact row'],
    ['Donations',       'the failed row'],
    ['Refunds',         'the cancelled row'],
    ['GST Summary',     'the pending row'],
    ['Broadcast Usage', 'the processing row'],
  ]
  for (const [label, why] of expect) {
    if (!list.includes(label)) issues.push(`[owner] ${why} ("${label}") missing from History`)
  }
  for (const [state, why] of [
    ['Completed',        'completed'], ['Failed', 'failed'], ['Cancelled', 'cancelled'],
    ['Queued',           'pending'],   ['Generating', 'processing'],
    ['Download expired', 'the expired artifact'],
  ]) {
    if (!list.includes(state)) issues.push(`[owner] no "${state}" state rendered (${why})`)
  }
  if (!/by you/.test(list)) issues.push('[owner] createdByYou attribution not rendered')

  // A retired kind has no registry entry and therefore no permission to check — it must not
  // be listed at all.
  if (/legacy-attendance-report/.test(list)) issues.push('[owner] a retired-kind job was listed')

  // The raw stored failure message must never reach the browser.
  const whole = await page.evaluate(() => document.body.innerText)
  for (const leak of ['PERMISSION_DENIED', 'rd-prod', 'Missing index', 'reportExports/', 'text/csv']) {
    if (whole.includes(leak)) issues.push(`[owner] LEAKED "${leak}" into the page`)
  }

  // Download buttons appear only for downloadable rows.
  // `^\s*Download\s*$` and not `^Download$`: the button renders an icon before the word, so
  // its text content is " Download". The strict anchor matched nothing and the first run of
  // this script died on it rather than reporting a false result — but it also must not match
  // the "Download expired" LABEL, which is why the anchors stay.
  const DL = /^\s*Download\s*$/
  const dlButtons = await page.locator('ul.divide-y button', { hasText: DL }).count()
  const expiredLabels = await page.locator('ul.divide-y', { hasText: 'Download expired' }).count()
  facts.push(`[owner] download buttons: ${dlButtons}; expired labels present: ${expiredLabels > 0}`)
  if (dlButtons < 1) issues.push('[owner] no download button on any completed row')

  // Load more → a second page, via a cursor.
  const more = page.getByRole('button', { name: /Load more/ })
  if (await more.count() === 0) {
    issues.push('[owner] no "Load more" despite 38 seeded jobs')
  } else {
    await more.click()
    await page.waitForTimeout(1500)
    const after = await page.locator('ul.divide-y > li').count()
    facts.push(`[owner] rows after Load more: ${after}`)
    if (after <= rows) issues.push('[owner] "Load more" added no rows')
    await page.screenshot({ path: `${OUT}/desktop-owner-history-page2.png` })
  }

  // THE DEFECT THIS PHASE EXISTS FOR: a refresh must not lose the history.
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(settled, { timeout: 45_000 }).catch(() => {})
  await openHistory(page)
  const afterReload = await page.locator('ul.divide-y > li').count()
  facts.push(`[owner] rows after a full page reload: ${afterReload}`)
  if (afterReload < 25) issues.push('[owner] history did not survive a refresh')

  // Clicking Download must hit the EXISTING export download route, not a new one.
  const before = calls.length
  try {
    await page.locator('ul.divide-y button', { hasText: DL }).first().click({ timeout: 15_000 })
    await page.waitForTimeout(2500)
  } catch (e) {
    issues.push(`[owner] could not click a Download button: ${e.message.split('\n')[0]}`)
  }
  const hit = calls.slice(before).find(c => /exports\/.+\/download/.test(c))
  facts.push(`[owner] download click → ${hit ?? 'NO REQUEST'}`)
  if (!hit) issues.push('[owner] Download did not call the existing export download route')

  facts.push(`[owner] report API calls observed: ${[...new Set(calls)].join(' | ')}`)
  await ctx.close()
}

// ── Finance: same feed, and the row it did not create ─────────────────────────
{
  const ctx  = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  const page = await ctx.newPage()
  page.on('pageerror', e => issues.push(`[finance] pageerror: ${e.message}`))
  await login(page, FINANCE)
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(settled, { timeout: 45_000 }).catch(() => {})
  await openHistory(page)
  await page.screenshot({ path: `${OUT}/desktop-finance-history.png` })

  const rows = await page.locator('ul.divide-y > li').count()
  const list = await listText(page)
  facts.push(`[finance] history rows: ${rows}`)
  if (rows === 0) issues.push('[finance] a finance member sees no history at all')
  // The Settlements row was created BY this user; the Transactions rows were not.
  if (!/Settlements/.test(list)) issues.push('[finance] the settlements export is missing')
  await ctx.close()
}

// ── Manager: no finance permission ⇒ no History tab, no rows, no names ────────
{
  const ctx  = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  const page = await ctx.newPage()
  page.on('pageerror', e => issues.push(`[manager] pageerror: ${e.message}`))
  await login(page, MANAGER)
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(settled, { timeout: 45_000 }).catch(() => {})
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${OUT}/desktop-manager-empty.png` })

  const text = await page.evaluate(() => document.body.innerText)
  if (!/no reports available/i.test(text)) issues.push('[manager] empty state missing')
  const tabs = await page.getByRole('tab').count()
  facts.push(`[manager] tabs rendered: ${tabs} (expected 0)`)
  if (tabs !== 0) issues.push('[manager] a History tab was offered to a caller with no reports')

  for (const label of ['Transactions', 'Settlements', 'Wallet Ledger', 'Donations',
                       'Refunds', 'Broadcast Usage', 'GST Summary', 'Payout Statement']) {
    if (text.includes(label)) issues.push(`[manager] LEAKED report name "${label}"`)
  }
  // And nothing from the seeded jobs.
  for (const leak of ['rex_seed', 'Download expired', 'Cancelled', 'by you']) {
    if (text.includes(leak)) issues.push(`[manager] LEAKED job metadata "${leak}"`)
  }

  // Even called directly, the endpoint must answer nothing to this caller.
  const direct = await page.evaluate(async () => {
    const res = await fetch('/api/organizer/reports/history', { cache: 'no-store' })
    return { status: res.status, body: (await res.text()).slice(0, 300) }
  })
  facts.push(`[manager] direct GET /reports/history (no auth header) → ${direct.status}`)
  if (/transactions|settlements|rex_seed/i.test(direct.body)) {
    issues.push('[manager] the endpoint returned report metadata to an unauthorized caller')
  }
  await ctx.close()
}

// ── Responsive + keyboard ────────────────────────────────────────────────────
for (const vp of [{ name: 'desktop', width: 1440, height: 1100 },
                  { name: 'tablet',  width: 834,  height: 1100 },
                  { name: 'mobile',  width: 390,  height: 900  }]) {
  const ctx  = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
  const page = await ctx.newPage()
  page.on('pageerror', e => issues.push(`[${vp.name}] pageerror: ${e.message}`))
  await login(page, OWNER)
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(settled, { timeout: 45_000 }).catch(() => {})
  await openHistory(page)
  await page.screenshot({ path: `${OUT}/${vp.name}-history.png` })

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth)
  if (overflow > 1) issues.push(`[${vp.name}] horizontal overflow ${overflow}px`)

  // The action on each row must stay reachable, not clipped off the edge.
  const reachable = await page.evaluate(() => {
    const li = document.querySelector('ul.divide-y > li')
    if (!li) return null
    const btn = li.querySelector('button') ?? li.lastElementChild
    if (!btn) return null
    const r = btn.getBoundingClientRect()
    return r.right <= document.documentElement.clientWidth + 1 && r.width > 0
  })
  /**
   * Report names must not be CLIPPED, which is different from the page not overflowing.
   *
   * At 390px the first version of this list passed both checks above and still rendered
   * "Transacti…" — the text block had shrunk to make room for the status pill and the
   * Download button, and `truncate` did the rest. Only rows WITH a download button were
   * affected, so the defect was invisible in a row-count or an overflow number. This
   * compares each title's scrollWidth to its clientWidth, which is what truncation is.
   */
  const clipped = await page.evaluate(() =>
    [...document.querySelectorAll('ul.divide-y > li')]
      .map(li => li.querySelector('p'))
      .filter(Boolean)
      .filter(p => p.scrollWidth > p.clientWidth + 1)
      .map(p => p.innerText.trim().slice(0, 40)))
  facts.push(`[${vp.name}] overflow ${overflow}px; row action reachable: ${reachable}; clipped titles: ${clipped.length}`)
  if (reachable === false) issues.push(`[${vp.name}] the row action is clipped`)
  if (clipped.length) issues.push(`[${vp.name}] ${clipped.length} report name(s) truncated, e.g. "${clipped[0]}"`)

  if (vp.name === 'desktop') {
    // Keyboard: the tabs must be reachable and operable.
    const tab = page.getByRole('tab', { name: /Reports/ }).first()
    await tab.focus()
    const ring = await tab.evaluate(el => {
      el.focus()
      const s = getComputedStyle(el)
      return { outline: s.outlineStyle, shadow: s.boxShadow !== 'none' }
    })
    await page.keyboard.press('Enter')
    await page.waitForTimeout(800)
    const selected = await page.getByRole('tab', { name: /Reports/ }).first().getAttribute('aria-selected')
    if (selected !== 'true') issues.push('[a11y] Enter did not activate the focused tab')
    facts.push(`[a11y] tab focus ring: outline=${ring.outline} shadow=${ring.shadow}; Enter selects=${selected}`)
    await page.screenshot({ path: `${OUT}/desktop-keyboard-tab.png` })
  }
  await ctx.close()
}

await browser.close()
console.log(facts.join('\n'))
console.log(issues.length ? '\nISSUES:\n' + issues.join('\n')
                          : '\nNo console errors, no overflow, every visibility claim held.')
console.log(`shots → ${OUT}`)
