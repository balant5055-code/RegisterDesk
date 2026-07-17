// Shared settlement status pill (Phase H.5.1) — metadata-driven via statusMeta.
// Replaces the inline SettleStatusBadge duplicated on the finance page.

import { cn } from '@/lib/utils/cn'
import { settlementStatusMeta } from '@/lib/settlements/statusMeta'

export function SettlementStatusBadge({ status }: { status: string }) {
  const meta = settlementStatusMeta(status)
  return (
    <span
      title={meta.description}
      className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[12px] font-semibold', meta.badgeClass)}
    >
      {meta.label}
    </span>
  )
}
