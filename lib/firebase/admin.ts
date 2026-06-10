// Firebase Admin SDK — server-side only.
// Never import this file in client components or pages.

import { initializeApp, getApps, cert, type App } from 'firebase-admin/app'
import { getFirestore }  from 'firebase-admin/firestore'
import { getAuth }       from 'firebase-admin/auth'

function buildAdminApp(): App {
  if (getApps().length > 0) return getApps()[0]!

  const encodedKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY
  if (!encodedKey) {
    throw new Error(
      'FIREBASE_SERVICE_ACCOUNT_KEY is not set. ' +
      'Generate a service account key from the Firebase console, ' +
      'base64-encode it, and add it to .env.local.',
    )
  }

  const serviceAccount = JSON.parse(
    Buffer.from(encodedKey, 'base64').toString('utf-8'),
  ) as object

  return initializeApp({ credential: cert(serviceAccount) })
}

export const adminApp  = buildAdminApp()
export const adminDb   = getFirestore(adminApp)
export const adminAuth = getAuth(adminApp)
