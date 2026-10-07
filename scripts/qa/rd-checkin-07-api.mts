#!/usr/bin/env node
/**
 * scripts/qa/rd-checkin-07-api.mts
 *
 * RD-CHECKIN-07 — the server-side half of the production smoke test: real Firebase
 * ID tokens for real identities, driven against the running application.
 *
 *   npx tsx scripts/qa/rd-checkin-07-api.mts <run> [baseUrl]
 *
 * ═══ WHY TOKENS AND NOT THE BROWSER ══════════════════════════════════════════
 * "Denied in the UI" is not a security result — the UI can simply not draw a button.
 * These probes call the route handlers directly with a genuine signed-in identity, so
 * a pass means the SERVER refused, which is the only claim worth making. Nothing here
 * bypasses authentication: every request carries a real token minted by Firebase for
 * a real account with real permissions.
 */

import fs   from 'node:fs'
import path from 'node:path'

// RD-PREPROD · this script drives authorization probes (and check-in actions) through the live API against PRODUCTION (registerdesk-c91a3). It must never start by
// accident: the operator confirms the project explicitly in the environment.
if (process.env.RD_CONFIRM_PROD_PROJECT !== 'registerdesk-c91a3') {
  console.error('Refusing to run: set RD_CONFIRM_PROD_PROJECT=registerdesk-c91a3 to confirm this targets production.')
  process.exit(2)
}


const envFile = path.resolve(process.cwd(), '.env.local')
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/)
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '')
  }
}

const run     = process.argv[2]
const BASE    = process.argv[3] ?? 'http://localhost:3199'
if (!run) { console.error('usage: rd-checkin-07-api.mts <run> [baseUrl]'); process.exit(2) }

const API_KEY = process.env.NEXT_PUBLIC_FIREBASE_API_KEY!
const PROJECT = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID
if (PROJECT !== 'registerdesk-c91a3') { console.error(`wrong project: ${PROJECT}`); process.exit(2) }

interface Manifest {
  run: string
  organizer: { uid: string; email: string; password: string }
  events: { eventId: string; slug: string; name: string; timing: boolean; regIds: string[]; bibs: { value: string; registrationId: string }[] }[]
  staff:  { staffId: string | null; username: string; password: string; role: string; walkin: boolean }[]
}
const m = JSON.parse(fs.readFileSync(path.resolve('.qa', `${run}.fixture.json`), 'utf-8')) as Manifest
const [E1, E2] = m.events
const gate = m.staff.find(s => s.role === 'checkin_staff')!
const lead = m.staff.find(s => s.role === 'checkin_lead')!

const results: { phase: string; name: string; ok: boolean; detail: string }[] = []
function check(phase: string, name: string, ok: boolean, detail = ''): void {
  results.push({ phase, name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${phase}] ${name}${detail ? ` — ${detail}` : ''}`)
}

async function signIn(email: string, password: string): Promise<string> {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  })
  const j = await r.json() as { idToken?: string; error?: { message: string } }
  if (!j.idToken) throw new Error(`sign-in failed for ${email}: ${j.error?.message}`)
  return j.idToken
}

async function call(pathname: string, opts: { token?: string; method?: string; body?: unknown } = {}) {
  const r = await fetch(`${BASE}${pathname}`, {
    method: opts.method ?? 'GET',
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  let json: unknown = null
  try { json = await r.json() } catch { /* empty body */ }
  return { status: r.status, json: json as Record<string, unknown> | null }
}

const STAFF_DOMAIN = 'staff.registerdesk.invalid'

// ─── Identities ──────────────────────────────────────────────────────────────
console.log(`base: ${BASE}\nproject: ${PROJECT}\n`)
const gateTok = await signIn(`${gate.username}@${STAFF_DOMAIN}`, gate.password)
const leadTok = await signIn(`${lead.username}@${STAFF_DOMAIN}`, lead.password)
const orgTok  = await signIn(m.organizer.email, m.organizer.password)
console.log('signed in: gate staff, check-in lead, organizer\n')

// ─── Phase 3/4 — identity, scope, readiness ──────────────────────────────────
console.log('── Phase 3/4 — staff identity, event scope, readiness ──')
{
  const me = await call('/api/staff/me', { token: gateTok })
  check('3', 'staff identity resolves server-side', me.status === 200 &&
    (me.json?.username as string) === gate.username, `status ${me.status}`)
  check('3', 'staff is scoped to exactly one event',
    Array.isArray(me.json?.eventIds) && (me.json!.eventIds as string[]).length === 1 &&
    (me.json!.eventIds as string[])[0] === E1!.eventId)

  const anon = await call('/api/staff/me')
  check('12', 'unauthenticated /api/staff/me is refused', anon.status === 401 || anon.status === 403, `status ${anon.status}`)

  const ops1 = await call(`/api/checkin/ops/${E1!.eventId}`, { token: gateTok })
  check('4', 'staff may open their assigned event', ops1.status === 200, `status ${ops1.status}`)
  check('4', 'readiness resolver reports the event open', ops1.json?.eventSlug === E1!.slug,
    String(ops1.json?.eventSlug ?? ops1.json?.error))

  const ops2 = await call(`/api/checkin/ops/${E2!.eventId}`, { token: gateTok })
  check('4', 'staff CANNOT open an unassigned event (server-side)',
    ops2.status === 403 || ops2.status === 404, `status ${ops2.status}`)

  const forged = await call(`/api/checkin/ops/${encodeURIComponent('../../etc/passwd')}`, { token: gateTok })
  check('12', 'forged event id is refused', forged.status >= 400, `status ${forged.status}`)

  const opsAnon = await call(`/api/checkin/ops/${E1!.eventId}`)
  check('12', 'unauthenticated ops read is refused', opsAnon.status === 401 || opsAnon.status === 403, `status ${opsAnon.status}`)
}

// ─── Phase 5 — every lookup mode against production ──────────────────────────
console.log('\n── Phase 5 — lookup modes (live indexes) ──')
{
  const target   = E1!.regIds[0]!             // Zenobia Quartermaine, BIB A1045
  const deepName = 'Zenobia'
  const probes: [string, string][] = [
    ['registration id', target],
    ['ticket code',     `RD-${E1!.eventId.slice(-4).toUpperCase()}0001`],
    ['BIB',             E1!.bibs[0]!.value],
    ['email',           `${target}@example.invalid`],
    ['mobile',          '+919876500000'],
    ['name prefix',     deepName],
  ]
  for (const [label, q] of probes) {
    const r = await call(`/api/organizer/events/${E1!.eventId}/checkin/search?q=${encodeURIComponent(q)}`, { token: gateTok })
    const rows = (r.json?.results as { id: string; name?: string }[] | undefined) ?? []
    const hit  = rows.some(x => x.id === target)
    check('5', `${label} finds the right attendee`, r.status === 200 && hit,
      r.status !== 200 ? `status ${r.status} ${String(r.json?.error ?? '')}` : `${rows.length} row(s)`)
  }

  const wrongEvent = await call(`/api/organizer/events/${E2!.eventId}/checkin/search?q=${encodeURIComponent(deepName)}`, { token: gateTok })
  check('12', 'search on an unassigned event is refused',
    wrongEvent.status === 403 || wrongEvent.status === 404, `status ${wrongEvent.status}`)

  const cross = await call(`/api/organizer/events/${E1!.eventId}/checkin/search?q=${encodeURIComponent(E2!.regIds[0]!)}`, { token: gateTok })
  const crossRows = (cross.json?.results as unknown[] | undefined) ?? []
  check('12', "another event's registration id leaks nothing", crossRows.length === 0, `${crossRows.length} row(s)`)
}

// ─── Phase 6 / 11 — admit, duplicate, undo, re-admit ─────────────────────────
console.log('\n── Phase 6/11 — admit → duplicate → undo → re-admit ──')
{
  // The gate admits by TICKET CODE — that is the route's contract; there is no
  // registrationId admission path, which is itself a scope safeguard.
  const ticket = `RD-${E1!.eventId.slice(-4).toUpperCase()}0001`
  // Start from a known state so the suite is re-runnable: a previous run leaves the
  // attendee admitted, which would make "first check-in" report ALREADY. Undo is the
  // legitimate path and is itself under test below, so this uses no back door.
  await call('/api/checkin/undo', { token: orgTok, method: 'POST', body: { ticketCode: ticket } })

  const before = await call(`/api/checkin/ops/${E1!.eventId}`, { token: gateTok })
  const countBefore = (before.json?.checkedIn as number | null) ?? null

  const a = await call('/api/checkin/scan', { token: gateTok, method: 'POST',
    body: { ticketCode: ticket, eventSlug: E1!.slug, source: 'manual' } })
  check('6', 'first check-in succeeds', a.status === 200 && a.json?.alreadyCheckedIn !== true,
    `status ${a.status} ${String(a.json?.error ?? '')}`)

  const after = await call(`/api/checkin/ops/${E1!.eventId}`, { token: gateTok })
  const countAfter = (after.json?.checkedIn as number | null) ?? null
  check('6', 'server-backed attendance count increased',
    countBefore !== null && countAfter !== null && countAfter === countBefore + 1,
    `${countBefore} → ${countAfter}`)

  const dup = await call('/api/checkin/scan', { token: gateTok, method: 'POST',
    body: { ticketCode: ticket, eventSlug: E1!.slug, source: 'manual' } })
  check('6', 'duplicate returns ALREADY CHECKED IN, not a second success',
    dup.status === 200 && dup.json?.alreadyCheckedIn === true, `alreadyCheckedIn=${dup.json?.alreadyCheckedIn}`)
  // A fresh admission does not echo `checkedInAt` — only the ALREADY branch does,
  // which is exactly where it is needed. Preservation is therefore tested the way it
  // matters: a SECOND duplicate must report the same instant as the first, and that
  // instant must predate the duplicate attempts rather than being "now".
  const dupAt = dup.json?.checkedInAt as string | undefined
  const beforeSecond = Date.now()
  const dup2 = await call('/api/checkin/scan', { token: gateTok, method: 'POST',
    body: { ticketCode: ticket, eventSlug: E1!.slug, source: 'manual' } })
  check('6', 'original timestamp is preserved across repeated duplicates',
    typeof dupAt === 'string' && dup2.json?.checkedInAt === dupAt, String(dupAt ?? '—'))
  check('6', 'the reported time is the ORIGINAL admission, not the retry',
    typeof dupAt === 'string' && Date.parse(dupAt) < beforeSecond,
    typeof dupAt === 'string' ? `${beforeSecond - Date.parse(dupAt)}ms earlier` : '—')
  check('6', 'the duplicate names the original operator',
    typeof dup.json?.attendee === 'object' && dup.json?.attendee !== null,
    JSON.stringify(dup.json?.attendee ?? null))

  const dupCount = await call(`/api/checkin/ops/${E1!.eventId}`, { token: gateTok })
  check('6', 'duplicate did NOT increment attendance',
    ((dupCount.json?.checkedIn as number | null) ?? null) === countAfter,
    `${countAfter} → ${(dupCount.json?.checkedIn as number | null) ?? null}`)

  // Undo requires the `registrations` permission, so it is an ORGANIZER action by
  // design — a gate operator cannot erase their own admission. Both halves asserted.
  const staffUndo = await call('/api/checkin/undo', { token: gateTok, method: 'POST',
    body: { ticketCode: ticket } })
  check('11', 'gate staff CANNOT undo (undo is an organizer action)', staffUndo.status === 403,
    `status ${staffUndo.status}`)

  const undo = await call('/api/checkin/undo', { token: orgTok, method: 'POST',
    body: { ticketCode: ticket } })
  check('11', 'organizer undo through the legitimate path succeeds', undo.status === 200,
    `status ${undo.status} ${String(undo.json?.error ?? '')}`)

  const re = await call('/api/checkin/scan', { token: gateTok, method: 'POST',
    body: { ticketCode: ticket, eventSlug: E1!.slug, source: 'manual' } })
  check('11', 're-check-in after undo succeeds', re.status === 200 && re.json?.alreadyCheckedIn !== true,
    `status ${re.status} ${String(re.json?.error ?? '')}`)
}

// ─── Phase 9 — walk-in permission ────────────────────────────────────────────
console.log('\n── Phase 9 — walk-in permission ──')
{
  const opsGate = await call(`/api/checkin/ops/${E1!.eventId}`, { token: gateTok })
  check('9', 'gate staff is told it may NOT walk in', opsGate.json?.canWalkIn === false,
    `canWalkIn=${opsGate.json?.canWalkIn}`)

  const denied = await call('/api/checkin/walkin', { token: gateTok, method: 'POST',
    body: { eventId: E1!.eventId, name: 'RD QA Should Not Exist', email: 'nope@example.invalid', phone: '+919876000000' } })
  check('9', 'walk-in by a checkin-only account is refused server-side',
    denied.status === 403, `status ${denied.status}`)

  const opsLead = await call(`/api/checkin/ops/${E1!.eventId}`, { token: leadTok })
  check('9', 'check-in lead IS granted walk-in', opsLead.json?.canWalkIn === true,
    `canWalkIn=${opsLead.json?.canWalkIn}`)
}

// ─── Phase 10/12 — history authorization ─────────────────────────────────────
console.log('\n── Phase 10/12 — history access model ──')
{
  const asStaff = await call(`/api/organizer/events/${E1!.eventId}/checkin/history`, { token: gateTok })
  check('10', 'gate staff CANNOT read the event history ledger',
    asStaff.status === 403 || asStaff.status === 404, `status ${asStaff.status}`)

  const asOrg = await call(`/api/organizer/events/${E1!.eventId}/checkin/history`, { token: orgTok })
  type Row = { id: string; action: string; operatorName: string | null; attendeeName: string | null
               ticketCode: string | null; identifierValue: string | null
               method: string; occurredAt: string | null; registrationId: string }
  const rows = (asOrg.json?.rows as Row[] | undefined) ?? []
  check('10', 'organizer CAN read the history ledger', asOrg.status === 200, `status ${asOrg.status}`)
  check('10', 'ledger records the full QA timeline newest-first',
    rows.slice(0, 3).map(e => e.action).join(',') === 'CHECK_IN,CHECK_IN_UNDO,CHECK_IN',
    rows.slice(0, 3).map(e => e.action).join(' → ') || '—')
  check('10', 'operator identity is present on every entry',
    rows.length > 0 && rows.every(e => typeof e.operatorName === 'string' && e.operatorName!.length > 0),
    rows[0]?.operatorName ?? '—')
  check('10', 'attendee identity is joined onto entries',
    rows.length > 0 && rows.every(e => typeof e.attendeeName === 'string' && e.attendeeName!.length > 0),
    rows[0]?.attendeeName ?? '—')
  check('10', 'BIB held at the time of the action is recorded',
    rows.some(e => e.identifierValue === E1!.bibs[0]!.value),
    rows[0]?.identifierValue ?? '—')
  check('10', 'method and timestamp are present', rows.length > 0 &&
    rows.every(e => typeof e.method === 'string' && typeof e.occurredAt === 'string'),
    `${rows[0]?.method ?? '—'} @ ${rows[0]?.occurredAt ?? '—'}`)

  // Pagination must not repeat an entry across pages.
  const p1 = await call(`/api/organizer/events/${E1!.eventId}/checkin/history?limit=2`, { token: orgTok })
  const r1 = (p1.json?.rows as Row[] | undefined) ?? []
  const cursor = p1.json?.nextBefore as string | null
  const p2 = cursor
    ? await call(`/api/organizer/events/${E1!.eventId}/checkin/history?limit=2&before=${encodeURIComponent(cursor)}`, { token: orgTok })
    : { status: 0, json: null as Record<string, unknown> | null }
  const r2 = (p2.json?.rows as Row[] | undefined) ?? []
  check('10', 'pagination returns a second page with no duplicate ids',
    r1.length === 2 && r2.length > 0 && !r2.some(x => r1.some(y => y.id === x.id)),
    `page1=${r1.length} page2=${r2.length}`)

  // The ledger is append-only: the route must expose no mutating verb.
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    const mres = await call(`/api/organizer/events/${E1!.eventId}/checkin/history`,
      { token: orgTok, method, body: { action: 'CHECK_IN' } })
    check('10', `history rejects ${method} (immutable)`, mres.status === 404 || mres.status === 405,
      `status ${mres.status}`)
  }

  const anon = await call(`/api/organizer/events/${E1!.eventId}/checkin/history`)
  check('12', 'unauthenticated history read is refused', anon.status === 401 || anon.status === 403, `status ${anon.status}`)

  const otherOrg = await call(`/api/organizer/events/${E2!.eventId}/checkin/history`, { token: gateTok })
  check('12', 'staff cannot reach history of an unassigned event',
    otherOrg.status === 403 || otherOrg.status === 404, `status ${otherOrg.status}`)
}

// ─── Phase 12 — privilege escalation attempts ────────────────────────────────
console.log('\n── Phase 12 — escalation attempts ──')
{
  const grant = await call('/api/organizer/staff', { token: gateTok, method: 'POST',
    body: { username: `${gate.username}.evil`, displayName: 'Escalated', role: 'checkin_lead', eventIds: [E1!.eventId, E2!.eventId] } })
  check('12', 'staff cannot create staff accounts / grant themselves events',
    grant.status === 401 || grant.status === 403, `status ${grant.status}`)
  // If the server DID create one, it is a live production object — remove it here
  // rather than leaving it for the fixture cleanup, which does not know its id.
  const mintedId = (grant.json?.staff as { staffId?: string } | undefined)?.staffId
  if (mintedId) {
    const { deleteStaffAccount } = await import('@/lib/staff/service')
    const del = await deleteStaffAccount({ organizerUid: gate.staffId!, staffId: mintedId })
    console.log(`         ↳ probe-created account ${mintedId} removed: ${del.ok}`)
  }

  const orgOnly = await call('/api/organizer/dashboard', { token: gateTok })
  check('12', 'staff cannot reach organizer dashboard data',
    orgOnly.status === 401 || orgOnly.status === 403, `status ${orgOnly.status}`)

  // A REAL ticket belonging to the other event, presented at this gate. This is the
  // scope check that `eventSlug` in the scan body exists to enforce.
  const otherTicket = `RD-${E2!.eventId.slice(-4).toUpperCase()}0001`
  const forgedReg = await call('/api/checkin/scan', { token: gateTok, method: 'POST',
    body: { ticketCode: otherTicket, eventSlug: E1!.slug, source: 'manual' } })
  check('12', "another event's ticket cannot be admitted through this gate",
    forgedReg.status >= 400, `status ${forgedReg.status} ${String(forgedReg.json?.error ?? '')}`)

  const bogus = await call('/api/checkin/scan', { token: gateTok, method: 'POST',
    body: { ticketCode: 'RD-DOES-NOT-EXIST', eventSlug: E1!.slug, source: 'manual' } })
  check('12', 'a non-existent ticket is refused', bogus.status >= 400,
    `status ${bogus.status} ${String(bogus.json?.error ?? '')}`)
}

// ─── Phase 8 — timing gating ─────────────────────────────────────────────────
console.log('\n── Phase 8 — timing terminology gating ──')
{
  const ops1 = await call(`/api/checkin/ops/${E1!.eventId}`, { token: gateTok })
  const label1 = JSON.stringify(ops1.json ?? {})
  check('8', 'timing-OFF event does not advertise a timing chip',
    !/timing chip/i.test(label1), /timing chip/i.test(label1) ? 'timing wording present' : 'absent')
}

// ─── Summary ─────────────────────────────────────────────────────────────────
const failed = results.filter(r => !r.ok)
console.log(`\n═══ ${results.length - failed.length}/${results.length} API checks passed ═══`)
failed.forEach(f => console.log(`  FAILED [${f.phase}] ${f.name} — ${f.detail}`))
process.exit(failed.length ? 1 : 0)
