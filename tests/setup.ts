// RD-GA-HARDEN-01 — global test setup.
//
// Stub the env vars that lib/env validates at module load, so financial modules that
// transitively import it (e.g. via monitoring/clawbacks) can be imported. Firebase is
// mocked per-file, so these dummy values never initialize or authenticate anything real.

process.env.FIREBASE_SERVICE_ACCOUNT_KEY ||= 'test-service-account'
process.env.TICKET_SECRET               ||= 'test-ticket-secret'
process.env.NEXT_PUBLIC_APP_URL         ||= 'https://test.local'
