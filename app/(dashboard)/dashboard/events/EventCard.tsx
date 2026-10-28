'use client'

// RD-EVENT-02 §5–§11 · The event card.
//
// Extracted from the 810-line EventsClient it used to live inside. Everything it decides
// about wording, tone and which actions exist comes from ./presentation, so this file is
// only structure and style — and the parts worth testing are testable without a DOM.
//
// Layout is one column of decreasing loudness: identity (image, status, name, date), then
// anything needing attention, then the numbers, then the actions. Depth is a single
// border plus one hairline; the brand colour appears once, on the primary action.

import { useCallback, useState } from 'react'
import Link from 'next/link'
import {
  Calendar, Users, IndianRupee, ExternalLink, Pencil, Copy, Archive,
  ArchiveRestore, Trash2, ArrowRight, XCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { ReviewDeadlineCountdown } from '@/components/events/ReviewDeadlineCountdown'
import { CLOSURE_SERVICES_SHORT } from '@/lib/notifications/reviewDeadlineAlerts'
import { accent } from '@/lib/dashboard/accents'
import type { EventListItem } from '@/app/api/organizer/events/route'
import { EventCardMenu, type EventMenuItem } from './EventCardMenu'
import {
  UNAVAILABLE, fmtDate, capitalizeType,
  registrationsDisplay, revenueDisplay, capacityDisplay,
  lifecycleTone, lifecycleLabel, isReadOnlyLifecycle,
  actionAvailability, needsResubmit, manageHref, publicHref, primaryActionLabel,
} from './presentation'

export interface EventCardActions {
  onDuplicate:   (e: EventListItem) => void
  onArchive:     (e: EventListItem) => void
  onRestore:     (e: EventListItem) => void
  onDeleteDraft: (e: EventListItem) => void
  onDeleteForever: (e: EventListItem) => void
  onResubmit:    (e: EventListItem) => void
  /** RD-REVIEW-02 — close an event whose changes were requested (asks for confirmation first). */
  onCloseReview: (e: EventListItem) => void
}

/** Which mutation, if any, is currently in flight for this card. */
export type PendingAction =
  | 'duplicate' | 'archive' | 'restore' | 'delete' | 'resubmit' | 'close' | null

/** RD-REVIEW-02 — the wizard entry point for an event (the same relay every other deep link uses). */
const editEventHref = (e: EventListItem) => `/dashboard/events/new/visibility?draftId=${encodeURIComponent(e.draftId)}`

// ─── Status + type chips ──────────────────────────────────────────────────────

/**
 * Chips sit on top of the banner, so they carry an opaque plate of their own.
 *
 * The accent scale's `tile` pair is translucent in dark mode by design (it is meant for a
 * card surface); over a photograph that would leave the label fighting whatever pixel
 * happened to be behind it. The `bg-card` backing underneath makes the composite
 * deterministic, which is what lets the contrast below be a measurement rather than a hope.
 */
/**
 * 2026-09-29 luxury pass (owner: "compact, luxury, organizer feel"): the status is ONE
 * opaque plate with a tone dot — foreground ink on `bg-card`, so its contrast no longer
 * depends on the accent `tile` pair or on the photograph behind it. The tone is carried by
 * the dot AND stated in the words, so colour is never the only channel.
 */
function StatusChip({ event }: { event: EventListItem }) {
  const tone = lifecycleTone(event.lifecycleStatus)
  return (
    <span className="inline-flex items-center gap-1.5 rounded-control bg-card px-2 py-1 text-fs-2xs font-semibold text-foreground shadow-[0_1px_2px_rgb(15_23_42_/_0.10)] ring-1 ring-inset ring-border/60">
      <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', accent(tone).bar)} />
      {lifecycleLabel(event.lifecycleStatus)}
    </span>
  )
}

/**
 * Event type — a category, not a state, so it is quiet small caps beside the date rather
 * than a second coloured chip on the banner. The status is the one that earns colour.
 */
function TypeLabel({ type }: { type: string | null }) {
  if (!type) return null
  return (
    <span className="shrink-0 font-semibold uppercase tracking-[0.12em] text-[color:var(--primary-text)]">
      {capitalizeType(type)}
    </span>
  )
}

// ─── Event image (§7) ─────────────────────────────────────────────────────────

/**
 * Four states: loading, loaded, missing, and failed-to-load.
 *
 * Missing and failed resolve to the SAME intentional placeholder — a faint brand wash
 * with the event's initial — because from the organizer's point of view they are the same
 * thing, and a broken-image glyph makes a product look unfinished. `alt=""` throughout:
 * the card's heading already names the event, so describing the banner again would make
 * a screen reader say it twice.
 */
function EventImage({ event }: { event: EventListItem }) {
  const [failed, setFailed]   = useState(false)
  const [loaded, setLoaded]   = useState(false)
  const showImage = Boolean(event.bannerUrl) && !failed

  /**
   * The browser starts fetching from the server-rendered HTML, so an image can finish —
   * or fail — BEFORE React attaches onLoad/onError. Measured: a dead banner URL left
   * `complete: true, naturalWidth: 0` with neither handler ever called, so the card sat
   * on an empty grey box instead of falling back to its placeholder. A cached image hit
   * the mirror image of the same race and stayed at `opacity-0` forever.
   *
   * Reading the element's own state when the ref attaches settles both, because
   * `complete` and `naturalWidth` are facts the DOM already holds by then.
   */
  const settleFromDom = useCallback((node: HTMLImageElement | null) => {
    if (!node || !node.complete) return
    if (node.naturalWidth === 0) setFailed(true)
    else setLoaded(true)
  }, [])

  return (
    // 2026-09-29 mobile pass: a 76px square THUMBNAIL on a phone (the card is a row there),
    // the full-width 2:1 banner from sm up.
    <div className="relative size-[76px] shrink-0 overflow-hidden rounded-control bg-muted/40 ring-1 ring-inset ring-border/50 sm:aspect-[2/1] sm:h-auto sm:w-full sm:rounded-none sm:ring-0">
      {showImage ? (
        <>
          {!loaded && <div className="absolute inset-0 animate-pulse bg-muted" />}
          <img
            ref={settleFromDom}
            src={event.bannerUrl ?? ''}
            alt=""
            loading="lazy"
            decoding="async"
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
            className={cn(
              'size-full object-cover transition-[opacity,transform] duration-500 ease-out group-hover:scale-[1.03]',
              loaded ? 'opacity-100' : 'opacity-0',
            )}
          />
        </>
      ) : (
        <div
          className="relative flex size-full items-center justify-center bg-[radial-gradient(120%_90%_at_100%_0%,rgb(var(--primary-rgb)_/_0.10),transparent_60%),radial-gradient(90%_80%_at_0%_100%,rgb(var(--primary-rgb)_/_0.05),transparent_60%)]"
          aria-hidden
        >
          {/* 2026-09-29: a monogram TILE on a faint brand wash, rather than a bare grey
              letter that read as a missing image. Decorative — the heading names the
              event and this block is aria-hidden. */}
          <span className="flex size-10 select-none items-center justify-center rounded-control border border-primary/15 bg-card text-fs-lg font-semibold sm:size-14 sm:rounded-surface sm:text-fs-2xl text-[color:var(--primary-text)] shadow-[0_8px_24px_-12px_rgb(var(--primary-rgb)_/_0.45)]">
            {event.name.trim().charAt(0).toUpperCase() || '?'}
          </span>
        </div>
      )}

      <div className="absolute left-2.5 top-2.5 hidden sm:block">
        <StatusChip event={event} />
      </div>
    </div>
  )
}

// ─── Metric row (§10, §11 + the H1 contract) ──────────────────────────────────

/**
 * 2026-09-29: one cell of a two-up stat strip — small-caps label over the figure — in
 * place of the old label/value rows inside a tinted box. A "count / capacity" value
 * renders its capacity quieter, so the number that matters reads first.
 */
function Metric({ icon: Icon, label, value, unavailable, className }: {
  icon: typeof Users
  label: string
  value: string
  unavailable: boolean
  className?: string
}) {
  const [head, tail] = value.split(' / ')
  return (
    <div className={cn('min-w-0', className)}>
      <dt className="flex items-center gap-1.5 text-fs-2xs text-muted-foreground sm:text-fs-xs">
        <Icon className="size-3 shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
      </dt>
      {unavailable ? (
        <dd className="mt-0.5 text-fs-sm font-medium text-muted-foreground sm:mt-1 sm:text-fs-md">
          <span aria-hidden>{UNAVAILABLE}</span>
          <span className="sr-only">Unavailable</span>
        </dd>
      ) : (
        // `break-words` + `min-w-0`: a large figure wraps inside the card rather than
        // widening the grid track, which is what took the page 199px wide on mobile.
        <dd className="mt-0.5 min-w-0 break-words text-fs-sm font-semibold tabular-nums sm:mt-1 sm:text-fs-md tracking-[-0.01em] text-foreground">
          {head}
          {tail !== undefined && (
            <span className="text-fs-xs font-medium text-muted-foreground"> / {tail}</span>
          )}
        </dd>
      )}
    </div>
  )
}

// ─── RD-REVIEW-02 · Changes requested / Action Required ───────────────────────

/**
 * What the Super Admin asked for, the deadline the SERVER stored (the countdown only displays it),
 * and the two things the organizer can do: Edit Event — the existing editor, whose Submit for Review
 * resubmits — or Close Event. Deliberately no Resubmit button here: resubmission goes through the
 * editor so its validation and the saved content are what reaches review.
 */
function ReviewRequestPanel({ event, busy, pending, onClose }: {
  event: EventListItem; busy: boolean; pending: PendingAction; onClose: () => void
}) {
  const dl = event.reviewDeadline ?? null
  const actionRequired = dl?.phase === 'action_required'
  return (
    <div className={cn('mx-3 mb-3 min-w-0 space-y-2.5 rounded-control border p-3 sm:mx-4',
      actionRequired ? 'border-destructive/30 bg-destructive/5' : 'border-warning/30 bg-warning/10')}>
      <div>
        <p className="text-fs-xs font-semibold text-foreground">{actionRequired ? 'Action required' : 'Changes requested'}</p>
        {event.changesComment && (
          // The request is the whole point of the notice, so it wraps in full rather than truncating.
          <p className="mt-1 break-words text-fs-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
            {event.changesComment}
          </p>
        )}
      </div>
      {dl && (
        <ReviewDeadlineCountdown
          dueAt={actionRequired && dl.actionDueAt !== null ? dl.actionDueAt : dl.changesDueAt}
          label={actionRequired ? 'Closes automatically' : 'Changes due'}
          expiredText={actionRequired
            ? 'The event is being closed. It can no longer be edited or resubmitted.'
            : 'Edit and resubmit soon: one final 24-hour window starts, then the event closes.'}
        />
      )}
      {actionRequired && (
        <p className="text-fs-2xs leading-relaxed text-muted-foreground">
          If you do nothing, this event is closed at the deadline and can no longer be edited or resubmitted.{' '}
          {CLOSURE_SERVICES_SHORT}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Link
          href={editEventHref(event)}
          aria-disabled={busy || undefined}
          className={cn(
            'inline-flex h-11 items-center gap-1.5 rounded-control bg-foreground px-3.5 text-fs-xs font-semibold text-background',
            'transition-opacity hover:opacity-90 aria-disabled:pointer-events-none aria-disabled:opacity-50',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
          )}
        >
          <Pencil className="size-3.5" aria-hidden /> Edit Event
        </Link>
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className={cn(
            'inline-flex h-11 items-center gap-1.5 rounded-control border border-border bg-card px-3.5 text-fs-xs font-semibold text-foreground',
            'transition-colors hover:bg-muted disabled:opacity-50',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
          )}
        >
          <XCircle className="size-3.5" aria-hidden /> {pending === 'close' ? 'Closing…' : 'Close Event'}
        </button>
      </div>
    </div>
  )
}

// ─── Card ─────────────────────────────────────────────────────────────────────

export function EventCard({ event, actions, pending, canDeleteDraft }: {
  event:   EventListItem
  actions: EventCardActions
  pending: PendingAction
  /** The list owns draft deletion, so it tells the card whether that handler exists. */
  canDeleteDraft: boolean
}) {
  const ls        = event.lifecycleStatus
  const readOnly  = isReadOnlyLifecycle(ls)
  const avail     = actionAvailability(event, { canDeleteDraft })
  const regs      = registrationsDisplay(event)
  const revenue   = revenueDisplay(event)
  const capacity  = capacityDisplay(event)
  const publicUrl = publicHref(event)
  const busy      = pending !== null

  const menuItems: EventMenuItem[] = []
  // RD-EVENT-DRAFT-NAV-01 · NOT offered for a draft, because the primary button already is it.
  //
  // This entry used to read "Continue setup" for a draft — the same words as the primary
  // button beside it — while the two went to different places: the button to the event
  // workspace, this to the wizard. Two controls, one name, two destinations, and the
  // working one hidden behind the overflow menu.
  //
  // `manageHref` now sends a draft's primary button to the wizard, so this would be an exact
  // duplicate of it. It stays for every other editable status, where the button means
  // something genuinely different ("Manage" → the event workspace).
  if (avail.edit && ls !== 'draft') {
    menuItems.push({
      key: `${event.draftId}-edit`, label: 'Edit event',
      icon: Pencil, onSelect: () => { window.location.href = `/dashboard/events/new/visibility?draftId=${event.draftId}` },
    })
  }
  if (avail.duplicate) {
    menuItems.push({
      key: `${event.draftId}-duplicate`, label: 'Duplicate', icon: Copy,
      onSelect: () => actions.onDuplicate(event),
      pending: pending === 'duplicate', pendingLabel: 'Duplicating…',
    })
  }
  if (avail.archive) {
    menuItems.push({
      key: `${event.draftId}-archive`, label: 'Archive', icon: Archive,
      onSelect: () => actions.onArchive(event),
      pending: pending === 'archive', pendingLabel: 'Archiving…',
    })
  }
  if (avail.restore) {
    menuItems.push({
      key: `${event.draftId}-restore`, label: 'Restore', icon: ArchiveRestore,
      onSelect: () => actions.onRestore(event),
      pending: pending === 'restore', pendingLabel: 'Restoring…',
    })
  }
  if (avail.deleteDraft) {
    menuItems.push({
      key: `${event.draftId}-delete`, label: 'Delete draft', icon: Trash2,
      onSelect: () => actions.onDeleteDraft(event),
      separated: true, destructive: true,
      pending: pending === 'delete', pendingLabel: 'Deleting…',
    })
  }
  if (avail.deleteForever) {
    menuItems.push({
      key: `${event.draftId}-purge`, label: 'Delete permanently', icon: Trash2,
      onSelect: () => actions.onDeleteForever(event),
      separated: true, destructive: true,
      pending: pending === 'delete', pendingLabel: 'Deleting…',
    })
  }
  // An archived event whose licence read failed: say why the action is missing rather
  // than leaving a gap the organizer has to guess about.
  if (ls === 'archived' && event.licenseUnavailable) {
    menuItems.push({
      key: `${event.draftId}-purge-unknown`, label: 'Delete permanently', icon: Trash2,
      onSelect: () => undefined, separated: true, disabled: true,
      disabledReason: 'Licence status could not be loaded, so this event cannot be deleted right now.',
    })
  }

  return (
    <article
      className={cn(
        'group relative flex h-full min-w-0 flex-col overflow-hidden rounded-surface',
        'border border-border/80 bg-card shadow-[0_1px_2px_rgb(15_23_42_/_0.04)]',
        'transition-[border-color,box-shadow,transform] duration-200 ease-out',
        'hover:-translate-y-0.5 hover:border-border-strong hover:shadow-[0_1px_2px_rgb(15_23_42_/_0.04),0_18px_40px_-24px_rgb(15_23_42_/_0.28)]',
        'focus-within:border-border-strong motion-reduce:hover:translate-y-0',
        busy && 'opacity-70',
      )}
      aria-busy={busy || undefined}
    >
      {/*
        §6 · The identity region IS the link. A plain block anchor wrapping non-interactive
        content — no nested buttons, no absolute overlay — so the hover that highlights the
        title is the same element that actually navigates, and the accessible name is the
        heading text. The old card only navigated from its footer button while styling the
        title as though it were clickable.
      */}
      <Link
        href={manageHref(event)}
        className={cn(
          'flex min-w-0 items-start gap-3 rounded-t-surface p-3 transition-colors sm:block sm:p-0',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50',
        )}
      >
        <EventImage event={event} />

        <div className="min-w-0 flex-1 sm:px-4 sm:pb-3 sm:pt-3.5">
          {/* Type · date on one small-caps line ABOVE the name, so every title starts at
              the same height whether or not the event has a type. */}
          <p className="flex min-w-0 items-center gap-2 text-fs-2xs text-muted-foreground">
            <TypeLabel type={event.eventType} />
            {event.eventType && <span aria-hidden className="h-3 w-px shrink-0 bg-border" />}
            <Calendar className="size-3 shrink-0" aria-hidden />
            <span className="min-w-0 truncate font-medium tabular-nums">{fmtDate(event.startDate)}</span>
          </p>
          <h3 className={cn(
            'mt-1 line-clamp-2 break-words text-fs-sm font-semibold leading-snug sm:mt-1.5 sm:text-fs-md tracking-[-0.01em] transition-colors',
            readOnly
              ? 'text-muted-foreground'
              : 'text-foreground group-hover:text-[color:var(--primary-text)]',
          )}>
            {event.name}
          </h3>
          {/* On a phone the thumbnail is too small to carry the status plate, so it sits
              under the name instead. */}
          <div className="mt-2 sm:hidden">
            <StatusChip event={event} />
          </div>
        </div>
      </Link>

      {/* RD-REVIEW-02 — changes requested: what to fix, the server-stored deadline, ONE edit action
          (the editor's own Submit for Review resubmits) and a separate Close Event. */}
      {event.lifecycleStatus === 'changes_requested' && (
        <ReviewRequestPanel event={event} busy={busy} pending={pending} onClose={() => actions.onCloseReview(event)} />
      )}

      {/* Attention: an admin sent this back. Interactive, so it sits outside the link. */}
      {needsResubmit(event) && event.lifecycleStatus !== 'changes_requested' && (
        <div className="mx-3 mb-3 min-w-0 rounded-control sm:mx-4 border border-warning/30 bg-warning/10 p-3">
          <p className="text-fs-xs font-semibold text-foreground">
            {event.reviewStatus === 'rejected' ? 'Not approved' : 'Changes requested'}
          </p>
          {(event.rejectionReason || event.changesComment) && (
            // §18 · The reason is the whole point of the notice, so it wraps in full
            // rather than truncating — including a long URL or an unbroken Tamil word.
            <p className="mt-1 break-words text-fs-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
              {event.rejectionReason || event.changesComment}
            </p>
          )}
          <button
            type="button"
            onClick={() => actions.onResubmit(event)}
            disabled={busy}
            className={cn(
              'mt-2.5 inline-flex h-11 items-center rounded-control bg-foreground px-3.5 text-fs-xs font-semibold text-background',
              'transition-opacity hover:opacity-90 disabled:opacity-50',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
            )}
          >
            {pending === 'resubmit' ? 'Resubmitting…' : 'Resubmit for review'}
          </button>
        </div>
      )}

      {/* Metrics — pushed down so every card's action row lines up across a row. */}
      <div className="mt-auto min-w-0 space-y-2.5 px-3 pb-3 sm:px-4 sm:pb-3.5">
        {/* Two figures side by side on a hairline — the numbers are the content, so they
            get the weight; the old tinted box around them was chrome. */}
        <dl className="grid min-w-0 grid-cols-2 border-t border-border/70 pt-2.5 sm:pt-3">
          <Metric icon={Users} label="Registrations" value={regs.text} unavailable={regs.unavailable} className="pr-3" />
          <Metric
            icon={IndianRupee}
            label="Ticket revenue"
            value={revenue.text}
            unavailable={revenue.unavailable}
            className="border-l border-border/70 pl-3"
          />
        </dl>

        {capacity && (
          <div className="flex min-w-0 items-center gap-2.5">
            <div
              role="progressbar"
              aria-valuenow={capacity.pct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`Capacity ${capacity.pct}% — ${capacity.label}`}
              className="h-1 min-w-0 flex-1 overflow-hidden rounded-pill bg-muted"
            >
              <div
                className={cn('h-full rounded-pill transition-[width] duration-500', capacity.bar)}
                style={{ width: `${capacity.pct}%` }}
              />
            </div>
            {/* Colour is never the only channel: the tone is also stated in words. */}
            <p className="shrink-0 text-fs-2xs tabular-nums text-muted-foreground">
              {capacity.pct}% · {capacity.label}
            </p>
          </div>
        )}

        {/*
          RD-ANALYTICS-12-20 · two different absences, two different sentences.

          This block captioned EVERY dash as a failed read, so a manager — who is simply not
          entitled to revenue — was told the platform had a problem and to try again. Retrying
          would never have worked. The dash itself is unchanged and still reveals no amount.
        */}
        {(regs.reason === 'unreadable' || revenue.reason === 'unreadable') && (
          <p className="text-fs-2xs leading-relaxed text-muted-foreground">
            Some figures couldn&apos;t be loaded for this event. They aren&apos;t zero — try again shortly.
          </p>
        )}
        {revenue.reason === 'restricted' && (
          <p className="text-fs-2xs leading-relaxed text-muted-foreground">
            Ticket revenue requires finance access.
          </p>
        )}
      </div>

      {/* Actions */}
      {/* 2026-09-29: 44px targets on touch screens, a compact 36px row from sm up. */}
      <div className="flex items-center gap-1.5 border-t border-border/70 bg-muted/20 px-3 py-2.5">
        {/*
          A TINT, not a fill. A grid of sixteen events drew sixteen saturated brand buttons,
          which made the page loud and left "Create Event" — the one action that should own
          the accent — competing with every card on screen. The tinted pair also measures
          AA: white on `--primary` is 4.27:1, `--primary-text` on the tint is not.
        */}
        <Link
          href={manageHref(event)}
          className={cn(
            'group/manage inline-flex h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-control px-3 sm:h-9',
            'text-fs-sm font-semibold transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
            readOnly
              ? 'border border-border text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              : 'bg-primary/[0.08] text-[color:var(--primary-text)] hover:bg-primary/[0.14]',
          )}
        >
          <span className="truncate">{primaryActionLabel(event)}</span>
          <ArrowRight className="size-3.5 shrink-0 transition-transform duration-200 group-hover/manage:translate-x-0.5" aria-hidden />
        </Link>

        {publicUrl && (
          <a
            href={publicUrl}
            target="_blank"
            rel="noopener noreferrer"
            // §13 · A real accessible name. `title` alone never was one.
            aria-label={`${event.campaignType === 'donation_only' ? 'View campaign page' : 'View public page'} for ${event.name} (opens in a new tab)`}
            className={cn(
              'inline-flex size-11 shrink-0 items-center justify-center rounded-control border border-border bg-card sm:size-9',
              'text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
            )}
          >
            <ExternalLink className="size-3.5" aria-hidden />
          </a>
        )}

        <EventCardMenu items={menuItems} label={`Actions for ${event.name}`} />
      </div>
    </article>
  )
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────
// Mirrors the card's geometry (2:1 banner, same paddings, 44/36px action row) so the
// swap to real content shifts nothing.

export function EventCardSkeleton() {
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-surface border border-border bg-card">
      <div className="aspect-[2/1] animate-pulse bg-muted" />
      <div className="px-4 pb-3 pt-3.5">
        <div className="h-3 w-2/5 animate-pulse rounded bg-muted" />
        <div className="mt-2.5 h-4 w-4/5 animate-pulse rounded bg-muted" />
      </div>
      <div className="mt-auto px-4 pb-3.5">
        <div className="h-[52px] animate-pulse rounded-control bg-muted" />
      </div>
      <div className="border-t border-border/70 px-3 py-2.5">
        <div className="h-11 animate-pulse rounded-control bg-muted sm:h-9" />
      </div>
    </div>
  )
}

/**
 * Shared by the skeleton grid and the real grid so switching between them shifts nothing.
 *
 * 2026-09-29: columns FIT the content area (min 15.5rem a card) instead of following
 * viewport breakpoints. The breakpoints ignored the 248px sidebar, so at 1024px three
 * ~210px cards truncated their labels and wrapped "2,295 / 3,000".
 */
export const EVENTS_GRID_CLASS =
  'grid grid-cols-1 gap-4 sm:grid-cols-[repeat(auto-fill,minmax(15.5rem,1fr))] sm:gap-5'
