'use client'

// RD-PHOTO-04 · The branding step of the import workflow.
//
// ═══ WHY THIS LIVES IN THE IMPORT FLOW ════════════════════════════════════════
// Upload-time branding makes branding a PRECONDITION of import, not an independent setting.
// The audit's headline defect was that an organizer could create an event, import thousands
// of photos and only then discover branding was permanently unavailable — because the import
// page said nothing at all when no artwork existed.
//
// So the decision is asked HERE, before photos are selected, and it is asked ONCE per event.
//
// EXACTLY ONE state renders. The state itself is resolved by `resolveBrandingWorkflow`
// (pure, unit-tested) on the server, so this component never decides anything — it only
// draws what it is told, and the hub card and the gallery badge draw from the same answer.
//
// All wording comes from `brandingCopy`. Nothing here invents a sentence.

import { useCallback, useState } from 'react'
import Link from 'next/link'
import { Ban, CheckCircle2, ExternalLink, Loader2, Lock, Sparkles, TriangleAlert } from 'lucide-react'
import { Banner, Button, StatusChip } from '@/components/ui'
import { ROUTES } from '@/config/navigation'
import { cn } from '@/lib/utils/cn'
import { withEvent } from '@/features/media-studio/context/MediaStudioContext'
// The SAME label/value row the summary rails use, so branding metadata is aligned with the
// rest of the dashboard rather than being a second implementation of a definition list.
import { RailMetric } from '@/features/media-studio/components/workspace'
import {
  BRANDING_DECIDE_ONCE, BRANDING_LABEL, BRANDING_NONE, BRANDING_PERMANENT,
  BRANDING_REQUIRED, BRANDING_SESSION_NOTE, BRANDING_UNDECIDED, BRANDING_WHAT,
  BRANDING_WHY_LOCKED,
} from '@/features/photo-branding/utils/brandingCopy'
import { formatBytes, formatDimensions } from '@/features/photo-branding/utils/artworkSpec'
import type { BrandingIntent } from '@/features/photo-branding/utils/brandingIntent'
import type { BrandingResponse } from '@/app/api/organizer/media-studio/branding/route'

export interface BrandingGateProps {
  eventId:  string
  branding: BrandingResponse | null
  /**
   * True while the first fetch is still in flight.
   *
   * Distinguishing this from `branding === null` matters: without it a normal page load
   * renders the FAILURE banner for as long as the request takes, then swaps it for a card of
   * a different height. That is a visible layout shift on every visit, and it reports a
   * problem that has not happened.
   */
  loading?: boolean
  /** Records the decision. Resolves once the server has stored it. */
  onDecide: (intent: BrandingIntent) => Promise<void>
}

export function BrandingGate({
  eventId, branding, loading, onDecide,
}: BrandingGateProps) {

  const [deciding, setDeciding] = useState<BrandingIntent | null>(null)

  const decide = useCallback(async (intent: BrandingIntent) => {
    if (deciding) return
    setDeciding(intent)
    try { await onDecide(intent) } finally { setDeciding(null) }
  }, [deciding, onDecide])

  // Still loading. One compact line, not a warning — see `loading` above.
  if (loading && !branding) {
    return (
      <p className="flex items-center gap-2 text-fs-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Checking this event’s branding…
      </p>
    )
  }

  // Branding could not be read. Treated as undecided rather than as "no branding": guessing
  // the permissive answer is how photos get imported unbranded by accident.
  if (!branding) {
    return (
      <Banner tone="warning" title="Branding status unavailable">
        Your event&apos;s branding setting could not be read, so importing is paused. Reload
        the page to try again.
      </Banner>
    )
  }

  const { workflow, overlay } = branding
  const brandingHref = withEvent(ROUTES.MEDIA_STUDIO_BRANDING, eventId, 'import')

  // ─── STATE 0 · Undecided ───────────────────────────────────────────────────
  if (workflow.state === 'undecided') {
    return (
      <div className="space-y-2">
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-warning/10" aria-hidden>
            <TriangleAlert className="size-[17px] text-warning" />
          </div>
          <div className="min-w-0 space-y-1">
            <h3 className="text-fs-md font-semibold text-foreground">
              {BRANDING_UNDECIDED}
            </h3>
            <p className="text-fs-sm leading-relaxed text-muted-foreground">
              {BRANDING_WHAT} {BRANDING_DECIDE_ONCE}
            </p>
          </div>
        </div>

        <div className="mt-3.5 flex flex-wrap gap-2">
          <Button size="sm" disabled={deciding !== null} onClick={() => void decide('branded')}>
            {deciding === 'branded'
              ? <Loader2 className="size-4 animate-spin" aria-hidden />
              : <Sparkles className="size-4" aria-hidden />}
            Use Photo Branding
          </Button>
          <Button
            size="sm" variant="outline" disabled={deciding !== null}
            onClick={() => void decide('unbranded')}
          >
            {deciding === 'unbranded'
              ? <Loader2 className="size-4 animate-spin" aria-hidden />
              : <Ban className="size-4" aria-hidden />}
            Import Without Branding
          </Button>
        </div>
      </div>
    )
  }

  // ─── STATE 3 · Branding required ───────────────────────────────────────────
  if (workflow.state === 'required') {
    return (
      <Banner tone="warning" title={BRANDING_LABEL.required}>
        <p>{BRANDING_REQUIRED}</p>
        <Link
          href={brandingHref}
          className="mt-2 inline-flex items-center gap-1.5 text-fs-base font-semibold text-primary transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          Upload Branding
          <ExternalLink className="size-3.5" aria-hidden />
        </Link>
      </Banner>
    )
  }

  // ─── STATE 4 · Locked ──────────────────────────────────────────────────────
  if (workflow.state === 'locked') {
    return overlay && workflow.brandingApplies ? (
      <ArtworkBlock
        overlay={overlay}
        manageHref={brandingHref}
        photoCount={workflow.photoCount}
        helper={BRANDING_WHY_LOCKED}
      />
    ) : (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Lock className="size-4 text-muted-foreground" aria-hidden />
          <h3 className="text-fs-md font-semibold text-foreground">{BRANDING_LABEL.locked}</h3>
          <StatusChip tone="neutral">{BRANDING_LABEL.disabled}</StatusChip>
          <span className="text-fs-2xs text-muted-foreground">
            {workflow.photoCount.toLocaleString('en-IN')} photo
            {workflow.photoCount === 1 ? '' : 's'} imported
          </span>
        </div>
        <p className="text-fs-sm leading-relaxed text-muted-foreground">
          {BRANDING_WHY_LOCKED}
        </p>
      </div>
    )
  }

  // ─── STATE 2 · Disabled ────────────────────────────────────────────────────
  if (workflow.state === 'disabled') {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Ban className="size-4 text-muted-foreground" aria-hidden />
          <h3 className="text-fs-md font-semibold text-foreground">
            {BRANDING_LABEL.disabled}
          </h3>
        </div>
        <p className="text-fs-sm leading-relaxed text-muted-foreground">{BRANDING_NONE}</p>
        <p className="text-fs-2xs text-muted-foreground">
          Changed your mind?{' '}
          <Link
            href={brandingHref}
            className="font-semibold text-primary transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            Set up branding
          </Link>{' '}
          before importing — after the first photo it can no longer be added.
        </p>
      </div>
    )
  }

  // ─── STATE 1 · Enabled ─────────────────────────────────────────────────────
  return overlay ? (
    <ArtworkBlock
      overlay={overlay}
      manageHref={brandingHref}
      helper={BRANDING_SESSION_NOTE}
    />
  ) : (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <CheckCircle2 className="size-4 text-success" aria-hidden />
        <h3 className="text-fs-md font-semibold text-foreground">{BRANDING_LABEL.enabled}</h3>
      </div>
      <p className="text-fs-sm leading-relaxed text-muted-foreground">{BRANDING_PERMANENT}</p>
    </div>
  )
}

/**
 * RD-MEDIA-IMPORT-09 · The artwork, its facts, and ONE sentence.
 *
 * ─── What moved, and why ─────────────────────────────────────────────────────
 * The status heading, the lock state and the imported count used to sit in a block ABOVE
 * this grid, with a paragraph under them — roughly 60px of full-width chrome stacked on top
 * of a two-column layout that had room to spare. They are facts about the artwork, so they
 * now live in the column of facts beside it.
 *
 * The two columns carry NO top margin. They used to inherit `mt-3` from the stacked layout
 * this replaced; inside a `gap-4` grid that was 12px of dead offset at the top of each.
 *
 * Exactly ONE helper sentence, below the grid. There were two near-duplicates before —
 * "every imported photo will permanently include this branding" and "this branding will be
 * applied automatically to every photo uploaded in this session" — about 50px apart.
 */
function ArtworkBlock({
  overlay, manageHref, photoCount, helper,
}: {
  overlay: NonNullable<BrandingResponse['overlay']>
  manageHref: string
  /** Supplied ⇒ the event is locked; adds the state and the count to the facts. */
  photoCount?: number
  helper: string
}) {
  return (
    <div className="space-y-2">
      <div className="grid gap-4 sm:grid-cols-[minmax(0,auto)_minmax(0,1fr)]">
        <OverlayThumbnail
          url={overlay.url} width={overlay.width} height={overlay.height}
          maxWidth={PREVIEW_MAX_WIDTH} href={manageHref} flush
        />
        <dl className="space-y-1.5">
          <RailMetric
            label="Status"
            value={
              <StatusChip tone={overlay.enabled ? 'success' : 'neutral'}>
                {overlay.enabled ? BRANDING_LABEL.enabled : BRANDING_LABEL.disabled}
              </StatusChip>
            }
          />
          {photoCount !== undefined && (
            <>
              <RailMetric
                label="State"
                value={
                  <span className="inline-flex items-center gap-1.5">
                    <Lock className="size-3.5 text-muted-foreground" aria-hidden />
                    {BRANDING_LABEL.locked}
                  </span>
                }
              />
              <RailMetric label="Imported" value={photoCount.toLocaleString('en-IN') + ' photos'} />
            </>
          )}
          <RailMetric label="Resolution" value={formatDimensions(overlay.width, overlay.height)} />
          <RailMetric label="File size"  value={formatBytes(overlay.bytes)} />
          <RailMetric
            label="Uploaded"
            value={new Date(overlay.uploadedAt).toLocaleDateString('en-IN', {
              day: 'numeric', month: 'short', year: 'numeric',
            })}
          />
        </dl>
      </div>
      <p className="text-fs-sm leading-relaxed text-muted-foreground">{helper}</p>
    </div>
  )
}

/**
 * RD-MEDIA-IMPORT-UX · The same bound Photo Branding uses.
 *
 * Scales with the viewport, floors where a 2048x360 banner is still legible, and ceilings far
 * below the artwork's native width so it is never upscaled. A max-WIDTH, not a max-height:
 * the height stays derived from the true aspect ratio, so nothing is cropped.
 */
export const PREVIEW_MAX_WIDTH = 'clamp(420px, 48vw, 700px)'

export function OverlayThumbnail({
  url, width, height, maxWidth, href, flush,
}: {
  url: string
  width: number
  height: number
  /** Omitted ⇒ full column width, exactly as before. */
  maxWidth?: string
  /**
   * Supplied ⇒ the artwork becomes the affordance for managing branding.
   *
   * A LINK, not a button: it navigates. Button semantics on something that changes the URL
   * loses middle-click, open-in-new-tab and the screen-reader announcement of a destination.
   */
  href?: string
  /** True ⇒ no top margin. For grid cells, where the parent's gap already separates. */
  flush?: boolean
}) {
  const frame = (
    <div
      className="overflow-hidden rounded-lg border border-border"
      style={{
        // From the artwork's own dimensions, so the frame holds its height whether or not
        // the image is drawn — the with/without toggle can never reflow the panel.
        aspectRatio: height > 0 ? width / height : undefined,
        backgroundImage:
          'linear-gradient(45deg,var(--muted) 25%,transparent 25%,transparent 75%,var(--muted) 75%),'
          + 'linear-gradient(45deg,var(--muted) 25%,transparent 25%,transparent 75%,var(--muted) 75%)',
        backgroundSize: '12px 12px',
        backgroundPosition: '0 0, 6px 6px',
      }}
    >
        {/* A plain <img>, matching every other Media Studio surface: the overlay URL may be
            a SIGNED object-storage URL (RD-MEDIA-07) whose host is absent from
            `images.remotePatterns` when no public domain is configured — next/image would
            refuse it in exactly the deployment that resolver exists to support. */}
        {/* RD-PHOTO-06 — intrinsic width/height give the browser the aspect ratio BEFORE
            the bytes arrive, so the box is reserved at the right size instead of collapsing
            to 0 and jumping on decode. It matters more here than usual: with no public
            bucket domain configured these are SIGNED urls, and one that 403s never resolves
            at all. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt="Your event branding overlay"
          width={width}
          height={height}
          loading="lazy"
          decoding="async"
          className="h-auto w-full"
        />
    </div>
  )

  return (
    <div className={cn('space-y-1.5', !flush && 'mt-3')} style={maxWidth ? { maxWidth } : undefined}>
      {href ? (
        <Link
          href={href}
          title="Manage branding"
          aria-label="Manage branding"
          className={cn(
            'group block w-full cursor-pointer rounded-lg transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
            'focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            '[&>div]:transition-colors [&>div]:hover:border-primary/60',
          )}
        >
          {frame}
        </Link>
      ) : frame}
      {!maxWidth && (
        <p className="text-fs-2xs text-muted-foreground">
          {width} × {height} px
        </p>
      )}
    </div>
  )
}
