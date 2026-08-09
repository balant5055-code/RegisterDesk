// Firebase Admin SDK — server-side only.
// Never import this file in client components or pages.

import { initializeApp, getApps, cert, type App } from 'firebase-admin/app'
import { getFirestore }  from 'firebase-admin/firestore'
import { getAuth }       from 'firebase-admin/auth'
import { FIREBASE_SERVICE_ACCOUNT_KEY } from '@/lib/env'
console.log(
  '[ADMIN]',
  'NEXT_RUNTIME =',
  process.env.NEXT_RUNTIME,
  'KEY EXISTS =',
  !!process.env.FIREBASE_SERVICE_ACCOUNT_KEY,
  'LEN =',
  process.env.FIREBASE_SERVICE_ACCOUNT_KEY?.length
)
function buildAdminApp(): App {
  if (getApps().length > 0) return getApps()[0]!

  // RD-EVENT-16 — Emulator Suite. The Admin SDK auto-routes to emulators when
  // FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST are set, and rejects real
  // credentials against them, so it is initialised with a project id and no `cert`.
  //
  // Guarded on the emulator host vars rather than NODE_ENV: those variables are what
  // actually redirect the SDK, so keying off anything else could produce a server that
  // believes it is in emulator mode while writing to production.
  if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    return initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? 'demo-registerdesk' })
  }

  if (!FIREBASE_SERVICE_ACCOUNT_KEY) {
    throw new Error(
      '[firebase/admin] FIREBASE_SERVICE_ACCOUNT_KEY is not set. ' +
      'See lib/env.ts for setup instructions.',
    )
  }

  const serviceAccount = JSON.parse(
    Buffer.from(FIREBASE_SERVICE_ACCOUNT_KEY, 'base64').toString('utf-8'),
  ) as object

  return initializeApp({ credential: cert(serviceAccount) })
}

export const adminApp  = buildAdminApp()
export const adminDb   = getFirestore(adminApp)
export const adminAuth = getAuth(adminApp)
