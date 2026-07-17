import { initializeApp, getApps, getApp } from 'firebase/app'

const firebaseConfig = {
  apiKey:            process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain:        process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId:         process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket:     process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId:             process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
}

// Validate against the values resolved ABOVE (which use literal
// `process.env.NEXT_PUBLIC_*` access). Next.js only inlines LITERAL env reads
// into the browser bundle — a DYNAMIC lookup like `process.env[v]` is left
// untouched and evaluates to `undefined` on the client, which made every
// variable look "missing" even when correctly set. Check the resolved config,
// never a dynamic process.env read.
const REQUIRED_ENTRIES: ReadonlyArray<readonly [name: string, value: string | undefined]> = [
  ['NEXT_PUBLIC_FIREBASE_API_KEY',             firebaseConfig.apiKey],
  ['NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',         firebaseConfig.authDomain],
  ['NEXT_PUBLIC_FIREBASE_PROJECT_ID',          firebaseConfig.projectId],
  ['NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET',      firebaseConfig.storageBucket],
  ['NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID', firebaseConfig.messagingSenderId],
  ['NEXT_PUBLIC_FIREBASE_APP_ID',              firebaseConfig.appId],
]

const missingVars = REQUIRED_ENTRIES.filter(([, value]) => !value).map(([name]) => name)
if (missingVars.length > 0) {
  const message =
    'Configuration error: the app is missing required Firebase settings (' +
    missingVars.join(', ') +
    '). Set these NEXT_PUBLIC_FIREBASE_* environment variables and rebuild.'
  // Fail fast IN THE BROWSER so the app surfaces a clear error (caught by the
  // global error boundary) instead of loading forever waiting on Firebase Auth.
  // On the server/build we only warn — NEXT_PUBLIC_* values are inlined at build
  // time, so throwing here would break the build instead of the runtime.
  if (typeof window !== 'undefined') {
    throw new Error(message)
  }
  console.warn('[firebase/config] ' + message)
}

// Prevent re-initialization in Next.js hot-reload / multiple module evaluations
export const firebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig)