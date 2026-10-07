// "Already registered? Download your ticket" — the ONE public entry point to
// /events/[slug]/download-ticket.
//
// That page existed with no link to it anywhere on the public event page, so an attendee
// who lost their confirmation email had no way back to their ticket except a URL they did
// not know. This link is the way back. It carries only the slug: the page itself asks the
// attendee for their ticket ID or mobile number (rate-limited, scoped to this event).
//
// Presentational + directive-free, so server and client templates can both render it.

import Link from 'next/link'
import { Ticket, ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

export function downloadTicketHref(slug: string): string {
  return `/events/${encodeURIComponent(slug)}/download-ticket`
}

export function DownloadTicketLink({ slug, className }: { slug: string; className?: string }) {
  return (
    <Link
      href={downloadTicketHref(slug)}
      className={cn(
        'group inline-flex items-center gap-1.5 text-fs-sm text-muted-foreground transition-colors hover:text-foreground',
        'rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action/50',
        className,
      )}
    >
      <Ticket className="size-4 shrink-0" aria-hidden />
      <span>
        Already registered?{' '}
        <span className="font-medium text-action underline-offset-4 group-hover:underline">Download your ticket</span>
      </span>
      <ArrowRight className="size-3.5 shrink-0 text-action transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" aria-hidden />
    </Link>
  )
}
