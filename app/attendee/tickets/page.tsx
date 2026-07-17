'use client'

import { Ticket, Download, Calendar } from 'lucide-react'
import {
  AttendeePageHeader, ListSkeleton, ErrorState, EmptyState, fmtDate, useAttendeeList,
} from '@/components/attendee/ui'
import type { AttendeeTicket } from '@/lib/attendee/data'

export default function AttendeeTicketsPage() {
  const { items, loading, error, reload } = useAttendeeList<AttendeeTicket>('/api/attendee/tickets')

  return (
    <div>
      <AttendeePageHeader title="Tickets" subtitle="Download tickets for your confirmed registrations." />

      {loading ? <ListSkeleton />
        : error ? <ErrorState message={error} onRetry={reload} />
        : !items || items.length === 0 ? <EmptyState title="No tickets yet" hint="Tickets appear here once a registration is confirmed." />
        : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {items.map(t => (
              <div key={t.registrationId} className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4">
                <div className="flex items-start gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/[0.08] text-primary"><Ticket className="size-4.5 size-[18px]" aria-hidden /></div>
                  <div className="min-w-0">
                    <p className="truncate text-[14px] font-semibold text-foreground">{t.eventName || 'Event'}</p>
                    {t.eventDate && (
                      <p className="mt-0.5 flex items-center gap-1 text-[12.5px] text-muted-foreground">
                        <Calendar className="size-3.5" aria-hidden /> {fmtDate(t.eventDate)}
                      </p>
                    )}
                  </div>
                </div>
                <div className="rounded-lg bg-muted/40 px-3 py-2 text-center">
                  <p className="text-[10.5px] font-semibold uppercase tracking-widest text-muted-foreground">Ticket Code</p>
                  <p className="mt-0.5 font-mono text-[16px] font-bold tracking-[0.12em] text-foreground">{t.ticketCode}</p>
                </div>
                <a href={t.downloadUrl} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-[13.5px] font-semibold text-primary-foreground shadow-sm transition-opacity hover:opacity-90"
                  style={{ backgroundImage: 'var(--primary-gradient)' }}>
                  <Download className="size-4" aria-hidden /> Download Ticket
                </a>
              </div>
            ))}
          </div>
        )}
    </div>
  )
}
