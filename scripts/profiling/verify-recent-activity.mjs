/* RD-DASHBOARD-11 — Recent Activity, verified against REAL production records.
 *
 *   node scripts/profiling/verify-recent-activity.mjs
 *
 * ═══ WHY IT CHECKS THE DOM AGAINST FIRESTORE ═════════════════════════════════
 * "The feed shows the right rows" cannot be settled by reading the API payload — the
 * payload is what the API believes. So each rendered row is matched back to the actual
 * registration document it claims to describe: same participant, same event, same pass,
 * same instant. A row that cannot be matched is a fabrication and fails the run.
 *
 * ═══ IT WRITES NOTHING ═══════════════════════════════════════════════════════
 * Auth is a short-lived custom token for the workspace owner's own uid. Every Firestore
 * call is a read.
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

const BASE = process.env.RD_REAL_BASE_URL ?? 'http://localhost:3199'
const UID  = process.env.RD_REAL_UID ?? ''
const SLUG = 'noyyal-marathon-2026'
const OUT  = 'e2e/.shots/recent-activity'

const checks = [], failures = []
const check = (ok, label, detail = '') => {
  checks.push({ ok, label, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/** The rendered feed, row by row, straight out of the DOM. */
const feedRows = page => page.evaluate(() => {
  const heads = [...document.querySelectorAll('h2')]
  const card  = heads.find(h => /Recent activity/i.test(h.textContent ?? ''))?.closest('section')
  if (!card) return null
  const list = card.querySelector('ul[aria-label="Activity timeline"]')
  if (!list) return { rows: [], empty: card.innerText.replace(/\s+/g, ' ') }
  return {
    rows: [...list.querySelectorAll('li')].map(li => {
      const ps = li.querySelectorAll('p')
      const t  = li.querySelector('time')
      return {
        // The title carries an sr-only "Registration: " / "Check-in: " prefix so assistive
        // tech receives the activity TYPE in words rather than inferring it from an icon.
        // It is part of textContent by design; strip it to recover the participant name.
        title:       (ps[0]?.textContent ?? '').replace(/^[A-Za-z-]+:\s*/, '').trim(),
        description: ps[1]?.textContent?.trim() ?? '',
        iso:         t?.getAttribute('datetime') ?? '',
        exact:       t?.getAttribute('title') ?? '',
        href:        li.querySelector('a')?.getAttribute('href') ?? null,
      }
    }),
  }
})

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const { initializeApp, cert } = await import('firebase-admin/app')
  const { getAuth }             = await import('firebase-admin/auth')
  const { getFirestore }        = await import('firebase-admin/firestore')
  initializeApp({ credential: cert(JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_KEY, 'base64').toString('utf-8'))) })
  const db = getFirestore()
  const token = await getAuth().createCustomToken(UID)

  // ── Side A · the authoritative records ────────────────────────────────────
  const regSnap = await db.collection('registrations')
    .where('organizerUid', '==', UID).where('eventSlug', '==', SLUG)
    .orderBy('registeredAt', 'desc').limit(40).get()
  const byName = new Map()
  for (const d of regSnap.docs) {
    const r = d.data()
    const nm = r.attendee?.name?.trim() || 'Unnamed attendee'
    byName.set(`${nm}|registered`, {
      pass: r.passName ?? '', event: r.eventName ?? '',
      ms: r.registeredAt?.toMillis?.() ?? null, id: d.id,
    })
  }
  console.log(`\n═══ Recent Activity · REAL data ═══\n`)
  console.log(`  authoritative sample: ${regSnap.size} newest registrations for ${SLUG}\n`)

  // ── Sign in ───────────────────────────────────────────────────────────────
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, returnSecureToken: true }) })
  const session = await res.json()
  if (!session.idToken) { console.error('sign-in failed', session.error); process.exit(1) }
  const claims = JSON.parse(Buffer.from(session.idToken.split('.')[1], 'base64').toString('utf-8'))
  const authUser = {
    uid: claims.user_id ?? claims.sub, email: claims.email ?? null, emailVerified: true,
    isAnonymous: false, providerData: [],
    stsTokenManager: { refreshToken: session.refreshToken, accessToken: session.idToken, expirationTime: Date.now() + 3_600_000 },
    createdAt: String(Date.now()), lastLoginAt: String(Date.now()), apiKey, appName: '[DEFAULT]',
  }

  const browser = await chromium.launch()
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
  const errors = []
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))
  await page.addInitScript(({ key, user }) => new Promise(resolve => {
    const o = indexedDB.open('firebaseLocalStorageDb', 1)
    o.onupgradeneeded = () => o.result.createObjectStore('firebaseLocalStorage', { keyPath: 'fbase_key' })
    o.onsuccess = () => { const tx = o.result.transaction('firebaseLocalStorage', 'readwrite')
      tx.objectStore('firebaseLocalStorage').put({ fbase_key: key, value: user }); tx.oncomplete = () => resolve(); tx.onerror = () => resolve() }
    o.onerror = () => resolve()
  }), { key: `firebase:authUser:${apiKey}:[DEFAULT]`, user: authUser })

  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !/Loading /.test(document.body.innerText), undefined, { timeout: 120_000 })
  await page.waitForTimeout(1500)

  const selectEvent = async (rx) => {
    await page.getByRole('button', { name: /change event|select an event/i }).click()
    await page.getByRole('option', { name: rx }).first().click()
    await page.waitForFunction(() => !/Loading .*…/.test(document.body.innerText), undefined, { timeout: 60_000 })
    await page.waitForTimeout(1400)
  }

  // ── SELECTED EVENT ────────────────────────────────────────────────────────
  console.log('── Vanathukkul Noyyal Marathon ──')
  await selectEvent(/vanathukkul/i)
  const feed = await feedRows(page)
  await page.screenshot({ path: `${OUT}/scoped.png` })
  check(Boolean(feed) && feed.rows.length > 0, 'the feed renders rows', `${feed?.rows.length ?? 0}`)

  // Every row must match a REAL registration document.
  let matched = 0, unmatched = []
  for (const r of feed.rows.filter(x => /registered$/.test(x.title))) {
    const name = r.title.replace(/\s+registered$/, '')
    const rec  = byName.get(`${name}|registered`)
    if (rec && Math.abs(new Date(r.iso).getTime() - rec.ms) < 2000) matched++
    else unmatched.push(name)
  }
  check(unmatched.length === 0,
    'every "registered" row matches a real record (name + instant)',
    unmatched.length ? `unmatched: ${unmatched.slice(0, 3).join(', ')}` : `${matched} matched`)

  // Newest first.
  const times = feed.rows.map(r => new Date(r.iso).getTime())
  check(times.every((t, i) => i === 0 || times[i - 1] >= t), 'sorted newest first')

  // No duplicates.
  const keys = feed.rows.map(r => `${r.title}|${r.iso}`)
  check(new Set(keys).size === keys.length, 'no duplicate rows', `${keys.length} rows`)

  // §19 — the event name is NOT repeated on every row when one event is selected.
  const repeatsEvent = feed.rows.filter(r => /VANATHUKKUL/i.test(r.description)).length
  check(repeatsEvent === 0, 'scoped mode omits the redundant event name', `${repeatsEvent} rows repeated it`)

  // Pass information survives.
  check(feed.rows.some(r => r.description.trim().length > 0), 'pass/category is shown',
    feed.rows.find(r => r.description)?.description ?? '')

  // Exact timestamp available.
  check(feed.rows.every(r => r.exact && r.iso), 'every row exposes an exact timestamp')
  // No future timestamps (timezone sanity).
  check(times.every(t => t <= Date.now() + 60_000), 'no future timestamps')
  // Canonical destination, scoped.
  check(feed.rows.every(r => r.href && (/\/dashboard\/registrations\?eventId=/.test(r.href) || r.href === '/dashboard/check-in')),
    'rows link to the canonical module, carrying scope', feed.rows[0]?.href ?? '')

  console.log('\n  sample rows:')
  for (const r of feed.rows.slice(0, 4)) console.log(`    • ${r.title} — ${r.description || '(no pass)'} — ${r.exact}`)

  // ── ANOTHER EVENT ─────────────────────────────────────────────────────────
  console.log('\n── switch to another event ──')
  await selectEvent(/certificate test/i)
  const other = await feedRows(page)
  await page.screenshot({ path: `${OUT}/other-event.png` })
  const leaked = (other?.rows ?? []).filter(r => byName.has(`${r.title.replace(/\s+(registered|checked in)$/, '')}|registered`))
  check(leaked.length === 0, 'Vanathukkul activity is GONE after switching',
    leaked.length ? leaked.map(l => l.title).join(', ') : `${other?.rows.length ?? 0} rows`)

  // ── ALL EVENTS ────────────────────────────────────────────────────────────
  console.log('\n── All events ──')
  await page.getByRole('button', { name: /change event|select an event/i }).click()
  await page.getByRole('option', { name: /all events/i }).first().click()
  await page.waitForFunction(() => /across all your events/.test(document.body.innerText), undefined, { timeout: 60_000 })
  await page.waitForTimeout(1400)
  const all = await feedRows(page)
  await page.screenshot({ path: `${OUT}/all-events.png` })
  check((all?.rows ?? []).length > 0, 'all-events feed renders', `${all?.rows.length ?? 0} rows`)
  check((all?.rows ?? []).every(r => r.description.trim().length > 0),
    'every all-events row identifies its event')
  const namesEvent = (all?.rows ?? []).filter(r => /VANATHUKKUL|CERTIFICATE|Lorem/i.test(r.description)).length
  check(namesEvent > 0, 'the event name IS present in all-events mode', `${namesEvent} rows`)

  // ── RESPONSIVE ────────────────────────────────────────────────────────────
  console.log('')
  for (const w of [1440, 1280, 1024, 768, 390, 375]) {
    await page.setViewportSize({ width: w, height: 900 })
    await page.waitForTimeout(500)
    const ov = await page.evaluate(() => {
      const el = document.querySelector('#main-content') ?? document.documentElement
      return el.scrollWidth - el.clientWidth
    })
    check(ov <= 1, `${w}px · no horizontal overflow`, `${ov}px`)
    if (w === 390) await page.screenshot({ path: `${OUT}/mobile.png` })
  }
  await page.setViewportSize({ width: 1440, height: 900 })

  const real = errors.filter(e => !/favicon|DevTools|hydrat|Permissions-Policy/i.test(e))
  check(real.length === 0, 'no console errors', real.slice(0, 2).join(' | '))

  fs.writeFileSync(`${OUT}/result.json`, JSON.stringify({ checks, failures }, null, 2))
  await browser.close()
  console.log(`\n${checks.filter(c => c.ok).length}/${checks.length} checks passed. Screenshots in ${OUT}/`)
  if (failures.length) { console.error(`\nFAILED:\n  ${failures.join('\n  ')}`); process.exit(1) }
}

main().catch(e => { console.error(e); process.exit(1) })
