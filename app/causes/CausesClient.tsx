'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { Heart, Users, Calendar, Shield } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { isValidImageUrl } from '@/lib/utils/imageUrl'
import { typography } from '@/lib/ds/typography'
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

function CauseCard({ campaign }: { campaign: CampaignListItem }) {
  const days     = daysRemaining(campaign.endDate)
  const progress = progressPercent(campaign.totalRaisedPaise, campaign.goalRupees)
  const subtype  = DONATION_SUBTYPE_LABELS[campaign.eventSubtype as DonationCampaignSubtype] ?? null
  const isEnding = days <= 3 && days > 0
  const ended    = days === 0

  return (
    <article className="group flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-card shadow-sm transition-all duration-200 hover:shadow-md hover:border-primary/40 hover:-translate-y-0.5">
      {/* Cover image */}
      <div className="relative aspect-[16/9] overflow-hidden bg-gradient-to-br from-primary/5 via-primary/10 to-primary/5">
        {isValidImageUrl(campaign.coverImageUrl) ? (
          <Image
            src={campaign.coverImageUrl}
            alt={campaign.title}
            fill
            className="object-cover transition-transform duration-500 group-hover:scale-105"
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Heart className="size-10 text-primary/30" aria-hidden />
          </div>
        )}

        {/* Badges */}
        <div className="absolute left-3 top-3 flex flex-wrap gap-1.5">
          {subtype && (
            <span className="rounded-full bg-white/90 px-2.5 py-0.5 text-[var(--fs-2xs)] font-semibold text-primary shadow-sm backdrop-blur-sm">
              {subtype}
            </span>
          )}
          {campaign.is80G && (
            <span className="flex items-center gap-1 rounded-full bg-emerald-600/90 px-2.5 py-0.5 text-[var(--fs-2xs)] font-semibold text-white shadow-sm backdrop-blur-sm">
              <Shield className="size-3" aria-hidden />
              80G
            </span>
          )}
        </div>

        {/* Urgency badge */}
        {(isEnding || ended) && (
          <div className={cn(
            'absolute right-3 top-3 rounded-full px-2.5 py-0.5 text-[var(--fs-2xs)] font-bold shadow-sm',
            ended
              ? 'bg-slate-700/90 text-white'
              : 'bg-red-600/90 text-white',
          )}>
            {ended ? 'Ended' : `${days}d left`}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex flex-1 flex-col gap-3 p-4">
        {/* Title */}
        <div>
          <h3 className={cn(typography.cardTitle, 'line-clamp-2 leading-snug text-foreground transition-colors group-hover:text-primary')}>
            {campaign.title}
          </h3>
          {campaign.tagline && (
            <p className="mt-0.5 line-clamp-1 text-[var(--fs-sm)] text-muted-foreground">
              {campaign.tagline}
            </p>
          )}
        </div>

        {/* Raised + goal */}
        <div>
          <div className="flex items-baseline justify-between">
            <span className="text-[17px] font-bold text-foreground">
              {formatRupees(campaign.totalRaisedPaise)}
            </span>
            {campaign.showGoalAmount && campaign.goalRupees && (
              <span className="text-[var(--fs-xs)] text-muted-foreground">
                of ₹{campaign.goalRupees.toLocaleString('en-IN')} goal
              </span>
            )}
          </div>

          {/* Progress bar */}
          {campaign.showGoalAmount && campaign.goalRupees && (
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  'h-full rounded-full transition-all duration-700',
                  progress >= 100
                    ? 'bg-emerald-500'
                    : progress >= 75
                      ? 'bg-primary/80'
                      : 'bg-primary',
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

        {/* Stats row */}
        <div className="flex items-center gap-3 text-[var(--fs-xs)] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Users className="size-3.5" aria-hidden />
            {campaign.donorCount.toLocaleString('en-IN')} donors
          </span>
          <span className="size-1 rounded-full bg-border" aria-hidden />
          <span className="flex items-center gap-1">
            <Calendar className="size-3.5" aria-hidden />
            {ended ? 'Campaign ended' : days === 1 ? '1 day left' : `${days} days left`}
          </span>
        </div>

        {/* Organizer */}
        <p className="text-[var(--fs-xs)] text-muted-foreground truncate">
          by <span className="font-medium text-foreground/80">{campaign.organizerName}</span>
          {campaign.beneficiaryName && campaign.beneficiaryName !== campaign.organizerName && (
            <>
              {' '}for <span className="font-medium text-foreground/80">{campaign.beneficiaryName}</span>
            </>
          )}
        </p>
      </div>

      {/* CTA */}
      <div className="px-4 pb-4">
        <Link
          href={`/campaign/${campaign.slug}`}
          className={cn(
            'flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-[var(--fs-base)] font-semibold transition-all duration-150',
            ended
              ? 'border border-border bg-muted text-muted-foreground cursor-not-allowed'
              : 'bg-primary text-primary-foreground hover:bg-primary/90 active:scale-[0.98]',
          )}
          aria-label={`Donate to ${campaign.title}`}
          tabIndex={ended ? -1 : undefined}
        >
          <Heart className="size-4" aria-hidden />
          {ended ? 'Campaign Ended' : 'Donate Now'}
        </Link>
      </div>
    </article>
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
          <span className="text-xs text-muted-foreground font-medium">Sort:</span>
          <div className="flex rounded-xl border border-border bg-muted/40 p-0.5">
            {SORT_OPTIONS.map(opt => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setSort(opt.key)}
                className={cn(
                  'rounded-lg px-3 py-1.5 text-[var(--fs-xs)] font-medium transition-all',
                  sort === opt.key
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
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
              <span className="ml-1.5 text-[var(--fs-2xs)] opacity-60">{count}</span>
            </FilterChip>
          )
        })}
      </div>

      {/* ── Result count ─────────────────────────────────────────────────────── */}
      <p className="mt-5 text-[var(--fs-sm)] text-muted-foreground">
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
