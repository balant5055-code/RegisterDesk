'use client'

// RD-MS-CLOSURE-01 · One photo, in full.
//
// ═══ WHAT THIS IS ═════════════════════════════════════════════════════════════
// A READ-ONLY drawer over the fields `MediaAssetView` already carries. Before it, the grid
// offered three inline actions and there was no way to see a photo's dimensions, its stored
// size, which compression profile produced it, how much it saved, which renditions exist, or
// whether anyone had ever downloaded it.
//
// ═══ WHAT THIS IS NOT ═════════════════════════════════════════════════════════
// Not an editor. No crop, no rotate, no filters — the sprint forbids them and the platform
// has no server-side image pipeline to run them with. Every action offered here is one the
// grid already had; this arranges them beside the facts rather than adding new ones.
//
// It fetches NOTHING. The drawer opens on a photo the grid has already loaded, so a second
// round trip would buy an identical answer.

import { Download, Loader2, X } from 'lucide-react'
import { Button, StatusChip } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import type { MediaAssetView } from '@/features/media-studio/types'

const VISIBILITY_LABEL: Record<MediaAssetView['visibility'], { label: string; tone: 'success' | 'info' | 'neutral' }> = {
  PUBLIC:     { label: 'Public',  tone: 'success' },
  SIGNED_URL: { label: 'Gated',   tone: 'info' },
  PRIVATE:    { label: 'Private', tone: 'neutral' },
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 KB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  const mb = bytes / (1024 * 1024)
  return mb < 1024 ? `${mb.toFixed(1)} MB` : `${(mb / 1024).toFixed(2)} GB`
}

const num = (n: number) => n.toLocaleString('en-IN')

export interface PhotoDetailDrawerProps {
  asset:   MediaAssetView
  onClose: () => void
  /** Reuses the grid's own download, so there is one implementation of it. */
  onDownload: (asset: MediaAssetView) => void
  downloading: boolean
}

export function PhotoDetailDrawer({
  asset, onClose, onDownload, downloading,
}: PhotoDetailDrawerProps) {
  // Space saved is MEASURED, not estimated: `bytesOriginalSource` is the size of the file the
  // organizer selected and `bytesStored` is what the bucket actually holds. Clamped at zero
  // because a profile never inflates a photo, so a negative would mean a bad stored number
  // rather than a real loss.
  const saved = Math.max(0, asset.bytesOriginalSource - asset.bytesStored)
  const savedPercent = asset.bytesOriginalSource > 0
    ? Math.round((saved / asset.bytesOriginalSource) * 100)
    : 0

  const vis = VISIBILITY_LABEL[asset.visibility]

  return (
    <>
      {/* Click-away. A plain overlay rather than a modal library: the drawer is informational
          and must never trap the organizer mid-review. */}
      <div
        className="fixed inset-0 z-40 bg-foreground/20 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-modal="false"
        aria-label={`Photo details${asset.originalFilename ? `: ${asset.originalFilename}` : ''}`}
        className={cn(
          'fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col',
          'border-l border-border bg-background shadow-xl',
          // Respects a reduced-motion preference — the slide is decoration.
          'motion-safe:animate-in motion-safe:slide-in-from-right motion-safe:duration-200',
        )}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-fs-sm font-medium text-foreground">
              {asset.originalFilename ?? 'Untitled photo'}
            </h2>
            <p className="mt-0.5 text-fs-2xs text-muted-foreground">
              {asset.uploadedAt
                ? new Date(asset.uploadedAt).toLocaleString('en-IN', {
                    day: 'numeric', month: 'short', year: 'numeric',
                    hour: 'numeric', minute: '2-digit',
                  })
                : 'Upload date unknown'}
            </p>
          </div>
          <Button variant="ghost" size="xs" onClick={onClose} aria-label="Close photo details">
            <X className="size-4" aria-hidden />
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {/* The largest rendition available. `previewUrl` is only populated when the list was
              asked for it; the thumbnail is the honest fallback rather than a broken tile. */}
          <div className="overflow-hidden rounded-xl border border-border bg-muted">
            {asset.previewUrl ?? asset.thumbnailUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={asset.previewUrl ?? asset.thumbnailUrl ?? ''}
                alt={asset.originalFilename ?? 'Photo'}
                className="h-auto w-full object-contain"
              />
            ) : (
              <div className="flex aspect-video items-center justify-center text-fs-2xs text-muted-foreground">
                Preview unavailable
              </div>
            )}
          </div>

          <div className="mt-4 flex items-center gap-2">
            <StatusChip tone={vis.tone}>{vis.label}</StatusChip>
            {asset.downloadCount > 0 && (
              <StatusChip tone="neutral">
                {num(asset.downloadCount)} download{asset.downloadCount === 1 ? '' : 's'}
              </StatusChip>
            )}
          </div>

          <Section title="Image">
            <Row label="Dimensions" value={
              asset.width && asset.height ? `${num(asset.width)} × ${num(asset.height)} px` : 'Unknown'
            } />
            <Row label="Format" value={asset.mimeType.replace('image/', '').toUpperCase()} />
          </Section>

          <Section title="Storage">
            <Row label="Stored" value={formatBytes(asset.bytesStored)} />
            <Row label="Original size" value={formatBytes(asset.bytesOriginalSource)} />
            <Row
              label="Space saved"
              value={saved > 0 ? `${formatBytes(saved)} (${savedPercent}%)` : 'None'}
            />
            <Row label="Compression" value={asset.profileId === 'unknown' ? '—' : asset.profileId} />
            <Row
              label="Renditions"
              value={asset.renditionNames.length > 0 ? asset.renditionNames.join(', ') : 'None'}
            />
          </Section>

          <Section title="Reach">
            {/* Only participant downloads are counted — an organizer opening their own
                gallery is not demand. Stated here so a zero is not read as a bug. */}
            <Row label="Participant downloads" value={num(asset.downloadCount)} />
            <p className="pt-1 text-fs-2xs text-muted-foreground">
              Counts downloads from the public gallery and participant photo pages. Your own
              downloads are not counted.
            </p>
          </Section>

          <Section title="Identity">
            <Row label="Photo ID" value={asset.assetId} mono />
            {/* The full checksum, not a prefix: it is what an organizer would paste into a
                support conversation about a duplicate. */}
            <Row label="Checksum" value={asset.checksum || '—'} mono wrap />
          </Section>
        </div>

        <footer className="border-t border-border px-4 py-3">
          <Button
            className="w-full" size="sm" variant="outline"
            disabled={downloading}
            onClick={() => onDownload(asset)}
          >
            {downloading
              ? <><Loader2 className="size-3.5 animate-spin" aria-hidden /> Downloading…</>
              : <><Download className="size-3.5" aria-hidden /> Download</>}
          </Button>
        </footer>
      </aside>
    </>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-5">
      <h3 className="text-fs-2xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <dl className="mt-2 space-y-1.5 border-t border-border/60 pt-2 text-fs-sm">{children}</dl>
    </section>
  )
}

function Row({
  label, value, mono, wrap,
}: { label: string; value: string; mono?: boolean; wrap?: boolean }) {
  return (
    <div className={cn('flex gap-3', wrap ? 'flex-col' : 'items-baseline justify-between')}>
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn(
        'text-foreground',
        mono ? 'font-mono text-fs-2xs' : 'tabular-nums',
        wrap ? 'break-all' : 'truncate',
      )}>
        {value}
      </dd>
    </div>
  )
}
