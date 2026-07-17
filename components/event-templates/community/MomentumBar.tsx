'use client'

import { Users, Share2 } from 'lucide-react'
import type { PassAvailability } from '@/lib/registrations/types'
import type { OrganizerInfo } from '@/components/wizard/eventDetailsConfig'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SUBTYPE_TAGS: Record<string, string[]> = {
  'rotary':            ['Service', 'Leadership', 'Community'],
  'startup-meetup':    ['Founders', 'Builders', 'Investors'],
  'startup_meetup':    ['Founders', 'Builders', 'Investors'],
  'business-meetup':   ['Entrepreneurs', 'Executives', 'Professionals'],
  'business_meetup':   ['Entrepreneurs', 'Executives', 'Professionals'],
  'networking':        ['Professionals', 'Leaders', 'Career Builders'],
  'foundation':        ['Social Leaders', 'NGO Partners', 'Changemakers'],
  'community-program': ['Volunteers', 'Community Members'],
  'community_program': ['Volunteers', 'Community Members'],
}

function getTotalAttendees(availability: Record<string, PassAvailability>): number {
  const entries = Object.values(availability)
  return entries.length > 0 ? (entries[0]!.eventTotalCount ?? 0) : 0
}

function getLowestRemaining(availability: Record<string, PassAvailability>): number | null {
  return Object.values(availability)
    .filter(a => a.remaining != null)
    .reduce<number | null>(
      (min, a) => (min === null || a.remaining! < min ? a.remaining! : min),
      null,
    )
}

// ─── Component ────────────────────────────────────────────────────────────────

export function MomentumBar({
  availability, showAttendeeCount,
  organizer, eventSubtype,
  title,
}: {
  availability:      Record<string, PassAvailability>
  showAttendeeCount: boolean
  organizer?:        OrganizerInfo
  eventSubtype?:     string
  title:             string
}) {
  const totalCount = getTotalAttendees(availability)
  const showCount  = showAttendeeCount && totalCount > 0
  const hostName   = organizer?.name?.trim() ?? ''
  const hostLogo   = organizer?.logoUrl?.trim() ?? ''
  const tags       = eventSubtype ? (SUBTYPE_TAGS[eventSubtype.toLowerCase()] ?? []) : []
  const isLow      = Object.values(availability).some(a => a.status === 'low')
  const lowestLeft = isLow ? getLowestRemaining(availability) : null

  const handleShare = () => {
    if (typeof window === 'undefined') return
    const url = window.location.href
    if (navigator.share) {
      navigator.share({ title, url }).catch(() => null)
    } else {
      navigator.clipboard.writeText(url).catch(() => null)
    }
  }

  return (
    <div className="mb-8 overflow-hidden rounded-xl border border-border/60 bg-card shadow-sm">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3">

        {/* Attending count */}
        {showCount && (
          <div className="flex items-center gap-1.5">
            <Users className="size-3.5 shrink-0 text-primary" aria-hidden />
            <span className="text-xs">
              <span className="font-semibold text-foreground">
                {totalCount.toLocaleString('en-IN')}
              </span>{' '}
              <span className="text-muted-foreground">attending</span>
            </span>
            {isLow && lowestLeft != null && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                {lowestLeft} left
              </span>
            )}
          </div>
        )}

        {/* Hosted by */}
        {hostName && (
          <div className="flex items-center gap-1.5">
            {hostLogo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={hostLogo} alt={hostName} className="size-4 rounded object-contain" />
            ) : (
              <div
                className="flex size-4 shrink-0 items-center justify-center rounded text-[8px] font-bold text-white"
                style={{ backgroundImage: 'var(--primary-gradient)' }}
                aria-hidden
              >
                {hostName.charAt(0).toUpperCase()}
              </div>
            )}
            <span className="text-xs text-muted-foreground">
              Hosted by{' '}
              <span className="font-medium text-foreground">{hostName}</span>
            </span>
          </div>
        )}

        {/* Community tags — hidden on mobile to keep it compact */}
        {tags.length > 0 && (
          <div className="hidden items-center gap-1 sm:flex" aria-hidden>
            {tags.map((tag, i) => (
              <span key={tag} className="flex items-center gap-1 text-[11px] text-muted-foreground">
                {i > 0 && <span className="text-border/60">·</span>}
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* Share — pushed to end */}
        <div className="ml-auto">
          <button
            onClick={handleShare}
            className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <Share2 className="size-3.5" aria-hidden />
            Share
          </button>
        </div>

      </div>
    </div>
  )
}
