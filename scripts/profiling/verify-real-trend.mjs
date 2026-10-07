/* RD-DASHBOARD-10 — browser verification against the REAL production event.
 *
 *   node scripts/profiling/verify-real-trend.mjs
 *
 * ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
 * Every previous verification ran against the emulator fixture. That proved the code path
 * but could not answer the actual question — "does VANATHUKKUL NOYYAL MARATHON render its
 * chart?" — because the fixture is not that event.
 *
 * This drives the real page against the real Firestore, reads the rendered DOM, and checks
 * the chart is genuinely painted (bars with non-zero height), not merely that the API
 * returned numbers.
 *
 * ═══ IT WRITES NOTHING ═══════════════════════════════════════════════════════
 * Auth is a short-lived custom token minted for the workspace owner's own uid; every
 * Firestore interaction is the page's ordinary reads. No document is created or modified.
 */
import fs from 'node:fs'
import { chromium } from '@playwright/test'

// RD-PREPROD · this script impersonates a workspace owner (custom token) and reads real data against PRODUCTION (registerdesk-c91a3). It must never start by
// accident: the operator confirms the project explicitly in the environment.
if (process.env.RD_CONFIRM_PROD_PROJECT !== 'registerdesk-c91a3') {
  console.error('Refusing to run: set RD_CONFIRM_PROD_PROJECT=registerdesk-c91a3 to confirm this targets production.')
  process.exit(2)
}
// RD-PREPROD · the real owner uid is no longer hard-coded in source: pass RD_REAL_UID explicitly.
if (!process.env.RD_REAL_UID) {
  console.error('Refusing to run: set RD_REAL_UID to the workspace owner uid to verify (no default).')
  process.exit(2)
}


for (const line of fs.readFileSync('.env.local', 'utf-8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

const BASE  = process.env.RD_REAL_BASE_URL ?? 'http://localhost:3199'
const UID   = process.env.RD_REAL_UID ?? ''
const EVENT = process.env.RD_REAL_EVENT    ?? 'VANATHUKKUL NOYYAL  MARATHON'
const SLUG  = process.env.RD_REAL_SLUG     ?? 'noyyal-marathon-2026'
const OUT   = 'e2e/.shots/real-trend'

const checks = [], failures = []
const check = (ok, label, detail = '') => {
  checks.push({ ok, label, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/** Measured bar geometry — the only proof the chart is actually painted. */
const barStats = page => page.evaluate(() => {
  const panel = document.querySelector('[aria-labelledby="trend-heading"]')
  if (!panel) return null
  const track = panel.querySelector('[role="img"]') ?? panel
  const fills = [...track.querySelectorAll('div')]
    .filter(d => /rounded-t/.test(d.className) && d.getBoundingClientRect().width > 0)
  const heights = fills.map(d => Math.round(d.getBoundingClientRect().height))
  return { count: heights.length, nonZero: heights.filter(h => h > 0).length, max: Math.max(0, ...heights) }
})

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const { initializeApp, cert } = await import('firebase-admin/app')
  const { getAuth } = await import('firebase-admin/auth')
  initializeApp({ credential: cert(JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_KEY, 'base64').toString('utf-8'))) })
  const token = await getAuth().createCustomToken(UID)

  const browser = await chromium.launch()
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
  const errors = []
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))

  console.log(`\n═══ REAL production verification · ${BASE} ═══\n`)
  // ═══ SIGN-IN ══════════════════════════════════════════════════════════════
  // `import('firebase/auth')` cannot resolve a bare specifier in page context, so the
  // custom token is exchanged through the Auth REST API and the resulting session is
  // written into the SDK's own IndexedDB record — which is exactly what the SDK does
  // itself on a normal sign-in, and what it reads back on load.
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, returnSecureToken: true }) },
  )
  const session = await res.json()
  check(Boolean(session.idToken), 'exchanged a custom token for a session',
    session.error?.message ?? 'session issued')
  if (!session.idToken) { await browser.close(); process.exit(1) }

  const claims = JSON.parse(Buffer.from(session.idToken.split('.')[1], 'base64').toString('utf-8'))
  const authUser = {
    uid: session.localId ?? claims.user_id ?? claims.sub,
    email: session.email ?? claims.email ?? null,
    emailVerified: true,
    isAnonymous: false,
    providerData: [],
    stsTokenManager: {
      refreshToken: session.refreshToken,
      accessToken:  session.idToken,
      expirationTime: Date.now() + Number(session.expiresIn ?? 3600) * 1000,
    },
    createdAt: String(Date.now()),
    lastLoginAt: String(Date.now()),
    apiKey,
    appName: '[DEFAULT]',
  }

  await page.addInitScript(({ key, user }) => {
    // Mirrors the SDK's own persistence layer: db "firebaseLocalStorageDb",
    // store "firebaseLocalStorage", one record keyed by apiKey + app name.
    return new Promise(resolve => {
      const open = indexedDB.open('firebaseLocalStorageDb', 1)
      open.onupgradeneeded = () => {
        open.result.createObjectStore('firebaseLocalStorage', { keyPath: 'fbase_key' })
      }
      open.onsuccess = () => {
        const db = open.result
        const tx = db.transaction('firebaseLocalStorage', 'readwrite')
        tx.objectStore('firebaseLocalStorage').put({ fbase_key: key, value: user })
        tx.oncomplete = () => resolve()
        tx.onerror = () => resolve()
      }
      open.onerror = () => resolve()
    })
  }, { key: `firebase:authUser:${apiKey}:[DEFAULT]`, user: authUser })

  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !/Loading /.test(document.body.innerText), undefined, { timeout: 120_000 })
  await page.waitForTimeout(1500)

  // Select the real event.
  await page.getByRole('button', { name: /change event|select an event/i }).click()
  await page.getByRole('option', { name: /vanathukkul/i }).first().click()
  await page.waitForFunction(
    () => !/Loading .*…/.test(document.body.innerText) && /VANATHUKKUL/i.test(document.body.innerText),
    undefined, { timeout: 120_000 })
  await page.waitForTimeout(1800)

  const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
  await page.screenshot({ path: `${OUT}/real-dashboard.png` })
  await page.screenshot({ path: `${OUT}/real-dashboard-full.png`, fullPage: true })

  check(/VANATHUKKUL/i.test(text), 'the real event is selected')
  check(/2,295/.test(text), 'registrations show the real figure', '2,295')
  check(/3,44,737/.test(text), 'ticket revenue shows the real figure', '₹3,44,737')

  // ── THE ACTUAL BUG ────────────────────────────────────────────────────────
  check(!/Daily history not available/i.test(text),
    'the "Daily history not available" empty state is GONE')

  for (const range of ['7d', '30d', '90d']) {
    await page.getByRole('button', { name: new RegExp(`^${range}$`, 'i') }).click()
    await page.waitForTimeout(900)
    const stats = await barStats(page)
    const t2 = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
    const total = (t2.match(/([\d,]+)\s*Confirmed registrations/) ?? [])[1] ?? '?'
    check(Boolean(stats) && stats.nonZero > 0,
      `${range} · chart renders real bars`,
      stats ? `${stats.nonZero}/${stats.count} bars, tallest ${stats.max}px, total ${total}` : 'no panel')
    await page.screenshot({ path: `${OUT}/trend-${range}.png` })
  }

  // ── RD-DASHBOARD-12 · the KPI redesign, on REAL data ─────────────────────
  console.log('')
  check(/Fees & payout/i.test(text), 'Fees & payout replaced Event Status in the primary row')
  check(!/EVENT STATUS/i.test(text), 'Event Status is no longer a primary card')
  check(/Net payout/i.test(text), 'net payout is the headline of that card')
  check(/Platform fee/i.test(text), 'platform fee is shown in the breakdown')
  check(/Razorpay fee/i.test(text), 'Razorpay fee row is present')
  check(!/Razorpay fees*₹0/i.test(text), 'Razorpay fee is never rendered as ₹0')

  // The event name must NOT be restated as a page title. It legitimately appears in the
  // selector trigger, the selector's own option list, and in the lower sections' subtitles
  // (which are out of this phase's scope) — so the check is scoped to the page HEADER,
  // which is the element §3/§4 actually govern.
  const headerNames = await page.evaluate(() => {
    const h = document.querySelector('main header') ?? document.querySelector('header')
    return h ? (h.innerText.match(/VANATHUKKUL/gi) ?? []).length : -1
  })
  check(headerNames === 0, 'the page header no longer restates the event name',
    headerNames < 0 ? 'no header found' : `${headerNames} occurrence(s)`)

  // …and it IS stated beside the selector, in the top bar.
  const inTopBar = await page.evaluate(() => {
    const bar = document.querySelector('header')
    return bar ? /VANATHUKKUL/i.test(bar.innerText) : false
  })
  check(inTopBar, 'the event identity sits beside the global Event Selector')

  // Icon and title on ONE row, for every KPI card.
  const headerRows = await page.evaluate(() => {
    const out = []
    for (const label of ['Key metrics', 'Today']) {
      const sec = document.querySelector(`[aria-label="${label}"]`)
      if (!sec) continue
      for (const card of sec.children) {
        const icon = card.querySelector('span[aria-hidden] svg')?.closest('span')
        const title = card.querySelector('span.truncate, p.truncate')
        if (!icon || !title) continue
        const a = icon.getBoundingClientRect(), b = title.getBoundingClientRect()
        out.push(Math.abs((a.top + a.height / 2) - (b.top + b.height / 2)) <= 6)
      }
    }
    return out
  })
  check(headerRows.length > 0 && headerRows.every(Boolean),
    'every KPI card puts its icon and title on ONE row', `${headerRows.filter(Boolean).length}/${headerRows.length}`)

  // ── §21 GEOMETRY, on the REAL dashboard ──────────────────────────────────
  // Equal height is a measurement, not a class name. Bottom edges within ±2px.
  const rowsOf = (label) => page.evaluate(sel => {
    const sec = document.querySelector(`[aria-label="${sel}"]`)
    if (!sec) return null
    return [...sec.children].map(el => {
      const r = el.getBoundingClientRect()
      return { top: Math.round(r.top), bottom: Math.round(r.bottom) }
    })
  }, label)
  const offenders = (boxes, tol = 2) => {
    const rows = new Map()
    for (const b of boxes) {
      const k = [...rows.keys()].find(x => Math.abs(x - b.top) <= tol) ?? b.top
      rows.set(k, [...(rows.get(k) ?? []), b])
    }
    const out = []
    for (const [top, items] of rows) {
      if (items.length < 2) continue
      const span = Math.max(...items.map(i => i.bottom)) - Math.min(...items.map(i => i.bottom))
      if (span > tol) out.push(`row@${top}: ${span}px`)
    }
    return out
  }

  console.log('')
  for (const vp of [[1440, 900], [1280, 860], [1024, 820], [768, 1024], [390, 844], [375, 812]]) {
    await page.setViewportSize({ width: vp[0], height: vp[1] })
    await page.waitForTimeout(600)

    const ov = await page.evaluate(() => {
      const el = document.querySelector('#main-content') ?? document.documentElement
      return el.scrollWidth - el.clientWidth
    })
    check(ov <= 1, `${vp[0]}px · no horizontal overflow`, `${ov}px`)

    for (const label of ['Key metrics', 'Today']) {
      const boxes = await rowsOf(label)
      check(Boolean(boxes) && offenders(boxes).length === 0,
        `${vp[0]}px · ${label} cards end level`,
        boxes ? (offenders(boxes).join('; ') || `${boxes.length} cards`) : 'missing')
    }

    const comp = await page.evaluate(() => {
      const box = el => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) } }
      const t = document.querySelector('[aria-labelledby="trend-heading"]')
      const q = document.querySelector('[aria-labelledby="quick-actions-heading"]')
      const u = [...document.querySelectorAll('section')].find(x => /^Upcoming events/.test(x.innerText ?? ''))
      return t && q ? { t: box(t), q: box(q), u: u ? box(u) : null } : null
    })
    if (comp && vp[0] >= 1280) {
      check(Math.abs(comp.t.top - comp.q.top) <= 4, `${vp[0]}px · Quick actions stays in the row`)
      const trio = [comp.t.bottom, comp.q.bottom, ...(comp.u ? [comp.u.bottom] : [])]
      check(Math.max(...trio) - Math.min(...trio) <= 2,
        `${vp[0]}px · Trend/Upcoming/Quick actions end level`, trio.join(' vs '))
    } else if (comp) {
      check(comp.q.top > comp.t.top, `${vp[0]}px · stacks in priority order`)
    }
    await page.screenshot({ path: `${OUT}/real-vp-${vp[0]}.png` })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  console.log('')

  const real = errors.filter(e => !/favicon|DevTools|hydrat|Permissions-Policy/i.test(e))
  check(real.length === 0, 'no console errors', real.slice(0, 2).join(' | '))

  fs.writeFileSync(`${OUT}/result.json`, JSON.stringify({ checks, failures }, null, 2))
  await browser.close()
  console.log(`\n${checks.filter(c => c.ok).length}/${checks.length} checks passed. Screenshots in ${OUT}/`)
  if (failures.length) { console.error(`\nFAILED:\n  ${failures.join('\n  ')}`); process.exit(1) }
}

void SLUG; void EVENT
main().catch(e => { console.error(e); process.exit(1) })
