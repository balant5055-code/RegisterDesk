/* RD-ANALYTICS-10 — the event-type × capability matrix, in a real browser. EMULATOR ONLY.
 *
 * The claim under test is negative as often as positive: a panel must be ABSENT for an
 * event that has not configured its capability. Absence cannot be photographed, so every
 * case is asserted against the rendered text as well as captured.
 *
 *   node rd-analytics-10-shots.mjs
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE  = process.env.RD_PROFILE_BASE_URL ?? 'http://localhost:3187'
const OWNER = { email: process.env.RD_PROFILE_EMAIL ?? 'profiling@registerdesk.test',
                password: process.env.RD_PROFILE_PASSWORD ?? 'ProfilingPassw0rd!' }
const MANAGER = { email: 'manager.a06@registerdesk.test', password: 'ManagerPassw0rd!' }
const STAFF   = { email: 'staff.a08@registerdesk.test',   password: 'StaffPassw0rd!' }
const OUT = 'e2e/.shots/rd-analytics-10'

/** [draftId, eventType, identifierLabel|null, timingLabel|null] */
const MATRIX = [
  ['a10-sports-both-draft',       'sports',      'Bib',    'Timing Chip'],
  ['a10-sports-ids-draft',        'sports',      'Bib',    null],
  ['a10-sports-none-draft',       'sports',      null,     null],
  ['a10-conference-both-draft',   'conference',  'Badge',  'Transponder'],
  ['a10-workshop-ids-draft',      'workshop',    'Token',  null],
  ['a10-exhibition-timing-draft', 'exhibition',  null,     'Wristband'],
  ['a10-cultural-none-draft',     'cultural',    null,     null],
  ['a10-fundraising-none-draft',  'fundraising', null,     null],
  ['a10-meetup-none-draft',       'meetup',      null,     null],
  ['a10-community-none-draft',    'community',   null,     null],
  ['a10-awards-none-draft',       'awards',      null,     null],
]

/** Every credential noun any fixture uses — so a leak from one event to another is caught. */
const ALL_LABELS = ['Bib', 'Badge', 'Token', 'Timing Chip', 'Transponder', 'Wristband']

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

const settled = () => /confirmed|select a single event|could not load/i.test(document.body.innerText)

// ── The matrix, at three viewports for the two most complex cases ─────────────
{
  const ctx  = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await ctx.newPage()
  page.on('console',   m => { if (m.type() === 'error') issues.push(`console: ${m.text()}`) })
  page.on('pageerror', e => issues.push(`pageerror: ${e.message}`))
  await login(page, OWNER)

  for (const [draftId, eventType, idLabel, timingLabel] of MATRIX) {
    await page.goto(`${BASE}/dashboard/analytics/operations?eventId=${draftId}`,
                    { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(settled, { timeout: 45_000 })
      .catch(() => issues.push(`${draftId}: never settled`))
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${OUT}/desktop-${draftId}.png` })

    const text = await page.evaluate(() => document.body.innerText)
    const tag  = `${eventType}/${idLabel ?? '-'}/${timingLabel ?? '-'}`

    // Universal analytics must be present for EVERY event type.
    for (const phrase of [/confirmed/i, /checked in/i, /attendance/i, /check-in trend/i]) {
      if (!phrase.test(text)) issues.push(`${draftId} [${tag}]: universal ${phrase} missing`)
    }

    // The configured label appears; every OTHER credential noun must not.
    const expected = [idLabel, timingLabel].filter(Boolean)
    for (const label of expected) {
      if (!new RegExp(`${label}\\s+assignment`, 'i').test(text)) {
        issues.push(`${draftId} [${tag}]: "${label} assignment" panel missing`)
      }
    }
    for (const label of ALL_LABELS.filter(l => !expected.includes(l))) {
      if (new RegExp(`${label}\\s+assignment`, 'i').test(text)) {
        issues.push(`${draftId} [${tag}]: LEAKED a "${label}" panel it did not configure`)
      }
    }

    // No sports vocabulary anywhere, on any event type — including the sports ones, which
    // must speak in their own configured noun rather than in race jargon.
    for (const w of [/\bBIB\b/, /finish time/i, /\bsplits\b/i, /finisher/i, /\bpace\b/i]) {
      if (w.test(text)) issues.push(`${draftId} [${tag}]: sports vocabulary ${w} on screen`)
    }
    // And no placeholder for an absent capability.
    if (/\bN\/A\b/.test(text)) issues.push(`${draftId} [${tag}]: an "N/A" placeholder is on screen`)
    // Operations is not a Revenue page.
    if (/₹/.test(text)) issues.push(`${draftId} [${tag}]: a rupee symbol is on the page`)

    facts.push(`${draftId.padEnd(30)} ${tag.padEnd(34)} panels=${expected.join('+') || 'none'}`)
  }
  await ctx.close()
}

// ── Responsive: the richest case at every viewport ────────────────────────────
for (const vp of [{ name: 'desktop', width: 1440, height: 1000 },
                  { name: 'tablet',  width: 834,  height: 1100 },
                  { name: 'mobile',  width: 390,  height: 900  }]) {
  const ctx  = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
  const page = await ctx.newPage()
  page.on('pageerror', e => issues.push(`[${vp.name}] pageerror: ${e.message}`))
  await login(page, OWNER)

  for (const draftId of ['a10-conference-both-draft', 'a10-over-attended-draft']) {
    await page.goto(`${BASE}/dashboard/analytics/operations?eventId=${draftId}`,
                    { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(settled, { timeout: 45_000 }).catch(() => {})
    await page.waitForTimeout(500)
    await page.screenshot({ path: `${OUT}/${vp.name}-${draftId}.png` })

    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth)
    if (overflow > 1) issues.push(`[${vp.name}] ${draftId}: horizontal overflow ${overflow}px`)

    const text = await page.evaluate(() => document.body.innerText)
    if (draftId === 'a10-over-attended-draft') {
      // 120 admitted against 100 confirmed. The clamped implementation showed 100% / 0.
      const pct = text.match(/ATTENDANCE\s*\n\s*(\d+)%/i)?.[1]
      if (!pct) issues.push(`[${vp.name}] over-attended: no attendance percentage`)
      else {
        facts.push(`[${vp.name}] over-attended: ${pct}% attendance`)
        if (Number(pct) <= 100) issues.push(`[${vp.name}] over-attendance clamped to ${pct}%`)
      }
      if (!/above confirmed/i.test(text)) issues.push(`[${vp.name}] over-attended: no over-attendance metric`)
      if (!/checked in than confirmed/i.test(text)) {
        issues.push(`[${vp.name}] over-attended: the state is not explained`)
      }
      if (/still expected/i.test(text)) {
        issues.push(`[${vp.name}] over-attended: shows "still expected", which is meaningless here`)
      }
    }
  }
  await ctx.close()
}

// ── Presets, the empty event, and partial coverage ────────────────────────────
{
  const ctx  = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await ctx.newPage()
  page.on('console',   m => { if (m.type() === 'error') issues.push(`console: ${m.text()}`) })
  page.on('pageerror', e => issues.push(`pageerror: ${e.message}`))
  await login(page, OWNER)

  const open = async (draftId, preset) => {
    await page.goto(`${BASE}/dashboard/analytics/operations?eventId=${draftId}`,
                    { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(settled, { timeout: 45_000 }).catch(() => {})
    if (preset) {
      await page.getByRole('group', { name: 'Date range' })
                .getByRole('button', { name: preset }).click()
      await page.waitForTimeout(1_100)
    }
    await page.waitForTimeout(400)
    return page.evaluate(() => document.body.innerText)
  }

  // Each preset must produce its OWN window, named from the range the server served.
  for (const [preset, days] of [['7D', 7], ['30D', 30], ['90D', 90]]) {
    const text = await open('a10-conference-both-draft', preset)
    await page.screenshot({ path: `${OUT}/desktop-preset-${preset}.png` })
    const m = text.match(/checked in during the last (\d+) days/)
    if (!m) issues.push(`preset ${preset}: no period figure`)
    else if (Number(m[1]) !== days) issues.push(`preset ${preset}: window says ${m[1]} days`)
    else facts.push(`preset ${preset}: window is ${m[1]} days`)
  }

  // The empty event: measured zeros, and no capacity module (it configures none).
  const empty = await open('profiling-event-draft-empty')
  await page.screenshot({ path: `${OUT}/desktop-empty-event.png` })
  if (!/CONFIRMED\s*\n\s*0/i.test(empty)) issues.push('empty event: confirmed is not a measured 0')
  if (/capacity/i.test(empty)) issues.push('empty event: a capacity module appeared for an uncapped event')
  if (/assignment/i.test(empty)) issues.push('empty event: a credential panel appeared')
  facts.push('empty event: zeros measured, no capacity module, no credential panels')

  // Partial coverage — the marathon fixture, whose coverage floor sits inside the window.
  const partial = await open('profiling-draft-event', '90D')
  await page.screenshot({ path: `${OUT}/desktop-partial-coverage.png` })
  if (!/daily analytics begin/i.test(partial)) {
    issues.push('partial coverage: the gap is not disclosed')
  } else facts.push('partial coverage: disclosed with a date')

  await ctx.close()
}

// ── An unauthenticated visitor never reaches the module ───────────────────────
{
  const ctx  = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await ctx.newPage()
  await page.goto(`${BASE}/dashboard/analytics/operations?eventId=a10-conference-both-draft`,
                  { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3_000)
  await page.screenshot({ path: `${OUT}/desktop-unauthorized.png` })
  const text = await page.evaluate(() => document.body.innerText)
  const url  = page.url()
  if (/checked in|attendance|assignment/i.test(text)) {
    issues.push('unauthorized: operational figures rendered for a signed-out visitor')
  }
  const anon = await page.request
    .get(`${BASE}/api/organizer/analytics/overview/a10-conference-both?preset=30d`)
    .then(async r => ({ status: r.status(), body: (await r.text()).slice(0, 500) }))
    .catch(() => ({ status: null, body: '' }))
  if (anon.status !== 401 && anon.status !== 403) {
    issues.push(`unauthorized: the endpoint answered ${anon.status} with no credentials`)
  }
  facts.push(`unauthorized: redirected to ${url.includes('/login') ? 'login' : url} · anon probe ${anon.status}`)
  await ctx.close()
}

// ── The two roles that must not reach Operations analytics ────────────────────
for (const [who, name, expected] of [[MANAGER, 'manager', 200], [STAFF, 'staff', 403]]) {
  const ctx  = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await ctx.newPage()
  let bearer = null
  page.on('request', r => {
    const h = r.headers()['authorization']
    if (!bearer && h?.startsWith('Bearer ') && r.url().includes('/api/')) bearer = h
  })
  await login(page, who)
  await page.goto(`${BASE}/dashboard/analytics/operations?eventId=a10-conference-both-draft`,
                  { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3_000)
  await page.screenshot({ path: `${OUT}/desktop-${name}.png` })

  const direct = bearer
    ? await page.request
        .get(`${BASE}/api/organizer/analytics/overview/a10-conference-both?preset=30d`,
             { headers: { Authorization: bearer } })
        .then(async r => ({ status: r.status(), body: (await r.text()).slice(0, 4000) }))
        .catch(e => ({ status: null, body: String(e) }))
    : { status: null, body: '' }

  facts.push(`[${name}] direct probe: ${direct.status}`)
  if (direct.status !== expected) {
    issues.push(`[${name}] analytics endpoint answered ${direct.status}, expected ${expected}`)
  }
  // A manager may see Operations — it is attendance, not money — but never a financial byte.
  for (const probe of [/Paise/, /"revenue"/, /profitEstimate/]) {
    if (probe.test(direct.body)) issues.push(`[${name}] PAYLOAD leaked ${probe}`)
  }
  const text = await page.evaluate(() => document.body.innerText)
  if (/₹/.test(text)) issues.push(`[${name}] a rupee symbol is on the page`)
  if (name === 'manager' && !/checked in/i.test(text)) {
    issues.push('[manager] Operations did not render for a role that holds `events`')
  }
  await ctx.close()
}

await browser.close()
console.log(facts.join('\n'))
console.log(issues.length ? '\nISSUES:\n' + issues.join('\n')
                          : '\nNo console errors, no overflow, every capability claim held.')
console.log(`shots → ${OUT}`)
