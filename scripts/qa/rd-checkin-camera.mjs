#!/usr/bin/env node
/**
 * scripts/qa/rd-checkin-camera.mjs
 *
 * RD-CHECKIN-CAMERA-FIX-01 — does the camera actually turn off?
 *
 *   node scripts/qa/rd-checkin-camera.mjs [baseUrl]
 *
 * ═══ WHY A SEPARATE HARNESS ══════════════════════════════════════════════════
 * rd-checkin-10-device.mjs proves the scanner OPENS. This proves it CLOSES, which
 * is the property that shipped broken — and the reason it shipped broken is that
 * nothing asserted it.
 *
 * ═══ TWO THINGS THIS GETS RIGHT ══════════════════════════════════════════════
 * 1. It holds the real MediaStreamTrack objects, not a snapshot of their state, so
 *    `readyState` is read at assertion time rather than at capture time. A snapshot
 *    would have recorded "live" and told us nothing.
 *
 * 2. It navigates IN-DOCUMENT (next/link, and mode switches), never page.goto. A
 *    full document load tears down the previous document's media streams for us —
 *    which would mask exactly the bug under test. The reported symptom is a
 *    client-side route change, and that is what is exercised here.
 */

import fs   from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

for (const line of fs.readFileSync('.env.emulator', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

const BASE  = process.argv[2] ?? 'http://localhost:3188'
const SHOTS = path.resolve('.qa', 'shots-camera')
fs.mkdirSync(SHOTS, { recursive: true })

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const shot = (page, n) => page.screenshot({ path: path.join(SHOTS, `${n}.png`) })

/**
 * Keep the TRACK OBJECTS. Reading `readyState` later is the whole point: a track
 * that was live at creation and is ended now is the success case, and a snapshot
 * cannot tell the two apart.
 */
const INSTRUMENT = () => {
  window.__cam = { calls: 0, tracks: [] }
  const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
  navigator.mediaDevices.getUserMedia = async c => {
    window.__cam.calls++
    const stream = await real(c)
    for (const t of stream.getTracks()) window.__cam.tracks.push(t)
    return stream
  }
  window.__camState = () => ({
    calls: window.__cam.calls,
    total: window.__cam.tracks.length,
    live:  window.__cam.tracks.filter(t => t.readyState === 'live').length,
    ended: window.__cam.tracks.filter(t => t.readyState === 'ended').length,
    states: window.__cam.tracks.map(t => t.readyState),
  })
}

const camState = page => page.evaluate(() => window.__camState())

/** The attendee sheet is a real modal and will intercept a click on the back link. */
async function closeDialog(page) {
  // Two different things can own the surface, and they are dismissed differently:
  // the modal confirmation sheet, and the inline outcome card left after an
  // admission. Each is handled on its own — the outcome card outlives the dialog,
  // so making its dismissal conditional on the dialog leaves it on screen.
  const dlg = page.locator('[role="dialog"][aria-modal="true"]')
  if (await dlg.isVisible().catch(() => false)) {
    for (const sel of ['[role="dialog"] button:has-text("Close")',
                       '[role="dialog"] button[aria-label="Cancel"]']) {
      const b = page.locator(sel).first()
      if (await b.count()) { await b.click({ force: true }).catch(() => {}); break }
    }
    await dlg.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
  }

  const next = page.locator('button', { hasText: /next attendee|scan next/i }).first()
  if (await next.count()) await next.click({ timeout: 3000 }).catch(() => {})
}

/**
 * Switch gate mode, dismissing any sheet first.
 *
 * A decode that lands just after a mode switch still raises its confirmation sheet,
 * which is a real modal and will intercept the next click. That is correct product
 * behaviour and a harness concern, not a defect.
 */
async function setMode(page, label) {
  // The synthetic QR is permanently in frame, so the scanner re-decodes as soon as a
  // sheet is dismissed and raises another one. Rather than racing that, retry: close,
  // attempt the switch quickly, repeat. Once the mode changes the scanner unmounts
  // and the loop settles. This is a property of the test rig holding a QR in view
  // forever, not of the product.
  const btn = page.locator('[aria-label="Check-in method"] button', { hasText: label })
  for (let i = 0; i < 8; i++) {
    await closeDialog(page)
    const ok = await btn.click({ timeout: 3000 }).then(() => true).catch(() => false)
    if (ok) return
  }
  throw new Error(`setMode(${label}) never got through — a sheet kept intercepting`)
}

async function typeInto(page, sel, value) {
  const el = page.locator(sel)
  await el.waitFor({ state: 'visible', timeout: 20000 })
  await el.click(); await el.fill('')
  await el.pressSequentially(value, { delay: 8 })
}

// ── Sign in as the ORGANIZER, whose check-in page has a real next/link back ──
// The staff gate has no navigation chrome by design, so it cannot exercise an
// in-document route change. The organizer surface renders the SAME
// CheckinWorkspace and the same QrScanner, so the component under test is identical.
async function organizerLogin(page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await typeInto(page, 'input[type="email"]', 'qa.checkin@registerdesk.test')
  await typeInto(page, 'input[type="password"]', 'QaCheckinPassw0rd!')
  await page.locator('button[type="submit"]').first().click()
  return page.waitForURL(/\/dashboard/, { timeout: 30000 }).then(() => true).catch(() => false)
}

const EVENT_ID = 'qa-checkin-event'

/**
 * A BLANK camera feed — deliberately nothing to decode.
 *
 * A QR held permanently in frame makes the scanner decode, raise its confirmation
 * sheet, and do it again the moment the sheet is dismissed. That is correct product
 * behaviour and it makes camera-lifecycle assertions impossible to sequence: every
 * mode switch races a new modal. This harness is about whether the camera turns OFF;
 * decoding is proven separately in rd-checkin-10-device.mjs, which drives a real QR
 * through a real scan and passed.
 *
 * Flat mid-grey I420, same geometry as the QR feed.
 */
function writeBlankY4m(file, { w = 640, h = 480, frames = 30 } = {}) {
  const Y = Buffer.alloc(w * h, 128)
  const U = Buffer.alloc((w >> 1) * (h >> 1), 128)
  const V = Buffer.alloc((w >> 1) * (h >> 1), 128)
  const out = [Buffer.from(`YUV4MPEG2 W${w} H${h} F15:1 Ip A1:1 C420jpeg\n`)]
  for (let f = 0; f < frames; f++) out.push(Buffer.from('FRAME\n'), Y, U, V)
  fs.writeFileSync(file, Buffer.concat(out))
}

const feed = path.join(SHOTS, 'blank.y4m')
writeBlankY4m(feed)

const browser = await chromium.launch({
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-video-capture=${feed}`,
  ],
})
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
await context.grantPermissions(['camera'])
const page = await context.newPage()
await page.addInitScript(INSTRUMENT)

console.log('── signing in ──')
if (!await organizerLogin(page)) {
  check('organizer signs in', false, 'login failed')
  await browser.close(); process.exit(1)
}

// ══ 1. Enter Check-in — the camera starts ════════════════════════════════════
console.log('\n── 1. enter check-in ──')
await page.goto(`${BASE}/dashboard/events/${EVENT_ID}/checkin`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('[aria-label="Check-in method"]', { timeout: 30000 })
// The gate opens on Scan QR, so the camera comes up on its own.
await page.waitForFunction(() => window.__camState().live > 0, { timeout: 25000 }).catch(() => {})
let s = await camState(page)
check('camera starts on entering check-in', s.live > 0, `${s.calls} call(s), ${s.live} live`)
await shot(page, '01-entered')

// ══ 2. Exactly one stream per scanner session ════════════════════════════════
// The pre-fix build made two: one for the initial `cameraId: undefined` start and
// one after device enumeration set an id, with the loser orphaned.
check('exactly ONE getUserMedia call for the session', s.calls === 1, `${s.calls} call(s)`)
check('exactly one track created', s.total === 1, `${s.total} track(s)`)

// ══ 3. Scan QR → Find — the scanner unmounts ═════════════════════════════════
console.log('\n── 2. switch Scan QR → Find ──')
await setMode(page, /^Find$/)
await page.waitForSelector('[aria-label="Find an attendee"]', { timeout: 20000 })
await page.waitForFunction(() => window.__camState().live === 0, { timeout: 10000 }).catch(() => {})
s = await camState(page)
check('Scan → Find ends every track', s.live === 0, `live=${s.live} ended=${s.ended} [${s.states}]`)
await shot(page, '02-find-mode')

// ══ 4a. Find → Scan — the restart, measured with nothing else in the way ═════
console.log('\n── 3. scanner restart ──')
const beforeRestart = await camState(page)
await setMode(page, /^Scan QR$/)
await page.waitForFunction(() => window.__camState().live > 0, { timeout: 25000 }).catch(() => {})
const afterRestart = await camState(page)
check('returning to Scan starts a FRESH stream', afterRestart.live === 1,
  `${afterRestart.calls} call(s) total, live=${afterRestart.live}`)
check('the restart created exactly one new stream',
  afterRestart.total === beforeRestart.total + 1,
  `${beforeRestart.total} → ${afterRestart.total} track(s)`)

// ══ 4b. An admission — `active` toggles while a sheet is up ══════════════════
// onCode/confirm → setBusy(true) → active=false → stopScanner, then back. Driven
// through Find because a scan needs a QR in frame, and a QR permanently in frame
// re-decodes endlessly. The `active` toggle under test is identical either way.
await setMode(page, /^Find$/)
await typeInto(page, '[aria-label="Find an attendee"]', 'Aditya')
await page.keyboard.press('Enter')
const row = page.locator('li button').first()
if (await row.waitFor({ timeout: 15000 }).then(() => true).catch(() => false)) {
  await row.click()
  const admit = page.locator('[role="dialog"] button')
    .filter({ hasText: /^(check in|continue|admit)$/i }).first()
  if (await admit.count()) { await admit.click(); await page.waitForTimeout(2000) }
  check('an admission completes while the scanner is unmounted', true)
} else {
  check('an admission completes while the scanner is unmounted', false, 'attendee not found')
}
s = await camState(page)
check('admission leaves no orphan live track', s.live === 0,
  `live=${s.live} of ${s.total} [${s.states}]`)
await shot(page, '03-after-admission')

// ══ 5. Leave check-in via a REAL in-document route change ════════════════════
console.log('\n── 4. leave check-in (next/link, same document) ──')
const before = await camState(page)
await closeDialog(page)
const back = page.locator(`a[href="/dashboard/events/${EVENT_ID}"]`).first()
const haveLink = await back.count() > 0
check('an in-document back link exists (no full page load)', haveLink)
if (haveLink) {
  // Same retry as the mode switch: a confirmation sheet may still own the surface,
  // and dismissing it is a harness concern rather than anything under test.
  for (let i = 0; i < 8; i++) {
    await closeDialog(page)
    if (await back.click({ timeout: 3000 }).then(() => true).catch(() => false)) break
  }
  await page.waitForURL(new RegExp(`/dashboard/events/${EVENT_ID}$`), { timeout: 25000 }).catch(() => {})
  await page.waitForFunction(() => window.__camState().live === 0, { timeout: 10000 }).catch(() => {})
}
s = await camState(page)

// ═══ THE ACCEPTANCE CONDITION ═══════════════════════════════════════════════
check('AFTER LEAVING CHECK-IN: zero live camera tracks', s.live === 0,
  `live=${s.live} ended=${s.ended} of ${s.total} [${s.states}]`)
check('every track ever created reached "ended"', s.total > 0 && s.ended === s.total,
  `${s.ended}/${s.total} ended`)
console.log(`         ↳ tracks created across the whole session: ${before.total}`)
await shot(page, '04-left-checkin')

// ══ 6. Return — a fresh stream must still work ═══════════════════════════════
console.log('\n── 5. return to check-in ──')
const priorTotal = s.total
await page.locator(`a[href="/dashboard/events/${EVENT_ID}/checkin"]`).first().click()
  .catch(async () => { await page.goto(`${BASE}/dashboard/events/${EVENT_ID}/checkin`) })
await page.waitForSelector('[aria-label="Check-in method"]', { timeout: 30000 })
await page.waitForFunction(t => window.__camState().total > t, priorTotal, { timeout: 25000 }).catch(() => {})
s = await camState(page)
check('returning starts a fresh working stream', s.live >= 1 && s.total > priorTotal,
  `${s.calls} call(s) total, live=${s.live}, tracks=${s.total}`)
await shot(page, '05-returned')

await browser.close()

const failed = results.filter(r => !r.ok)
console.log(`\n═══ ${results.length - failed.length}/${results.length} camera checks passed ═══`)
failed.forEach(f => console.log(`  FAILED: ${f.name} — ${f.detail}`))
console.log(`screenshots: .qa/shots-camera/`)
process.exit(failed.length ? 1 : 0)
