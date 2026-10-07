// MC-07 · Media Studio → Credits — RETIRED (RD-PHOTO-01, 2026-10-06).
//
// Photos are a paid EVENT service bought only on the event's License & Services step. The
// organizer-level Media Credits wallet (and its credit checkout) is no longer an active
// purchase or upload path, so this route keeps working for old bookmarks but sells nothing: it
// explains where photo capacity now lives and links there. Historical credit records remain
// auditable by Super Admins (Admin → Media Credits).

import Link from 'next/link'
import { MediaStudioHeader } from '@/features/media-studio/components/MediaStudioHeader'
import { Card, buttonVariants } from '@/components/ui'
import { ROUTES } from '@/config/navigation'

export const metadata = { title: 'Photo capacity — Media Studio' }

export default function MediaStudioCreditsPage() {
  return (
    <div className="space-y-5">
      <MediaStudioHeader
        title="Photo capacity"
        subtitle="Photos are purchased per event, on the event’s License & Services step."
      />
      <Card className="max-w-2xl p-5">
        <h2 className="text-fs-md font-semibold text-foreground">Media Credits are no longer used</h2>
        <p className="mt-2 text-fs-sm text-muted-foreground">
          Every photo you upload uses the photo capacity paid for on that event — up to 3,000 photos per
          event. To add capacity, open the event’s License &amp; Services step (from the Event Wallet’s
          Photos card, or from the Import page when capacity runs out). Media Studio itself never takes a payment.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href="/dashboard/wallet" className={buttonVariants({ size: 'sm' })}>Open Event Wallet</Link>
          <Link href={ROUTES.MEDIA_STUDIO_IMPORT} className={buttonVariants({ size: 'sm', variant: 'outline' })}>Import photos</Link>
        </div>
      </Card>
    </div>
  )
}
