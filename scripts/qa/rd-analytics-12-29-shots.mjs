/* RD-ANALYTICS-12-29 — the Participants module. EMULATOR ONLY. Run the fixture first.
 *
 * Checks the PAYLOAD against the seeded arithmetic (so a wrong remainder or a wrong scope
 * is a numeric failure), then photographs the screen and reads its text for the words that
 * must and must not appear — above all, that nothing on it is called a participant count.
 *
 *   node rd-analytics-12-29-shots.mjs
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
const OUT = 'e2e/.shots/rd-analytics-12-29'
mkdirSync(OUT, { recursive: true })

const EXPECT = {
  'a29-mix':   { source: { online: 463, walkin: 65, unrecorded: 70 },
                 confirmed: { online: 420, walkin: 60, unrecorded: 60 },
                 cancelled: { online: 25, walkin: 5, unrecorded: 10 },
                 passMix: ['General', 'Student', 'VIP'], rules: { limitPerEmail: true, limitPerMobile: false },
                 statusConfirmedPct: 90 },
  'a29-clean': { source: { online: 50, walkin: 0, unrecorded: 0 },
                 confirmed: { online: 48, walkin: 0, unrecorded: 0 },
                 cancelled: { online: 2, walkin: 0, unrecorded: 0 },
                 passMix: ['General'], rules: { limitPerEmail: false, limitPerMobile: false },
                 statusConfirmedPct: 96 },
}

const browser = await chromium.launch()
const issues = [], facts = []
const eq = (tag, label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g !== w) issues.push(`[${tag}] ${label}: got ${g}, expected ${w}`); else facts.push(`[${tag}] ${label} = ${g} ✓`)
}

async function login(page, who) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.locator('#login-email').waitFor({ state: 'visible', timeout: 60_000 })
  await page.locator('#login-email').pressSequentially(who.email, { delay: 8 })
  await page.locator('#login-password').pressSequentially(who.password, { delay: 8 })
  await page.getByRole('button', { name: /sign in|log ?in/i }).first().click()
  await page.waitForURL(/\/dashboard|\/checkin/, { timeout: 90_000 })
  await page.waitForTimeout(2000)
}

function checkPayload(tag, slug, body, money) {
  const j = JSON.parse(body).analytics
  const e = EXPECT[slug]
  const p = j.participants
  if (!p) { issues.push(`[${tag}/${slug}] no participants block`); return }
  eq(tag, `${slug} modules include participants`, j.capabilities.modules.includes('participants'), true)
  eq(tag, `${slug} source`, p.composition.source, e.source)
  eq(tag, `${slug} confirmed by source`, p.composition.sourceByStatus.confirmed, e.confirmed)
  eq(tag, `${slug} cancelled by source`, p.composition.sourceByStatus.cancelled, e.cancelled)
  eq(tag, `${slug} pass mix labels`, p.composition.passMix.map(m => m.label), e.passMix)
  eq(tag, `${slug} pass mix sums to confirmed`, p.composition.passMix.reduce((s, m) => s + m.value, 0), j.registrations.confirmed)
  eq(tag, `${slug} status mix confirmed pct`, p.composition.statusMix.find(m => m.key === 'confirmed').sharePct, e.statusConfirmedPct)
  eq(tag, `${slug} identity rules`, p.composition.identityRules, e.rules)
  for (const k of ['returning', 'ageBuckets', 'genderBuckets', 'cityBuckets']) eq(tag, `${slug} ${k} absent`, k in p, false)
  const text = JSON.stringify(p)
  if (/@|phone|name"/.test(text)) issues.push(`[${tag}/${slug}] PII-looking content inside participants`)
  if (/paise|cost|revenue/i.test(text)) issues.push(`[${tag}/${slug}] money inside participants`)
  eq(tag, `${slug} revenue presence follows transactions`, 'revenue' in j, money)
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
    const seen = new Map()
    page.on('response', async r => {
      const m = new URL(r.url()).pathname.match(/\/api\/organizer\/analytics\/(?:overview\/)?([^/]+)$/)
      if (!m) return
      const slug = decodeURIComponent(m[1]).replace(/-draft$/, '')
      if (r.status() !== 200) { seen.set(slug, r.status()); return }
      let body = ''; try { body = await r.text() } catch { return }
      if (!seen.has(slug)) { seen.set(slug, 200); if (EXPECT[slug]) checkPayload(tag, slug, body, who.money) }
    })

    await login(page, who)
    if (!who.analytics) {
      await page.goto(`${BASE}/dashboard/analytics/participants?eventId=a29-mix-draft`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(6000)
      await page.screenshot({ path: `${OUT}/desktop-staff-gate.png`, fullPage: true })
      const status = seen.get('a29-mix') ?? null
      facts.push(`[${tag}] gate role analytics API → ${status === null ? 'never called' : 'HTTP ' + status}`)
      if (status === 200) issues.push(`[${tag}] gate role received a 200 analytics payload`)
      const text = await page.evaluate(() => document.body.innerText)
      if (/Registration status by source|Duplicate rules/.test(text)) issues.push(`[${tag}] participant figures rendered to a gate role`)
      await ctx.close(); continue
    }
    for (const slug of ['a29-mix', 'a29-clean']) {
      if (vp.tag !== 'desktop' && slug === 'a29-clean') continue
      await page.goto(`${BASE}/dashboard/analytics/participants?eventId=${slug}-draft`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(7000)
      await page.screenshot({ path: `${OUT}/${vp.tag}-${name}-${slug}.png`, fullPage: true })
      // The module lives in <main>; the sidebar shows the signed-in user's own email, which is not participant PII.
      const text = await page.evaluate(() => (document.querySelector('main') ?? document.body).innerText)
      for (const bad of ['NaN', 'Infinity', 'undefined', 'null']) {
        if (new RegExp(`\\b${bad}\\b`).test(text)) issues.push(`[${tag}/${slug}] renders literal "${bad}"`)
      }
      const must = ['Every figure counts registrations', 'all time', 'Registration status by source',
                    'Registration mix by pass', 'Registration mix by status', 'Duplicate rules', 'What this page does not show']
      for (const w of must) if (!text.includes(w)) issues.push(`[${tag}/${slug}] missing "${w}"`)
      const forbidden = /Unique participants|Total participants|Returning participants|New participants/
      if (forbidden.test(text)) issues.push(`[${tag}/${slug}] participant-count wording present`)
      if (slug === 'a29-mix'   && !/Source not recorded/i.test(text)) issues.push(`[${tag}] not-recorded row missing on a29-mix`)
      if (slug === 'a29-clean' && /Not recorded\s+\d/.test(text)) issues.push(`[${tag}] not-recorded column drawn on a29-clean`)
      if (/@[a-z0-9-]+\.test/.test(text)) issues.push(`[${tag}/${slug}] an email address is on screen`)
      if (!seen.has(slug)) issues.push(`[${tag}/${slug}] analytics payload never observed`)
      const overflow = await page.evaluate(() => Math.max(
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
        (document.querySelector('main')?.scrollWidth ?? 0) - (document.querySelector('main')?.clientWidth ?? 0)))
      facts.push(`[${tag}/${slug}] overflow ${overflow}px`)
      if (overflow > 1) issues.push(`[${tag}/${slug}] horizontal overflow ${overflow}px`)
      // The nav must now offer the module, and the module must be reachable from a sibling.
      const navHas = await page.evaluate(() => [...document.querySelectorAll('nav[aria-label="Analytics modules"] a')].some(a => a.textContent?.trim() === 'Participants'))
      if (!navHas) issues.push(`[${tag}/${slug}] Participants missing from the module nav`)
    }
    await ctx.close()
  }
}

await browser.close()
console.log(facts.join('\n'))
console.log(issues.length ? '\nISSUES:\n' + issues.join('\n') : '\nParticipants: every seeded figure matches, nothing is called a participant count, every role sees exactly its slice.')
console.log(`shots → ${OUT}`)
