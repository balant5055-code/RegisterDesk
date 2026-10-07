/* eslint-disable @typescript-eslint/no-unused-expressions --
 * Assertions here read as `condition ? PASS(...) : FAIL(...)`. That is the clearest
 * form for a list of ~60 checks, and the alternative (an if/else per assertion, or a
 * wrapper that hides which branch fired) makes the harness harder to scan than the
 * thing it is testing. Scoped to this dev-tooling file only.
 */
/* RD-CHECKIN-2.0 · browser acceptance pass. EMULATOR ONLY. DEV TOOLING.
 *
 *   node scripts/qa/checkin-acceptance.mjs
 *   node scripts/qa/checkin-acceptance.mjs --mobile
 *
 * Drives the real UI, against the real dev server, against the real emulator.
 * Every assertion here is an OBSERVATION of the rendered page — never of source.
 *
 * Requires, in order:
 *   npm run emu:start
 *   npx dotenv-cli -e .env.emulator -- node scripts/emulator/seed-checkin-qa.mjs
 *   npm run emu:dev          (serves on :3187)
 *
 * Each phase is independently guarded, so a failure in one still leaves evidence
 * for the rest — a harness that aborts on the first mismatch produces one finding
 * per run, which is the slowest possible way to do this.
 */
import { chromium, devices } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MOBILE = process.argv.includes('--mobile')
const BASE   = process.env.QA_BASE ?? 'http://localhost:3187'
const OUT    = process.env.QA_OUT ?? join(process.cwd(), '.qa', MOBILE ? 'mobile' : 'desktop')
mkdirSync(OUT, { recursive: true })

const ORG        = { email: 'qa.checkin@registerdesk.test', password: 'QaCheckinPassw0rd!' }
const EVENT_ID   = 'qa-checkin-event'
const OTHER_ID   = 'qa-checkin-other'
const STAFF_USER = MOBILE ? 'gate.mobile' : 'gate.arun'
const NEW_PW     = 'MeridianGate2026'

const findings = []
let shotNo = 0

const log = (status, id, detail) => {
  findings.push({ status, id, detail })
  console.log(`${status.padEnd(4)} ${id.padEnd(4)} ${detail}`)
}
const PASS = (id, d) => log('PASS', id, d)
const FAIL = (id, d) => log('FAIL', id, d)
const INFO = (id, d) => log('INFO', id, d)

async function shot(page, name) {
  shotNo += 1
  const file = join(OUT, `${String(shotNo).padStart(2, '0')}-${name}.png`)
  await page.screenshot({ path: file }).catch(() => {})
  return file
}

const settle = (page, ms = 800) => page.waitForTimeout(ms)
const text   = page => page.locator('body').innerText().catch(() => '')
/**
 * innerText() returns RENDERED text, and these labels are uppercased by CSS
 * (`text-transform`). The first run reported four missing metrics that were plainly
 * on screen. Case-folded here so the assertion tests the product, not my casing.
 */
const has = (haystack, needle) => haystack.toLowerCase().includes(needle.toLowerCase())
/** The staff layout mounts a Toast live region, so `alert` matches more than one node. */
const alertText = async page =>
  (await page.getByRole('alert').first().innerText().catch(() => '')).trim()

/** Runs one phase; a throw is recorded as a finding rather than ending the run. */
async function phase(name, fn) {
  try { await fn() }
  catch (e) { FAIL(name, `harness error: ${String(e).slice(0, 300)}`) }
}

async function main() {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({
    ...(MOBILE ? devices['iPhone 13'] : { viewport: { width: 1440, height: 900 } }),
  })
  const page = await ctx.newPage()

  const consoleErrors = []
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`))

  let tempPw = null

  // ══ A · the organizer issues a staff credential ════════════════════════
  await phase('A', async () => {
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
    await settle(page, 2500)
    await page.locator('input[type="email"]').first().fill(ORG.email)
    await page.locator('input[type="password"]').first().fill(ORG.password)
    await page.getByRole('button', { name: /sign in|log in/i }).first().click()
    await page.waitForURL(/\/dashboard/, { timeout: 40000 }).catch(() => {})
    await settle(page, 2500)
    PASS('A1', `organizer signed in → ${new URL(page.url()).pathname}`)

    await page.goto(`${BASE}/dashboard/settings/staff`, { waitUntil: 'domcontentloaded' })
    await settle(page, 4000)
    await shot(page, 'staff-accounts')

    const h = await page.getByRole('heading', { name: /staff accounts/i }).count()
    h ? PASS('A2', 'Staff Accounts page renders') : FAIL('A2', 'Staff Accounts heading not found')

    await page.locator('#sa-name').fill(MOBILE ? 'Mobile Gate' : 'Arun Gate')
    await page.locator('#sa-user').fill(STAFF_USER)
    await page.getByRole('button', { name: /check-in lead/i }).click().catch(() => {})
    // Assign ONLY the main event — the other one is the 403 case in phase E.
    await page.getByRole('button', { name: /Meridian City Half Marathon/i }).first().click().catch(() => {})
    await shot(page, 'staff-create-filled')

    await page.getByRole('button', { name: /create account/i }).click()
    await settle(page, 4000)
    await shot(page, 'staff-created')

    const codes = await page.locator('code').allInnerTexts().catch(() => [])
    tempPw = codes.map(c => c.trim()).find(c => /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(c)) ?? null
    tempPw ? PASS('A3', `one-time password shown once: ${tempPw}`)
           : FAIL('A3', `no one-time password rendered; codes seen: ${JSON.stringify(codes).slice(0, 200)}`)

    const roster = await text(page)
    roster.includes(STAFF_USER) ? PASS('A4', 'account appears in the roster')
                                : FAIL('A4', 'account row missing after create')
  })

  // ══ A2 · refusals on the create form ═══════════════════════════════════
  await phase('A-neg', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await settle(page, 3500)
    await page.locator('#sa-name').fill('Duplicate Person')
    await page.locator('#sa-user').fill(STAFF_USER)
    await page.getByRole('button', { name: /Meridian City Half Marathon/i }).first().click().catch(() => {})
    await page.getByRole('button', { name: /create account/i }).click()
    await settle(page, 3000)
    const t = await text(page)
    ;/already taken/i.test(t) ? PASS('A5', 'duplicate username refused')
                             : FAIL('A5', `duplicate username not refused; saw: ${t.slice(0, 200).replace(/\n+/g, ' | ')}`)
    await shot(page, 'staff-duplicate-username')

    await page.reload({ waitUntil: 'domcontentloaded' })
    await settle(page, 3500)
    await page.locator('#sa-name').fill('Unassigned Person')
    await page.locator('#sa-user').fill('gate.unassigned')
    await page.getByRole('button', { name: /create account/i }).click()
    await settle(page, 2500)
    const t2 = await text(page)
    ;/assign at least one event/i.test(t2)
      ? PASS('A6', 'account with no event assignment refused')
      : FAIL('A6', `no-event account not refused; saw: ${t2.slice(0, 200).replace(/\n+/g, ' | ')}`)
    await shot(page, 'staff-no-event-refused')
  })

  // Drop the organizer session completely.
  await ctx.clearCookies()
  await page.evaluate(() => {
    try { localStorage.clear(); sessionStorage.clear(); indexedDB.deleteDatabase('firebaseLocalStorageDb') } catch {}
  }).catch(() => {})

  // ══ B · staff sign-in ══════════════════════════════════════════════════
  await phase('B', async () => {
    await page.goto(`${BASE}/staff/login`, { waitUntil: 'domcontentloaded' })
    await settle(page, 2500)
    await shot(page, 'staff-login')

    const ok = await page.locator('#staff-username').count() && await page.locator('#staff-password').count()
    ok ? PASS('B1', 'staff login renders username + password')
       : FAIL('B1', 'staff login fields missing')

    const signIn = () => page.getByRole('button', { name: /^sign in$/i }).click()

    await page.locator('#staff-username').fill(STAFF_USER)
    await page.locator('#staff-password').fill('definitely-wrong-password')
    await signIn()
    await settle(page, 4000)
    const e1 = await alertText(page)
    ;/incorrect username or password/i.test(e1)
      ? PASS('B2', `wrong password → "${e1}"`)
      : FAIL('B2', `unexpected wrong-password copy: "${e1}"`)
    await shot(page, 'staff-login-wrong-password')

    await page.locator('#staff-username').fill('nobody.at.all')
    await page.locator('#staff-password').fill('definitely-wrong-password')
    await signIn()
    await settle(page, 4000)
    const e2 = await alertText(page)
    e2 === e1 && e1
      ? PASS('B3', 'unknown username gives the identical message — no username oracle')
      : FAIL('B3', `messages differ: "${e1}" vs "${e2}"`)

    if (!tempPw) { FAIL('B4', 'skipped — no temporary password captured in phase A'); return }

    await page.locator('#staff-username').fill(STAFF_USER)
    await page.locator('#staff-password').fill(tempPw)
    await signIn()
    await settle(page, 5000)
    const forced = await page.locator('#staff-new').count()
    forced ? PASS('B4', 'temporary password forces a change before the gate')
           : FAIL('B4', `no forced change; page: ${(await text(page)).slice(0, 200).replace(/\n+/g, ' | ')}`)
    await shot(page, 'staff-forced-password-change')
    if (!forced) return

    const save = () => page.getByRole('button', { name: /save and continue/i }).click()

    await page.locator('#staff-new').fill(NEW_PW)
    await page.locator('#staff-confirm').fill('a-different-password')
    await save()
    await settle(page, 1500)
    const m = await alertText(page)
    ;/do not match/i.test(m) ? PASS('B5', 'password mismatch refused') : FAIL('B5', `mismatch not refused: "${m}"`)
    await shot(page, 'staff-password-mismatch')

    await page.locator('#staff-new').fill('short')
    await page.locator('#staff-confirm').fill('short')
    await save()
    await settle(page, 1500)
    const s = await alertText(page)
    ;/at least/i.test(s) ? PASS('B6', 'too-short password refused') : FAIL('B6', `short password not refused: "${s}"`)

    await page.locator('#staff-new').fill(NEW_PW)
    await page.locator('#staff-confirm').fill(NEW_PW)
    await save()
    await page.waitForURL(/\/ops\//, { timeout: 40000 }).catch(() => {})
    await settle(page, 5000)
    const p = new URL(page.url()).pathname
    p.includes(`/ops/checkin/${EVENT_ID}`)
      ? PASS('B7', `single assignment opens the gate directly → ${p}`)
      : FAIL('B7', `expected /ops/checkin/${EVENT_ID}, landed on ${p}`)
    await shot(page, 'gate-workspace')
  })

  // ══ C · the workspace ══════════════════════════════════════════════════
  await phase('C-header', async () => {
    const t = await text(page)
    ;/Meridian City Half Marathon/.test(t) ? PASS('C1', 'event name in header') : FAIL('C1', 'event name missing')
    for (const label of ['Registered', 'Checked in', 'Remaining', 'Progress']) {
      has(t, label) ? PASS('C2', `metric "${label}" present`) : FAIL('C2', `metric "${label}" missing`)
    }
    const nums = t.match(/Registered\s+([\d,—]+)\s+Checked in\s+([\d,—]+)\s+Remaining\s+([\d,—]+)\s+Progress\s+([\d%—]+)/)
    INFO('C3', nums ? `header → registered=${nums[1]} checkedIn=${nums[2]} remaining=${nums[3]} progress=${nums[4]}`
                    : 'header numbers not parseable from text')
    const tabs = await page.getByRole('tab').allInnerTexts().catch(() => [])
    INFO('C4', `modes: ${JSON.stringify(tabs.map(x => x.replace(/\n/g, ' ')))}`)
    tabs.some(x => /walk-in/i.test(x))
      ? PASS('C5', 'walk-in offered to checkin_lead — permission-driven, not hidden')
      : FAIL('C5', 'walk-in missing for checkin_lead')
  })

  const find = async q => {
    await page.getByRole('tab', { name: /find/i }).click().catch(() => {})
    await settle(page, 700)
    const input = page.getByLabel(/find an attendee/i)
    await input.fill(q)
    await page.getByRole('button', { name: /^find$/i }).click()
    await settle(page, 3000)
  }
  const rowCount = () => page.locator('ul li button').count()

  await phase('C-lookup', async () => {
    await find('Arun')
    await shot(page, 'lookup-ambiguous-name')
    const n = await rowCount()
    n >= 2 ? PASS('C6', `ambiguous name → ${n} rows, operator must choose`)
           : FAIL('C6', `expected >=2 rows for "Arun", got ${n}`)
    const t = await text(page)
    ;/start of the name/i.test(t) ? PASS('C7', 'prefix caveat shown alongside results')
                                 : FAIL('C7', 'prefix caveat missing on a name search')

    await find('Zzzznobody')
    await shot(page, 'lookup-no-results')
    ;/no one found/i.test(await text(page)) ? PASS('C8', 'empty state renders with guidance')
                                           : FAIL('C8', 'no empty state for a genuine miss')

    await find('1000')
    await shot(page, 'lookup-by-bib')
    const b = await rowCount()
    b === 1 ? PASS('C9', 'bib lookup resolves exactly one attendee') : FAIL('C9', `bib lookup → ${b} rows`)

    await find('arun.kumar.5@runners.test')
    const em = await rowCount()
    em === 1 ? PASS('C10', 'exact email lookup resolves one attendee') : FAIL('C10', `email lookup → ${em} rows`)

    await find('RD-MCH-00000')
    const tk = await rowCount()
    tk === 1 ? PASS('C11', 'ticket-code lookup resolves one attendee') : FAIL('C11', `ticket lookup → ${tk} rows`)
  })

  // ── verify → check in ───────────────────────────────────────────────────
  await phase('C-admit', async () => {
    await find('1000')
    await page.locator('ul li button').first().click()
    await settle(page, 3000)
    await shot(page, 'attendee-verification')

    const dlg = await page.getByRole('dialog').count()
    dlg ? PASS('C12', 'verification card is an accessible dialog') : FAIL('C12', 'verification card is not a dialog')

    const t = await text(page)
    ;/Bib Number/.test(t) ? PASS('C13', 'configured identifier label shown verbatim')
                         : FAIL('C13', 'identifier label missing on the card')
    has(t, 'T-shirt size') ? PASS('C14', "organizer's own form answers shown, labelled")
                           : FAIL('C14', 'form answers missing on the card')
    ;/timing|chip/i.test(t) ? FAIL('C15', 'TIMING vocabulary on a non-timing event')
                           : PASS('C15', 'no timing vocabulary on a non-timing event')

    await page.getByRole('button', { name: /^check in$/i }).click()
    await settle(page, 5000)
    await shot(page, 'checkin-success')

    const s = await text(page)
    ;/CHECK-IN SUCCESSFUL/i.test(s) ? PASS('C16', 'success state is unmistakable') : FAIL('C16', 'no explicit success wording')
    ;/Checked in at/i.test(s)       ? PASS('C17', 'success shows the admission time') : FAIL('C17', 'success has no timestamp')
    ;/Checked in by/i.test(s)       ? PASS('C18', 'success names the operator') : FAIL('C18', 'success does not name the operator')
    ;/Recent check-ins/i.test(s)    ? PASS('C19', 'recent check-ins area present') : FAIL('C19', 'recent check-ins area missing')
  })

  // ── duplicate ───────────────────────────────────────────────────────────
  /**
   * Dismisses whatever is on top. The card's dismiss label is "Cancel" for an
   * admissible attendee and "Close" for one who is already in or ineligible — the
   * first run assumed "Close" and then sat waiting 30s for a ticket input that was
   * behind an open dialog.
   */
  const dismiss = async () => {
    for (const re of [/^close$/i, /^cancel$/i, /scan next|next attendee/i]) {
      const b = page.getByRole('button', { name: re }).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); await settle(page, 700); return }
    }
  }

  const byTicket = async code => {
    await dismiss()
    await page.getByRole('tab', { name: /ticket code/i }).click().catch(() => {})
    await settle(page, 700)
    await page.locator('#ci-ticket').fill(code)
    await page.getByRole('button', { name: /find attendee/i }).click()
    await settle(page, 3500)
  }

  await phase('C-duplicate', async () => {
    await byTicket('RD-MCH-00000')
    await shot(page, 'duplicate-already-checked-in')
    const t = await text(page)
    ;/already checked in/i.test(t) ? PASS('C20', 're-resolving an admitted attendee says so, with the original time')
                                  : FAIL('C20', 'no already-checked-in signal on re-resolve')
    const stillOffered = await page.getByRole('button', { name: /^check in$/i }).count()
    stillOffered === 0 ? PASS('C21', 'no Check In action for an already-admitted attendee')
                       : FAIL('C21', 'Check In still offered for an admitted attendee')
    await page.getByRole('button', { name: /^close$/i }).click().catch(() => {})
    await settle(page, 800)

    await byTicket('RD-MCH-00002')
    await shot(page, 'preexisting-already-checked-in')
    ;/already checked in/i.test(await text(page))
      ? PASS('C22', 'pre-existing admission surfaced with its original time')
      : FAIL('C22', 'pre-existing admission not surfaced')
    await page.getByRole('button', { name: /^close$/i }).click().catch(() => {})
    await settle(page, 800)
  })

  // ── refusals ────────────────────────────────────────────────────────────
  await phase('C-refusals', async () => {
    // RD-CHECKIN-QA-01. The FIRST run walked a cancelled registration all the way to
    // a "Continue" button with nothing on the card saying it was cancelled. The
    // server refused at the end, so nobody was admitted — but the operator only
    // learned it after committing, in front of the person. What is asserted now is
    // that the refusal is on the CARD and that no admit action is offered at all.
    for (const [code, id, expected, label] of [
      ['RD-MCH-00090', 'C23', 'Registration cancelled', 'cancelled'],
      ['RD-MCH-00093', 'C24', 'Registration refunded',  'refunded'],
      ['RD-MCH-00091', 'C29', 'Not confirmed yet',      'pending'],
      ['RD-MCH-00092', 'C30', 'Registration rejected',  'rejected'],
    ]) {
      await byTicket(code)
      await shot(page, `refusal-${label}`)
      const t = await text(page)
      has(t, expected) ? PASS(id, `${label} registration refused ON THE CARD ("${expected}")`)
                       : FAIL(id, `${label} not refused on the card; saw: ${t.slice(0, 260).replace(/\n+/g, ' | ')}`)

      const admit = await page.getByRole('button', { name: /^check in$|^continue$/i }).count()
      admit === 0 ? PASS(`${id}b`, `no admit action offered for a ${label} registration`)
                  : FAIL(`${id}b`, `${label} registration still offers an admit action`)
      await dismiss()
    }

    await find('Ravi Bhatt')
    await shot(page, 'lookup-row-ineligible')
    has(await text(page), 'Cancelled')
      ? PASS('C31', 'an ineligible attendee is labelled on the result ROW, before it is opened')
      : FAIL('C31', 'result row does not flag an ineligible attendee')

    await byTicket('RD-NOPE-00000')
    await shot(page, 'unknown-ticket')
    ;/ticket not found/i.test(await text(page)) ? PASS('C25', 'unknown ticket refused clearly')
                                               : FAIL('C25', 'unknown ticket produced no clear refusal')
  })

  // ── identifier prompt ───────────────────────────────────────────────────
  await phase('C-identifier', async () => {
    await byTicket('RD-MCH-00009')
    await shot(page, 'attendee-without-bib')
    ;/not assigned yet/i.test(await text(page))
      ? PASS('C26', 'card names the missing identifier instead of showing a bare input')
      : FAIL('C26', 'no "not assigned yet" affordance')

    await page.getByRole('button', { name: /^continue$/i }).click().catch(() => {})
    await settle(page, 4500)
    await shot(page, 'identifier-prompt')
    ;/bib number/i.test(await text(page)) ? PASS('C27', 'blocking prompt uses the configured label')
                                         : FAIL('C27', 'identifier prompt missing or unlabelled')

    await page.getByRole('button', { name: /cancel/i }).first().click().catch(() => {})
    await settle(page, 2000)
    await shot(page, 'identifier-cancelled')
    const afterCancel = await text(page)
    // Not merely "the words appear somewhere" — the operator must be left on a
    // REFUSAL, not returned to a card still offering Continue. QA found exactly that:
    // the outcome was set but unreachable behind the confirmation card.
    has(afterCancel, 'The attendee was not checked in')
      ? PASS('C28', 'cancelling the prompt leaves the attendee OUT, and says so')
      : FAIL('C28', `cancelling gave no refusal state; saw: ${afterCancel.slice(0, 200).replace(/\n+/g, ' | ')}`)
    const stillOffering = await page.getByRole('button', { name: /^continue$/i }).count()
    stillOffering === 0 ? PASS('C28b', 'the confirmation card is dismissed, not left looping')
                        : FAIL('C28b', 'still offering Continue after cancelling the identifier prompt')
  })

  // ══ D · walk-in ════════════════════════════════════════════════════════
  await phase('D', async () => {
    await dismiss()
    await page.getByRole('tab', { name: /walk-in/i }).click()
    await settle(page, 3500)
    await shot(page, 'walkin-form')

    const submit = () => page.getByRole('button', { name: /register and check in/i }).click()

    await submit()
    await settle(page, 1500)
    const v1 = await alertText(page)
    ;/name/i.test(v1) ? PASS('D1', `walk-in validates before submitting: "${v1}"`)
                     : FAIL('D1', `no walk-in validation: "${v1}"`)
    await shot(page, 'walkin-validation-error')

    // ── The email field is validated by the BROWSER, not by our handler ────
    //
    // `<input type="email">` means Chrome refuses to submit a malformed address and
    // anchors its own bubble to the field, so `submit` never runs. The first pass
    // asserted on OUR copy and reported "email validation missing" while the
    // screenshot plainly showed the browser refusing the submit — the assertion was
    // wrong, not the product. What matters is that a bad address cannot get through.
    //
    // Real keystrokes rather than fill(), so this is what an operator actually does.
    await page.locator('#wi-name').click()
    await page.locator('#wi-name').pressSequentially('Walk Up Runner', { delay: 10 })
    await page.locator('#wi-email').click()
    await page.locator('#wi-email').pressSequentially('not-an-email', { delay: 10 })

    const constraint = await page.evaluate(() => {
      const el = document.querySelector('#wi-email')
      return { valid: el.checkValidity(), message: el.validationMessage }
    })
    constraint.valid === false
      ? PASS('D2', `a malformed address cannot be submitted — browser says: "${constraint.message}"`)
      : FAIL('D2', 'a malformed email address passed constraint validation')

    // RD-CHECKIN-QA-01 — and the earlier message must not still contradict the form
    // now that the name has been typed.
    const stale = await alertText(page)
    stale === '' ? PASS('D2b', 'the earlier validation message clears once the field is corrected')
                 : FAIL('D2b', `stale validation message still shown: "${stale}"`)
    await shot(page, 'walkin-email-validation')

    await page.locator('#wi-email').fill(`walkup.${Date.now()}@runners.test`)
    await page.locator('#wi-phone').fill('+91 90000 22222')
    await submit()
    await settle(page, 8000)
    await shot(page, 'walkin-success')
    ;/registered and checked in/i.test(await text(page))
      ? PASS('D3', 'walk-in creates and admits in one step')
      : FAIL('D3', `walk-in did not succeed: ${(await text(page)).slice(0, 260).replace(/\n+/g, ' | ')}`)
  })

  // ══ G · the audit trail is not gate data ═══════════════════════════════
  // Still signed in as the gate operator. RD-CHECKIN-04 gates history on
  // `registrations`, which no gate role holds, so this must refuse.
  await phase('G', async () => {
    await page.goto(`${BASE}/dashboard/events/${EVENT_ID}/checkin/history`, { waitUntil: 'domcontentloaded' })
    // Generous on purpose. Two acceptable outcomes exist — the dashboard guard
    // routes them back to their own console, or the route refuses in place — and
    // they resolve at different speeds on different viewports. A long wait is what
    // separates "slow" from "never", and "never" is a defect.
    await settle(page, 15000)
    await shot(page, 'history-gate-operator-refused')
    const landed = new URL(page.url()).pathname
    const t = await text(page)

    // THE security property, independent of where they ended up: no ledger ROWS.
    //
    // Matching the words "checked in" is useless here — the gate workspace has a
    // metric labelled CHECKED IN and a "Recent check-ins" strip, so a text match
    // reports a leak on a page that contains none. A history row is a BUTTON whose
    // accessible name begins with the action, and nothing else in the product
    // renders one, so counting those is the precise question.
    const ledgerRows = await page.getByRole('button', { name: /checked in|check-in undone/i }).count()
    ledgerRows === 0
      ? PASS('G1', `a gate operator sees no history rows (ended on ${landed})`)
      : FAIL('G1', `gate operator saw ${ledgerRows} ledger row(s) at ${landed}`)

    // …and they must be TOLD, or taken somewhere they belong. Sitting on a spinner
    // forever after a permission denial is its own defect.
    const offHistory   = !landed.includes('/checkin/history')
    const refusedHere  = /missing required permission|not assigned|could not load|unavailable/i.test(t)
    const stillLoading = /loading check-in history/i.test(t)
    offHistory || refusedHere
      ? PASS('G2', offHistory ? `routed away to ${landed}` : 'refused in place, with a stated reason')
      : FAIL('G2', stillLoading
          ? 'stuck on a spinner after a permission denial — it never resolves'
          : `neither refused nor redirected: ${t.slice(0, 200).replace(/\n+/g, ' | ')}`)
  })

  // ══ E · permission + event scope ═══════════════════════════════════════
  await phase('E', async () => {
    await page.goto(`${BASE}/ops/checkin/${OTHER_ID}`, { waitUntil: 'domcontentloaded' })
    await settle(page, 6000)
    await shot(page, 'unassigned-event-refused')
    ;/not assigned to this event/i.test(await text(page))
      ? PASS('E1', 'an unassigned event is refused with a clear message')
      : FAIL('E1', `unassigned event not refused: ${(await text(page)).slice(0, 220).replace(/\n+/g, ' | ')}`)

    await page.goto(`${BASE}/dashboard/settings/staff`, { waitUntil: 'domcontentloaded' })
    await settle(page, 6000)
    await shot(page, 'gate-operator-on-organizer-surface')
    INFO('E2', `gate operator at /dashboard/settings/staff → ${new URL(page.url()).pathname}`)

    await ctx.clearCookies()
    await page.evaluate(() => {
      try { localStorage.clear(); sessionStorage.clear(); indexedDB.deleteDatabase('firebaseLocalStorageDb') } catch {}
    }).catch(() => {})
    await page.goto(`${BASE}/ops/checkin/${EVENT_ID}`, { waitUntil: 'domcontentloaded' })
    await settle(page, 7000)
    await shot(page, 'signed-out-gate')
    const t = await text(page)
    ;/sign in|unavailable/i.test(t) ? PASS('E3', 'signed-out gate shows a refusal, not a blank screen')
                                   : FAIL('E3', `signed-out gate rendered: "${t.slice(0, 220).replace(/\n+/g, ' | ')}"`)
  })

  // ══ H · the organizer reads what happened at the gate ══════════════════
  await phase('H', async () => {
    await ctx.clearCookies()
    await page.evaluate(() => {
      try { localStorage.clear(); sessionStorage.clear(); indexedDB.deleteDatabase('firebaseLocalStorageDb') } catch {}
    }).catch(() => {})

    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
    await settle(page, 3000)
    await page.locator('input[type="email"]').first().fill(ORG.email)
    await page.locator('input[type="password"]').first().fill(ORG.password)
    await page.getByRole('button', { name: /sign in|log in/i }).first().click()
    await page.waitForURL(/\/dashboard/, { timeout: 40000 }).catch(() => {})
    await settle(page, 3000)

    // The link must be reachable from the organizer's own check-in page.
    await page.goto(`${BASE}/dashboard/events/${EVENT_ID}/checkin`, { waitUntil: 'domcontentloaded' })
    await settle(page, 5000)
    const link = await page.getByRole('link', { name: /history/i }).count()
    link ? PASS('H1', 'History is reachable from the organizer check-in page')
         : FAIL('H1', 'no History link on the organizer check-in page')

    await page.getByRole('link', { name: /history/i }).first().click().catch(() => {})
    await page.waitForURL(/\/checkin\/history/, { timeout: 20000 }).catch(() => {})
    await settle(page, 6000)
    await shot(page, 'history-ledger')

    const t = await text(page)
    // The index is declared but NOT deployed. The emulator does not enforce
    // indexes, so the feed should render here; if a deployment ever lacks it the
    // page must say so rather than show an empty ledger.
    if (/index has not been created/i.test(t)) {
      INFO('H2', 'history reported the missing-index state honestly (not an empty list)')
      return
    }

    ;/checked in/i.test(t) ? PASS('H2', 'the ledger lists admissions from this run')
                          : FAIL('H2', `no admissions listed: ${t.slice(0, 240).replace(/\n+/g, ' | ')}`)

    for (const [id, re, what] of [
      ['H3', /check-in history/i,               'page identifies itself'],
      ['H4', /append-only/i,                    'states the record is append-only'],
      ['H5', /(today|yesterday|\d{4})/i,        'entries are grouped by day'],
      ['H6', /walk-in|qr scan|ticket code/i,    'the METHOD of each admission is shown'],
    ]) {
      re.test(t) ? PASS(id, what) : FAIL(id, `missing: ${what}`)
    }

    // The operator who performed the admissions is named.
    ;/arun gate|mobile gate|meridian ops/i.test(t)
      ? PASS('H7', 'each entry names the operator who performed it')
      : FAIL('H7', 'no operator named on any entry')

    // Expanding a row must show that participant's complete timeline.
    // Scoped by the row's own accessible name. `button[aria-expanded]` also matched
    // the top-bar EVENT SELECTOR, so the harness opened that dropdown instead and
    // then reported the ledger as broken.
    const rowBtn = page.getByRole('button', { name: /checked in/i }).first()
    if (await rowBtn.count()) {
      await rowBtn.click()
      await settle(page, 4000)
      await shot(page, 'history-participant-timeline')
      ;/complete timeline/i.test(await text(page))
        ? PASS('H8', 'a row opens that participant’s complete timeline in place')
        : FAIL('H8', 'row did not expand into a timeline')
    } else {
      FAIL('H8', 'no history rows to expand')
    }

    // Read-only: nothing on this surface may change anything.
    // Exact names only. A substring match hit the row LABEL “Check-in undone” and
    // reported the ledger's own text as a mutating control.
    const mutators = await page.getByRole('button', { name: /^(delete|remove|edit|revoke|correct)$/i }).count()
    mutators === 0 ? PASS('H9', 'the history surface offers no mutating control')
                   : FAIL('H9', `${mutators} mutating control(s) on a read-only surface`)
  })

  // ══ F · accessibility spot checks ══════════════════════════════════════
  await phase('F', async () => {
    await page.goto(`${BASE}/staff/login`, { waitUntil: 'domcontentloaded' })
    await settle(page, 2500)
    const a = await page.evaluate(() => ({
      unlabelled: [...document.querySelectorAll('input')]
        .filter(i => !(i.labels?.length || i.getAttribute('aria-label') || i.getAttribute('aria-labelledby')))
        .map(i => i.id || i.type),
      h1: document.querySelectorAll('h1').length,
      divButtons: [...document.querySelectorAll('[role="button"]')].filter(e => e.tagName !== 'BUTTON').length,
    }))
    a.unlabelled.length === 0 ? PASS('F1', 'every input on staff login has a real label')
                              : FAIL('F1', `unlabelled inputs: ${JSON.stringify(a.unlabelled)}`)
    a.h1 === 1 ? PASS('F2', 'exactly one h1 on staff login') : FAIL('F2', `h1 count = ${a.h1}`)
    a.divButtons === 0 ? PASS('F3', 'no div-as-button on staff login') : FAIL('F3', `${a.divButtons} non-button role=button`)

    await page.keyboard.press('Tab')
    const f = await page.evaluate(() => {
      const el = document.activeElement
      if (!el || el === document.body) return null
      const cs = getComputedStyle(el)
      // A ring counts, an outline counts, a border colour change on its own does not.
      const ring = cs.boxShadow && cs.boxShadow !== 'none'
      const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0
      return { tag: el.tagName, id: el.id, ring, outline, shadow: cs.boxShadow }
    })
    if (!f) FAIL('F4', 'Tab did not move focus into the form')
    else if (f.ring || f.outline)
      PASS('F4', `focus on ${f.tag}#${f.id} has a visible indicator (ring=${f.ring} outline=${f.outline})`)
    else
      FAIL('F4', `focus on ${f.tag}#${f.id} has NO visible indicator — shadow: ${f.shadow}`)
    await shot(page, 'a11y-keyboard-focus')
  })

  INFO('X1', `console errors: ${consoleErrors.length}`)
  consoleErrors.slice(0, 10).forEach((e, i) => INFO('X1', `  [${i}] ${e.slice(0, 220)}`))

  writeFileSync(join(OUT, 'findings.json'), JSON.stringify({ findings, consoleErrors }, null, 2))
  await browser.close()

  const fails = findings.filter(f => f.status === 'FAIL')
  console.log(`\n${MOBILE ? 'MOBILE' : 'DESKTOP'} — ${findings.filter(f => f.status === 'PASS').length} pass · ${fails.length} fail`)
  fails.forEach(f => console.log(`  FAIL ${f.id} ${f.detail}`))
  process.exit(fails.length ? 1 : 0)
}

main().catch(e => { console.error('HARNESS ERROR', e); process.exit(2) })
