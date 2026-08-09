'use client'

// Client action centre for the ticket page (H-6). The page itself is a server
// component; the interactive actions (Add to Calendar, Share) live here. Reuses the
// shared AddToCalendarButton and the signed PDF/receipt URLs — no ticket/QR/business
// logic. Unavailable actions are hidden.

import { useState } from 'react'
import { Download, MapPin, Mail, Phone, Share2 } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { AddToCalendarButton } from '@/components/event-templates/shared/ui/AddToCalendarButton'

export interface TicketCalendar {
  startDate: string
  endDate:   string
  startTime: string
  endTime:   string
  location:  string
}

// Keyboard users need a visible target; the hover-only styles left none.
const FOCUS = ' focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
const primaryAction   = 'flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-[14px] font-semibold text-primary-foreground shadow-sm transition-opacity hover:opacity-90'+FOCUS
const secondaryAction = 'flex items-center justify-center gap-2 rounded-xl border border-border bg-white px-3 py-2.5 text-[13px] font-semibold text-foreground transition-colors hover:bg-muted/50'+FOCUS

export function TicketActions({
  eventName, eventSlug, pdfUrl, receiptUrl, directionsUrl,
  contactHref, contactIsEmail, shareUrl, calendar, cancelled,
}: {
  eventName:      string
  eventSlug:      string
  pdfUrl:         string
  receiptUrl:     string | null
  directionsUrl:  string | null
  contactHref:    string | null
  contactIsEmail: boolean
  shareUrl:       string
  calendar:       TicketCalendar | null
  cancelled:      boolean
}) {
  const [shared, setShared] = useState(false)

  async function share() {
    const nav = typeof navigator !== 'undefined' ? navigator : undefined
    if (nav?.share) {
      await nav.share({ title: eventName, text: `My ticket for ${eventName}`, url: shareUrl }).catch(() => null)
    } else if (nav?.clipboard) {
      await nav.clipboard.writeText(shareUrl).catch(() => null)
      setShared(true)
      setTimeout(() => setShared(false), 2000)
    }
  }

  return (
    <section aria-labelledby="ticket-actions-h" className="print:hidden">
      <h2 id="ticket-actions-h" className="sr-only">Ticket actions</h2>
      <div className="flex flex-col gap-2.5">
        {/* Primary */}
        {!cancelled && (
          <a href={pdfUrl} target="_blank" rel="noopener noreferrer" className={primaryAction}>
            <Download className="size-4" aria-hidden />
            Download Ticket
          </a>
        )}
        {!cancelled && calendar && (
          <div className="flex items-center justify-center rounded-xl border border-border bg-white px-4 py-2.5">
            <AddToCalendarButton
              title={eventName}
              startDate={calendar.startDate}
              endDate={calendar.endDate}
              startTime={calendar.startTime}
              endTime={calendar.endTime}
              location={calendar.location}
              description={`Your ticket for ${eventName}. View it at ${shareUrl}`}
              slug={eventSlug}
            />
          </div>
        )}

        {/* Secondary */}
        <div className="grid grid-cols-2 gap-2.5">
          {directionsUrl && !cancelled && (
            <a href={directionsUrl} target="_blank" rel="noopener noreferrer" className={secondaryAction}>
              <MapPin className="size-4 text-muted-foreground" aria-hidden />
              Get Directions
            </a>
          )}
          {contactHref && (
            <a href={contactHref} className={secondaryAction}>
              {contactIsEmail
                ? <Mail className="size-4 text-muted-foreground" aria-hidden />
                : <Phone className="size-4 text-muted-foreground" aria-hidden />}
              Contact Organizer
            </a>
          )}
          <button type="button" onClick={() => void share()} className={cn(secondaryAction, 'w-full')}>
            <Share2 className="size-4 text-muted-foreground" aria-hidden />
            {shared ? 'Link copied!' : 'Share Ticket'}
          </button>
          {receiptUrl && !cancelled && (
            <a href={receiptUrl} target="_blank" rel="noopener noreferrer" className={secondaryAction}>
              <Download className="size-4 text-muted-foreground" aria-hidden />
              Download Receipt
            </a>
          )}
        </div>
      </div>
    </section>
  )
}
