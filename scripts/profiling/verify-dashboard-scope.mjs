/* RD-DASHBOARD-05 — real-browser verification that the Dashboard follows the Event Selector.
 *
 *   npm run emu:seed
 *   dotenv -e .env.emulator -- node scripts/emulator/seed-dashboard-scope.mjs
 *   dotenv -e .env.emulator -- node scripts/profiling/verify-dashboard-scope.mjs
 *
 * ═══ WHY A BROWSER AND NOT A UNIT TEST ═══════════════════════════════════════
 * Every unit assertion about scope is about SOURCE. None of them can tell you whether the
 * numbers on screen actually change when you switch events — which is the only question
 * that matters here, and precisely the one a green source-shaped suite is worst at
 * answering. So this drives the real page against the real API against the emulator, reads
 * the rendered text, and compares.
 *
 * It PROVES rather than illustrates: it fails loudly if event B shows event A's figures.
 * Screenshots are written for the visual pass; the assertions are what gate the change.
 */
import { chromium } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'

const BASE     = process.env.RD_PROFILE_BASE_URL ?? 'http://localhost:3187'
const EMAIL    = process.env.RD_PROFILE_EMAIL
const PASSWORD = process.env.RD_PROFILE_PASSWORD
const OUT      = 'e2e/.shots/dashboard-scope'

// Must match scripts/emulator/seed-dashboard-scope.mjs exactly.
const A = {
  id: 'scope-event-coastal', name: 'Coastal Marathon 2026',
  registrations: 420, revenue: '6,93,000',
  emailsToday: 31, emailsFailedToday: 4, campaigns: 5, passes: ['10K Run', 'Half Marathon'],
}
const B = {
  id: 'scope-event-hilltrail', name: 'Hill Trail Run 2026',
  registrations: 37, revenue: '26,640',
  emailsToday: 6, emailsFailedToday: 1, campaigns: 2, passes: ['5K Trail', '12K Trail'],
}
const DRAFT = { id: 'scope-event-draft', name: 'Monsoon 10K 2027' }

const failures = []
const checks   = []
const check = (ok, label, detail = '') => {
  checks.push({ ok, label, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/** Text of the whole dashboard, normalised so a line break cannot fail a comparison. */
const bodyText = page => page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))

async function selectEvent(page, name) {
  await page.getByRole('button', { name: /change event|select an event/i }).click()
  await page.getByRole('option', { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') })
    .or(page.getByRole('button', { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }))
    .first().click()
  // The page shows a skeleton while the new event loads. Waiting for the event's own name
  // in the header badge is what proves the SWITCH completed rather than the click landing.
  await page.waitForFunction(
    n => !/Loading .*…/.test(document.body.innerText) && document.body.innerText.includes(n),
    name, { timeout: 30_000 },
  )
  await page.waitForTimeout(600)   // let the rise animation settle before capturing
}

async function run() {
  mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch()
  const ctx  = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()

  const consoleErrors = []
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`))

  // Count dashboard requests, to prove the "wait for the selector" rule saves a read.
  const dashboardCalls = []
  let authHeader = null
  page.on('request', r => {
    if (!r.url().includes('/api/organizer/dashboard')) return
    dashboardCalls.push(r.url())
    // Kept so the payload-level checks below can call the API with the SAME credential the
    // page used, rather than minting a second one.
    authHeader ??= r.headers()['authorization'] ?? null
  })

  console.log(`\nSigning in at ${BASE}`)
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.locator('#login-email').fill(EMAIL)
  await page.locator('#login-password').fill(PASSWORD)
  await page.getByRole('button', { name: /sign in to dashboard/i }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 30_000 })
  await page.waitForFunction(() => !/Loading /.test(document.body.innerText), undefined, { timeout: 30_000 })
  await page.waitForTimeout(800)

  // ── Event A ────────────────────────────────────────────────────────────────
  console.log(`\n── ${A.name} ──`)
  await selectEvent(page, A.name)
  const textA = await bodyText(page)
  await page.screenshot({ path: `${OUT}/A-${A.registrations}.png` })
  await page.screenshot({ path: `${OUT}/A-${A.registrations}-full.png`, fullPage: true })

  check(textA.includes(A.name), 'header names the selected event', A.name)
  check(textA.includes(A.registrations.toLocaleString('en-IN')), 'registrations are event A’s', String(A.registrations))
  check(textA.includes(A.revenue), 'revenue is event A’s', `₹${A.revenue}`)
  check(!textA.includes(B.name) || textA.indexOf(B.name) > textA.indexOf('Event performance'),
        'event B appears only inside the cross-event comparison')

  // ── Event B ────────────────────────────────────────────────────────────────
  console.log(`\n── ${B.name} ──`)
  const callsBefore = dashboardCalls.length
  await selectEvent(page, B.name)
  const textB = await bodyText(page)
  await page.screenshot({ path: `${OUT}/B-${B.registrations}.png` })
  await page.screenshot({ path: `${OUT}/B-${B.registrations}-full.png`, fullPage: true })

  check(textB.includes(B.name), 'header names the newly selected event', B.name)
  check(textB.includes(String(B.registrations)), 'registrations are event B’s', String(B.registrations))
  check(textB.includes(B.revenue), 'revenue is event B’s', `₹${B.revenue}`)

  // ── THE CENTRAL ASSERTION ──────────────────────────────────────────────────
  // Event A's figures must be GONE. This is the one check that distinguishes a working
  // scope from a page that merely relabels its heading.
  //
  // Event Performance is EXCLUDED, and deliberately: it is the documented cross-event
  // exception, so event A's total appearing there is the feature working, not leaking.
  // Excluding it by DOM subtree rather than by string means the exclusion cannot quietly
  // swallow a genuine leak elsewhere on the page.
  const outsideComparison = await page.evaluate(() => {
    const clone = document.body.cloneNode(true)
    for (const s of clone.querySelectorAll('section, div')) {
      if (/^Event performance/.test(s.innerText ?? '')) s.remove()
    }
    return clone.innerText.replace(/\s+/g, ' ')
  })
  check(!outsideComparison.includes(A.registrations.toLocaleString('en-IN')),
        'event A’s registration total is GONE everywhere except the cross-event chart',
        `looked for ${A.registrations}`)
  check(!textB.includes(A.revenue), 'event A’s revenue is GONE after the switch', `looked for ₹${A.revenue}`)
  check(textA !== textB, 'the page genuinely changed, it did not just relabel')

  // The switch issued exactly one new dashboard request.
  const newCalls = dashboardCalls.slice(callsBefore)
  check(newCalls.length === 1, 'an event switch costs exactly ONE dashboard read', `${newCalls.length} request(s)`)
  check(newCalls.every(u => u.includes('eventId=')), 'the request carries the selected event id')

  // ── Workspace-level sections must be LABELLED, not silently mixed in ───────
  check(/All events/.test(textB), 'workspace-level sections carry an "All events" pill')
  check(/compared across all your events/i.test(textB),
        'Event Performance declares itself the cross-event exception')

  // ── Show / hide sections ───────────────────────────────────────────────────
  console.log('\n── Customise ──')
  await page.getByRole('button', { name: /customise/i }).click()
  await page.getByRole('menuitemcheckbox', { name: /coupon performance/i }).click()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  const afterHide = await bodyText(page)
  check(!afterHide.includes('Coupon performance'), 'hiding a section removes it from the page')
  check(/1 hidden/.test(afterHide), 'the hidden count is surfaced, so it reads as a choice')
  await page.screenshot({ path: `${OUT}/C-section-hidden-full.png`, fullPage: true })

  // The lower half of the page, as a VIEWPORT capture. A tall fullPage PNG is downscaled
  // for review to the point where a scope pill is unreadable, so the sections that carry
  // those pills get their own shot at real size.
  await page.evaluate(() => document.querySelector('#main-content')?.scrollTo(0, 1400))
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${OUT}/D-lower.png` })
  await page.evaluate(() => document.querySelector('#main-content')?.scrollTo(0, 2600))
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${OUT}/E-lower.png` })

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !/Loading /.test(document.body.innerText), undefined, { timeout: 30_000 })
  await page.waitForTimeout(800)
  const afterReload = await bodyText(page)
  check(!afterReload.includes('Coupon performance'), 'the preference SURVIVES a reload')

  await page.getByRole('button', { name: /customise/i }).click()
  await page.getByRole('button', { name: /show all sections/i }).click()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  check((await bodyText(page)).includes('Coupon performance'), 'reset restores every section')

  // ═══ SECTION-BY-SECTION DATA ISOLATION ═════════════════════════════════════
  //
  // Read STRAIGHT FROM THE API rather than the rendered page. The DOM proves what an
  // organizer sees; the payload proves what each individual section was actually given,
  // which is the only way to tell "Pass Distribution is scoped" from "Pass Distribution
  // happens to look right because the page re-rendered".
  console.log('\n── Section isolation (API payloads) ──')

  // The token is LIFTED from a request the page already made, rather than re-authenticating
  // or reaching into Firebase internals from page context. It is the same credential the
  // real dashboard used, so these calls exercise the identical authorization path.
  if (!authHeader) throw new Error('No dashboard request was observed — cannot call the API.')

  const api = (eventId) => page.evaluate(async ({ id, auth }) => {
    const url = id ? `/api/organizer/dashboard?eventId=${encodeURIComponent(id)}` : '/api/organizer/dashboard'
    const res = await fetch(url, { headers: { Authorization: auth }, cache: 'no-store' })
    return { status: res.status, body: await res.json().catch(() => null) }
  }, { id: eventId, auth: authHeader })

  const [pa, pb, pAll, pDraft] = [await api(A.id), await api(B.id), await api(null), await api(DRAFT.id)]

  const ok = (r) => r.status === 200 && r.body
  check(ok(pa) && ok(pb) && ok(pAll) && ok(pDraft),
    'all four scopes return 200',
    `A=${pa.status} B=${pb.status} all=${pAll.status} draft=${pDraft.status}`)

  if (ok(pa) && ok(pb) && ok(pAll) && ok(pDraft)) {
    // ── Pass Distribution — selected event only ──
    const passLabels = (p) => p.body.passDistribution.map(r => r.label)
    check(A.passes.every(n => passLabels(pa).includes(n)) && !passLabels(pa).some(n => B.passes.includes(n)),
      'Pass Distribution · A holds only A’s passes', passLabels(pa).join(', '))
    check(B.passes.every(n => passLabels(pb).includes(n)) && !passLabels(pb).some(n => A.passes.includes(n)),
      'Pass Distribution · B holds only B’s passes', passLabels(pb).join(', '))

    // ── Registration Status — selected event only ──
    check(pa.body.registrationTotals.confirmed === A.registrations,
      'Registration Status · A confirmed', String(pa.body.registrationTotals.confirmed))
    check(pb.body.registrationTotals.confirmed === B.registrations,
      'Registration Status · B confirmed', String(pb.body.registrationTotals.confirmed))
    check(pAll.body.registrationTotals.confirmed === A.registrations + B.registrations,
      'Registration Status · All Events is the SUM',
      `${pAll.body.registrationTotals.confirmed} vs ${A.registrations + B.registrations}`)

    // ── Recent Activity — selected event only ──
    const feedEvents = (p) => [...new Set(p.body.activity.map(a => a.eventName).filter(Boolean))]
    check(feedEvents(pa).every(n => n === A.name), 'Recent Activity · A only', feedEvents(pa).join(', ') || 'empty')
    check(feedEvents(pb).every(n => n === B.name), 'Recent Activity · B only', feedEvents(pb).join(', ') || 'empty')

    // ── Communication Usage — NOW event-scoped ──
    check(pa.body.communications.emailsSentToday === A.emailsToday,
      'Communication Usage · A emails today', String(pa.body.communications.emailsSentToday))
    check(pb.body.communications.emailsSentToday === B.emailsToday,
      'Communication Usage · B emails today', String(pb.body.communications.emailsSentToday))
    check(pa.body.communications.emailsFailedToday === A.emailsFailedToday &&
          pb.body.communications.emailsFailedToday === B.emailsFailedToday,
      'Communication Usage · failed counts scope too',
      `A=${pa.body.communications.emailsFailedToday} B=${pb.body.communications.emailsFailedToday}`)
    check(pa.body.communications.campaignsSent === A.campaigns &&
          pb.body.communications.campaignsSent === B.campaigns,
      'Communication Usage · campaigns scope too',
      `A=${pa.body.communications.campaignsSent} B=${pb.body.communications.campaignsSent}`)
    check(pAll.body.communications.emailsSentToday === A.emailsToday + B.emailsToday,
      'Communication Usage · All Events is workspace-wide',
      String(pAll.body.communications.emailsSentToday))
    check(!pa.body.scope.workspaceOnly.includes('communications'),
      'Communication Usage · no longer labelled workspace-only')

    // ── Finance Summary — selected event only, when permitted ──
    check(pa.body.finance.allowed && pb.body.finance.allowed, 'Finance · owner is permitted')
    check(pa.body.overview.totalRevenuePaise === 420 * 1_65_000 &&
          pb.body.overview.totalRevenuePaise === 37 * 72_000,
      'Finance · ticket revenue is event-scoped',
      `A=${pa.body.overview.totalRevenuePaise} B=${pb.body.overview.totalRevenuePaise}`)
    // RD-DASHBOARD-09: SETTLEMENT is now event-scoped — platformTransactions is per-event
    // (entityId = eventSlug) with an index built for the aggregate — so it left the
    // workspace-only list. The WALLET stays: one wallet per organizer, not divisible.
    check(!pa.body.scope.workspaceOnly.includes('settlement'),
      'Finance · settlement is now the SELECTED EVENT’s, not workspace-lifetime',
      JSON.stringify(pa.body.scope.workspaceOnly))
    check(pa.body.scope.workspaceOnly.includes('wallet'),
      'Finance · the wallet balance stays workspace-labelled')
    // …and the two events report DIFFERENT settlements, which is the proof it scoped.
    check(pa.body.settlement?.grossRevenuePaise !== pb.body.settlement?.grossRevenuePaise ||
          (pa.body.settlement?.grossRevenuePaise ?? 0) === 0,
      'Finance · each event reports its own settlement',
      `A=${pa.body.settlement?.grossRevenuePaise} B=${pb.body.settlement?.grossRevenuePaise}`)

    // ── Event Performance — intentionally cross-event ──
    const perf = (p) => p.body.eventPerformance.map(r => r.label)
    check(perf(pa).includes(A.name) && perf(pa).includes(B.name),
      'Event Performance · cross-event under A', perf(pa).join(', '))
    check(perf(pb).includes(A.name) && perf(pb).includes(B.name),
      'Event Performance · cross-event under B', perf(pb).join(', '))

    // ── All Events mode ──
    check(pAll.body.scope.mode === 'all' && pAll.body.scope.workspaceOnly.length === 0,
      'All Events · nothing needs a workspace label', JSON.stringify(pAll.body.scope.workspaceOnly))

    // ── Draft ──
    check(pDraft.status === 200, 'Draft · served, not refused', `status ${pDraft.status}`)
    check(pDraft.body.scope.mode === 'event' && pDraft.body.scope.eventPublished === false,
      'Draft · scoped AND flagged unpublished')
    check(pDraft.body.overview.totalRegistrations === 0 &&
          pDraft.body.overview.totalRevenuePaise === 0 &&
          pDraft.body.communications.emailsSentToday === 0,
      'Draft · honest zeros, NOT the workspace totals',
      `regs=${pDraft.body.overview.totalRegistrations} rev=${pDraft.body.overview.totalRevenuePaise} mail=${pDraft.body.communications.emailsSentToday}`)
    check(pDraft.body.trendDays.every(d => d.count === 0),
      'Draft · the trend is its OWN empty series, not the workspace one')
    check(pDraft.body.activity.length === 0, 'Draft · no borrowed activity rows')

    // ── Malformed registration ──
    check(pb.status === 200, 'Malformed record · the API still returns 200, not 500')
    check((pb.body.activitySkipped ?? 0) === 0 && pb.body.activity.some(a => a.attendeeName === 'Unnamed attendee'),
      'Malformed record · degrades to ONE labelled row, feed intact',
      `rows=${pb.body.activity.length} skipped=${pb.body.activitySkipped ?? 0}`)
  }

  // ═══ ALL EVENTS — REACHABLE FROM THE GLOBAL SELECTOR ═══════════════════════
  //
  // The workspace-wide mode was implemented, tested and verified at the API — and had no
  // control that reached it. These checks are the difference between "the mode exists" and
  // "an organizer can use it".
  console.log('\n── All events (global selector) ──')

  await page.getByRole('button', { name: /change event|select an event/i }).click()
  const allOption = page.getByRole('option', { name: /all events/i }).first()
  check(await allOption.isVisible().catch(() => false), 'All events appears in the GLOBAL selector')

  const callsBeforeAll = dashboardCalls.length
  await allOption.click()
  await page.waitForFunction(
    () => !/Loading /.test(document.body.innerText) && /All events/.test(document.body.innerText),
    undefined, { timeout: 30_000 })
  await page.waitForTimeout(800)
  const textAll = await bodyText(page)
  await page.screenshot({ path: `${OUT}/G-all-events.png` })
  await page.screenshot({ path: `${OUT}/G-all-events-full.png`, fullPage: true })

  const allCalls = dashboardCalls.slice(callsBeforeAll)
  check(allCalls.length === 1, 'selecting All events costs exactly ONE dashboard read', `${allCalls.length}`)
  check(allCalls.every(u => !u.includes('eventId=')),
    'the All-events request carries NO eventId', allCalls.join(' '))

  // Workspace totals, not one event's.
  const workspaceTotal = (A.registrations + B.registrations).toLocaleString('en-IN')
  check(textAll.includes(workspaceTotal), 'All events shows the workspace total', workspaceTotal)
  check(!/· Draft/.test(textAll), 'All events is not mistaken for a draft')

  // The badge, read from the DOM next to the page title rather than from body text — body
  // text also contains "All events" in the selector trigger and the Upcoming link, so a
  // string search here would pass even if the badge itself were wrong.
  const badgeText = await page.evaluate(() => {
    const h1 = document.querySelector('h1')
    return h1?.parentElement?.querySelector('span')?.textContent?.trim() ?? null
  })
  check(badgeText === 'All events', 'the header badge states the All-events scope', String(badgeText))

  // The selector trigger itself must show the scope, not a leftover event name.
  const triggerText = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')]
      .find(b => /change event|select an event/i.test(b.getAttribute('aria-label') ?? ''))
    return btn?.textContent?.trim() ?? null
  })
  check(triggerText?.includes('All events') ?? false,
    'the GLOBAL selector trigger shows All events', String(triggerText))

  // Switching BACK to a single event must not leave workspace figures behind.
  console.log('\n── All events → Event A → All events ──')
  await selectEvent(page, A.name)
  const backToA = await bodyText(page)
  check(backToA.includes(A.registrations.toLocaleString('en-IN')),
    'All events → Event A shows A’s figures', String(A.registrations))
  check(!backToA.includes(`${workspaceTotal} `) || backToA.indexOf(workspaceTotal) === -1,
    'the workspace total is GONE after returning to one event', `looked for ${workspaceTotal}`)

  await page.getByRole('button', { name: /change event|select an event/i }).click()
  await page.getByRole('option', { name: /all events/i }).first().click()
  await page.waitForFunction(
    () => !/Loading /.test(document.body.innerText) && /All events/.test(document.body.innerText),
    undefined, { timeout: 30_000 })
  await page.waitForTimeout(600)
  check((await bodyText(page)).includes(workspaceTotal),
    'Event A → All events returns to the workspace total')

  // The choice must SURVIVE a reload — otherwise it reads as broken rather than remembered.
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !/Loading /.test(document.body.innerText), undefined, { timeout: 30_000 })
  await page.waitForTimeout(800)
  const afterReloadAll = await bodyText(page)
  check(afterReloadAll.includes(workspaceTotal) && /All events/.test(afterReloadAll),
    'the All-events choice survives a reload')

  // ═══ EVERY EVENT STATE STAYS REACHABLE ═════════════════════════════════════
  //
  // The selector must never hide a state. An organizer has to be able to open a finished
  // race to pull its reports, and an archived one to check what happened.
  console.log('\n── Event states in the selector ──')
  await page.getByRole('button', { name: /change event|select an event/i }).click()
  await page.waitForTimeout(300)
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('[role="option"]')].map(o => o.innerText.replace(/\s+/g, ' ').trim()))
  await page.screenshot({ path: `${OUT}/H-selector-open.png` })
  await page.keyboard.press('Escape')

  check(rows.some(r => /^All events/.test(r)), 'All events is the first-class option', rows[0] ?? '')
  for (const [label, state] of [
    ['Coastal Marathon 2026', 'Upcoming'],
    ['Monsoon 10K 2027',      'Draft'],
    ['Lakeside Run 2025',     'Completed'],
    ['Old City Dash 2024',    'Archived'],
  ]) {
    const row = rows.find(r => r.startsWith(label))
    check(Boolean(row) && row.includes(state),
      `${state} event is listed with its state`, row ?? 'MISSING')
  }

  // A completed event must not merely be listed — it must actually load.
  await selectEvent(page, 'Lakeside Run 2025')
  const textDone = await bodyText(page)
  check(textDone.includes('Lakeside Run 2025'), 'a COMPLETED event is selectable and loads')
  check(!textDone.includes(A.registrations.toLocaleString('en-IN')) ||
        textDone.indexOf(String(A.registrations)) > textDone.indexOf('Event performance'),
    'the completed event does not borrow another event’s totals')

  // ═══ PERMISSIONS-POLICY — PARSED, NOT DISCARDED ════════════════════════════
  console.log('\n── Permissions-Policy ──')
  const ppErrors = consoleErrors.filter(e => /Permissions-Policy/i.test(e))
  check(ppErrors.length === 0,
    'Chrome ACCEPTS the header — no parse error', ppErrors[0]?.slice(0, 90) ?? 'none')

  const ppHeader = await page.evaluate(async () => {
    const res = await fetch(location.href, { method: 'GET', cache: 'no-store' })
    return res.headers.get('permissions-policy')
  })
  check(ppHeader === 'camera=(self), microphone=(), geolocation=(self)',
    'the served header is the corrected policy', String(ppHeader))

  // And the policy is actually ENFORCED as intended — first-party allowed, mic denied.
  const allowed = await page.evaluate(() => {
    const fp = document.featurePolicy ?? document.permissionsPolicy
    if (!fp?.allowsFeature) return null
    return {
      camera:      fp.allowsFeature('camera'),
      microphone:  fp.allowsFeature('microphone'),
      geolocation: fp.allowsFeature('geolocation'),
    }
  })
  if (allowed) {
    check(allowed.camera === true,
      'camera is ALLOWED first-party — gate check-in scanning still works')
    check(allowed.geolocation === true,
      'geolocation is ALLOWED first-party — discovery “use my location” still works')
    check(allowed.microphone === false,
      'microphone is DENIED — genuinely unused, and now genuinely enforced')
  } else {
    check(false, 'the browser exposes a feature-policy API to assert against')
  }

  // ── No console noise ───────────────────────────────────────────────────────
  // `Permissions-Policy` is NO LONGER filtered. It was a real defect — the header used CSP's
  // semicolons, so Chrome discarded it entirely — and it is fixed. Leaving the filter in
  // place would let a regression re-introduce the bug without failing this suite.
  const real = consoleErrors.filter(e =>
    !/favicon|Download the React DevTools|hydrat/i.test(e))
  check(real.length === 0, 'no console errors introduced by this change', real.slice(0, 3).join(' | '))

  writeFileSync(`${OUT}/result.json`, JSON.stringify({ checks, failures }, null, 2))
  await browser.close()

  console.log(`\n${checks.filter(c => c.ok).length}/${checks.length} checks passed. Screenshots in ${OUT}/`)
  if (failures.length) { console.error(`\nFAILED:\n  ${failures.join('\n  ')}`); process.exit(1) }
}

if (!EMAIL || !PASSWORD) { console.error('RD_PROFILE_EMAIL / RD_PROFILE_PASSWORD required'); process.exit(2) }
run().catch(e => { console.error(e); process.exit(1) })
