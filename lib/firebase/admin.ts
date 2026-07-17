// Firebase Admin SDK — server-side only.
// Never import this file in client components or pages.

import { initializeApp, getApps, cert, type App } from 'firebase-admin/app'
import { getFirestore }  from 'firebase-admin/firestore'
import { getAuth }       from 'firebase-admin/auth'
import { FIREBASE_SERVICE_ACCOUNT_KEY } from '@/lib/env'

function buildAdminApp(): App {
  if (getApps().length > 0) return getApps()[0]!

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
