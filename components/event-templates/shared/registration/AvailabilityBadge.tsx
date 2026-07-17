import type { PassAvailability } from '@/lib/registrations/types'

export function AvailabilityBadge({ avail }: { avail?: PassAvailability }) {
  if (!avail) return null
  if (avail.status === 'sold_out')
    return (
      <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold text-rose-600">
        Sold Out
      </span>
    )
  if (avail.status === 'low')
    return (
      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
        Only {avail.remaining} left
      </span>
    )
  return null
}
