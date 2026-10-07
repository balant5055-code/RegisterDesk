/* RD-ANALYTICS-08 — a CHECK-IN-ONLY member on the fixture workspace. EMULATOR ONLY.
 *
 * `checkin_staff` holds exactly ['checkin']. It must not reach Analytics simply because a
 * new module was added — the boundary is `authorizeWorkspace(req, 'events')`, and this
 * account is what proves it in a browser rather than only in a mock.
 *
 * Deliberately created with an ordinary address rather than the reserved `.invalid` staff
 * namespace: the refusal under test is the PERMISSION, and using a normal login removes
 * "the credential type blocked it" as an alternative explanation for the 403.
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
const EMAIL     = 'staff.a08@registerdesk.test'
const PASSWORD  = 'StaffPassw0rd!'

const user = await auth.getUserByEmail(EMAIL).catch(() => null)
  ?? await auth.createUser({ email: EMAIL, password: PASSWORD, emailVerified: true, displayName: 'A08 Gate Staff' })
await auth.updateUser(user.uid, { password: PASSWORD, emailVerified: true })

// A gate-only role with an EMPTY assignment is restricted, not unrestricted — see
// isEventInScope. The event is named explicitly so the refusal cannot be attributed to
// scope rather than to the missing `events` permission.
/**
 * The event this gate credential is assigned to, pinned by ID.
 *
 * This took `docs[0]` of a one-document page, which is whichever id sorts first — so once
 * RD-ANALYTICS-10's "a10-" fixtures existed the staff account was scoped to an arbitrary
 * one of them, and the refusal under test could have been attributed to SCOPE rather than
 * to the missing `events` permission. Same defect class as `rd-analytics-06-seed`'s
 * `findDraftId`; fixed the same way.
 */
const CANONICAL_DRAFT = 'profiling-draft-event'
const draft = await db.doc(`users/${OWNER_UID}/eventDrafts/${CANONICAL_DRAFT}`).get()
const eventIds = draft.exists ? [CANONICAL_DRAFT] : []

await db.collection('teamMembers').doc(`a08-staff-${OWNER_UID}`).set({
  organizerUid: OWNER_UID,
  memberUid:    user.uid,
  email:        EMAIL,
  name:         'A08 Gate Staff',
  role:         'checkin_staff',
  status:       'active',
  eventIds,
  createdAt:    new Date(),
})

await db.doc(`users/${user.uid}`).set({
  uid: user.uid, email: EMAIL, name: 'A08 Gate Staff', role: 'organizer',
}, { merge: true })

console.log(`checkin_staff ready · ${EMAIL} / ${PASSWORD} · events ${JSON.stringify(eventIds)}`)
