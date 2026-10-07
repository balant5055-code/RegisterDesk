/* RD-ANALYTICS-11 — the Communications module, in a real browser. EMULATOR ONLY.
 *
 * Most of what this module has to get right is an ABSENCE, and an absence cannot be
 * photographed: a channel with no transport must not show a zero, a rate with no confirmed
 * outcomes must not show 0%, a caller without `transactions` must not see a rupee. So every
 * case is asserted against the rendered text as well as captured.
 *
 *   node rd-analytics-11-shots.mjs
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE  = process.env.RD_PROFILE_BASE_URL ?? 'http://localhost:3187'
const OWNER   = { email: process.env.RD_PROFILE_EMAIL ?? 'profiling@registerdesk.test',
                  password: process.env.RD_PROFILE_PASSWORD ?? 'ProfilingPassw0rd!' }
const MANAGER = { email: 'manager.a06@registerdesk.test',  password: 'ManagerPassw0rd!'  }
const FINANCE = { email: 'finance.a11@registerdesk.test',  password: 'FinancePassw0rd!'  }
const STAFF   = { email: 'staff.a08@registerdesk.test',    password: 'StaffPassw0rd!'    }
const OUT = 'e2e/.shots/rd-analytics-11'

/** [draftId, eventId, shape] */
const SCENARIOS = [
  ['a11-email-heavy-draft',    'a11-email-heavy',    'email only, healthy'],
  ['a11-whatsapp-heavy-draft', 'a11-whatsapp-heavy', 'whatsapp, unknowns + rejections'],
  ['a11-mixed-draft',          'a11-mixed',          'both channels, over the read cap'],
  ['a11-quiet-draft',          'a11-quiet',          'never sent anything'],
  ['a11-thin-webhook-draft',   'a11-thin-webhook',   '5,000 sent, 4 outcomes confirmed'],
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
  /messages sent|select a single event|could not load|not available/i.test(document.body.innerText)

/**
 * Photograph the FOOT of the module.
 *
 * Reminders, certificates, messaging spend and the trust notice all sit below the fold at
 * 1000px. `fullPage` is not the answer — it composites a view no user ever sees — and
 * `window.scrollTo` does nothing here, because the dashboard shell scrolls an inner
 * container rather than the document. Scrolling the last element into view works whichever
 * container owns the scrollbar.
 */
async function toBottom(page, path) {
  await page.getByText(/what these numbers do and do not cover/i).first()
            .scrollIntoViewIfNeeded({ timeout: 10_000 })
            .catch(() => {})
  await page.waitForTimeout(350)
  await page.screenshot({ path })
}

/** `innerText` is CSS-uppercased in places, so every probe here is case-insensitive. */
const num = (text, label) =>
  text.match(new RegExp(`${label}\\s*\\n\\s*([\\d,]+)`, 'i'))?.[1]?.replace(/,/g, '')

// ── The five communication shapes, as the owner ───────────────────────────────
{
  const ctx  = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await ctx.newPage()
  page.on('console',   m => { if (m.type() === 'error') issues.push(`console: ${m.text()}`) })
  page.on('pageerror', e => issues.push(`pageerror: ${e.message}`))
  await login(page, OWNER)

  for (const [draftId, , shape] of SCENARIOS) {
    await page.goto(`${BASE}/dashboard/analytics/communications?eventId=${draftId}`,
                    { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(settled, { timeout: 45_000 })
      .catch(() => issues.push(`${draftId}: never settled`))
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${OUT}/desktop-${draftId}.png` })
    await toBottom(page, `${OUT}/desktop-${draftId}-bottom.png`)
    const text = await page.evaluate(() => document.body.innerText)

    if (/select a single event/i.test(text)) {
      issues.push(`${draftId}: the event selector never resolved it — module not rendered`)
      continue
    }

    // ── Universal, on every event ──
    // SMS and Push are unsupported everywhere, and must never render a figure.
    for (const chan of ['SMS', 'Push']) {
      if (!new RegExp(`${chan}[\\s\\S]{0,200}not available on this platform`, 'i').test(text)) {
        issues.push(`${draftId}: ${chan} is not declared unsupported`)
      }
      if (new RegExp(`${chan}[\\s\\S]{0,120}?\\bSent\\b\\s*\\n\\s*0\\b`, 'i').test(text)) {
        issues.push(`${draftId}: ${chan} renders a ZERO, which claims none were sent`)
      }
    }
    // The unknown bucket is its own KPI, never folded into failed.
    if (!/unknown/i.test(text)) issues.push(`${draftId}: no Unknown figure on screen`)
    if (!/send timed out/i.test(text)) issues.push(`${draftId}: Unknown is not defined on screen`)
    if (!/excludes timeouts/i.test(text)) issues.push(`${draftId}: Failed does not disclaim timeouts`)
    // Engagement metrics are absent BY EXPLANATION, never silently.
    if (!/opens and clicks are not/i.test(text)) issues.push(`${draftId}: no engagement disclosure`)
    if (/open rate|click rate|click-through/i.test(text)) {
      issues.push(`${draftId}: an engagement metric is on screen and cannot be measured`)
    }
    // Reminders are execution, not delivery.
    if (/reminder delivery rate/i.test(text)) issues.push(`${draftId}: a reminder DELIVERY rate`)

    // ── Per-scenario ──
    const sent = num(text, 'Messages sent')
    facts.push(`${draftId.padEnd(28)} ${shape.padEnd(34)} sent=${sent ?? '—'}`)

    if (draftId === 'a11-quiet-draft') {
      // A measured zero, and no rate offered over an empty divisor.
      if (sent !== '0') issues.push(`quiet: Messages sent is "${sent}", expected a measured 0`)
      if (!/no email messages have been sent/i.test(text)) {
        issues.push('quiet: the silent state is not stated in words')
      }
      if (/\b\d+%/.test(text.split(/channel/i)[0] ?? '')) {
        issues.push('quiet: a percentage is shown with nothing to take it against')
      }
    }

    if (draftId === 'a11-thin-webhook-draft') {
      // The point of the whole rate model: 100% delivery over 4 outcomes out of 5,000.
      const m = text.match(/delivery rate\s*\n\s*(\d+)%\s*\n\s*of\s+([\d,]+)\s+messages with a confirmed outcome/i)
      if (!m) issues.push('thin webhook: delivery rate is not printed with its denominator')
      else {
        facts.push(`thin webhook: delivery ${m[1]}% over a denominator of ${m[2]}`)
        if (Number(m[2].replace(/,/g, '')) > 100) {
          issues.push(`thin webhook: denominator ${m[2]} — the fixture did not load as intended`)
        }
      }
      // The denominator is NAMED, not asserted as the count: "of 5,000 messages sent".
      if (!/unconfirmed\s*\n\s*\d+%\s*\n\s*of\s+[\d,]+\s+messages sent/i.test(text)) {
        issues.push('thin webhook: the unconfirmed share is not published beside the rate')
      }
    }

    if (draftId === 'a11-whatsapp-heavy-draft') {
      // 180 timeouts must NOT be inside the failure count (70 rejections).
      const failed  = num(text, 'Failed')
      const unknown = num(text, 'Unknown')
      facts.push(`whatsapp-heavy: failed=${failed} unknown=${unknown}`)
      if (unknown === '0' || unknown == null) issues.push('whatsapp-heavy: no unknown messages surfaced')
      if (failed && unknown && Number(failed) >= Number(failed) + Number(unknown)) {
        issues.push('whatsapp-heavy: failed appears to include the timeouts')
      }
      if (failed === '250') issues.push('whatsapp-heavy: failed is 70+180 — timeouts counted as rejections')
    }

    if (draftId === 'a11-mixed-draft') {
      /**
       * Over the cap: the COUNTS stay exact (aggregates) while the breakdown withdraws.
       *
       * 5,200 rows are seeded, of which 80 are `skipped` — never attempted, so never in
       * "Messages sent". 5,120 is therefore the correct figure AND still past the old
       * 5,000-row bound, which is what this case exists to prove.
       */
      if (!sent || Number(sent) < 5_000) {
        issues.push(`mixed: Messages sent is "${sent}" — an aggregate should exceed the 5,000 cap`)
      } else facts.push(`mixed: ${sent} messages counted past the old 5,000 cap`)
      if (!/per-template breakdown exceeded its read limit/i.test(text)) {
        issues.push('mixed: the truncated breakdown is not disclosed')
      }
    }
  }
  await ctx.close()
}

// ── Responsive: the richest case at three viewports ───────────────────────────
for (const vp of [{ name: 'desktop', width: 1440, height: 1000 },
                  { name: 'tablet',  width: 834,  height: 1100 },
                  { name: 'mobile',  width: 390,  height: 900  }]) {
  const ctx  = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
  const page = await ctx.newPage()
  page.on('pageerror', e => issues.push(`[${vp.name}] pageerror: ${e.message}`))
  await login(page, OWNER)

  for (const draftId of ['a11-mixed-draft', 'a11-whatsapp-heavy-draft']) {
    await page.goto(`${BASE}/dashboard/analytics/communications?eventId=${draftId}`,
                    { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(settled, { timeout: 45_000 }).catch(() => {})
    await page.waitForTimeout(500)
    await page.screenshot({ path: `${OUT}/${vp.name}-${draftId}.png` })
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth)
    if (overflow > 1) issues.push(`[${vp.name}] ${draftId}: horizontal overflow ${overflow}px`)
  }
  await ctx.close()
}

// ── Date presets ──────────────────────────────────────────────────────────────
{
  const ctx  = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await ctx.newPage()
  page.on('pageerror', e => issues.push(`pageerror: ${e.message}`))
  await login(page, OWNER)

  for (const preset of ['7D', '30D', '90D']) {
    await page.goto(`${BASE}/dashboard/analytics/communications?eventId=a11-mixed-draft`,
                    { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(settled, { timeout: 45_000 }).catch(() => {})
    await page.getByRole('group', { name: 'Date range' })
              .getByRole('button', { name: preset }).click()
    await page.waitForTimeout(1_100)
    await page.screenshot({ path: `${OUT}/desktop-preset-${preset}.png` })
    const text = await page.evaluate(() => document.body.innerText)
    // The communication totals are event-total, not windowed — the page must not imply
    // otherwise by silently changing them when the range changes.
    facts.push(`preset ${preset}: sent=${num(text, 'Messages sent')}`)
    if (/could not load/i.test(text)) issues.push(`preset ${preset}: the module failed to load`)
  }
  await ctx.close()
}

/**
 * The financial boundary: three callers, three outcomes.
 *
 * ═══ WHY THERE IS NO "MANAGER WITH TRANSACTIONS" ═════════════════════════════
 * `ROLE_PERMISSIONS` grants `transactions` to `owner` and `finance` only, and `finance` does
 * NOT hold `events` — so it cannot open the analytics workspace at all and the endpoint
 * answers 403 before any money question is asked. The owner is therefore the only caller in
 * this product who can see messaging spend. `finance` is still exercised here, because the
 * useful assertion is that its 403 comes from the ROUTE rather than from the spend gate
 * silently doing authorization work of its own.
 */
for (const [who, name, expectSpend] of [[OWNER, 'owner', true],
                                        [MANAGER, 'manager-no-transactions', false],
                                        [FINANCE, 'finance-no-events', false]]) {
  const ctx  = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await ctx.newPage()
  let bearer = null
  page.on('request', r => {
    const h = r.headers()['authorization']
    if (!bearer && h?.startsWith('Bearer ') && r.url().includes('/api/')) bearer = h
  })
  page.on('pageerror', e => issues.push(`[${name}] pageerror: ${e.message}`))
  await login(page, who)
  await page.goto(`${BASE}/dashboard/analytics/communications?eventId=a11-mixed-draft`,
                  { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(settled, { timeout: 45_000 }).catch(() => {})
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${OUT}/desktop-role-${name}.png` })
  // Spend sits at the foot of the page — the half of the boundary claim that is visual.
  await toBottom(page, `${OUT}/desktop-role-${name}-bottom.png`)

  const text = await page.evaluate(() => document.body.innerText)
  const hasMoney = /₹/.test(text)
  facts.push(`[${name}] spend on screen: ${hasMoney}`)

  if (expectSpend && !hasMoney) issues.push(`[${name}] holds transactions but sees no spend`)
  if (!expectSpend && hasMoney) issues.push(`[${name}] SEES MONEY without transactions`)

  // The delivery figures are operational and must reach a caller without `transactions`.
  if (name.startsWith('manager') && !/messages sent/i.test(text)) {
    issues.push('[manager] operational communication figures were withheld with the money')
  }

  // …and the payload itself, not just the screen.
  const probe = bearer
    ? await page.request
        .get(`${BASE}/api/organizer/analytics/overview/a11-mixed?preset=30d`,
             { headers: { Authorization: bearer } })
        .then(async r => ({ status: r.status(), body: await r.text() }))
        .catch(e => ({ status: null, body: String(e) }))
    : { status: null, body: '' }
  facts.push(`[${name}] payload probe: ${probe.status}`)
  // `finance` lacks `events`, so the ROUTE refuses it — the spend gate is never consulted.
  if (name === 'finance-no-events' && probe.status !== 403) {
    issues.push(`[finance] endpoint answered ${probe.status}, expected 403 (no \`events\`)`)
  }
  if (!expectSpend && probe.status === 200) {
    for (const p of [/"spend"/, /Paise/, /profitEstimate/]) {
      if (p.test(probe.body)) issues.push(`[${name}] PAYLOAD leaked ${p}`)
    }
  }
  await ctx.close()
}

// ── checkin_staff must not reach the module at all ────────────────────────────
{
  const ctx  = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await ctx.newPage()
  let bearer = null
  page.on('request', r => {
    const h = r.headers()['authorization']
    if (!bearer && h?.startsWith('Bearer ') && r.url().includes('/api/')) bearer = h
  })
  await login(page, STAFF)
  await page.goto(`${BASE}/dashboard/analytics/communications?eventId=a11-mixed-draft`,
                  { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3_000)
  await page.screenshot({ path: `${OUT}/desktop-role-checkin-staff.png` })
  const text = await page.evaluate(() => document.body.innerText)
  if (/messages sent|delivery rate/i.test(text)) {
    issues.push('[checkin_staff] communication figures rendered for a gate-only role')
  }
  const probe = bearer
    ? await page.request
        .get(`${BASE}/api/organizer/analytics/overview/a11-mixed?preset=30d`,
             { headers: { Authorization: bearer } })
        .then(r => r.status()).catch(() => null)
    : null
  facts.push(`[checkin_staff] payload probe: ${probe}`)
  if (probe !== 403) issues.push(`[checkin_staff] endpoint answered ${probe}, expected 403`)
  await ctx.close()
}

// ── An unauthenticated visitor ────────────────────────────────────────────────
{
  const ctx  = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await ctx.newPage()
  await page.goto(`${BASE}/dashboard/analytics/communications?eventId=a11-mixed-draft`,
                  { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3_000)
  await page.screenshot({ path: `${OUT}/desktop-unauthorized.png` })
  const text = await page.evaluate(() => document.body.innerText)
  if (/messages sent|delivery rate/i.test(text)) {
    issues.push('unauthorized: communication figures rendered for a signed-out visitor')
  }
  const anon = await page.request
    .get(`${BASE}/api/organizer/analytics/overview/a11-mixed?preset=30d`)
    .then(r => r.status()).catch(() => null)
  facts.push(`unauthorized: anon probe ${anon} · url ${page.url().includes('/login') ? 'login' : page.url()}`)
  if (anon !== 401 && anon !== 403) issues.push(`unauthorized: the endpoint answered ${anon}`)
  await ctx.close()
}

await browser.close()
console.log(facts.join('\n'))
console.log(issues.length ? '\nISSUES:\n' + issues.join('\n')
                          : '\nNo console errors, no overflow, every communication claim held.')
console.log(`shots → ${OUT}`)
