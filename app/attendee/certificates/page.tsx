'use client'

import { Award, Download, ShieldCheck, Calendar } from 'lucide-react'
import {
  AttendeePageHeader, ListSkeleton, ErrorState, EmptyState, fmtDate, useAttendeeList,
} from '@/components/attendee/ui'
import type { AttendeeCertificate } from '@/lib/attendee/data'

export default function AttendeeCertificatesPage() {
  const { items, loading, error, reload } = useAttendeeList<AttendeeCertificate>('/api/attendee/certificates')

  return (
    <div>
      <AttendeePageHeader title="Certificates" subtitle="Download and verify the certificates you've earned." />

      {loading ? <ListSkeleton />
        : error ? <ErrorState message={error} onRetry={reload} />
        : !items || items.length === 0 ? <EmptyState title="No certificates yet" hint="Certificates issued for your events will appear here." />
        : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {items.map(c => (
              <div key={c.certificateId} className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4">
                <div className="flex items-start gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/[0.08] text-primary"><Award className="size-4.5 size-[18px]" aria-hidden /></div>
                  <div className="min-w-0">
                    <p className="truncate text-[14px] font-semibold text-foreground">{c.eventName || 'Certificate'}</p>
                    <p className="mt-0.5 flex items-center gap-1 text-[12.5px] text-muted-foreground">
                      <Calendar className="size-3.5" aria-hidden /> Issued {fmtDate(c.issuedAt)}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <a href={c.verificationUrl} target="_blank" rel="noopener noreferrer"
                    className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-[13px] font-medium text-foreground hover:bg-muted">
                    <ShieldCheck className="size-4" aria-hidden /> Verify
                  </a>
                  <a href={c.downloadUrl} target="_blank" rel="noopener noreferrer"
                    className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-semibold text-primary-foreground shadow-sm transition-opacity hover:opacity-90"
                    style={{ backgroundImage: 'var(--primary-gradient)' }}>
                    <Download className="size-4" aria-hidden /> Download
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
    </div>
  )
}
