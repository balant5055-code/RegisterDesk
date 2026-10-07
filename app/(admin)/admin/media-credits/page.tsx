// MC-08 · Media Credits operations console.
//
// Platform admin only — every endpoint behind it is gated by `resolveAdminUid`, so the page
// itself carries no authorization logic of its own.
//
// RD-LEGACY-01 — Media Credits are RETIRED (RD-PHOTO-01). This console is HISTORICAL: it reads
// the old wallets, ledger, grants and refunds, and keeps the two wind-down actions that settle
// what already exists — rejecting a pending refund request (releases its hold) and retrying the
// payout of a refund approved before retirement. Nothing here can buy, grant or approve credits.

import Link from 'next/link'
import { SlidersHorizontal, Boxes } from 'lucide-react'
import { AdminCreditsConsole } from '@/features/media-credits/components/AdminCreditsConsole'
import { adminMetadata } from '@/app/(admin)/adminMetadata'
import { ROUTES } from '@/config/navigation'

export const metadata = adminMetadata(
  'Media Credits (retired)',
  'Historical Media Credit records and refunds still owed.',
)

export default function AdminMediaCreditsPage() {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-fs-2xl font-semibold text-foreground">Media Credits (retired)</h1>
        <p className="mt-1 text-fs-sm text-muted-foreground">
          Media Credits are no longer sold, granted or used — photos are bought per event on License
          &amp; Services. This page keeps the historical records and settles refunds still owed.
        </p>

        {/* ═══ RD-ADMIN-CLOSURE-01 · contextual navigation ═══════════════════
            RD-ADMIN-IA-01 found media administration split across three unrelated sidebar
            groups with nothing linking them: the money lives here in Finance, the prices and
            limits that produce it live in System → Configuration, and the jobs that settle it
            live in Operations. An admin who changed a credit price had no path to the console
            where that price takes effect.

            Contextual links, NOT new sidebar entries — the IA is unchanged and nothing is
            duplicated in the menu. Two links, pointing at the two places this console's
            numbers actually come from. */}
        <nav aria-label="Related consoles" className="mt-3 flex flex-wrap items-center gap-2">
          <Link
            href={ROUTES.ADMIN_BUSINESS_CONFIG}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-fs-2xs font-medium text-foreground transition-colors hover:bg-muted"
          >
            <SlidersHorizontal className="size-3.5 text-muted-foreground" aria-hidden />
            Media limits
          </Link>
          <Link
            href={ROUTES.ADMIN_OPERATIONS_CENTER}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-fs-2xs font-medium text-foreground transition-colors hover:bg-muted"
          >
            <Boxes className="size-3.5 text-muted-foreground" aria-hidden />
            Background jobs
          </Link>
        </nav>
      </div>
      <AdminCreditsConsole />
    </div>
  )
}
