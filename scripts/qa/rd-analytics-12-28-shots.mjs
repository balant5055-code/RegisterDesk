/* RD-ANALYTICS-12-28 — communication intelligence on the Analytics Communications module.
 * EMULATOR ONLY. Run rd-analytics-12-28-fixture.mjs first.
 *
 * Checks the PAYLOAD against the seeded arithmetic (so a wrong window or a wrong scope is a
 * numeric failure, not a visual impression), then photographs the screen and reads its text
 * for the words that must and must not appear.
 *
 *   node rd-analytics-12-28-shots.mjs
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE = process.env.RD_PROFILE_BASE_URL ?? 'http://localhost:3187'
const ACCOUNTS = {
  owner:   { email: 'profiling@registerdesk.test',    password: 'ProfilingPassw0rd!', money: true,  comms: true },
  finance: { email: 'finance.a11@registerdesk.test',  password: 'FinancePassw0rd!',   money: true,  comms: true },
  admin:   { email: 'admin.a1220@registerdesk.test',  password: 'AdminPassw0rd!',     money: false, comms: true },
  manager: { email: 'manager.a06@registerdesk.test',  password: 'ManagerPassw0rd!',   money: false, comms: true },
  staff:   { email: 'staff.a08@registerdesk.test',    password: 'StaffPassw0rd!',     money: false, comms: false },
}
const OUT = 'e2e/.shots/rd-analytics-12-28'
mkdirSync(OUT, { recursive: true })

// Seeded arithmetic (see the fixture). Window = 30d preset.
const EXPECT = {
  'a28-intel': {
    campaigns: { created: 6, completed: 4, scheduled: 1, period: 5, baseline: 1 },
    composition: { broadcast: 420 },
    email: { bounces: 30, complaints: 3 },
    whatsapp: { read: 40, walletSkipped: 6 },
    window: { attempted: 852, delivered: 691, notDelivered: 51, baselineAttempted: 290, perDay: 28 },
    lifetime: { waUnknown: 9, waFailed: 12 },
    reminders: { scheduled: 60, sent: 520 },
    limits: { reminders: false, certificates: true },
  },
  'a28-other': {
    campaigns: { created: 1, completed: 1, scheduled: 0, period: 1, baseline: 0 },
    composition: { broadcast: 0 },
    email: { bounces: 2, complaints: 0 },
    whatsapp: { read: 0, walletSkipped: 0 },
    window: { attempted: 27, delivered: 25, notDelivered: 2, baselineAttempted: 0, perDay: 0 },
    lifetime: { waUnknown: 0, waFailed: 0 },
    reminders: { scheduled: 0, sent: 0 },
    limits: { reminders: true, certificates: true },
  },
}

const browser = await chromium.launch()
const issues = [], facts = []
const eq = (tag, label, got, want) => {
  if (got !== want) issues.push(`[${tag}] ${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`)
  else facts.push(`[${tag}] ${label} = ${JSON.stringify(got)} ✓`)
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
  const c = j.communications, i = c.intelligence, e = EXPECT[slug]
  if (!i) { issues.push(`[${tag}] no intelligence block`); return }
  eq(tag, 'campaigns.created',   i.campaigns.created,   e.campaigns.created)
  eq(tag, 'campaigns.completed', i.campaigns.completed, e.campaigns.completed)
  eq(tag, 'campaigns.scheduled', i.campaigns.scheduled, e.campaigns.scheduled)
  eq(tag, 'campaigns.period.value',    i.campaigns.period.value,    e.campaigns.period)
  eq(tag, 'campaigns.period.baseline', i.campaigns.period.baseline, e.campaigns.baseline)
  eq(tag, 'composition.broadcast', i.composition.broadcast, e.composition.broadcast)
  eq(tag, 'composition sums to total', i.composition.broadcast + i.composition.automatic, c.totalMessages)
  eq(tag, 'email.bounces',    i.email.bounces,    e.email.bounces)
  eq(tag, 'email.complaints', i.email.complaints, e.email.complaints)
  eq(tag, 'whatsapp.read',          i.whatsapp.read,          e.whatsapp.read)
  eq(tag, 'whatsapp.walletSkipped', i.whatsapp.walletSkipped, e.whatsapp.walletSkipped)
  eq(tag, 'window.attempted',    i.window.attempted.value,    e.window.attempted)
  eq(tag, 'window.delivered',    i.window.delivered.value,    e.window.delivered)
  eq(tag, 'window.notDelivered', i.window.notDelivered.value, e.window.notDelivered)
  eq(tag, 'window.attempted.baseline', i.window.attempted.baseline, e.window.baselineAttempted)
  eq(tag, 'window.velocity.perDay', i.window.velocity.perDay, e.window.perDay)
  eq(tag, 'window has NO unknown key', 'unknown' in i.window.period.whatsapp, false)
  const wa = c.channels.find(x => x.key === 'whatsapp').delivery
  eq(tag, 'lifetime whatsapp.unknown', wa?.unknown ?? null, e.lifetime.waUnknown)
  eq(tag, 'lifetime whatsapp.failed (excludes unknown)', wa?.failed ?? null, e.lifetime.waFailed)
  eq(tag, 'remindersScheduled', c.remindersScheduled, e.reminders.scheduled)
  eq(tag, 'remindersSent',      c.remindersSent,      e.reminders.sent)
  eq(tag, 'limits.reminders',   j.limits.reminders,   e.limits.reminders)
  eq(tag, 'limits.certificates', j.limits.certificates, e.limits.certificates)
  eq(tag, 'sms unsupported', c.channels.find(x => x.key === 'sms').support, 'not_implemented')
  eq(tag, 'spend presence follows transactions', 'spend' in c, money)
  if (/"paise"|"cost"/.test(JSON.stringify(i))) issues.push(`[${tag}] money inside intelligence`)
  if (/Infinity|NaN/.test(body)) issues.push(`[${tag}] payload contains Infinity/NaN`)
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
      const u = new URL(r.url())
      const m = u.pathname.match(/\/api\/organizer\/analytics\/(?:overview\/)?([^/]+)$/)
      if (!m) return
      const slug = decodeURIComponent(m[1]).replace(/-draft$/, '')
      if (r.status() !== 200) { facts.push(`[${tag}] ${slug} → HTTP ${r.status()}`); seen.set(slug, r.status()); return }
      let body = ''; try { body = await r.text() } catch { return }
      if (!seen.has(slug)) { seen.set(slug, 200); checkPayload(tag, slug, body, who.money) }
    })

    await login(page, who)
    if (!who.comms) {
      // A gate role reaches the page shell; what matters is that the analytics API refuses
      // it (403) or is never even called, and that no communication figure renders.
      await page.goto(`${BASE}/dashboard/analytics/communications?eventId=a28-intel-draft`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(6000)
      await page.screenshot({ path: `${OUT}/desktop-staff-gate.png`, fullPage: true })
      const status = seen.get('a28-intel') ?? null
      facts.push(`[${tag}] gate role analytics API → ${status === null ? 'never called' : 'HTTP ' + status}`)
      if (status === 200) issues.push(`[${tag}] gate role received a 200 analytics payload`)
      const text = await page.evaluate(() => document.body.innerText)
      if (/Messages in the last|Provider signals/.test(text)) issues.push(`[${tag}] communication figures rendered to a gate role`)
      await ctx.close()
      continue
    }
    for (const slug of ['a28-intel', 'a28-other']) {
      if (vp.tag !== 'desktop' && slug === 'a28-other') continue
      await page.goto(`${BASE}/dashboard/analytics/communications?eventId=${slug}-draft`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(7000)
      await page.screenshot({ path: `${OUT}/${vp.tag}-${name}-${slug}.png`, fullPage: true })
      const text = await page.evaluate(() => document.body.innerText)
      for (const bad of ['NaN', 'Infinity', 'undefined', 'null']) {
        if (new RegExp(`\\b${bad}\\b`).test(text)) issues.push(`[${tag}/${slug}] renders literal "${bad}"`)
      }
      const must = ['Messages in the last 30 days', 'Not delivered', 'Campaigns', 'What was sent', 'Provider signals',
                    'any type', 'not an email open', 'not a failure', 'alerts sent to you', '/day']
      for (const w of must) if (!text.includes(w)) issues.push(`[${tag}/${slug}] missing "${w}"`)
      if (/Push\s+0\b|SMS\s+0\b/.test(text)) issues.push(`[${tag}/${slug}] renders SMS/Push as 0`)
      if (who.money && !/Messaging spend/.test(text)) issues.push(`[${tag}/${slug}] spend section missing for a money role`)
      if (!who.money && /Messaging spend/.test(text)) issues.push(`[${tag}/${slug}] spend rendered to a non-money role`)
      if (slug === 'a28-intel' && !/reminder recipient total is withheld/.test(text)) issues.push(`[${tag}] overflow note missing`)
      if (!seen.has(slug)) issues.push(`[${tag}/${slug}] analytics payload never observed`)
      const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, (document.querySelector('main')?.scrollWidth ?? 0) - (document.querySelector('main')?.clientWidth ?? 0)))
      facts.push(`[${tag}/${slug}] overflow ${overflow}px`)
      if (overflow > 1) issues.push(`[${tag}/${slug}] horizontal overflow ${overflow}px`)
    }
    await ctx.close()
  }
}

await browser.close()
console.log(facts.join('\n'))
console.log(issues.length ? '\nISSUES:\n' + issues.join('\n') : '\nCommunication intelligence: every seeded figure matches, every role sees exactly its slice, no false zeros.')
console.log(`shots → ${OUT}`)
