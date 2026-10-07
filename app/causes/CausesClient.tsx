'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { Heart, Users, Calendar, Shield } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { isValidImageUrl } from '@/lib/utils/imageUrl'
import { EmptyState } from '@/components/ui'
import { SearchBar } from '@/components/marketing/discovery/SearchBar'
import { FilterChip } from '@/components/marketing/discovery/FilterChip'
import { DiscoveryGrid } from '@/components/marketing/discovery/DiscoveryGrid'
import type { CampaignListItem } from '@/lib/firebase/firestore/campaigns'
import {
  DONATION_SUBTYPE_LABELS,
  type DonationCampaignSubtype,
} from '@/lib/campaigns/campaignDetailsConfig'

// ─── Types ────────────────────────────────────────────────────────────────────

type SortKey = 'newest' | 'most_raised' | 'ending_soon'

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'newest',      label: 'Newest'      },
  { key: 'most_raised', label: 'Most Raised' },
  { key: 'ending_soon', label: 'Ending Soon' },
]

const SUBTYPE_KEYS = Object.keys(DONATION_SUBTYPE_LABELS) as DonationCampaignSubtype[]

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatRupees(paise: number): string {
  const rupees = Math.floor(paise / 100)
  if (rupees >= 10_000_000) return `₹${(rupees / 10_000_000).toFixed(1)}Cr`
  if (rupees >= 100_000)    return `₹${(rupees / 100_000).toFixed(1)}L`
  if (rupees >= 1_000)      return `₹${(rupees / 1_000).toFixed(1)}K`
  return `₹${rupees.toLocaleString('en-IN')}`
}

function daysRemaining(endDate: string): number {
  const end  = new Date(endDate + 'T23:59:59')
  const diff = end.getTime() - Date.now()
  return Math.max(0, Math.ceil(diff / (1_000 * 60 * 60 * 24)))
}

function progressPercent(raisedPaise: number, goalRupees: number | null): number {
  if (!goalRupees || goalRupees <= 0) return 0
  return Math.min(100, Math.round((raisedPaise / (goalRupees * 100)) * 100))
}

// ─── Cause Card ───────────────────────────────────────────────────────────────
//
// 2026-09-23 luxury pass — the same family as the landing event cards: the category (and
// the 80G mark) sits on a line ABOVE the card, never over the campaign's cover artwork;
// the title and the amount raised are set in the display face; progress is a hairline;
// counts are small caps; the one action is a squared --action button. Same data, same
// link, same ended state — only the presentation changed.

function CauseCard({ campaign }: { campaign: CampaignListItem }) {
  const days     = daysRemaining(campaign.endDate)
  const progress = progressPercent(campaign.totalRaisedPaise, campaign.goalRupees)
  const subtype  = DONATION_SUBTYPE_LABELS[campaign.eventSubtype as DonationCampaignSubtype] ?? null
  const isEnding = days <= 3 && days > 0
  const ended    = days === 0
  const showGoal = Boolean(campaign.showGoalAmount && campaign.goalRupees)

  return (
    <div className="flex h-full flex-col">
      {/* ── Above the card: what kind of cause, and its tax status ── */}
      <div className="mb-2.5 flex min-h-7 items-center justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-2">
          <span aria-hidden className="inline-flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-control)] border border-hero-accent-rule/40 bg-card text-hero-accent-rule">
            <Heart className="size-3.5" strokeWidth={1.75} />
          </span>
          <span className="truncate text-fs-2xs font-semibold uppercase tracking-[0.14em] text-hero-ink">
            {subtype ?? 'Cause'}
          </span>
        </span>
        {campaign.is80G && (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] border border-border/70 bg-card px-2 py-1 text-fs-2xs font-semibold uppercase tracking-[0.12em] text-hero-ink">
            <Shield aria-hidden className="size-3 text-success" />
            80G
          </span>
        )}
      </div>

      <article className="group flex flex-1 flex-col overflow-hidden rounded-lg border border-border/70 bg-card transition-colors duration-200 hover:border-border-strong">
        {/* Cover image */}
        <div className="relative aspect-video overflow-hidden border-b border-border/60 bg-surface-3/60">
          {isValidImageUrl(campaign.coverImageUrl) ? (
            <Image
              src={campaign.coverImageUrl}
              alt={campaign.title}
              fill
              className="object-cover transition-transform duration-500 ease-out group-hover:scale-[1.03]"
              sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <Heart className="size-10 text-hero-accent-rule/50" strokeWidth={1.25} aria-hidden />
            </div>
          )}
        </div>

        {/* Content */}
        <div className="flex flex-1 flex-col p-4 sm:p-5">
          {/* Time left — small caps with a hairline, urgent in the destructive colour. */}
          <p className={cn(
            'flex items-center gap-2 text-fs-2xs font-semibold uppercase tracking-[0.16em]',
            ended ? 'text-muted-foreground' : isEnding ? 'text-destructive' : 'text-hero-eyebrow',
          )}>
            <span aria-hidden className={cn('h-px w-4 shrink-0', isEnding ? 'bg-destructive' : 'bg-hero-accent-rule')} />
            <Calendar aria-hidden className="size-3.5" />
            {ended ? 'Campaign ended' : days === 1 ? '1 day left' : `${days} days left`}
          </p>

          <h3 className="mt-2.5 line-clamp-2 font-display text-fs-lg font-normal tracking-[-0.01em] text-hero-ink transition-colors leading-snug group-hover:text-action">
            {campaign.title}
          </h3>
          {campaign.tagline && (
            <p className="mt-1 line-clamp-2 text-fs-sm text-hero-ink-soft">
              {campaign.tagline}
            </p>
          )}

          {/* Raised + goal */}
          <div className="mt-4">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-display text-fs-2xl font-light tabular-nums text-hero-ink leading-none">
                {formatRupees(campaign.totalRaisedPaise)}
              </span>
              {showGoal && (
                <span className="text-fs-xs text-hero-ink-soft">
                  of ₹{campaign.goalRupees!.toLocaleString('en-IN')} goal
                </span>
              )}
            </div>

            {showGoal && (
              <div className="mt-2.5 h-1 w-full overflow-hidden rounded-[var(--radius-control)] bg-muted">
                <div
                  className={cn(
                    'h-full transition-all duration-700',
                    progress >= 100 ? 'bg-success' : 'bg-action',
                  )}
                  style={{ width: `${progress}%` }}
                  role="progressbar"
                  aria-valuenow={progress}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${progress}% funded`}
                />
              </div>
            )}
          </div>

          {/* Donors + organizer */}
          <div className="mt-4 flex items-center gap-2 text-fs-xs text-hero-ink-soft">
            <Users className="size-3.5 shrink-0 text-hero-accent-rule" aria-hidden />
            <span className="font-semibold tabular-nums text-hero-ink">{campaign.donorCount.toLocaleString('en-IN')}</span>
            <span>{campaign.donorCount === 1 ? 'donor' : 'donors'}</span>
          </div>
          <p className="mt-1.5 truncate text-fs-xs text-hero-ink-soft">
            by <span className="font-medium text-hero-ink">{campaign.organizerName}</span>
            {campaign.beneficiaryName && campaign.beneficiaryName !== campaign.organizerName && (
              <>
                {' '}for <span className="font-medium text-hero-ink">{campaign.beneficiaryName}</span>
              </>
            )}
          </p>

          {/* CTA */}
          <div className="mt-auto pt-5">
            <Link
              href={`/campaign/${campaign.slug}`}
              className={cn(
                'flex h-10 w-full items-center justify-center gap-2 rounded-[var(--radius-control)] text-fs-sm font-semibold transition-colors duration-150',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-2',
                ended
                  ? 'cursor-not-allowed border border-border bg-muted text-muted-foreground'
                  : 'bg-action text-action-foreground hover:bg-action-hover',
              )}
              aria-label={`Donate to ${campaign.title}`}
              tabIndex={ended ? -1 : undefined}
            >
              <Heart className="size-4" aria-hidden />
              {ended ? 'Campaign Ended' : 'Donate Now'}
            </Link>
          </div>
        </div>
      </article>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

interface Props {
  campaigns: CampaignListItem[]
}

export function CausesClient({ campaigns }: Props) {
  const [search,         setSearch]         = useState('')
  const [activeSubtype,  setActiveSubtype]  = useState<DonationCampaignSubtype | null>(null)
  const [sort,           setSort]           = useState<SortKey>('newest')

  const filtered = useMemo(() => {
    let list = campaigns

    // Filter by search
    const q = search.trim().toLowerCase()
    if (q) {
      list = list.filter(c =>
        c.title.toLowerCase().includes(q) ||
        c.tagline.toLowerCase().includes(q) ||
        c.beneficiaryName.toLowerCase().includes(q) ||
        c.organizerName.toLowerCase().includes(q),
      )
    }

    // Filter by subtype
    if (activeSubtype) {
      list = list.filter(c => c.eventSubtype === activeSubtype)
    }

    // Sort
    switch (sort) {
      case 'newest':
        list = [...list].sort((a, b) =>
          (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''),
        )
        break
      case 'most_raised':
        list = [...list].sort((a, b) => b.totalRaisedPaise - a.totalRaisedPaise)
        break
      case 'ending_soon':
        list = [...list].sort((a, b) =>
          daysRemaining(a.endDate) - daysRemaining(b.endDate),
        )
        break
    }

    return list
  }, [campaigns, search, activeSubtype, sort])

  return (
    <div>
      {/* ── Controls ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        {/* Search */}
        <SearchBar value={search} onChange={setSearch} placeholder="Search causes…" className="w-full sm:max-w-sm" />

        {/* Sort */}
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-fs-2xs font-semibold uppercase tracking-[0.16em] text-hero-eyebrow">Sort</span>
          <div className="flex rounded-[var(--radius-surface)] border border-border/70 bg-card p-0.5">
            {SORT_OPTIONS.map(opt => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setSort(opt.key)}
                className={cn(
                  'rounded-[var(--radius-control)] px-3 py-1.5 text-fs-xs font-medium transition-colors',
                  sort === opt.key
                    ? 'bg-surface-3 text-hero-ink'
                    : 'text-hero-ink-soft hover:text-hero-ink',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Category filter chips ─────────────────────────────────────────────── */}
      <div className="mt-4 flex flex-wrap gap-2">
        <FilterChip active={activeSubtype === null} onClick={() => setActiveSubtype(null)}>
          All Causes
        </FilterChip>
        {SUBTYPE_KEYS.map(key => {
          const count = campaigns.filter(c => c.eventSubtype === key).length
          if (count === 0) return null
          return (
            <FilterChip
              key={key}
              active={activeSubtype === key}
              onClick={() => setActiveSubtype(activeSubtype === key ? null : key)}
            >
              {DONATION_SUBTYPE_LABELS[key]}
              <span className="ml-1.5 text-fs-2xs opacity-60">{count}</span>
            </FilterChip>
          )
        })}
      </div>

      {/* ── Result count ─────────────────────────────────────────────────────── */}
      <p className="mt-6 text-fs-2xs font-semibold uppercase tracking-[0.16em] text-hero-eyebrow">
        {filtered.length === 0
          ? 'No causes match your filters.'
          : filtered.length === campaigns.length
            ? `${campaigns.length} active cause${campaigns.length === 1 ? '' : 's'}`
            : `${filtered.length} of ${campaigns.length} causes`}
      </p>

      {/* ── Grid ─────────────────────────────────────────────────────────────── */}
      {filtered.length > 0 ? (
        <DiscoveryGrid className="mt-4">
          {filtered.map(campaign => (
            <CauseCard key={campaign.slug} campaign={campaign} />
          ))}
        </DiscoveryGrid>
      ) : (
        <EmptyState
          className="mt-12"
          icon={Heart}
          title="No causes found"
          description={
            search || activeSubtype
              ? 'Try adjusting your search or removing the category filter.'
              : 'No active fundraising campaigns at the moment.'
          }
          size="lg"
          action={
            search || activeSubtype
              ? { label: 'Clear filters', onClick: () => { setSearch(''); setActiveSubtype(null) } }
              : undefined
          }
        />
      )}
    </div>
  )
}
