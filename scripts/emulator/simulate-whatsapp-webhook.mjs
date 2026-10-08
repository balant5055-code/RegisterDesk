// Simulates Meta WhatsApp Cloud API webhook deliveries against a LOCAL, EMULATOR-backed
// server, then reads the result back from the Firestore emulator.
//
//   dotenv -e .env.emulator -- node scripts/emulator/simulate-whatsapp-webhook.mjs [mode] [options]
//
// Modes
//   inbound   (default) POST a signed text message, POST it AGAIN (idempotency), read back
//             whatsappInbound/{sha256(wamid)} and, when routed, its conversation.
//   handshake GET verification: right token → 200 + challenge, wrong token → 403.
//   badsig    POST with a forged signature → must be 401 and write nothing.
//
// Options (inbound)
//   --from <digits>     sender wa_id (default 919900011122 → no match → unmatched queue).
//                       After `node scripts/emulator/seed-whatsapp-inbox.mjs`, 919845030001
//                       routes onto a seeded conversation by phone.
//   --text <string>     message body
//   --context <wamid>   reply-to wamid (exercises context routing)
//
// The server must be started with TEST Meta values (never real ones) — see the bottom of
// this file. Signing uses WEBHOOK_TEST_APP_SECRET, which must equal the server's
// META_APP_SECRET.
//
// SAFETY. `npm run dev` on :3000 talks to PRODUCTION Firestore (.env.local has no emulator
// flag), so this script refuses any target that is not localhost, refuses port 3000, and
// refuses to run unless the Firestore emulator env and a demo-* project are set.

import { createHmac, createHash, randomBytes } from 'node:crypto'
import { initializeApp, getApps } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

const PROJECT_ID = process.env.GCLOUD_PROJECT ?? 'demo-registerdesk'
if (!process.env.FIRESTORE_EMULATOR_HOST || !PROJECT_ID.startsWith('demo-')) {
  console.error('Refusing: run through `dotenv -e .env.emulator --` (FIRESTORE_EMULATOR_HOST + demo-* project required).')
  process.exit(2)
}

const TARGET   = new URL(process.env.WEBHOOK_TARGET ?? 'http://127.0.0.1:3187')
const SECRET   = process.env.WEBHOOK_TEST_APP_SECRET   ?? 'local-webhook-test-secret'
const VERIFY   = process.env.WEBHOOK_TEST_VERIFY_TOKEN ?? 'local-verify-token'
const PHONE_ID = process.env.WEBHOOK_TEST_PHONE_ID     ?? '100000000000001'

if (!['localhost', '127.0.0.1'].includes(TARGET.hostname) || TARGET.port === '3000') {
  console.error(`Refusing target ${TARGET.origin}: only a local EMULATOR server (npm run emu:dev → :3187) is allowed. :3000 writes to production.`)
  process.exit(2)
}

const ENDPOINT = new URL('/api/webhooks/whatsapp', TARGET)
const [mode = 'inbound', ...rest] = process.argv.slice(2)
const opt = name => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined }

let failures = 0
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failures++ }

const sign = raw => `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`

async function post(body, signature) {
  const raw = JSON.stringify(body)
  const res = await fetch(ENDPOINT, {
    method:  'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature ?? sign(raw) },
    body:    raw,     // signed bytes === sent bytes; re-serialising would break the HMAC
  })
  return { status: res.status, body: await res.text() }
}

/** Exactly the envelope Meta sends for an inbound text message. */
function inboundPayload({ wamid, from, text, context }) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'local-waba',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15550000000', phone_number_id: PHONE_ID },
          contacts: [{ profile: { name: 'Local Test' }, wa_id: from }],
          messages: [{
            from, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text',
            text: { body: text },
            ...(context ? { context: { from: '15550000000', id: context } } : {}),
          }],
        },
      }],
    }],
  }
}

async function handshake() {
  const challenge = randomBytes(6).toString('hex')
  const ok = new URL(ENDPOINT)
  ok.search = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY, 'hub.challenge': challenge }).toString()
  const good = await fetch(ok)
  const echoed = await good.text()
  check(good.status === 200 && echoed === challenge, `GET with the right verify token → 200 + challenge echoed (got ${good.status})`)

  const bad = new URL(ok); bad.searchParams.set('hub.verify_token', 'wrong')
  check((await fetch(bad)).status === 403, 'GET with a wrong verify token → 403')
}

async function badsig() {
  const wamid = `wamid.LOCALTEST.${Date.now()}.forged`
  const r = await post(inboundPayload({ wamid, from: '919900011122', text: 'forged' }), 'sha256=' + '0'.repeat(64))
  check(r.status === 401, `POST with a forged signature → 401 (got ${r.status})`)
  const db = firestore()
  const snap = await db.collection('whatsappInbound').doc(createHash('sha256').update(wamid).digest('hex')).get()
  check(!snap.exists, 'nothing was written for the forged delivery')
}

function firestore() {
  if (!getApps().length) initializeApp({ projectId: PROJECT_ID })
  return getFirestore()
}

async function inbound() {
  const wamid = `wamid.LOCALTEST.${Date.now()}.${randomBytes(3).toString('hex')}`
  const body  = inboundPayload({
    wamid,
    from:    opt('from') ?? '919900011122',
    text:    opt('text') ?? 'Hello from the local webhook simulator',
    context: opt('context'),
  })

  const first = await post(body)
  check(first.status === 200, `first delivery acknowledged 200 (got ${first.status}: ${first.body})`)
  const again = await post(body)
  check(again.status === 200, `redelivery of the same wamid acknowledged 200 (got ${again.status})`)

  // Routing runs in after(), i.e. after the 200 — give it a moment.
  await new Promise(r => setTimeout(r, 2500))

  const db  = firestore()
  const ref = db.collection('whatsappInbound').doc(createHash('sha256').update(wamid).digest('hex'))
  const doc = await ref.get()
  check(doc.exists, `receipt written at whatsappInbound/${ref.id.slice(0, 12)}…`)
  if (!doc.exists) return

  const d = doc.data()
  console.log(`      state=${d.state}  routing=${JSON.stringify(d.routing ?? null)}  conversationId=${d.conversationId ?? '—'}`)
  check(['routed', 'unmatched', 'ignored'].includes(d.state), 'the receipt left `received` (routing ran)')

  const dupes = await db.collection('whatsappInbound').where('wamid', '==', wamid).count().get()
  check(dupes.data().count === 1, `exactly ONE receipt for the wamid after two deliveries (got ${dupes.data().count})`)

  if (d.state === 'routed' && d.conversationId) {
    const conv = await db.collection('whatsappConversations').doc(d.conversationId).get()
    check(conv.exists, `conversation ${d.conversationId} exists`)
    const msgs = await conv.ref.collection('messages').where('wamid', '==', wamid).count().get()
    check(msgs.data().count === 1, 'exactly one message row for the wamid in that conversation')
  }
}

const run = { inbound, handshake, badsig }[mode]
if (!run) { console.error(`Unknown mode "${mode}" — use inbound | handshake | badsig`); process.exit(2) }

run()
  .then(() => { console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed'); process.exit(failures ? 1 : 0) })
  .catch(err => { console.error(err); process.exit(1) })

// ─── Starting the emulator-backed server with TEST Meta values ─────────────────
// lib/whatsapp/config.ts throws if any META_* is set without the full set, so all six are
// given — every value fake. dotenv-cli does not override variables already in the
// environment, so these win over .env.emulator.
//
//   Git Bash:
//     META_APP_ID=local META_APP_SECRET=local-webhook-test-secret META_ACCESS_TOKEN=local \
//     META_PHONE_NUMBER_ID=100000000000001 META_BUSINESS_ACCOUNT_ID=local \
//     META_WEBHOOK_VERIFY_TOKEN=local-verify-token npm run emu:dev
//
//   PowerShell:
//     $env:META_APP_ID='local'; $env:META_APP_SECRET='local-webhook-test-secret';
//     $env:META_ACCESS_TOKEN='local'; $env:META_PHONE_NUMBER_ID='100000000000001';
//     $env:META_BUSINESS_ACCOUNT_ID='local'; $env:META_WEBHOOK_VERIFY_TOKEN='local-verify-token';
//     npm run emu:dev
