/* RD-ANALYTICS-11 — a FINANCE member on the fixture workspace. EMULATOR ONLY.
 *
 * The communications module has one financial figure — messaging spend — and the whole
 * boundary claim is that it follows `transactions` rather than "is this person senior".
 * Proving that needs a caller who holds `transactions` and is NOT the owner, because the
 * owner holds every permission and therefore cannot distinguish the two rules.
 *
 * `ROLE_PERMISSIONS.finance` is `['wallet', 'settlements', 'transactions']` — money without
 * `events` — which is exactly the discriminating case. The existing `manager` fixture
 * (rd-analytics-07-manager.mjs) is its mirror: `events` without `transactions`.
 *
 *   node rd-analytics-11-roles.mjs
 */
import { initializeApp, getApps } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.error('Refusing to run outside the emulator.'); process.exit(1)
}
const PROJECT = process.env.GCLOUD_PROJECT ?? ''
if (!PROJECT.startsWith('demo-')) {
  console.error(`Refusing to run outside a demo- project (got "${PROJECT}").`); process.exit(1)
}

if (!getApps().length) initializeApp({ projectId: PROJECT })
const auth = getAuth()
const db   = getFirestore()

const OWNER_UID = 'profiling-organizer-uid'
const EMAIL     = 'finance.a11@registerdesk.test'
const PASSWORD  = 'FinancePassw0rd!'

const user = await auth.getUserByEmail(EMAIL).catch(() => null)
  ?? await auth.createUser({ email: EMAIL, password: PASSWORD, emailVerified: true, displayName: 'A11 Finance' })
await auth.updateUser(user.uid, { password: PASSWORD, emailVerified: true })

// Empty `eventIds` is UNRESTRICTED for a non-gate role — see lib/team/eventScope.ts.
await db.collection('teamMembers').doc(`a11-finance-${OWNER_UID}`).set({
  organizerUid: OWNER_UID,
  memberUid:    user.uid,
  email:        EMAIL,
  name:         'A11 Finance',
  role:         'finance',
  status:       'active',
  eventIds:     [],
  createdAt:    new Date(),
})

// The dashboard reads a user profile at boot; without it the shell can stall before the
// module is ever requested.
await db.doc(`users/${user.uid}`).set({
  uid: user.uid, email: EMAIL, name: 'A11 Finance', role: 'organizer',
}, { merge: true })

console.log(`finance ready · ${EMAIL} / ${PASSWORD} · uid ${user.uid}`)
