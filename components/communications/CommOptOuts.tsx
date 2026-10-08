'use client'

// Communication Center › Opt-outs (RD-COMMS-P2-G). READ-ONLY.
//
// Who has asked this organizer to stop sending them announcement and reminder emails, and which
// addresses bounced for them. The list comes from GET /api/organizer/communications/opt-outs,
// scoped server-side to this workspace. An opt-out applies to ALL of the organizer's events, so
// this view is not event-filtered. Nothing here changes an opt-out: recipients make and lift
// their own from the link in each email, and platform-wide suppression is never shown or
// overridable. Why an individual message was not sent is on Messages (status "Skipped").

import { useEffect, useState } from 'react'
import { Loader2, MailX } from 'lucide-react'
import { auth } from '@/lib/firebase/auth'
import { Card, EmptyState } from '@/components/ui'
import type { OrganizerOptOutRow } from '@/lib/firebase/firestore/emailSuppressionList'

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—')

export const OPT_OUT_KIND_LABELS: Record<OrganizerOptOutRow['kind'], string> = {
  unsubscribed:  'Unsubscribed',
  undeliverable: 'Not deliverable',
}

type State = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; rows: OrganizerOptOutRow[]; truncated: boolean }

export function CommOptOuts() {
  const [state, setState] = useState<State>({ kind: 'loading' })

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const token = await auth.currentUser?.getIdToken()
        const res = await fetch('/api/organizer/communications/opt-outs', { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: 'no-store' })
        const body = await res.json().catch(() => ({})) as { optOuts?: OrganizerOptOutRow[]; truncated?: boolean; error?: string }
        if (!alive) return
        if (!res.ok) { setState({ kind: 'error', message: body.error ?? 'Could not load opt-outs.' }); return }
        setState({ kind: 'ready', rows: body.optOuts ?? [], truncated: body.truncated === true })
      } catch {
        if (alive) setState({ kind: 'error', message: 'Network error — please try again.' })
      }
    })()
    return () => { alive = false }
  }, [])

  return (
    <div className="space-y-4">
      <Card variant="elevated" padded={false} className="p-4 text-[13px] text-muted-foreground">
        <p className="font-semibold text-foreground">How opt-outs work</p>
        <ul className="mt-1.5 list-disc space-y-1 pl-5">
          <li>Every broadcast and reminder email carries an unsubscribe link. A recipient who uses it stops receiving your announcement and reminder emails — for all of your events.</li>
          <li>They still receive essential messages: tickets, registration and payment confirmations, refunds and certificates.</li>
          <li>Opted-out and undeliverable addresses are skipped automatically when a message is sent; you’ll see them as <span className="font-semibold text-foreground">Skipped</span> in Messages, with the reason.</li>
          <li>Only the recipient can opt back in, from the same link. Opt-outs can’t be removed from here.</li>
          {/* RD-COMMS-WA-CONSENT */}
          <li>WhatsApp broadcasts reach only attendees who ticked “WhatsApp updates” when they registered. Anyone who replies STOP is excluded until they reply START. Tickets and other essential WhatsApp messages are not affected.</li>
        </ul>
      </Card>

      {state.kind === 'loading' && <div className="flex justify-center py-10"><Loader2 className="size-5 animate-spin text-muted-foreground motion-reduce:animate-none" aria-label="Loading opt-outs" /></div>}
      {state.kind === 'error' && <p role="alert" className="text-[13px] text-destructive">{state.message}</p>}
      {state.kind === 'ready' && (state.rows.length === 0 ? (
        <EmptyState icon={MailX} title="No opt-outs" description="No one has unsubscribed from your emails." />
      ) : (
        <Card variant="elevated" padded={false} className="overflow-hidden">
          <p className="border-b border-border px-4 py-3 text-[14px] font-semibold text-foreground">Opted-out recipients · {state.rows.length.toLocaleString('en-IN')}</p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-[13px]">
              <thead className="border-b border-border text-left text-[11.5px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-2 font-semibold">Email</th>
                  <th scope="col" className="px-4 py-2 font-semibold">Status</th>
                  <th scope="col" className="px-4 py-2 font-semibold">Since</th>
                </tr>
              </thead>
              <tbody>
                {state.rows.map(r => (
                  <tr key={r.email} className="border-b border-border/60 last:border-0">
                    <td className="max-w-[260px] truncate px-4 py-2 text-foreground" title={r.email}>{r.email}</td>
                    <td className="px-4 py-2">
                      <span className={r.kind === 'unsubscribed' ? 'rounded-full bg-muted px-2 py-0.5 text-[11.5px] font-semibold text-muted-foreground' : 'rounded-full bg-amber-50 px-2 py-0.5 text-[11.5px] font-semibold text-amber-800'}>
                        {OPT_OUT_KIND_LABELS[r.kind]}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">{fmt(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {state.truncated && <p className="border-t border-border px-4 py-2 text-[12px] text-muted-foreground">Showing the first 500 only.</p>}
        </Card>
      ))}
    </div>
  )
}
