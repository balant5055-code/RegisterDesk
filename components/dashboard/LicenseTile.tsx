'use client'

// RD-DASHBOARD-08 · Registration entitlement — the first tile on the Dashboard.
//
// ═══ WHY THIS IS THE FIRST TILE ══════════════════════════════════════════════
// Every other KPI answers "how is it going?". This one answers "can I keep selling?" —
// the only question on the row whose answer can stop the business today. An organizer at
// 98% of their plan needs to know before registrations start failing, not after.
//
// ═══ WHAT IT IS NOT ══════════════════════════════════════════════════════════
// NOT event capacity. `eventDetails.capacity.totalCapacity` is how many seats the
// organizer chose to sell; this is how many the PURCHASED PLAN permits. An event can be
// sold out with entitlement to spare, or blocked by the plan with seats unsold. Merging
// them would tell the organizer to do the wrong thing, so the copy here never says
// "seats" and never borrows a capacity denominator.
//
// Every number arrives resolved from the license catalog (see DashboardLicense). Nothing
// is computed, defaulted or assumed here — including the upgrade CTA, which renders only
// when the payload names a real next tier.
//
// Visually it shares the primary KPI system exactly: surface card, tinted icon, semantic
// top rule, same padding and type scale. See components/dashboard/KpiTile.tsx.

import Link from 'next/link'
import { ArrowUpRight, BadgeCheck, CreditCard, Infinity as InfinityIcon } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { accent, kpiFill, ON_FILL, type AccentTone } from '@/lib/dashboard/accents'
import { CardMotif } from './CardMotif'
import type { DashboardLicense } from '@/app/api/organizer/dashboard/route'

/** Where the organizer goes to buy more. The canonical billing surface — no new page. */
const BILLING_HREF = '/dashboard/settings/billing'

const nf = (n: number) => n.toLocaleString('en-IN')

/**
 * Usage → tone. Thresholds are deliberate and few:
 *   ≥100 % critical — registrations are being refused right now.
 *   ≥85 %  pending  — close enough that an upgrade is a real decision this week.
 *   below  event    — healthy; the plan is doing its job.
 *
 * The healthy tone is VIOLET (the licence accent), not green. Ticket Revenue is already
 * green, and two adjacent cards wearing the same colour is exactly why the row read as
 * four identical white boxes. Violet gives entitlement its own identity while the
 * escalation path — violet → gold → red — still carries the state.
 */
function usageTone(pct: number | null): AccentTone {
  if (pct === null) return 'event'
  if (pct >= 100) return 'critical'
  if (pct >= 85) return 'pending'
  return 'event'
}

/** Status → its dot tone and whether the plan is currently able to take registrations. */
function statusPresentation(status: string): { label: string; tone: AccentTone; blocking: boolean } {
  switch (status) {
    case 'active':    return { label: 'Active',    tone: 'verify',   blocking: false }
    case 'pending':   return { label: 'Pending',   tone: 'pending',  blocking: true  }
    case 'expired':   return { label: 'Expired',   tone: 'critical', blocking: true  }
    case 'suspended': return { label: 'Suspended', tone: 'critical', blocking: true  }
    case 'cancelled': return { label: 'Cancelled', tone: 'critical', blocking: true  }
    // An unrecognised status is REPORTED, not normalised to "Active" — a licence in a
    // state we do not understand must not be presented as healthy.
    default:          return { label: status || 'Unknown', tone: 'neutral', blocking: false }
  }
}

export function LicenseTile({ license, className }: { license: DashboardLicense; className?: string }) {
  const unlimited = !license.unavailable && license.limit === null
  const pct  = license.percentUsed
  const st   = statusPresentation(license.status)
  // A blocking status outranks usage: a suspended plan at 10% is still not selling.
  const tone = st.blocking ? 'critical' : usageTone(pct)

  /**
   * RD-LEGACY-01 — there are no plans or tiers to upgrade to. The card says where capacity comes
   * from (the event's License & Services page) instead of offering an upgrade.
   */

  // ── Unavailable ────────────────────────────────────────────────────────────
  // An unreadable licence is UNKNOWN, never "0 of 0". A zeroed meter would read as a plan
  // with nothing left and push the organizer at an upgrade they may not need.
  if (license.unavailable) {
    return (
      <section
        aria-label="Registration capacity"
        className={cn('flex h-full flex-col rounded-surface border border-border bg-card p-3.5', className)}
      >
        <TileHead tone="neutral" label="Registration capacity" />
        <p className="mt-2.5 text-fs-xl font-semibold tabular-nums text-muted-foreground/50">—</p>
        <p className="mt-1 text-fs-2xs leading-snug text-muted-foreground">
          {license.scope === 'event'
            ? 'This event has no license yet, so there is no entitlement to report.'
            : 'Plan details could not be loaded, so no entitlement is shown.'}
        </p>
        <Link
          href={BILLING_HREF}
          className="mt-auto inline-flex items-center gap-1 pt-2.5 text-fs-2xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          View licences <ArrowUpRight className="size-3" aria-hidden />
        </Link>
      </section>
    )
  }

  return (
    <section
      aria-label="Registration capacity"
      // The coral→rose fill. `kpiFill` also redefines --foreground / --muted-foreground /
      // --border / --muted for this subtree, which is why every plain semantic class
      // below keeps working unchanged on a saturated ground.
      style={kpiFill('capacity')}
      className={cn(
        'relative flex h-full flex-col overflow-hidden rounded-surface p-3.5',
        'shadow-[0_6px_20px_-8px_rgb(0_0_0_/_0.28)]',
        className,
      )}
    >
      <CardMotif kind="capacity" onFill />
      <TileHead tone={tone} label="Registration capacity" plan={license.tierName} onFill />

      {unlimited ? (
        // No denominator exists, so none is invented — the point of the whole tile.
        <>
          <p className="relative mt-3 flex items-baseline gap-1.5">
            <span className="text-fs-2xl font-bold leading-none tracking-tight tabular-nums text-foreground">{nf(license.used)}</span>
            <span className="text-fs-2xs text-muted-foreground">used</span>
          </p>
          <p className="relative mt-1 inline-flex w-fit items-center gap-1 text-fs-2xs font-medium text-foreground">
            <InfinityIcon className="size-3.5" aria-hidden /> Unlimited registrations
          </p>
        </>
      ) : (
        <>
          <p className="relative mt-3 flex items-baseline gap-1 tabular-nums">
            <span className="text-fs-2xl font-bold leading-none tracking-tight text-foreground">{nf(license.used)}</span>
            <span className="text-fs-xs font-semibold text-muted-foreground">/ {nf(license.limit ?? 0)}</span>
          </p>

          {/* The meter. `pct` is already clamped to 100 server-side, so an over-limit plan
              shows a full bar rather than one that overflows its track. */}
          <div
            className="relative mt-2.5 h-1 w-full overflow-hidden rounded-pill bg-muted"
            role="progressbar"
            aria-valuenow={pct ?? 0}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Registration entitlement used: ${pct ?? 0} percent of ${nf(license.limit ?? 0)}`}
          >
            <div className="h-full rounded-pill bg-[color:var(--kpi-on-fill)] transition-[width] duration-500 ease-out"
                 style={{ width: `${Math.max(2, pct ?? 0)}%` }} />
          </div>

          <p className="relative mt-1.5 flex flex-1 flex-wrap items-baseline gap-x-2 text-fs-2xs">
            <span className="font-semibold tabular-nums text-foreground">{pct ?? 0}% used</span>
            <span className="font-medium tabular-nums text-muted-foreground">{nf(license.remaining ?? 0)} remaining</span>
          </p>
        </>
      )}

      {/* ── Footer ── status, context, and the one action that changes any of it ── */}
      <div className="relative mt-auto space-y-2 border-t border-border pt-2.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {/* Status is text + dot, never colour alone — the dot is decorative and the
              word carries the meaning for screen readers and colour-blind readers. */}
          <span className="inline-flex items-center gap-1.5 text-fs-2xs font-medium text-foreground">
            <span className="size-1.5 rounded-pill bg-[color:var(--kpi-on-fill)]" aria-hidden />
            {st.label}
          </span>
          <span className="min-w-0 truncate text-fs-2xs text-muted-foreground">
            {license.scope === 'workspace' && license.eventCount > 0
              ? `Across ${nf(license.eventCount)} licensed event${license.eventCount === 1 ? '' : 's'}`
              : license.expiresAt
                ? `Renews ${new Date(license.expiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`
                : ''}
          </span>
        </div>

        {/* RD-CLOSE — licence tiers are retired (RD-EVENT-COMMERCE-05): there is never a "next plan"
            to sell (the dashboard route always reports upgrade: null), so the dead "Upgrade to …"
            button was removed. The card says where capacity comes from instead. */}
        <p className="text-fs-2xs text-muted-foreground">
          {license.tier === 'capacity'
            // RD-EVENT-COMMERCE-04 — capacity licences have no tiers; capacity is bought per event.
            ? 'Add capacity from the event’s License & Services page.'
            // RD-EVENT-COMMERCE-05 — a historical tier licence: tiers are no longer sold.
            : 'Legacy licence — tiers are no longer sold.'}
        </p>
      </div>
    </section>
  )
}

/** Shared head: glyph, section label, and the plan name as a badge when there is one. */
function TileHead({ tone, label, plan, onFill }: {
  tone: AccentTone; label: string; plan?: string
  /** On the gradient card the glyph takes a translucent-white chip, not a tinted one. */
  onFill?: boolean
}) {
  const a = accent(tone)
  return (
    <div className={cn('relative flex items-center justify-between gap-2', onFill && 'h-8')}>
      <span className="flex min-w-0 items-center gap-2">
        <span
          className={cn(
            'flex shrink-0 items-center justify-center',
            onFill ? 'size-8 rounded-surface' : 'size-7 rounded-control',
            onFill ? ON_FILL.tile : a.chip,
          )}
          aria-hidden
        >
          <CreditCard className={onFill ? 'size-4' : 'size-3.5'} />
        </span>
        {/* Sentence case, NOT uppercase + tracking-wide. The same words set that way are
            ~40% wider and truncated to "REGISTRATION CAPACI…" beside the plan badge in a
            four-column row. A label that cannot be read is not a label. */}
        <span className={cn(
          'min-w-0 truncate text-muted-foreground',
          onFill ? 'text-fs-xs font-medium' : 'text-fs-2xs font-semibold',
        )}>
          {label}
        </span>
      </span>
      {plan && (
        <span className={cn(
          'inline-flex shrink-0 items-center gap-1 rounded-control px-2 py-1 text-fs-2xs font-medium text-foreground',
          // RD-DASH-16 · `bg-white/20` washed the gradient TOWARDS the white type it sits
          // under — 4.32:1 light, 3.83:1 dark, measured from rendered pixels. The chip now
          // deepens its own ground instead. The inset ring stays: it is what keeps the chip
          // reading as a raised badge rather than a hole punched in the card.
          onFill
            ? 'bg-[color:var(--kpi-on-fill-chip)] ring-1 ring-inset ring-white/25'
            : 'border border-border bg-muted/50',
        )}>
          <BadgeCheck className="size-3" aria-hidden />
          {plan}
        </span>
      )}
    </div>
  )
}
