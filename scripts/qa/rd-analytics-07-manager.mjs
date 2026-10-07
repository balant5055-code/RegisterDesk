/* RD-ANALYTICS-07 — a MANAGER on the fixture workspace. EMULATOR ONLY.
 *
 * `manager` holds `events` but not `transactions`, which is the role the financial
 * isolation claim rests on. The row is re-created here rather than assumed so the browser
 * check is reproducible from a clean emulator instead of depending on a hand-made account.
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
const EMAIL     = 'manager.a06@registerdesk.test'
const PASSWORD  = 'ManagerPassw0rd!'

const user = await auth.getUserByEmail(EMAIL).catch(() => null)
  ?? await auth.createUser({ email: EMAIL, password: PASSWORD, emailVerified: true, displayName: 'A06 Manager' })
await auth.updateUser(user.uid, { password: PASSWORD, emailVerified: true })

// An empty `eventIds` is UNRESTRICTED for a non-gate role — see lib/team/eventScope.ts —
// so the manager sees every event in the workspace, which is the state under test.
await db.collection('teamMembers').doc(`a07-manager-${OWNER_UID}`).set({
  organizerUid: OWNER_UID,
  memberUid:    user.uid,
  email:        EMAIL,
  name:         'A06 Manager',
  role:         'manager',
  status:       'active',
  eventIds:     [],
  createdAt:    new Date(),
})

// The dashboard reads a user profile at boot; without it the shell can stall before the
// Overview is ever requested.
await db.doc(`users/${user.uid}`).set({
  uid: user.uid, email: EMAIL, name: 'A06 Manager', role: 'organizer',
}, { merge: true })

console.log(`manager ready · ${EMAIL} / ${PASSWORD} · uid ${user.uid}`)
