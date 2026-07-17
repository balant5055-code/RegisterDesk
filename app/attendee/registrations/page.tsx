'use client'

import Link from 'next/link'
import { Ticket } from 'lucide-react'
import {
  AttendeePageHeader, ListSkeleton, ErrorState, EmptyState, StatusBadge, fmtDate, useAttendeeList,
} from '@/components/attendee/ui'
import type { AttendeeRegistration } from '@/lib/attendee/data'

export default function AttendeeRegistrationsPage() {
  const { items, loading, error, reload } = useAttendeeList<AttendeeRegistration>('/api/attendee/registrations')

  return (
    <div>
      <AttendeePageHeader title="Registrations" subtitle="Every event you've registered for." />

      {loading ? <ListSkeleton />
        : error ? <ErrorState message={error} onRetry={reload} />
        : !items || items.length === 0 ? <EmptyState title="No registrations yet" hint="When you register for an event, it will show up here." />
        : (
          <div className="overflow-x-auto rounded-2xl border border-border">
            <table className="w-full min-w-[640px] text-[13.5px]">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left text-[12px] font-semibold text-muted-foreground">
                  <th className="px-4 py-2.5">Event</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5">Date</th>
                  <th className="px-4 py-2.5">Ticket Code</th>
                  <th className="px-4 py-2.5 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {items.map(r => (
                  <tr key={r.registrationId} className="hover:bg-muted/20">
                    <td className="px-4 py-3 font-medium text-foreground">{r.eventName || '—'}</td>
                    <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
                    <td className="px-4 py-3 text-muted-foreground">{fmtDate(r.registeredAt)}</td>
                    <td className="px-4 py-3 font-mono text-[12px] text-muted-foreground">{r.ticketCode || '—'}</td>
                    <td className="px-4 py-3 text-right">
                      {r.status === 'confirmed' && r.ticketCode ? (
                        <Link href="/attendee/tickets" className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[12px] font-medium text-foreground hover:bg-muted">
                          <Ticket className="size-3.5" aria-hidden /> View Ticket
                        </Link>
                      ) : <span className="text-[12px] text-muted-foreground/50">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  )
}
