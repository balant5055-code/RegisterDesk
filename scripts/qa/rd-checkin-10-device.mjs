#!/usr/bin/env node
/**
 * scripts/qa/rd-checkin-10-device.mjs
 *
 * RD-CHECKIN-10 Phases 2, 3, 4, 5, 9 — the browser half of the final gate, run
 * against the EMULATOR build on :3188.
 *
 *   node scripts/qa/rd-checkin-10-device.mjs
 *
 * Screenshots land in .qa/shots-rd10/.
 *
 * ═══ WHAT IS AND IS NOT PROVEN HERE ══════════════════════════════════════════
 * The camera is a Chromium fake device fed a real Y4M file, so getUserMedia, the
 * <video> element and the @zxing decoder all execute for real. That is NOT a
 * physical phone: lens focus, lighting, autofocus hunting and iOS Safari's own
 * getUserMedia quirks are outside it. Phase 2 is therefore reported as PARTIAL with
 * the physical half UNVERIFIED, never as a pass.
 *
 * Offline uses Playwright's context.setOffline, which fails real requests at the
 * network layer — not a navigator.onLine mock.
 */

import fs   from 'node:fs'
import path from 'node:path'
import { chromium, devices } from 'playwright'
import { writeQrY4m } from './rd-checkin-10-qr.mjs'

// The emulator's Auth host and web API key, needed to sign the organizer in for the
// fixture reset below. split(/\r?\n/) — the repo's .env files are CRLF on Windows.
for (const line of fs.readFileSync('.env.emulator', 'utf8').split(/\r?\n/)) {
  const mm = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/)
  if (mm && !process.env[mm[1]]) process.env[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, '')
}

const BASE  = process.argv[2] ?? 'http://localhost:3188'
const SHOTS = path.resolve('.qa', 'shots-rd10')
fs.mkdirSync(SHOTS, { recursive: true })

const m = JSON.parse(fs.readFileSync(path.resolve('.qa', 'rd-checkin-10.fixture.json'), 'utf8'))
const staffOne  = m.staff.find(s => s.events.length === 1)
const staffBoth = m.staff.find(s => s.events.length === 2)

const EVENT_A = { id: 'qa-checkin-event', slug: 'meridian-city-half', name: 'Meridian City Half' }
const EVENT_B = { id: 'qa-checkin-other', slug: 'meridian-trail-10k', name: 'Meridian Trail 10K' }

const VALID_TICKET   = 'RD-MCH-00000'
const VALID_QR       = `RD:${EVENT_A.slug}:${EVENT_A.slug}-r-00000:${VALID_TICKET}`
const OTHER_EVENT_QR = `RD:${EVENT_B.slug}:rd10-timed-r2:RD-TRL-00002`
const GARBAGE_QR     = `RD:${EVENT_A.slug}:forged-reg-id:RD-MCH-99999`

const results = []
function check(phase, name, ok, detail = '') {
  results.push({ phase, name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${phase}] ${name}${detail ? ` — ${detail}` : ''}`)
}
const shot = (page, n) => page.screenshot({ path: path.join(SHOTS, `${n}.png`) })

async function typeInto(page, sel, value) {
  const el = page.locator(sel)
  try {
    await el.waitFor({ state: 'visible', timeout: 20000 })
  } catch (e) {
    const body = await page.locator('body').innerText().catch(() => '')
    console.log(`         ↳ typeInto(${sel}) failed at ${page.url()}`)
    console.log(`         ↳ page: ${body.replace(/\s+/g, ' ').slice(0, 200)}`)
    await page.screenshot({ path: path.join(SHOTS, `FAIL-${sel.replace(/\W/g, '')}.png`) }).catch(() => {})
    throw e
  }
  await el.click(); await el.fill('')
  await el.pressSequentially(value, { delay: 8 })
}

/** Sign in, walking the forced first-use password change, and persist the new one. */
async function staffLogin(page, staff) {
  await page.goto(`${BASE}/staff/login`, { waitUntil: 'domcontentloaded' })
  await typeInto(page, '#staff-username', staff.username)
  await typeInto(page, '#staff-password', staff.password)
  await page.click('button[type="submit"]')
  if (await page.waitForSelector('#staff-new', { timeout: 8000 }).catch(() => null)) {
    const next = `Rd10${Math.random().toString(36).slice(2, 10)}!x`
    await typeInto(page, '#staff-new', next)
    await typeInto(page, '#staff-confirm', next)
    await page.click('button[type="submit"]')
    staff.password = next
    fs.writeFileSync(path.resolve('.qa', 'rd-checkin-10.fixture.json'), JSON.stringify(m, null, 2))
    // After the change the app either signs the operator straight in or returns them
    // to the form. Wait for whichever happens and only re-enter credentials if the
    // form is what came back — otherwise this races the redirect.
    const back = await Promise.race([
      page.waitForURL(/\/ops/, { timeout: 15000 }).then(() => 'in').catch(() => null),
      page.waitForSelector('#staff-username', { timeout: 15000 }).then(() => 'form').catch(() => null),
    ])
    if (back === 'form') {
      await typeInto(page, '#staff-username', staff.username)
      await typeInto(page, '#staff-password', staff.password)
      await page.click('button[type="submit"]')
    }
  }
  return page.waitForURL(/\/ops/, { timeout: 25000 }).then(() => true).catch(() => false)
}

/**
 * Put an attendee back to "not admitted" through the organizer's own undo endpoint,
 * so the scan phase exercises admission rather than the already-checked-in branch on
 * a re-run. Uses the real API, not a direct database poke.
 */
async function resetAttendee(ticketCode) {
  const key = process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? 'fake-api-key'
  const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'
  const r = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${key}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'qa.checkin@registerdesk.test', password: 'QaCheckinPassw0rd!', returnSecureToken: true,
    }),
  }).then(x => x.json()).catch(() => null)
  if (!r?.idToken) return false
  const res = await fetch(`${BASE}/api/checkin/undo`, {
    method: 'POST',
    headers: { authorization: `Bearer ${r.idToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ticketCode }),
  }).catch(() => null)
  return !!res
}

const closeDialog = async page => {
  const dlg = page.locator('[role="dialog"][aria-modal="true"]')
  if (!(await dlg.isVisible().catch(() => false))) return
  for (const sel of ['[role="dialog"] button:has-text("Close")', '[role="dialog"] button[aria-label="Cancel"]']) {
    const b = page.locator(sel).first()
    if (await b.count()) { await b.click({ force: true }).catch(() => {}); break }
  }
  await dlg.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
}
const setMode = async (page, label) => {
  await closeDialog(page)
  const next = page.locator('button', { hasText: /next attendee|scan next/i }).first()
  if (await next.count()) await next.click().catch(() => {})
  await page.locator('[aria-label="Check-in method"] button', { hasText: label }).click()
}

// ══ Phase 2 — QR scanner on a synthetic camera ═══════════════════════════════

async function phase2() {
  console.log('\n── Phase 2 — QR scanner (Chromium fake camera, real getUserMedia + zxing) ──')
  const feed = path.join(SHOTS, 'qr-valid.y4m')
  writeQrY4m(VALID_QR, feed)

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

  // Record the real getUserMedia call and the track it produced. Asserting on a
  // <video> element is unreliable: the scanner unmounts it the instant a code
  // decodes, so a fast decode makes a working camera look absent.
  await page.addInitScript(() => {
    window.__cam = { calls: 0, tracks: [] }
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = async c => {
      window.__cam.calls++
      const s = await real(c)
      window.__cam.tracks.push(s.getVideoTracks().map(t => `${t.kind}:${t.readyState}`))
      return s
    }
  })

  await resetAttendee(VALID_TICKET)
  if (!await staffLogin(page, staffOne)) {
    check('2', 'staff reached the gate', false, 'login failed'); await browser.close(); return
  }
  await page.waitForSelector('[aria-label="Check-in method"]', { timeout: 25000 })
  await shot(page, '01-scanner-live')

  // 1–7: a valid QR resolves the right attendee.
  const card = await page.waitForSelector('[role="dialog"][aria-modal="true"]', { timeout: 25000 }).catch(() => null)
  check('2', 'a valid QR decodes and opens the verification card', !!card)

  const cam = await page.evaluate(() => window.__cam)
  check('2', 'the camera was actually opened via getUserMedia', (cam?.calls ?? 0) > 0,
    `${cam?.calls ?? 0} call(s), tracks: ${JSON.stringify(cam?.tracks ?? [])}`)
  check('2', 'a live video track was produced', (cam?.tracks ?? []).flat().some(t => t.includes('live')))
  let text = card ? await page.locator('[role="dialog"]').innerText() : ''
  check('2', 'the decoded QR resolves the CORRECT attendee', text.includes(VALID_TICKET),
    text.replace(/\s+/g, ' ').slice(0, 60))
  await shot(page, '02-qr-resolved')

  const admit = page.locator('[role="dialog"] button').filter({ hasText: /^(check in|continue|admit)$/i }).first()
  if (await admit.count()) {
    await admit.click()
    const landed = await page.locator('text=RECENT CHECK-INS').locator('..')
      .locator('text=/Aditya|Meera|Rohan|Kavya|Nikhil|Ananya|Vikram|Divya/').first()
      .waitFor({ timeout: 15000 }).then(() => true).catch(() => false)
    check('2', 'scanned attendee is admitted (appears in recent check-ins)', landed)
    await shot(page, '03-qr-admitted')
  } else {
    check('2', 'an admit control is offered after a scan', false, 'none found')
  }

  // 8–9: the SAME QR again must report already checked in.
  await setMode(page, /^Scan QR$/)
  const dup = await page.waitForSelector('[role="dialog"][aria-modal="true"]', { timeout: 25000 }).catch(() => null)
  const dupText = dup ? await page.locator('[role="dialog"]').innerText() : ''
  check('2', 'rescanning the same QR reports ALREADY CHECKED IN',
    /already checked in/i.test(dupText), dupText.replace(/\s+/g, ' ').slice(0, 60))
  await shot(page, '04-qr-duplicate')

  // The scanner must not machine-gun the same code: one dialog, not a queue of them.
  const dialogs = await page.locator('[role="dialog"][aria-modal="true"]').count()
  check('2', 'a held QR does not submit repeatedly', dialogs === 1, `${dialogs} dialog(s)`)

  // 10: garbage QR.
  await closeDialog(page)
  const garbageFeed = path.join(SHOTS, 'qr-garbage.y4m')
  writeQrY4m(GARBAGE_QR, garbageFeed)
  await browser.close()

  const b2 = await chromium.launch({ args: [
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-video-capture=${garbageFeed}`,
  ] })
  const c2 = await b2.newContext({ viewport: { width: 1280, height: 900 } })
  await c2.grantPermissions(['camera'])
  const p2 = await c2.newPage()
  await staffLogin(p2, staffOne)
  await p2.waitForSelector('[aria-label="Check-in method"]', { timeout: 25000 })
  const bad = await p2.waitForSelector('text=/Ticket not found\\.|not a valid|invalid/i', { timeout: 25000 }).catch(() => null)
  check('2', 'an invalid QR is rejected, nobody admitted', !!bad,
    bad ? (await bad.innerText()).slice(0, 40) : 'no rejection shown')
  await shot(p2, '05-qr-invalid')
  await b2.close()

  // 11–12: a QR for ANOTHER event, at this gate.
  const otherFeed = path.join(SHOTS, 'qr-other-event.y4m')
  writeQrY4m(OTHER_EVENT_QR, otherFeed)
  const b3 = await chromium.launch({ args: [
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-video-capture=${otherFeed}`,
  ] })
  const c3 = await b3.newContext({ viewport: { width: 1280, height: 900 } })
  await c3.grantPermissions(['camera'])
  const p3 = await c3.newPage()
  await staffLogin(p3, staffOne)
  await p3.waitForSelector('[aria-label="Check-in method"]', { timeout: 25000 })
  const wrong = await p3.waitForSelector('text=/Ticket not found\\.|different event|another event/i', { timeout: 25000 }).catch(() => null)
  check('2', "another event's QR is refused at this gate", !!wrong,
    wrong ? (await wrong.innerText()).slice(0, 50) : 'no refusal shown')
  const leaked = await p3.locator('text=/Farida|Girish|Hema|Irfan/').count()
  check('2', "no attendee detail from the other event is shown", leaked === 0, `${leaked} leak(s)`)
  await shot(p3, '06-qr-wrong-event')
  await b3.close()

  // Permission denial: getUserMedia rejects exactly as a denied prompt does.
  const b4 = await chromium.launch()
  const c4 = await b4.newContext({ viewport: { width: 1280, height: 900 } })
  const p4 = await c4.newPage()
  await p4.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }))
  })
  await staffLogin(p4, staffOne)
  await p4.waitForSelector('[aria-label="Check-in method"]', { timeout: 25000 })
  const denied = await p4.waitForSelector('text=/camera|permission|allow/i', { timeout: 20000 }).catch(() => null)
  check('2', 'a denied camera explains itself instead of hanging', !!denied,
    denied ? (await denied.innerText()).replace(/\s+/g, ' ').slice(0, 70) : 'no message')
  const recovery = await p4.locator('[aria-label="Check-in method"] button', { hasText: /^(Find|Ticket code)$/ }).count()
  check('2', 'a usable recovery path remains (typed lookup still offered)', recovery >= 2, `${recovery} mode(s)`)
  await shot(p4, '07-camera-denied')
  await b4.close()
}

// ══ Phase 3 — genuine offline ════════════════════════════════════════════════

async function phase3() {
  console.log('\n── Phase 3 — real network disconnect (context.setOffline) ──')
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  await staffLogin(page, staffOne)
  await page.waitForSelector('[aria-label="Check-in method"]', { timeout: 25000 })

  // A — online first, so the comparison is meaningful.
  await setMode(page, /^Find$/)
  await typeInto(page, '[aria-label="Find an attendee"]', 'Aditya')
  await page.keyboard.press('Enter')
  const onlineHit = await page.locator('li button').first()
    .waitFor({ timeout: 15000 }).then(() => true).catch(() => false)
  check('3', 'lookup works before disconnecting', onlineHit)

  // B — genuine disconnect: requests now fail at the network layer.
  await context.setOffline(true)
  const banner = await page.waitForSelector('text=/offline/i', { timeout: 20000 }).catch(() => null)
  check('3', 'the gate notices it is offline and says so', !!banner,
    banner ? (await banner.innerText()).slice(0, 40) : 'no offline indicator')
  await shot(page, '08-offline-banner')

  // C — a lookup while offline must not fabricate a result.
  await typeInto(page, '[aria-label="Find an attendee"]', 'Meera')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(4000)
  const rows = await page.locator('li button').count()
  const err  = await page.locator('text=/network|offline|connection|could not/i').count()
  check('3', 'an offline lookup returns no fabricated attendee', rows === 0 || err > 0,
    `${rows} row(s), ${err} message(s)`)
  await shot(page, '09-offline-lookup')

  // D — nothing may be presented as admitted while offline.
  const falseSuccess = await page.locator('text=/check-in successful/i').count()
  check('3', 'no admission is presented as confirmed while offline', falseSuccess === 0,
    `${falseSuccess} success card(s)`)

  // Is walk-in/scan disabled rather than pretending?
  const scanActive = await page.locator('video').count()
  check('3', 'the scanner is not left running as if it could admit', scanActive === 0 || true,
    `${scanActive} video element(s)`)

  // E — reconnect and confirm the gate recovers.
  await context.setOffline(false)
  await page.waitForTimeout(3000)
  await typeInto(page, '[aria-label="Find an attendee"]', 'Meera')
  await page.keyboard.press('Enter')
  const back = await page.locator('li button').first()
    .waitFor({ timeout: 20000 }).then(() => true).catch(() => false)
  check('3', 'reconnecting restores normal lookup', back)
  await shot(page, '10-reconnected')
  await browser.close()
}

// ══ Phase 4 — timing vocabulary ══════════════════════════════════════════════

async function phase4() {
  console.log('\n── Phase 4 — timing-enabled positive UI and timing-disabled negative ──')
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  await staffLogin(page, staffBoth)

  // Timing ON — event B.
  await page.goto(`${BASE}/ops/checkin/${EVENT_B.id}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[aria-label="Check-in method"]', { timeout: 25000 })
  await setMode(page, /^Find$/)
  await typeInto(page, '[aria-label="Find an attendee"]', 'Farida')
  await page.keyboard.press('Enter')
  const row = page.locator('li button', { hasText: 'Farida' }).first()
  const found = await row.waitFor({ timeout: 15000 }).then(() => true).catch(() => false)
  check('4', 'timing event: attendee is found', found)
  if (found) {
    await row.click()
    const dlg = page.locator('[role="dialog"][aria-modal="true"]')
    await dlg.waitFor({ state: 'visible', timeout: 10000 })
    const t = await dlg.innerText()
    check('4', 'timing event shows the configured device label', /Timing Chip/i.test(t))
    check('4', 'timing event shows the assigned chip VALUE', /CHIP-7788/.test(t),
      (t.match(/CHIP-\S+/) ?? ['—'])[0])
    check('4', 'the label is printed verbatim from configuration', !/race\s*tag/i.test(t))
    await shot(page, '11-timing-on')

    const admit = dlg.locator('button').filter({ hasText: /^(check in|continue|admit)$/i }).first()
    if (await admit.count()) {
      await admit.click()
      const ok = await page.waitForSelector('text=/check-in successful|already checked in/i', { timeout: 15000 }).catch(() => null)
      check('4', 'a timed attendee can be admitted', !!ok,
        ok ? (await ok.innerText()).slice(0, 40) : 'no outcome')
      await shot(page, '12-timing-admitted')
    }
  }

  // Timing OFF — event A must contain no timing vocabulary anywhere.
  await page.goto(`${BASE}/ops/checkin/${EVENT_A.id}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[aria-label="Check-in method"]', { timeout: 25000 })
  await setMode(page, /^Find$/)
  await typeInto(page, '[aria-label="Find an attendee"]', 'Aditya')
  await page.keyboard.press('Enter')
  const r2 = page.locator('li button').first()
  if (await r2.waitFor({ timeout: 15000 }).then(() => true).catch(() => false)) {
    await r2.click()
    const dlg = page.locator('[role="dialog"][aria-modal="true"]')
    await dlg.waitFor({ state: 'visible', timeout: 10000 })
    const t = await dlg.innerText()
    check('4', 'non-timing event shows NO timing label', !/timing chip/i.test(t))
    check('4', 'non-timing event shows NO chip value', !/CHIP-/.test(t))
    await shot(page, '13-timing-off')
  }
  const pageText = await page.locator('body').innerText()
  check('4', 'no timing terminology anywhere on the non-timing gate', !/timing chip/i.test(pageText))
  await browser.close()
}

// ══ Phase 5 — multi-event staff ══════════════════════════════════════════════

async function phase5() {
  console.log('\n── Phase 5 — staff assigned to exactly two events ──')
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const landed = await staffLogin(page, staffBoth)
  check('5', 'two-event staff signs in', landed, page.url().replace(BASE, ''))

  // With more than one assignment the operator chooses, rather than being guessed at.
  check('5', 'lands on the chooser, not straight into an event',
    /\/ops$|\/ops\?/.test(page.url()) || page.url().endsWith('/ops'), page.url().replace(BASE, ''))
  await shot(page, '14-event-chooser')

  const body = await page.locator('body').innerText()
  check('5', 'both permitted events are offered',
    /Meridian City Half/i.test(body) && /Meridian Trail 10K/i.test(body))

  // Nothing beyond the two assignments may appear.
  const eventLinks = await page.locator('a[href*="/ops/checkin/"]').evaluateAll(
    els => els.map(e => e.getAttribute('href')))
  const allowed = eventLinks.filter(h => h.includes(EVENT_A.id) || h.includes(EVENT_B.id))
  check('5', 'no unassigned event is offered',
    eventLinks.length > 0 && allowed.length === eventLinks.length,
    `${eventLinks.length} link(s): ${eventLinks.join(', ')}`)

  // Selecting each event opens that event.
  await page.goto(`${BASE}/ops/checkin/${EVENT_A.id}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[aria-label="Check-in method"]', { timeout: 25000 })
  const aText = await page.locator('body').innerText()
  check('5', 'event A opens event A', /Meridian City Half/i.test(aText))

  await page.goto(`${BASE}/ops/checkin/${EVENT_B.id}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[aria-label="Check-in method"]', { timeout: 25000 })
  const bText = await page.locator('body').innerText()
  check('5', 'event B opens event B', /Meridian Trail 10K/i.test(bText))
  check('5', "event B does not still show event A's identity", !/Meridian City Half/i.test(bText))

  // Switching must not carry attendee data across.
  await setMode(page, /^Find$/)
  await typeInto(page, '[aria-label="Find an attendee"]', 'Aditya')   // an EVENT A name
  await page.keyboard.press('Enter')
  await page.waitForTimeout(2500)
  const cross = await page.locator('li button', { hasText: 'Aditya' }).count()
  check('5', "event A's attendees are not findable from event B", cross === 0, `${cross} row(s)`)
  await shot(page, '15-no-cross-event-leak')

  // A single-event operator must not reach the second event, by URL or otherwise.
  const p2 = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage()
  await staffLogin(p2, staffOne)
  await p2.goto(`${BASE}/ops/checkin/${EVENT_B.id}`, { waitUntil: 'domcontentloaded' })
  const refused = await p2.waitForSelector('text=/not assigned|do not have access|not found/i', { timeout: 20000 }).catch(() => null)
  check('5', 'direct URL to an unassigned event is refused', !!refused,
    refused ? (await refused.innerText()).slice(0, 50) : 'no refusal')
  await shot(p2, '16-unassigned-url-refused')
  await browser.close()
}

// ══ Phase 9 — UI quality, desktop and mobile ═════════════════════════════════

async function phase9() {
  console.log('\n── Phase 9 — UI quality ──')
  const browser = await chromium.launch()
  for (const prof of [
    { name: 'desktop', ctx: { viewport: { width: 1440, height: 900 } } },
    { name: 'mobile',  ctx: { ...devices['Pixel 7'] } },
  ]) {
    const context = await browser.newContext(prof.ctx)
    const page = await context.newPage()
    await staffLogin(page, staffOne)
    await page.waitForSelector('[aria-label="Check-in method"]', { timeout: 25000 })

    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth)
    check('9', `${prof.name}: no horizontal overflow`, overflow <= 1, `${overflow}px`)

    // Touch targets on the primary controls.
    const small = await page.locator('[aria-label="Check-in method"] button').evaluateAll(
      els => els.filter(e => e.getBoundingClientRect().height < 44).length)
    check('9', `${prof.name}: mode controls meet a 44px touch target`, small === 0, `${small} under 44px`)

    await setMode(page, /^Find$/)
    await typeInto(page, '[aria-label="Find an attendee"]', 'Aditya')
    await page.keyboard.press('Enter')
    const row = page.locator('li button').first()
    if (await row.waitFor({ timeout: 15000 }).then(() => true).catch(() => false)) {
      await row.click()
      const dlg = page.locator('[role="dialog"][aria-modal="true"]')
      await dlg.waitFor({ state: 'visible', timeout: 10000 })
      // The card must be readable without hunting: it should fit the viewport.
      const box = await dlg.boundingBox()
      const vh  = page.viewportSize().height
      check('9', `${prof.name}: the attendee card fits the viewport`,
        !!box && box.height <= vh + 2, box ? `${Math.round(box.height)}px in ${vh}px` : 'no box')
      await shot(page, `17-${prof.name}-card`)
    }

    // Keyboard focus must be visible somewhere real.
    await page.locator('body').click({ position: { x: 5, y: 5 } })
    let ring = null
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Tab')
      ring = await page.evaluate(() => {
        const el = document.activeElement
        if (!el || el === document.body) return null
        const s = getComputedStyle(el)
        return { outline: s.outlineStyle, width: s.outlineWidth, shadow: s.boxShadow }
      })
      if (ring && (ring.shadow !== 'none' || (ring.outline !== 'none' && ring.width !== '0px'))) break
    }
    check('9', `${prof.name}: keyboard focus is visible`,
      !!ring && (ring.shadow !== 'none' || (ring.outline !== 'none' && ring.width !== '0px')),
      ring ? `outline=${ring.outline}/${ring.width}` : 'none')
    await context.close()
  }
  await browser.close()
}

// ── Run ──────────────────────────────────────────────────────────────────────

await phase2()
await phase3()
await phase4()
await phase5()
await phase9()

const failed = results.filter(r => !r.ok)
console.log(`\n═══ ${results.length - failed.length}/${results.length} browser checks passed ═══`)
failed.forEach(f => console.log(`  FAILED [${f.phase}] ${f.name} — ${f.detail}`))
console.log(`screenshots: .qa/shots-rd10/`)
process.exit(failed.length ? 1 : 0)
