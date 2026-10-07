#!/usr/bin/env node
/**
 * scripts/qa/rd-checkin-07-ui.mjs
 *
 * RD-CHECKIN-07 — the browser half of the production smoke test. Real Chromium, real
 * production backend, at desktop and mobile widths.
 *
 *   node scripts/qa/rd-checkin-07-ui.mjs <run> [baseUrl]
 *
 * Screenshots land in .qa/shots-<run>/ (gitignored).
 *
 * The staff accounts are created with mustChangePassword, so the FIRST login here
 * genuinely walks the forced password-change stage. The new password is written back
 * into the fixture manifest, otherwise every later run — and the API suite — would
 * still be holding the temporary one.
 */

import fs   from 'node:fs'
import path from 'node:path'
import { chromium, devices } from 'playwright'

// RD-PREPROD · this script performs real check-ins and staff password changes through the app against PRODUCTION (registerdesk-c91a3). It must never start by
// accident: the operator confirms the project explicitly in the environment.
if (process.env.RD_CONFIRM_PROD_PROJECT !== 'registerdesk-c91a3') {
  console.error('Refusing to run: set RD_CONFIRM_PROD_PROJECT=registerdesk-c91a3 to confirm this targets production.')
  process.exit(2)
}


const run  = process.argv[2]
const BASE = process.argv[3] ?? 'http://localhost:3199'
if (!run) { console.error('usage: rd-checkin-07-ui.mjs <run> [baseUrl]'); process.exit(2) }

const mpath = path.resolve('.qa', `${run}.fixture.json`)
const m     = JSON.parse(fs.readFileSync(mpath, 'utf8'))
const E1    = m.events[0]
const gate  = m.staff.find(s => s.role === 'checkin_staff')
const SHOTS = path.resolve('.qa', `shots-${run}`)
fs.mkdirSync(SHOTS, { recursive: true })

const results = []
function check(phase, name, ok, detail = '') {
  results.push({ phase, name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${phase}] ${name}${detail ? ` — ${detail}` : ''}`)
}
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false })

/**
 * Type into a controlled React input the way a person does.
 *
 * `fill()` writes the DOM value in one shot, which can land BEFORE hydration attaches
 * the change handler — the field then looks filled while React state is still empty,
 * and the form rejects a perfectly valid username. Typing after an explicit click,
 * then reading the value back, removes that race instead of sleeping through it.
 */
async function typeInto(page, selector, value) {
  const el = page.locator(selector)
  await el.waitFor({ state: 'visible', timeout: 20000 })
  await el.click()
  await el.fill('')
  await el.pressSequentially(value, { delay: 8 })
  const got = await el.inputValue()
  if (got !== value) throw new Error(`typeInto(${selector}): expected ${JSON.stringify(value)}, got ${JSON.stringify(got)}`)
}

/**
 * Close any open attendee dialog before touching the mode switcher.
 *
 * The confirmation sheet is a real modal (`aria-modal="true"`) covering the whole
 * viewport, so a click on a tab behind it is correctly intercepted. Escape is the
 * keyboard affordance a modal is expected to honour; the button fallback exists so a
 * modal that does not is reported rather than hung on.
 */
async function closeDialog(page) {
  const dlg = page.locator('[role="dialog"][aria-modal="true"]')
  if (!(await dlg.isVisible().catch(() => false))) return true
  // The sheet has an explicit Close and an X labelled Cancel; use them rather than
  // Escape, which this modal does not treat as a dismissal.
  for (const sel of ['[role="dialog"] button:has-text("Close")', '[role="dialog"] button[aria-label="Cancel"]']) {
    const btn = page.locator(sel).first()
    if (await btn.count()) {
      await btn.click({ force: true }).catch(() => {})
      if (await dlg.waitFor({ state: 'hidden', timeout: 5000 }).then(() => true).catch(() => false)) return true
    }
  }
  return false
}

/** Switch gate mode, clearing any modal that would swallow the click. */
async function setMode(page, label) {
  await closeDialog(page)
  await page.locator('[aria-label="Check-in method"] button', { hasText: label }).click()
}

/** Sign a staff account in, walking the forced password change on first use. */
async function staffLogin(page, staff, label) {
  await page.goto(`${BASE}/staff/login`, { waitUntil: 'domcontentloaded' })
  await typeInto(page, '#staff-username', staff.username)
  await typeInto(page, '#staff-password', staff.password)
  await page.click('button[type="submit"]')

  // Either we land on the gate, or we are asked for a new password first.
  const changed = await page.waitForSelector('#staff-new', { timeout: 8000 }).catch(() => null)
  if (changed) {
    const next = `Qa${Math.random().toString(36).slice(2, 12)}!7`
    await typeInto(page, '#staff-new', next)
    await typeInto(page, '#staff-confirm', next)
    await page.click('button[type="submit"]')
    staff.password = next
    fs.writeFileSync(mpath, JSON.stringify(m, null, 2))   // keep the manifest truthful
    console.log(`         ↳ ${label}: forced password change completed (manifest updated)`)

    // By design the app does not carry the old session forward — it says "Password
    // changed. Please sign in again." So sign in a second time with the new secret.
    await page.waitForSelector('#staff-username', { timeout: 15000 }).catch(() => null)
    await typeInto(page, '#staff-username', staff.username)
    await typeInto(page, '#staff-password', staff.password)
    await page.click('button[type="submit"]')
  }
  const landed = await page.waitForURL(/\/ops\//, { timeout: 20000 }).then(() => true).catch(() => false)
  if (!landed) {
    await shot(page, `${label}-LOGIN-FAILED`)
    const text = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 400)
    console.log(`         ↳ ${label}: did NOT reach /ops — url=${page.url().replace(BASE, '')}`)
    console.log(`         ↳ page text: ${text}`)
  }
  return landed
}

/**
 * Reset the UI target to "not admitted" through the real organizer undo endpoint, so
 * the suite is re-runnable without a back door. Failures are ignored: on a first run
 * the attendee is not checked in and undo legitimately refuses.
 */
async function resetTarget(ticketCode) {
  const key = process.env.NEXT_PUBLIC_FIREBASE_API_KEY
  if (!key) return
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${key}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: m.organizer.email, password: m.organizer.password, returnSecureToken: true }),
  }).then(x => x.json()).catch(() => null)
  if (!r?.idToken) return
  await fetch(`${BASE}/api/checkin/undo`, {
    method: 'POST',
    headers: { authorization: `Bearer ${r.idToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ticketCode }),
  }).catch(() => {})
}

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const mm = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/)
  if (mm && !process.env[mm[1]]) process.env[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, '')
}

// r2 is the attendee that HAS a BIB and is not used by the API suite. An attendee
// with no identifier cannot be admitted in one step on this event — the gate asks for
// a BIB first — so the admit path must be driven by someone who already holds one.
const TARGET_TICKET = `RD-${E1.eventId.slice(-4).toUpperCase()}0002`
const TARGET_NAME   = 'Aarti Bhatt'
await resetTarget(TARGET_TICKET)

const browser = await chromium.launch()

// ══ Desktop ══════════════════════════════════════════════════════════════════
for (const profile of [
  { name: 'desktop', ctx: { viewport: { width: 1440, height: 900 } } },
  { name: 'mobile',  ctx: { ...devices['Pixel 7'] } },
]) {
  console.log(`\n── Phase 3/13 — ${profile.name} ──`)
  // Per PROFILE, not per run: the desktop pass admits this attendee, so the mobile
  // pass would otherwise open the already-checked-in branch and find no admit control.
  await resetTarget(TARGET_TICKET)
  const context = await browser.newContext(profile.ctx)
  const page = await context.newPage()

  // 1. invalid credentials are rejected
  await page.goto(`${BASE}/staff/login`, { waitUntil: 'domcontentloaded' })
  await typeInto(page, '#staff-username', gate.username)
  await typeInto(page, '#staff-password', 'definitely-not-the-password')
  await page.click('button[type="submit"]')
  const err = await page.waitForSelector('text=/incorrect|invalid|could not|check your/i', { timeout: 10000 }).catch(() => null)
  check('3', `${profile.name}: invalid credentials are rejected`, !!err,
    err ? (await err.innerText()).slice(0, 60) : 'no error shown')
  check('3', `${profile.name}: rejection did not navigate away from login`,
    page.url().includes('/staff/login'), page.url().replace(BASE, ''))
  await shot(page, `${profile.name}-01-login-rejected`)

  // 2. real login
  await staffLogin(page, gate, profile.name)
  check('3', `${profile.name}: staff login lands on the assigned gate`,
    page.url().includes(`/ops/checkin/${E1.eventId}`), page.url().replace(BASE, ''))

  // The gate opens on Scan QR by design; the typed lookup lives under "Find".
  await page.waitForSelector('[aria-label="Check-in method"]', { timeout: 25000 })
  await shot(page, `${profile.name}-02-workspace-scan`)
  const modes = await page.locator('[aria-label="Check-in method"] button').allInnerTexts()
  check('13', `${profile.name}: gate opens on the scanner with the mode switcher present`,
    modes.length >= 3, modes.join(' | '))

  await setMode(page, /^Find$/)
  await page.waitForSelector('[aria-label="Find an attendee"]', { timeout: 20000 })
  await shot(page, `${profile.name}-02b-find-mode`)

  // 3. no horizontal overflow
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth)
  check('13', `${profile.name}: no horizontal overflow`, overflow <= 1, `${overflow}px`)

  // 4. walk-in must not be offered to a checkin-only operator
  const walkin = await page.locator('[aria-label="Check-in method"] button', { hasText: /^Walk-in$/ }).count()
  check('9', `${profile.name}: walk-in control is not drawn for checkin-only staff`,
    walkin === 0, `${walkin} control(s)`)

  // 5. search → verify → check in
  // The lookup is a FORM — it deliberately does not fire per keystroke, so the query
  // has to be submitted rather than merely typed.
  const search = async q => {
    const box = page.locator('[aria-label="Find an attendee"]')
    await box.click(); await box.fill('')
    await box.pressSequentially(q, { delay: 8 })
    await page.keyboard.press('Enter')
  }
  // Deep-roster proof first: a Z-name is found by prefix, not by scanning a page of rows.
  await search('Zenobia')
  const deep = await page.locator('li button', { hasText: 'Zenobia' }).first()
    .waitFor({ timeout: 15000 }).then(() => true).catch(() => false)
  check('5', `${profile.name}: name search reaches a deep-roster attendee`, deep)
  await shot(page, `${profile.name}-03-search`)

  // The admit path needs someone who already HOLDS an identifier: on an event that
  // issues them, an attendee without one is correctly sent to the BIB prompt instead
  // of being admitted, which is a different flow.
  await search(TARGET_NAME.split(' ')[0])
  const freshName = TARGET_NAME
  const fresh = page.locator('li button', { hasText: TARGET_NAME }).first()
  const hasFresh = await fresh.waitFor({ timeout: 15000 }).then(() => true).catch(() => false)
  check('5', `${profile.name}: the BIB-holding target is found`, hasFresh, TARGET_NAME)

  const found = deep
  if (found) {
    {
      await fresh.click()
      const dlg = page.locator('[role="dialog"][aria-modal="true"]')
      const opened = await dlg.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false)
      check('6', `${profile.name}: verification card opens`, opened)
      const dlgText = opened ? await dlg.innerText() : ''
      check('6', `${profile.name}: card carries ticket code, category and event`,
        /TICKET CODE/i.test(dlgText) && /CATEGORY/i.test(dlgText) && /EVENT/i.test(dlgText))
      await shot(page, `${profile.name}-04-verify`)

      // The BIB must be shown before admitting — this is the operator's verification.
      check('6', `${profile.name}: the held BIB is shown on the card`,
        new RegExp(E1.bibs[1].value).test(dlgText), E1.bibs[1].value)

      const admit = dlg.locator('button', { hasText: /^(check in|continue|admit)$/i }).first()
      if (await admit.count()) {
        const label = (await admit.innerText()).trim()
        await admit.click()
        // NOT a page-wide text match: "CHECKED IN" is also a KPI label in the header,
        // which would pass whether or not anyone was admitted. The recent-admissions
        // strip naming this attendee is unambiguous evidence that the write happened.
        const recent = page.locator('text=RECENT CHECK-INS').locator('..')
        const landed = await recent.locator(`text=${TARGET_NAME.split(' ')[0]}`).first()
          .waitFor({ timeout: 15000 }).then(() => true).catch(() => false)
        check('6', `${profile.name}: admission is reflected in recent check-ins`, landed,
          `pressed "${label}"`)
        await shot(page, `${profile.name}-05-outcome`)

        // duplicate — the same attendee, admitted a moment ago
        await closeDialog(page)
        await setMode(page, /^Find$/)
        await search(freshName.split(' ')[0])
        const again = page.locator('li button', { hasText: freshName }).first()
        if (await again.waitFor({ timeout: 12000 }).then(() => true).catch(() => false)) {
          await again.click()
          const dupText = await page.locator('[role="dialog"][aria-modal="true"]')
            .innerText({ timeout: 10000 }).catch(() => '')
          check('6', `${profile.name}: duplicate shows ALREADY CHECKED IN`,
            /already checked in/i.test(dupText), dupText.replace(/\s+/g, ' ').slice(0, 60))
          check('6', `${profile.name}: the original check-in time stays visible`,
            /already checked in at/i.test(dupText))

          // If the card still offers admission, press it: the SERVER is the authority
          // on duplicates, and what the operator finally sees is what matters.
          const admitAgain = page.locator('[role="dialog"][aria-modal="true"] button')
            .filter({ hasText: /^(check in|continue|admit)$/i }).first()
          if (await admitAgain.count()) {
            await admitAgain.click()
            const out = await page.waitForSelector('text=/already checked in/i', { timeout: 15000 }).catch(() => null)
            check('6', `${profile.name}: re-admitting the same attendee yields ALREADY CHECKED IN`,
              !!out, out ? (await out.innerText()).replace(/s+/g, ' ').slice(0, 50) : 'no already-state')
          }

          // DEFECT PROBE — this is the ONLY place it can be observed. `onUndo` is
          // gated on `confirm.checkedIn` alone, so the control appears exactly when
          // an attendee is already admitted. The server sent canUndo=false for this
          // checkin-only operator, and the workspace's own header comment says that
          // flag decides what is drawn.
          const undoDrawn = await page.locator('[role="dialog"][aria-modal="true"] button')
            .filter({ hasText: /undo/i }).count()
          check('9', `${profile.name}: Undo is NOT drawn to a checkin-only operator on an admitted attendee`,
            undoDrawn === 0, `${undoDrawn} undo control(s)`)
          await shot(page, `${profile.name}-06-duplicate`)
        }
      } else {
        check('6', `${profile.name}: an admit control is offered`, false, 'no admit button in dialog')
      }
    }
  }

  // 5b. Phase 7 — the ticket-code path. This is the SAME admission the scanner
  // produces once a code is decoded, so the parsing and scope rules are exercised
  // even though a physical camera is not available here.
  await closeDialog(page)
  await setMode(page, /^Ticket code$/)
  const codeBox = page.locator('input[placeholder="RD-XXXX-00000"]')
  if (await codeBox.count()) {
    await typeInto(page, 'input[placeholder="RD-XXXX-00000"]', 'NOT-A-REAL-CODE')
    await page.keyboard.press('Enter')
    const bad = await page.waitForSelector('text="Ticket not found."', { timeout: 15000 }).catch(() => null)
    check('7', `${profile.name}: a malformed/unknown ticket code is rejected`, !!bad,
      bad ? (await bad.innerText()).slice(0, 50) : 'no rejection shown')
    await shot(page, `${profile.name}-07-bad-ticket`)

    // The outcome card REPLACES the input, so the gate must be reset with its own
    // "Next attendee" control before another code can be entered. Without this the
    // second probe silently re-reads the first outcome.
    await page.goto(`${BASE}/ops/checkin/${E1.eventId}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[aria-label="Check-in method"]', { timeout: 25000 })
    await setMode(page, /^Ticket code$/)
    const otherTicket = `RD-${m.events[1].eventId.slice(-4).toUpperCase()}0001`
    await typeInto(page, 'input[placeholder="RD-XXXX-00000"]', otherTicket)
    await page.keyboard.press('Enter')
    const wrong = await page.waitForSelector('text=/This ticket is for a different event.|Ticket not found./', { timeout: 15000 }).catch(() => null)
    check('7', `${profile.name}: a valid ticket for ANOTHER event is refused at this gate`, !!wrong,
      wrong ? (await wrong.innerText()).slice(0, 60) : 'no scope refusal shown')
    await shot(page, `${profile.name}-08-wrong-event-ticket`)
  } else {
    check('7', `${profile.name}: ticket-code entry is available`, false, 'no ticket input found')
  }

  // 6. keyboard focus is visible on the search field
  // `:focus-visible` only applies to KEYBOARD focus, so this tabs until a real
  // control is focused rather than calling .focus(), which would report nothing.
  await setMode(page, /^Find$/)
  await page.locator('body').click({ position: { x: 5, y: 5 } })
  let ring = null
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Tab')
    ring = await page.evaluate(() => {
      const el = document.activeElement
      if (!el || el === document.body) return null
      const s = getComputedStyle(el)
      return {
        tag: el.tagName.toLowerCase(),
        label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24),
        outline: s.outlineStyle, width: s.outlineWidth, shadow: s.boxShadow,
      }
    })
    if (ring && (ring.shadow !== 'none' || (ring.outline !== 'none' && ring.outline !== '' && ring.width !== '0px'))) break
  }
  check('13', `${profile.name}: keyboard focus has a visible indicator`,
    !!ring && (ring.shadow !== 'none' || (ring.outline !== 'none' && ring.width !== '0px')),
    ring ? `${ring.tag}[${ring.label}] outline=${ring.outline}/${ring.width} shadow=${String(ring.shadow).slice(0, 24)}` : 'nothing focusable')

  // 7. scope: another event must not open
  await page.goto(`${BASE}/ops/checkin/${m.events[1].eventId}`, { waitUntil: 'domcontentloaded' })
  const denied = await page.waitForSelector('text=/not assigned|do not have access|not found|denied|not authori/i', { timeout: 15000 }).catch(() => null)
  check('4', `${profile.name}: an unassigned event does not render a gate`, !!denied,
    denied ? (await denied.innerText()).slice(0, 50) : 'no refusal shown')
  await shot(page, `${profile.name}-07-scope-denied`)

  await context.close()
}

// ══ Organizer history UI ═════════════════════════════════════════════════════
console.log('\n── Phase 10 — history UI as the organizer ──')
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  const emailBox = page.locator('input[type="email"]').first()
  const opened = await emailBox.waitFor({ timeout: 15000 }).then(() => true).catch(() => false)
  if (!opened) {
    check('10', 'organizer login page reachable', false, 'no email field found')
  } else {
    await emailBox.fill(m.organizer.email)
    await page.locator('input[type="password"]').first().fill(m.organizer.password)
    await page.locator('button[type="submit"]').first().click()
    await page.waitForURL(/\/dashboard/, { timeout: 30000 }).catch(() => {})
    check('10', 'organizer signs in through the real login page', /dashboard/.test(page.url()),
      page.url().replace(BASE, ''))

    await page.goto(`${BASE}/dashboard/events/${E1.eventId}/checkin/history`, { waitUntil: 'domcontentloaded' })
    const undo = await page.waitForSelector('text=/check-?in undone|undone/i', { timeout: 25000 }).catch(() => null)
    check('10', 'history UI renders the ledger including the undo entry', !!undo)
    const name = await page.locator('text=/Zenobia Quartermaine/i').count()
    check('10', 'history UI shows attendee identity', name > 0, `${name} match(es)`)
    const mutate = await page.locator('button', { hasText: /delete|edit|remove/i }).count()
    check('10', 'history UI offers no edit/delete control', mutate === 0, `${mutate} control(s)`)
    await shot(page, 'organizer-08-history')
  }
  await context.close()
}

await browser.close()

const failed = results.filter(r => !r.ok)
console.log(`\n═══ ${results.length - failed.length}/${results.length} UI checks passed ═══`)
failed.forEach(f => console.log(`  FAILED [${f.phase}] ${f.name} — ${f.detail}`))
console.log(`screenshots: .qa/shots-${run}/`)
process.exit(failed.length ? 1 : 0)
