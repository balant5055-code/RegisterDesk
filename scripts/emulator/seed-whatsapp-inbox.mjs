// WhatsApp Inbox — local verification data for the Firebase EMULATOR only.
//
// The Organizer Inbox is behind `featureFlags.whatsappInbox` (default OFF) and reads
// conversations that only the Meta webhook writes. A plain `npm run dev` talks to the REAL
// Firebase project (.env.local has no emulator switch), where the flag is off and no inbox
// data or composite indexes exist yet — so the Inbox is correctly hidden there. This script is
// the local way to see both inboxes WITHOUT touching production:
//
//   • turns the flag ON in the emulator's business configuration;
//   • seeds conversations for the standard seeded organizer (scripts/emulator/seed.mjs) and a
//     second organizer, plus messages the router could not assign (the unmatched queue);
//   • creates two emulator-only accounts: a MANAGER in the seeded workspace (no `broadcasts`
//     permission → must NOT get the Inbox) and a Super Admin candidate whose uid is
//     `emulator-super-admin` (a Super Admin only when the server runs with
//     ADMIN_UIDS=emulator-super-admin — this script never touches ADMIN_UIDS).
//
// Usage (emulator hosts must be set; run `npm run emu:seed` first for the organizer):
//   npx dotenv -e .env.emulator -- node scripts/emulator/seed-whatsapp-inbox.mjs [seed|flag-on|flag-off|clean]
//
// Refuses to run unless BOTH emulator hosts are set and the project id starts with `demo-`,
// so it can never write to a real project.

import { initializeApp, getApps } from 'firebase-admin/app'
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore'
import { getAuth } from 'firebase-admin/auth'

const PROJECT_ID = process.env.GCLOUD_PROJECT ?? 'demo-registerdesk'
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST || !PROJECT_ID.startsWith('demo-')) {
  console.error('Refusing: FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST must be set and the project must be demo-*.')
  process.exit(2)
}
if (!getApps().length) initializeApp({ projectId: PROJECT_ID })
const db = getFirestore(), auth = getAuth()

const ORGANIZER   = 'profiling-organizer-uid'          // scripts/emulator/seed.mjs
const SECOND_ORG  = 'emulator-inbox-org-2'
const MANAGER     = { uid: 'emulator-inbox-manager', email: 'inbox-manager@registerdesk.test' }
const SUPER_ADMIN = { uid: 'emulator-super-admin',   email: 'inbox-superadmin@registerdesk.test' }
const PASSWORD    = 'InboxPassw0rd!'
const TAG         = 'emulator-inbox-seed'

const now = Date.now()
const ago = min => Timestamp.fromMillis(now - min * 60_000)
const phone = n => `9198450${String(30000 + n).slice(-5)}`

async function upsertUser({ uid, email }, claims) {
  try { await auth.createUser({ uid, email, password: PASSWORD, emailVerified: true }) }
  catch (e) {
    if (e.code !== 'auth/uid-already-exists') throw e
    await auth.updateUser(uid, { email, password: PASSWORD, emailVerified: true })
  }
  await auth.setCustomUserClaims(uid, claims ?? null)
}

const setFlag = on => db.doc('system/businessConfiguration').set({ featureFlags: { whatsappInbox: on } }, { merge: true })

async function seed() {
  await setFlag(true)

  // Accounts.
  await upsertUser(MANAGER)
  await db.collection('teamMembers').doc(`${ORGANIZER}__${MANAGER.uid}`).set({
    id: `${ORGANIZER}__${MANAGER.uid}`, organizerUid: ORGANIZER, memberUid: MANAGER.uid, email: MANAGER.email,
    role: 'manager', permissions: ['events', 'registrations', 'checkin', 'walkin', 'participants'], status: 'active',
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), seed: TAG,
  })
  await db.doc(`users/${MANAGER.uid}`).set({ uid: MANAGER.uid, email: MANAGER.email, name: 'Inbox Manager', seed: TAG }, { merge: true })
  // `admin: true` lets the account through the admin SHELL (resolveAdminUid); the Inbox itself
  // additionally requires the uid to be in ADMIN_UIDS (resolveSuperAdminUid).
  await upsertUser(SUPER_ADMIN, { admin: true })
  await db.doc(`users/${SECOND_ORG}`).set({ organizationName: 'Second Organizer Co', seed: TAG }, { merge: true })

  // Conversations — the shape the routing transaction writes (lib/whatsapp-inbox/persist.ts).
  const CONVS = [
    [ORGANIZER, 'profiling-marathon-2026', 'Profiling Marathon 2026', 'Asha Raghavan', 2, 4,  ['Hi! Got my ticket, thank you 🙏', 'Is there parking near the start line?']],
    [ORGANIZER, 'profiling-marathon-2026', 'Profiling Marathon 2026', 'Karthik S',     1, 25, ['Can I collect my bib on race morning?']],
    [ORGANIZER, 'profiling-marathon-2026', 'Profiling Marathon 2026', null,            0, 180, ['Thanks, see you there!']],
    [SECOND_ORG, 'second-org-summit-2026', 'Second Org Summit 2026',  'Meera Nair',    1, 60, ['Will the slides be shared?']],
  ]
  let n = 0
  for (const [org, ev, evName, name, unread, minutes, texts] of CONVS) {
    n++
    const ref = db.collection('whatsappConversations').doc(`${org}__${ev}__${phone(n)}`)
    await ref.set({
      organizerUid: org, eventId: ev, eventName: evName, attendeePhone: phone(n),
      registrationIds: [], primaryRegistrationId: null, attendeeName: name, attendeeNameLower: name?.toLowerCase() ?? null,
      lastMessageAt: ago(minutes), lastMessagePreview: texts[texts.length - 1], lastDirection: 'inbound', lastInboundAt: ago(minutes),
      unreadCount: unread, unread: unread > 0, adminUnreadCount: unread, adminUnread: unread > 0,
      messageCount: texts.length, lastReadAt: null, lastReadByUid: null, adminLastReadAt: null, adminLastReadByUid: null,
      createdAt: ago(minutes + 30), updatedAt: ago(minutes), seed: TAG,
    })
    for (let i = 0; i < texts.length; i++) {
      await ref.collection('messages').doc(`m${i}`).set({
        direction: 'inbound', wamid: `wamid.${TAG}.${n}.${i}`, type: 'text', text: texts[i], media: null, location: null,
        contextWamid: i === 0 ? 'wamid.out' : null, metaTimestamp: ago(minutes + (texts.length - 1 - i) * 5),
        status: 'received', routingMethod: i === 0 ? 'context' : 'phone_conversation', createdAt: ago(minutes), seed: TAG,
      })
    }
  }

  // Unmatched receipts — what routing parks for Super Admin review.
  const UNMATCHED = [
    ['u1', '919900011122', 'Who is this? I got a message about an event.', 'no_candidates', 'none', 0, 30],
    ['u2', '919811122233', 'Thanks for the update', 'context_organizer_notification', 'invalid', 1, 90],
  ]
  for (const [id, from, text, reason, context, candidates, minutes] of UNMATCHED) {
    await db.collection('whatsappInbound').doc(`${TAG}-${id}`).set({
      wamid: `wamid.${TAG}.${id}`, phoneNumberId: 'emulator', fromRaw: from, fromPhone: from, type: 'text', text,
      media: null, location: null, contextWamid: context === 'invalid' ? 'wamid.out.organizer' : null,
      metaTimestamp: ago(minutes), receivedAt: ago(minutes), updatedAt: ago(minutes), state: 'unmatched', attempts: 1,
      routing: { method: null, reason, context, candidateCount: candidates, matchedLogId: null, candidateRegistrationIds: [] },
      seed: TAG,
    })
  }
  console.log('WhatsApp Inbox emulator data ready: flag ON, 4 conversations, 2 unmatched.')
  console.log(`  Organizer (owner):  profiling@registerdesk.test / ProfilingPassw0rd!   (from npm run emu:seed)`)
  console.log(`  Manager (no Inbox): ${MANAGER.email} / ${PASSWORD}`)
  console.log(`  Super Admin:        ${SUPER_ADMIN.email} / ${PASSWORD}   — start the server with ADMIN_UIDS=${SUPER_ADMIN.uid}`)
}

async function clean() {
  for (const col of ['whatsappConversations', 'whatsappInbound', 'teamMembers']) {
    const snap = await db.collection(col).where('seed', '==', TAG).get()
    for (const d of snap.docs) await db.recursiveDelete(d.ref)
  }
  for (const uid of [MANAGER.uid, SUPER_ADMIN.uid]) await auth.deleteUser(uid).catch(() => {})
  await setFlag(false)
  console.log('WhatsApp Inbox emulator data removed; flag OFF.')
}

const action = process.argv[2] ?? 'seed'
if (action === 'seed') await seed()
else if (action === 'flag-on') { await setFlag(true); console.log('whatsappInbox ON (emulator)') }
else if (action === 'flag-off') { await setFlag(false); console.log('whatsappInbox OFF (emulator)') }
else if (action === 'clean') await clean()
else { console.error(`Unknown action "${action}". Use seed | flag-on | flag-off | clean.`); process.exit(2) }
process.exit(0)
