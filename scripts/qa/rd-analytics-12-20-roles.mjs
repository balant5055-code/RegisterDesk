/* RD-ANALYTICS-12-20 — an ADMIN member on the fixture workspace. EMULATOR ONLY.
 *
 * The phase's UI change is about what a caller WITHOUT `transactions` is told, and the brief
 * requires admin as well as manager. `ROLE_PERMISSIONS.admin` holds `events` (so the events
 * list is reachable) and NOT `transactions` (so revenue is withheld) — the same discriminating
 * shape as the existing manager fixture, from a different role, which is what makes it worth
 * having: it proves the caption follows the PERMISSION, not one particular role.
 *
 *   node rd-analytics-12-20-roles.mjs
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
const EMAIL     = 'admin.a1220@registerdesk.test'
const PASSWORD  = 'AdminPassw0rd!'

const user = await auth.getUserByEmail(EMAIL).catch(() => null)
  ?? await auth.createUser({ email: EMAIL, password: PASSWORD, emailVerified: true, displayName: 'A1220 Admin' })
await auth.updateUser(user.uid, { password: PASSWORD, emailVerified: true })

// Empty `eventIds` is UNRESTRICTED for a non-gate role — see lib/team/eventScope.ts.
await db.collection('teamMembers').doc(`a1220-admin-${OWNER_UID}`).set({
  organizerUid: OWNER_UID,
  memberUid:    user.uid,
  email:        EMAIL,
  name:         'A1220 Admin',
  role:         'admin',
  status:       'active',
  eventIds:     [],
  createdAt:    new Date(),
})

await db.doc(`users/${user.uid}`).set({
  uid: user.uid, email: EMAIL, name: 'A1220 Admin', role: 'organizer',
}, { merge: true })

console.log(`admin ready · ${EMAIL} / ${PASSWORD} · uid ${user.uid}`)
