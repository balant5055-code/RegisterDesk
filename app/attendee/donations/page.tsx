'use client'

import {
  AttendeePageHeader, ListSkeleton, ErrorState, EmptyState, StatusBadge, fmtDate, fmtINR, useAttendeeList,
} from '@/components/attendee/ui'
import type { AttendeeDonation } from '@/lib/attendee/data'

export default function AttendeeDonationsPage() {
  const { items, loading, error, reload } = useAttendeeList<AttendeeDonation>('/api/attendee/donations')

  return (
    <div>
      <AttendeePageHeader title="Donations" subtitle="Your giving history and receipts." />

      {loading ? <ListSkeleton />
        : error ? <ErrorState message={error} onRetry={reload} />
        : !items || items.length === 0 ? <EmptyState title="No donations yet" hint="Donations you make to campaigns will appear here." />
        : (
          <div className="overflow-x-auto rounded-2xl border border-border">
            <table className="w-full min-w-[640px] text-[13.5px]">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left text-[12px] font-semibold text-muted-foreground">
                  <th className="px-4 py-2.5">Campaign</th>
                  <th className="px-4 py-2.5 text-right">Amount</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5">Date</th>
                  <th className="px-4 py-2.5">Receipt No.</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {items.map(d => (
                  <tr key={d.donationId} className="hover:bg-muted/20">
                    <td className="px-4 py-3 font-medium text-foreground">{d.campaignName || '—'}</td>
                    <td className="px-4 py-3 text-right font-semibold text-foreground">{fmtINR(d.amount)}</td>
                    <td className="px-4 py-3"><StatusBadge status={d.status} /></td>
                    <td className="px-4 py-3 text-muted-foreground">{fmtDate(d.donatedAt)}</td>
                    <td className="px-4 py-3 font-mono text-[12px] text-muted-foreground">{d.receiptNumber || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  )
}
