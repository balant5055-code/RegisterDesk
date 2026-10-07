#!/usr/bin/env node
/**
 * scripts/qa/rd-checkin-10-matrix.mts
 *
 * RD-CHECKIN-10 Phases 6 and 7 — the server-side matrix, against the EMULATOR build.
 *
 *   npx dotenv-cli -e .env.emulator -- npx tsx scripts/qa/rd-checkin-10-matrix.mts
 *
 * "Denied in the UI" is not a security result, so every row here is a real HTTP call
 * carrying a real Firebase ID token for a real account.
 *
 * Phase 6 additionally PROVES what a zero-assignment gate account does, instead of
 * asserting it from a reading: the row is emptied directly (emulator only), the gate
 * is called, and the row is restored — see the note at that probe for why the state
 * cannot be reached through the product.
 */

import fs   from 'node:fs'
import path from 'node:path'

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.error('REFUSING TO RUN — emulator hosts are not set. This probe is emulator-only.')
  process.exit(2)
}

const BASE      = process.argv[2] ?? 'http://localhost:3188'
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST
const API_KEY   = process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? 'fake-api-key'

const { adminDb } = await import('@/lib/firebase/admin')
const { TEAM_COLLECTION } = await import('@/lib/team/types')

const m = JSON.parse(fs.readFileSync(path.resolve('.qa', 'rd-checkin-10.fixture.json'), 'utf8')) as {
  organizerUid: string
  staff: { staffId: string; username: string; password: string; events: string[] }[]
}
const staffOne  = m.staff.find(s => s.events.length === 1)!
const staffBoth = m.staff.find(s => s.events.length === 2)!

const EVENT_A = { id: 'qa-checkin-event', slug: 'meridian-city-half' }
const EVENT_B = { id: 'qa-checkin-other', slug: 'meridian-trail-10k' }
const TICKET_A = 'RD-MCH-00001'          // untouched by the browser run
const TICKET_B = 'RD-TRL-00003'

const results: { phase: string; name: string; ok: boolean; detail: string }[] = []
function check(phase: string, name: string, ok: boolean, detail = '') {
  results.push({ phase, name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${phase}] ${name}${detail ? ` — ${detail}` : ''}`)
}

async function signIn(email: string, password: string): Promise<string | null> {
  const r = await fetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  }).then(x => x.json() as Promise<{ idToken?: string }>).catch(() => null)
  return r?.idToken ?? null
}

async function call(p: string, o: { token?: string | null; method?: string; body?: unknown } = {}) {
  const r = await fetch(`${BASE}${p}`, {
    method: o.method ?? 'GET',
    headers: {
      ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
      ...(o.body ? { 'content-type': 'application/json' } : {}),
    },
    body: o.body ? JSON.stringify(o.body) : undefined,
  })
  let j: unknown = null; try { j = await r.json() } catch { /* none */ }
  return { status: r.status, json: j as Record<string, unknown> | null }
}

const DOMAIN = 'staff.registerdesk.invalid'
const oneTok  = await signIn(`${staffOne.username}@${DOMAIN}`, staffOne.password)
const bothTok = await signIn(`${staffBoth.username}@${DOMAIN}`, staffBoth.password)
const orgTok  = await signIn('qa.checkin@registerdesk.test', 'QaCheckinPassw0rd!')
console.log(`tokens: gate=${!!oneTok} both=${!!bothTok} organizer=${!!orgTok}\n`)

// ─── Phase 7 — authentication ────────────────────────────────────────────────
console.log('── Phase 7 · authentication ──')
check('7', 'unauthenticated ops read is refused',
  [401, 403].includes((await call(`/api/checkin/ops/${EVENT_A.id}`)).status))
check('7', 'unauthenticated scan is refused',
  [401, 403].includes((await call('/api/checkin/scan', { method: 'POST', body: { ticketCode: TICKET_A } })).status))
check('7', 'a garbage bearer token is refused',
  [401, 403].includes((await call(`/api/checkin/ops/${EVENT_A.id}`, { token: 'not-a-token' })).status))

// ─── Phase 7 — staff scope and permission ────────────────────────────────────
console.log('\n── Phase 7 · staff scope and permissions ──')
check('7', 'staff may open their assigned event',
  (await call(`/api/checkin/ops/${EVENT_A.id}`, { token: oneTok })).status === 200)
{
  const r = await call(`/api/checkin/ops/${EVENT_B.id}`, { token: oneTok })
  check('7', 'staff CANNOT open an unassigned event', [403, 404].includes(r.status), `status ${r.status}`)
}
{
  const r = await call('/api/checkin/walkin', { token: oneTok, method: 'POST',
    body: { eventId: EVENT_A.id, name: 'Should Not Exist', email: 'no@example.invalid' } })
  check('7', 'a checkin-only account cannot walk in (missing permission)', r.status === 403, `status ${r.status}`)
}

// ─── Phase 7 — check-in correctness ──────────────────────────────────────────
console.log('\n── Phase 7 · check-in ──')
await call('/api/checkin/undo', { token: orgTok, method: 'POST', body: { ticketCode: TICKET_A } })
{
  const a = await call('/api/checkin/scan', { token: oneTok, method: 'POST',
    body: { ticketCode: TICKET_A, eventSlug: EVENT_A.slug, source: 'manual' } })
  check('7', 'a valid attendee is admitted', a.status === 200 && a.json?.alreadyCheckedIn !== true,
    `status ${a.status} ${String(a.json?.error ?? '')}`)

  const d = await call('/api/checkin/scan', { token: oneTok, method: 'POST',
    body: { ticketCode: TICKET_A, eventSlug: EVENT_A.slug, source: 'manual' } })
  check('7', 'a duplicate reports ALREADY_CHECKED_IN', d.json?.alreadyCheckedIn === true)

  const w = await call('/api/checkin/scan', { token: oneTok, method: 'POST',
    body: { ticketCode: TICKET_B, eventSlug: EVENT_A.slug, source: 'manual' } })
  check('7', "another event's ticket is refused at this gate", w.status >= 400,
    `${w.status} ${String(w.json?.error ?? '')}`)

  const f = await call('/api/checkin/scan', { token: oneTok, method: 'POST',
    body: { ticketCode: 'RD-FORGED-0000', eventSlug: EVENT_A.slug, source: 'manual' } })
  check('7', 'a forged ticket code is refused', f.status >= 400,
    `${f.status} ${String(f.json?.error ?? '')}`)

  const e = await call(`/api/checkin/ops/${encodeURIComponent('../../admin')}`, { token: oneTok })
  check('7', 'a forged event id is refused', e.status >= 400, `status ${e.status}`)
}

// ─── Phase 7 — undo ──────────────────────────────────────────────────────────
console.log('\n── Phase 7 · undo ──')
{
  const s = await call('/api/checkin/undo', { token: oneTok, method: 'POST', body: { ticketCode: TICKET_A } })
  check('7', 'gate staff cannot undo (server rejects the direct request)', s.status === 403, `status ${s.status}`)
  const o = await call('/api/checkin/ops/' + EVENT_A.id, { token: oneTok })
  check('7', 'the server tells that client not to draw Undo', o.json?.canUndo === false, `canUndo=${o.json?.canUndo}`)
  const g = await call('/api/checkin/undo', { token: orgTok, method: 'POST', body: { ticketCode: TICKET_A } })
  check('7', 'an authorized organizer CAN undo', g.status === 200, `status ${g.status}`)
}

// ─── Phase 7 — staff management and team ─────────────────────────────────────
console.log('\n── Phase 7 · access-granting surfaces ──')
for (const [label, tok] of [['checkin_staff', oneTok], ['checkin_lead-equivalent', bothTok]] as const) {
  const s = await call('/api/organizer/staff', { token: tok, method: 'POST',
    body: { username: 'rd10.evil', displayName: 'Evil', role: 'checkin_staff', eventIds: [EVENT_A.id] } })
  check('7', `${label} cannot create a staff account`, s.status === 403, `status ${s.status}`)
  const t = await call('/api/organizer/team', { token: tok, method: 'POST',
    body: { email: 'evil@example.invalid', role: 'manager' } })
  check('7', `${label} cannot invite a team member`, t.status === 403, `status ${t.status}`)
}

// ─── Phase 7 — history ───────────────────────────────────────────────────────
console.log('\n── Phase 7 · history ──')
{
  const s = await call(`/api/organizer/events/${EVENT_A.id}/checkin/history`, { token: oneTok })
  check('7', 'gate staff cannot read the history ledger', [403, 404].includes(s.status), `status ${s.status}`)
  const o = await call(`/api/organizer/events/${EVENT_A.id}/checkin/history`, { token: orgTok })
  check('7', 'the organizer can read the history ledger', o.status === 200, `status ${o.status}`)
  const rows = (o.json?.rows as { action: string }[] | undefined) ?? []
  check('7', 'the ledger retained the admit/undo sequence', rows.length > 0,
    rows.slice(0, 4).map(r => r.action).join(' → ') || 'empty')
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    const r = await call(`/api/organizer/events/${EVENT_A.id}/checkin/history`,
      { token: orgTok, method, body: { action: 'CHECK_IN' } })
    check('7', `history refuses ${method} (append-only)`, [404, 405].includes(r.status), `status ${r.status}`)
  }
}

// ─── Phase 7 — an inactive credential ────────────────────────────────────────
console.log('\n── Phase 7 · inactive staff ──')
{
  const rows = await adminDb.collection(TEAM_COLLECTION)
    .where('organizerUid', '==', m.organizerUid).get()
  const row = rows.docs.find(d => (d.data() as { memberUid?: string }).memberUid === staffOne.staffId)
  if (!row) {
    check('7', 'the staff grant row was found for the suspension probe', false, 'row missing')
  } else {
    await row.ref.update({ status: 'suspended' })
    const r = await call(`/api/checkin/ops/${EVENT_A.id}`, { token: oneTok })
    check('7', 'a SUSPENDED staff credential is refused', [401, 403, 404].includes(r.status), `status ${r.status}`)
    await row.ref.update({ status: 'active' })
    const back = await call(`/api/checkin/ops/${EVENT_A.id}`, { token: oneTok })
    check('7', 'reactivating restores access', back.status === 200, `status ${back.status}`)
  }
}

// ─── Phase 6 — the zero-assignment state, proven ─────────────────────────────
console.log('\n── Phase 6 · zero-assignment gate account ──')
{
  // UNREACHABLE THROUGH THE PRODUCT: createStaffAccount and updateStaffAccount both
  // refuse an empty eventIds, because [] means "unrestricted" everywhere else in this
  // codebase. The row is emptied directly here — emulator only — purely to observe
  // what the gate WOULD do if a console edit or a future migration produced it.
  const rows = await adminDb.collection(TEAM_COLLECTION)
    .where('organizerUid', '==', m.organizerUid).get()
  const row = rows.docs.find(d => (d.data() as { memberUid?: string }).memberUid === staffOne.staffId)
  if (!row) {
    check('6', 'grant row located for the zero-assignment probe', false, 'row missing')
  } else {
    const original = (row.data() as { eventIds?: string[] }).eventIds ?? []
    await row.ref.update({ eventIds: [] })
    // RD-CHECKIN-10 measured 200 here — the credential reached an event it was never
    // assigned to. RD-CHECKIN-11 made the scope primitives fail closed for a gate
    // CREDENTIAL while leaving a legacy person's [] meaning intact, so this is now a
    // refusal. The assertion is inverted deliberately: it used to record the defect,
    // it now pins the fix.
    const unassigned = await call(`/api/checkin/ops/${EVENT_B.id}`, { token: oneTok })
    check('6', 'a zero-assignment gate account is DENIED an unassigned event',
      [401, 403, 404].includes(unassigned.status), `status ${unassigned.status}`)
    // And denied its previously-assigned event too: no assignment means no access,
    // not "the old one still counts".
    const assigned = await call(`/api/checkin/ops/${EVENT_A.id}`, { token: oneTok })
    check('6', 'a zero-assignment gate account is DENIED even its former event',
      [401, 403, 404].includes(assigned.status), `status ${assigned.status}`)
    await row.ref.update({ eventIds: original })
    const restored = (await row.ref.get()).data() as { eventIds?: string[] }
    check('6', 'the grant row was restored', JSON.stringify(restored.eventIds) === JSON.stringify(original),
      JSON.stringify(restored.eventIds))
  }
}

const failed = results.filter(r => !r.ok)
console.log(`\n═══ ${results.length - failed.length}/${results.length} matrix checks passed ═══`)
failed.forEach(f => console.log(`  FAILED [${f.phase}] ${f.name} — ${f.detail}`))
process.exit(0)
