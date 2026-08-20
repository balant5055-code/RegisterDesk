// RD-RECOVER-01 phase 2 · TEMPORARY execution surface for six confirmed orphaned captures.
//
// ═══ DELETE THIS DIRECTORY ONCE ALL SIX HAVE RUN ═════════════════════════════
// Same reasoning as the PRITHIVIK page: POST /api/admin/recover-phase2/[key] requires a
// Firebase ID token from a signed-in admin, and the only place such a token exists is an
// authenticated admin browser session. This is that session's button set.
//
// Deliberately NOT registered in ADMIN_SIDEBAR_NAV: the command palette derives from that
// SSOT, and six money-moving buttons should not be one keystroke from every admin. Reaching
// this page requires typing the URL.

import { adminMetadata } from '@/app/(admin)/adminMetadata'
import PageClient        from './PageClient'

export const metadata = adminMetadata('Recovery Phase 2', 'Temporary six-case payment recovery.')

export default function Page() {
  return <PageClient />
}
