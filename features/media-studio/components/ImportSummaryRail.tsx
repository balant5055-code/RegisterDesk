'use client'

// RD-MEDIA-UX-01 · The sticky summary rail.
//
// ═══ WHY THIS EXISTS ══════════════════════════════════════════════════════════
// The old page had a "6 · Review" section that restated the destination already shown twice
// above it, then a "7 · Upload" section that restated the counts the progress bar already
// encoded. Three places told you the same things, and the primary action sat at the bottom
// of ~1,900px of form.
//
// This is the one place that answers "what am I about to do, and can I do it?" — and it
// carries the single primary action on the page.
//
// PRESENTATION ONLY. Every number is passed in; nothing is computed from business state and
// no handler is defined here. `onStart`, `onPause`, `onCancel` and `onUploadMore` are the
// page's existing callbacks, unchanged.

import type { ReactNode } from 'react'
import Link from 'next/link'
import {
  CheckCircle2, CircleDashed, Images, Loader2, Pause, Play, X,
} from 'lucide-react'
import { Button, Card, ProgressBar, StatusChip, buttonVariants } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import { STAGE_ORDER, type ProgressStage } from '@/features/media-studio/utils/queueMachine'
import { STAGE_LABEL } from '@/features/media-studio/utils/uploadTimings'
import type { QueueCounts } from '@/features/media-studio/utils/queueMachine'

/** Which face the rail shows. Derived by the caller from the queue it already holds. */
export type RailState = 'ready' | 'uploading' | 'complete'

export interface ImportSummaryRailProps {
  state: RailState

  // ── Destination ──
  eventName:   string | null
  galleryName: string | null
  albumName:   string | null

  // ── Configuration ──
  brandingLabel: string
  brandingTone:  'success' | 'neutral' | 'warning'
  profileName:   string

  // ── Readiness ──
  hasEvent:   boolean
  hasGallery: boolean
  brandingResolved: boolean
  canStart:   boolean

  // ── Numbers ──
  photoCount:     number
  estimatedBytes: number
  savingsPercent: number
  estimatedSeconds: number
  storedBytes:    number

  // ── Live upload ──
  progress: number
  counts:   QueueCounts
  currentPhoto: { name: string; stage: ProgressStage | null } | null

  // ── Existing page callbacks, passed straight through ──
  onStart:  () => void
  onPause:  () => void
  onCancel: () => void
  onUploadMore: () => void
  galleryHref: string | null

  formatBytes:    (bytes: number) => string
  formatDuration: (seconds: number) => string
}

/**
 * Not sticky itself — `MEDIA_RAIL_COLUMN` on the grid item owns that, so the column is
 * content-sized rather than stretched to the workflow column's height.
 */
export function ImportSummaryRail(props: ImportSummaryRailProps) {
  return (
    <Card variant="elevated">
      {props.state === 'uploading'
        ? <Uploading {...props} />
        : props.state === 'complete'
          ? <Complete {...props} />
          : <Ready {...props} />}
    </Card>
  )
}

// ─── READY ────────────────────────────────────────────────────────────────────

function Ready(p: ImportSummaryRailProps) {
  const blocked = !p.canStart
  return (
    <div className="space-y-4">
      <header className="flex items-center gap-2">
        <span
          className={cn('size-2 shrink-0 rounded-full', blocked ? 'bg-warning' : 'bg-success')}
          aria-hidden
        />
        <h2 className="text-fs-md font-semibold text-foreground">
          {p.photoCount === 0
            ? 'Nothing selected yet'
            : blocked ? 'Not ready' : 'Ready to upload'}
        </h2>
      </header>

      {/* The numbers that decide whether to press the button. */}
      <dl className="space-y-1.5">
        <Metric label="Photos" value={p.photoCount.toLocaleString('en-IN')} emphasis />
        <Metric label="Estimated size" value={p.formatBytes(p.estimatedBytes)} />
        <Metric label="Storage saving" value={`${p.savingsPercent}%`} />
        {p.photoCount > 0 && (
          <Metric label="Estimated time" value={p.formatDuration(p.estimatedSeconds)} />
        )}
      </dl>

      <div className="border-t border-border pt-3">
        <dl className="space-y-1.5">
          <Metric label="Event"       value={p.eventName   ?? '—'} truncate />
          <Metric label="Gallery"     value={p.galleryName ?? '—'} truncate />
          <Metric label="Album"       value={p.albumName   ?? 'None'} truncate />
          <Metric label="Compression" value={p.profileName} />
          <Metric
            label="Branding"
            value={<StatusChip tone={p.brandingTone}>{p.brandingLabel}</StatusChip>}
          />
        </dl>
      </div>

      {/* Readiness checklist — says WHY the button is disabled rather than leaving an
          organizer to guess. */}
      <ul className="space-y-1 border-t border-border pt-3">
        <Check ok={p.hasEvent}   label="Event selected" />
        <Check ok={p.hasGallery} label="Gallery selected" />
        <Check ok={p.brandingResolved} label="Branding decided" />
        <Check ok={p.photoCount > 0} label="Photos added" />
      </ul>

      <Button
        variant="primary"
        size="md"
        className="w-full"
        disabled={blocked}
        onClick={p.onStart}
      >
        <Play className="size-4" aria-hidden />
        Start Upload
      </Button>
    </div>
  )
}

// ─── UPLOADING ────────────────────────────────────────────────────────────────

function Uploading(p: ImportSummaryRailProps) {
  const settled   = p.counts.completed + p.counts.failed
  const total     = p.counts.total - p.counts.cancelled
  const remaining = Math.max(0, total - settled)

  return (
    <div className="space-y-4">
      <header className="flex items-center gap-2">
        <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden />
        <h2 className="text-fs-md font-semibold text-foreground">Uploading</h2>
        <span className="ml-auto text-fs-md font-bold tabular-nums text-foreground">
          {p.progress}%
        </span>
      </header>

      <ProgressBar value={p.progress} label={`${p.progress}% complete`} />

      {/* Current file + its live stage. */}
      {p.currentPhoto && (
        <div className="rounded-lg border border-border bg-muted/40 p-2.5">
          <p className="truncate text-fs-sm font-medium text-foreground">
            {p.currentPhoto.name}
          </p>
          <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
            {STAGE_ORDER.map(stage => {
              const at = p.currentPhoto?.stage
                ? STAGE_ORDER.indexOf(p.currentPhoto.stage)
                : -1
              const i = STAGE_ORDER.indexOf(stage)
              const done = i <= at
              const active = i === at + 1
              return (
                <li
                  key={stage}
                  className={cn(
                    'flex items-center gap-1 text-fs-2xs',
                    done && 'text-success',
                    active && 'font-semibold text-foreground',
                    !done && !active && 'text-muted-foreground/50',
                  )}
                >
                  {done
                    ? <CheckCircle2 className="size-3" aria-hidden />
                    : active
                      ? <Loader2 className="size-3 animate-spin" aria-hidden />
                      : <CircleDashed className="size-3" aria-hidden />}
                  {STAGE_LABEL[stage]}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      <dl className="space-y-1.5">
        <Metric label="Completed" value={p.counts.completed.toLocaleString('en-IN')} emphasis />
        <Metric label="Remaining" value={remaining.toLocaleString('en-IN')} />
        {p.counts.failed > 0 && (
          <Metric
            label="Failed"
            value={<span className="text-destructive">{p.counts.failed}</span>}
          />
        )}
        <Metric label="ETA" value={p.formatDuration(etaSeconds(p))} />
      </dl>

      <div className="flex gap-2">
        <Button variant="outline" size="sm" className="flex-1" onClick={p.onPause}>
          <Pause className="size-4" aria-hidden /> Pause
        </Button>
        <Button variant="ghost" size="sm" className="flex-1" onClick={p.onCancel}>
          <X className="size-4" aria-hidden /> Cancel
        </Button>
      </div>
    </div>
  )
}

/**
 * Remaining time from the queue's own numbers.
 *
 * Deliberately derived from the ESTIMATE the page already computed rather than from measured
 * throughput: this is presentation, and adding a throughput sampler here would be new
 * behaviour in a refactor that must not add any.
 */
function etaSeconds(p: ImportSummaryRailProps): number {
  const total = p.counts.total - p.counts.cancelled
  if (total <= 0) return 0
  const done = p.counts.completed + p.counts.failed
  const left = Math.max(0, total - done)
  const perPhoto = p.estimatedSeconds / Math.max(1, total)
  return Math.round(left * perPhoto)
}

// ─── COMPLETE ─────────────────────────────────────────────────────────────────

function Complete(p: ImportSummaryRailProps) {
  return (
    <div className="space-y-4">
      <header className="flex items-center gap-2">
        <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden />
        <h2 className="text-fs-md font-semibold text-foreground">Upload complete</h2>
      </header>

      <dl className="space-y-1.5">
        <Metric
          label="Photos uploaded"
          value={p.counts.completed.toLocaleString('en-IN')}
          emphasis
        />
        {p.counts.failed > 0 && (
          <Metric
            label="Failed"
            value={<span className="text-destructive">{p.counts.failed}</span>}
          />
        )}
        <Metric label="Storage used" value={p.formatBytes(p.storedBytes)} />
        <Metric label="Gallery" value={p.galleryName ?? '—'} truncate />
      </dl>

      <div className="space-y-2">
        {/* `Button` renders a <button> and has no `asChild`, so a navigating action uses
            `buttonVariants` on a Link — the pattern the rest of the app uses. */}
        {p.galleryHref && (
          <Link
            href={p.galleryHref}
            className={cn(buttonVariants({ variant: 'primary', size: 'md' }), 'w-full')}
          >
            <Images className="size-4" aria-hidden />
            Open Gallery
          </Link>
        )}
        <Button variant="outline" size="md" className="w-full" onClick={p.onUploadMore}>
          Upload More
        </Button>
      </div>
    </div>
  )
}

// ─── Shared bits ──────────────────────────────────────────────────────────────

function Metric({
  label, value, emphasis, truncate,
}: { label: string; value: ReactNode; emphasis?: boolean; truncate?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-fs-sm text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'min-w-0 text-right tabular-nums',
          truncate && 'truncate',
          emphasis
            ? 'text-fs-md font-bold text-foreground'
            : 'text-fs-sm font-semibold text-foreground',
        )}
      >
        {value}
      </dd>
    </div>
  )
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className={cn('flex items-center gap-1.5 text-fs-sm', ok ? 'text-foreground' : 'text-muted-foreground')}>
      {ok
        ? <CheckCircle2 className="size-3.5 shrink-0 text-success" aria-hidden />
        : <CircleDashed className="size-3.5 shrink-0 text-muted-foreground/50" aria-hidden />}
      {label}
    </li>
  )
}
