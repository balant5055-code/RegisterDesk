#!/usr/bin/env node
/**
 * scripts/qa/rd-checkin-07-escalation.mts
 *
 * RD-CHECKIN-07 — measures the real blast radius of the `requireOwner(caller.uid,
 * caller.uid)` tautology in POST /api/organizer/staff, and then removes the account
 * the probe created.
 *
 *   npx tsx scripts/qa/rd-checkin-07-escalation.mts <staffId> [baseUrl]
 *
 * The question severity turns on is NOT "was an account created" — it was — but
 * "can that account reach the victim organizer's event". The created row names the
 * organizer's event ids, which LOOKS like escalation; whether it IS depends on how
 * the workspace is resolved at authorization time. So this signs in AS the created
 * account and asks the server.
 *
 * An ID token is obtained with a custom token rather than the account's password:
 * the password was returned once to the attacker and never stored, and resetting it
 * would mutate the object under test.
 */

import fs   from 'node:fs'
import path from 'node:path'

// RD-PREPROD · this script mints a token for and deletes a staff account against PRODUCTION (registerdesk-c91a3). It must never start by
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

const staffId = process.argv[2]
const BASE    = process.argv[3] ?? 'http://localhost:3199'
if (!staffId) { console.error('usage: <staffId> [baseUrl]'); process.exit(2) }

const API_KEY = process.env.NEXT_PUBLIC_FIREBASE_API_KEY!
if (process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID !== 'registerdesk-c91a3') {
  console.error('wrong project'); process.exit(2)
}

const { adminDb, adminAuth } = await import('@/lib/firebase/admin')

const doc = await adminDb.collection('staffAccounts').doc(staffId).get()
if (!doc.exists) { console.error('no such staff account'); process.exit(2) }
const d = doc.data() as { username: string; organizerUid: string; eventIds: string[] }
console.log(`account under test : ${d.username}`)
console.log(`  organizerUid     : ${d.organizerUid}`)
console.log(`  claims eventIds  : ${JSON.stringify(d.eventIds)}\n`)

const custom = await adminAuth.createCustomToken(staffId)
const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: custom, returnSecureToken: true }),
})
const { idToken } = await r.json() as { idToken: string }

async function call(p: string) {
  const res = await fetch(`${BASE}${p}`, { headers: { authorization: `Bearer ${idToken}` } })
  let j: unknown = null; try { j = await res.json() } catch { /* none */ }
  return { status: res.status, json: j as Record<string, unknown> | null }
}

let escalated = false
for (const ev of d.eventIds) {
  const ops = await call(`/api/checkin/ops/${ev}`)
  const reached = ops.status === 200
  if (reached) escalated = true
  console.log(`  ${reached ? 'REACHED' : 'refused'}  /api/checkin/ops/${ev}  → ${ops.status}`)
  const search = await call(`/api/organizer/events/${ev}/checkin/search?q=Zenobia`)
  const rows = (search.json?.results as unknown[] | undefined)?.length ?? 0
  if (search.status === 200 && rows > 0) escalated = true
  console.log(`  ${search.status === 200 && rows > 0 ? 'LEAKED ' : 'refused'}  search on ${ev} → ${search.status} (${rows} rows)`)
}
const me = await call('/api/staff/me')
console.log(`  /api/staff/me → ${me.status}  eventIds=${JSON.stringify(me.json?.eventIds ?? null)}`)

console.log(`\nVERDICT: ${escalated
  ? 'CROSS-WORKSPACE ESCALATION — the minted account reached the victim organizer\'s event'
  : 'NO cross-workspace access — the minted account is confined to a workspace that owns no events'}`)

// ─── Remove the object this probe created ────────────────────────────────────
// It is not in the fixture manifest because the SERVER created it, so it is named
// explicitly here rather than found by a broad query.
console.log('\n── removing the probe-created account ──')
const { deleteStaffAccount } = await import('@/lib/staff/service')
const del = await deleteStaffAccount({ organizerUid: d.organizerUid, staffId })
console.log(`  deleteStaffAccount: ${del.ok ? 'ok' : `status ${(del as { status?: number }).status}`}`)
const gone = await adminAuth.getUser(staffId).then(() => false).catch(() => true)
console.log(`  Auth user gone    : ${gone}`)
const lock = await adminDb.collection('staffUsernames').doc(d.username).get()
console.log(`  username lock gone: ${!lock.exists}`)
const prof = await adminDb.collection('staffAccounts').doc(staffId).get()
console.log(`  profile gone      : ${!prof.exists}`)
process.exit(0)
