// RD-RECOVER-01 · TEMPORARY execution surface for a single production recovery.
//
// ═══ DELETE THIS DIRECTORY ONCE THE RECOVERY HAS RUN ═════════════════════════
// This page exists for one reason: `POST /api/admin/recover-orphaned-capture` requires a
// Firebase ID token from a signed-in admin, and the only place such a token exists is an
// authenticated admin browser session. This is that session's button. It is scaffolding for
// a single incident, not a feature, and it must not become one.
//
// It is deliberately NOT registered in ADMIN_SIDEBAR_NAV: a temporary surface that appears in
// the navigation SSOT would outlive its incident, and the ⌘K palette derives from that SSOT,
// so listing it there would put a money-moving button one keystroke from every admin.
// Reaching it requires typing the URL.

import { adminMetadata } from '@/app/(admin)/adminMetadata'
import PageClient        from './PageClient'

export const metadata = adminMetadata('Recover PRITHIVIK', 'Temporary single-case payment recovery.')

export default function Page() {
  return <PageClient />
}
